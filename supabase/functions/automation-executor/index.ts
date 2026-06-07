import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import { isInternalCaller, isServiceRoleToken } from "../_shared/authz.ts";
import { resolveCampaignInstruction, formatInstructionForPrompt, type CampaignResolverInput } from "../_shared/campaignResolver.ts";
import { loadCampaignForLead } from "../_shared/campaignStepLoader.ts";
import { loadDealMemory, updateFromOutboundLite, saveDealMemory } from "../_shared/dealMemory.ts";
import {
  loadExecutionSettings,
  clearSettingsCache,
  checkMinGap,
  checkPerLeadCaps,
  checkSendWindow,
  checkStopConditions,
  computeNextEligibleAt,
  resolveStepDelay,
  type ExecutionSettings,
} from "../_shared/executionSettings.ts";
import { plainTextToHtml } from "../_shared/emailUtils.ts";
import { logger } from "../_shared/logger.ts";
import {
  resolveTouchContent,
  coldSendFloor,
  sendColdEmailTouch,
  advanceColdEnrollment,
  buildUnsubscribeUrl,
} from "../_shared/coldOutreach.ts";
import { signUnsubscribeToken, getUnsubscribeSecret } from "../_shared/outreachUnsubscribeToken.ts";

// Removes the "Best,\nMike" sign-off the AI generates per prompt instructions.
// Must run before the real signature block is appended to avoid duplication.
function stripAISignOff(body: string): string {
  const pattern = /\n\n(?:Best regards?|Best|Thanks|Thank you|Kind regards?|Warm regards?|Regards|Cheers|Sincerely),?\s*\n[^\n]{1,40}\s*$/i;
  return body.replace(pattern, "").trimEnd();
}

/** @deprecated — Use resolveCampaignInstruction() instead for new code.
 *  Kept temporarily for any edge case not yet migrated to the resolver. */
function buildStepInstructions(actionInstructions: string | null | undefined, nextActionKey: string | null | undefined): string | null {
  if (!actionInstructions) return null;

  const lines = actionInstructions.split("\n");
  const globalLines: string[] = [];
  const stepBlocks: Record<string, string[]> = {};
  let currentBlock: string | null = null;

  for (const line of lines) {
    const stepMatch = line.match(/^STEP\s+(\d+)\s+INSTRUCTIONS\s*:/i);
    if (stepMatch) {
      currentBlock = stepMatch[1];
      stepBlocks[currentBlock] = [];
    } else if (currentBlock) {
      stepBlocks[currentBlock].push(line);
    } else {
      globalLines.push(line);
    }
  }

  let stepNum: string | null = null;
  if (nextActionKey) {
    const match = nextActionKey.match(/(\d+)/);
    if (match) stepNum = match[1];
  }

  const parts: string[] = [];
  const globalText = globalLines.join("\n").trim();
  if (globalText) parts.push(globalText);
  if (stepNum && stepBlocks[stepNum]) {
    const stepText = stepBlocks[stepNum].join("\n").trim();
    if (stepText) parts.push(`STEP ${stepNum} SPECIFIC INSTRUCTIONS:\n${stepText}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── AUTH: Only internal-secret or service-role callers are allowed.
    // The anon key is NOT treated as privileged — it would let any
    // unauthenticated caller trigger sends.
    const privileged = isInternalCaller(req) || isServiceRoleToken(req);

    let ownerFilter: string | null = null;

    if (!privileged) {
      // Fall back to user-auth: resolve the user and scope to their leads
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      ownerFilter = user.id;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Clear per-invocation caches
    clearSettingsCache();

    const now = new Date().toISOString();

    // -------------------------------------------------------
    // STEP -1: STALE CLAIM RECOVERY
    // Claims stuck in "claiming" past their expiry are marked
    // "expired" so the unique index slot is freed and the lead
    // can be retried on the next run. A claim expires when:
    //   claim_expires_at < now AND status = 'claiming'
    // This handles: executor crash, provider timeout, DB write
    // failure after provider success (compensating log exists).
    // -------------------------------------------------------
    const { data: staleClaims } = await supabase
      .from("automation_log")
      .select("id, lead_id, action_key")
      .eq("status", "claiming")
      .lt("claim_expires_at", now)
      .limit(50);

    if (staleClaims && staleClaims.length > 0) {
      console.warn(`[automation-executor] Recovering ${staleClaims.length} stale claims`);
      for (const stale of staleClaims) {
        await supabase.from("automation_log")
          .update({
            status: "expired",
            error_message: "Stale claim expired — executor did not complete within TTL",
            completed_at: now,
          })
          .eq("id", stale.id);
        console.warn(`[automation-executor] Expired stale claim ${stale.id} for lead ${stale.lead_id}, action ${stale.action_key}`);
      }
    }

    // -------------------------------------------------------
    // STEP 0: OOO RETURN DETECTION
    // Find leads where ooo_until has passed and eligible_at
    // has arrived — surface "Back in office" action without
    // sending an email. needs_action is currently false for
    // these leads (set during OOO detection in gmail-sync).
    // -------------------------------------------------------
    let oooQuery = supabase
      .from("leads")
      .select("id, name, company, owner_user_id, ooo_until, eligible_at")
      .not("ooo_until", "is", null)
      .lte("ooo_until", now)          // OOO period has ended
      .not("eligible_at", "is", null)
      .lte("eligible_at", now)        // eligible_at has arrived
      .eq("needs_action", false)      // not yet surfaced
      .eq("unsubscribed", false)
      .not("automation_mode", "is", null) // ← consent gate: never auto-promote a non-consented lead
      .in("status", ["active", "new"])
      .limit(20);

    if (ownerFilter) {
      oooQuery = oooQuery.eq("owner_user_id", ownerFilter);
    }

    const { data: oooLeads } = await oooQuery;

    if (oooLeads && oooLeads.length > 0) {
      console.log(`[automation-executor] Found ${oooLeads.length} OOO-returning leads`);
      for (const lead of oooLeads) {
        const leadFirstName = lead.name.split(" ")[0];
        await supabase.from("leads").update({
          needs_action: true,
          next_action_key: "ooo_return_followup",
          next_action_label: `Back in office — follow up with ${leadFirstName}`,
          action_reason_code: "OOO_RETURN",
          ooo_until: null, // clear OOO flag now that we've surfaced it
        }).eq("id", lead.id);

        // Log a system note in the timeline
        await supabase.from("interactions").insert({
          lead_id: lead.id,
          type: "system_note",
          source: "automation",
          body_text: `${lead.name} is back in the office. Follow-up action surfaced.`,
          occurred_at: new Date().toISOString(),
          dedupe_key: `automation:ooo_return:${lead.id}:${new Date().toISOString().slice(0, 10)}`,
        });

        console.log(`[automation-executor] OOO return surfaced for lead ${lead.id} (${lead.name})`);
      }
    }

    // -------------------------------------------------------
    // STEP 0.5: WHATSAPP 6-HOUR NO-REPLY CHECK (PART 2)
    // If a lead sent an inbound WA message >6h ago and we
    // haven't replied (no outbound in that window), surface
    // needs_action so the rep sees it in the dashboard.
    // Safety: skip leads already flagged, OOO leads, unsubscribed.
    // -------------------------------------------------------
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    let waCheckQuery = supabase
      .from("leads")
      .select("id, name, phone, last_inbound_at, last_outbound_at, needs_action, next_action_key, ooo_until")
      .not("last_inbound_at", "is", null)
      .lte("last_inbound_at", sixHoursAgo)   // inbound was >6h ago
      .eq("needs_action", false)              // not already actioned
      .eq("unsubscribed", false)
      .in("status", ["active", "new"])
      .is("ooo_until", null)                  // not OOO
      .not("phone", "is", null)               // only flag if phone number exists
      .limit(30);

    if (ownerFilter) {
      waCheckQuery = waCheckQuery.eq("owner_user_id", ownerFilter);
    }

    const { data: pendingWaLeads } = await waCheckQuery;

    if (pendingWaLeads && pendingWaLeads.length > 0) {
      for (const lead of pendingWaLeads) {
        // Check if last_outbound_at is AFTER last_inbound_at → already replied
        const lastIn = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
        const lastOut = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
        if (lastOut >= lastIn) continue; // rep already replied — skip

        // Flag as needing action: WhatsApp reply pending
        await supabase.from("leads").update({
          needs_action: true,
          next_action_key: "reply_now",
          next_action_label: "Reply",
          action_reason_code: "REPLY_PENDING",
        } as any).eq("id", lead.id);

        console.log(`[automation-executor] WA 6h no-reply flagged for lead ${lead.id}`);
      }
    }

    // Find eligible leads (existing automation email flow)
    // CRITICAL: Exclude nurture leads — they are handled separately by the nurture pre-generate pipeline.
    // Nurture leads in "review" mode need manual approval; "automatic" mode is handled by its own flow.
    // Allowing nurture leads here causes prospecting emails to be sent erroneously.
    // CONSENT GATE: only send for leads where the user has explicitly enabled
    // automation (automation_mode IS NOT NULL). syncEngine/automation-check may
    // populate eligible_at/needs_action for any inbound lead, but those are
    // suggestions only — sending requires explicit user opt-in via the
    // BulkAutomationDialog / AutomationPreviewCard which sets automation_mode.
    let query = supabase
      .from("leads")
      .select("id, name, email, company, motion, source_type, stage, next_action_key, next_action_label, owner_user_id, last_inbound_at, has_future_meeting, nurture_mode, nurture_cadence, nurture_theme, nurture_outbound_count, eligible_at, unsubscribed, action_instructions, initial_message, website, linkedin_url, company_linkedin_url, city, state, country, industry, job_title, outbound_tone, manual_mode, automation_mode")
      .eq("needs_action", true)
      .not("eligible_at", "is", null)
      .not("automation_mode", "is", null) // ← explicit consent required
      .lte("eligible_at", now)
      .in("status", ["active", "new"])
      .eq("unsubscribed", false)
      .eq("manual_mode", false) // Skip leads in manual mode (multi-participant threads)
      .neq("next_action_key", "ooo_return_followup") // OOO returns are handled above — no email needed
      .limit(20);

    // ── MAX_SENDS_PER_RUN cap ───────────────────────────────
    // Default to 5 per run to stay within Edge Function time limits
    // when inter-send stagger is active (5 × ~60s avg = ~5 min).
    const maxSendsEnv = Deno.env.get("MAX_SENDS_PER_RUN");
    const maxSendsPerRun = maxSendsEnv ? parseInt(maxSendsEnv, 10) : 5;

    // ── DAILY SEND CAP PER MAILBOX ──────────────────────────
    // Counts emails already sent today (UTC) from automation_log for each owner.
    // Enforced per-owner inside the lead loop below.
    const dailySendCounts = new Map<string, number>();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Pre-load daily cap from workspace cadence settings (per-owner, loaded lazily)
    const dailyCapCache = new Map<string, number>();

    async function getDailyCapForOwner(ownerId: string): Promise<number> {
      const cached = dailyCapCache.get(ownerId);
      if (cached !== undefined) return cached;

      const execSettings = await loadExecutionSettings(ownerId, supabase);
      const cap = execSettings.guardrails.max_sends_per_day_per_mailbox;
      dailyCapCache.set(ownerId, cap);
      return cap;
    }

    async function getDailySendCount(ownerId: string): Promise<number> {
      const cached = dailySendCounts.get(ownerId);
      if (cached !== undefined) return cached;

      const { count } = await supabase
        .from("automation_log")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", ownerId)
        .eq("status", "sent")
        .gte("created_at", todayStart.toISOString());

      const c = count ?? 0;
      dailySendCounts.set(ownerId, c);
      return c;
    }

    if (ownerFilter) {
      query = query.eq("owner_user_id", ownerFilter);
    }

    const { data: eligibleLeads, error: queryErr } = await query;

    if (queryErr) {
      console.error("[automation-executor] Query error:", queryErr);
      return new Response(JSON.stringify({ ok: false, error: queryErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NOTE: do NOT early-return when there are no legacy leads. Cold-outreach
    // automatic touches must still run in the cold pass below — cold leads carry no
    // automation_mode, so the candidate query above legitimately finds nothing in
    // the common cold-only case. Falling through (legacy loop iterates an empty
    // list) lets the cold pass execute before the final response.
    const legacyLeads = eligibleLeads || [];
    if (legacyLeads.length === 0) {
      console.log("[automation-executor] No eligible legacy leads — proceeding to cold pass");
    } else {
      console.log(`[automation-executor] Found ${legacyLeads.length} eligible leads`);
    }

    // --- STRATEGY 6: Rep Profile/Signature Preloading (per-owner cache) ---
    type RepContext = {
      profile: { full_name: string | null; company_name: string | null; job_title: string | null; calendar_link: string | null; phone: string | null; email: string | null; linkedin_url: string | null } | null;
      signature: { signature_text: string } | null;
    };
    const repContextCache = new Map<string, RepContext>();

    async function getRepContext(ownerId: string): Promise<RepContext> {
      const cached = repContextCache.get(ownerId);
      if (cached) return cached;

      const [profileRes, sigRes] = await Promise.all([
        supabase
          .from("rep_profiles")
          .select("full_name, company_name, job_title, calendar_link, phone, email, linkedin_url")
          .eq("user_id", ownerId)
          .single(),
        supabase
          .from("rep_signatures")
          .select("signature_text")
          .eq("user_id", ownerId)
          .eq("is_default", true)
          .single(),
      ]);

      const ctx: RepContext = {
        profile: profileRes.data ?? null,
        signature: sigRes.data ?? null,
      };
      repContextCache.set(ownerId, ctx);
      return ctx;
    }

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const sentLeads: { leadId: string; leadName: string; subject: string }[] = [];

    for (const lead of legacyLeads) {
      // Enforce MAX_SENDS_PER_RUN cap
      if (processed >= maxSendsPerRun) {
        console.log(`[automation-executor] MAX_SENDS_PER_RUN reached (${maxSendsPerRun}), stopping`);
        break;
      }

      // Enforce daily send cap per mailbox/owner
      const dailyCap = await getDailyCapForOwner(lead.owner_user_id);
      const dailyCount = await getDailySendCount(lead.owner_user_id);
      if (dailyCount >= dailyCap) {
        console.log(`[automation-executor] Daily send cap reached for owner ${lead.owner_user_id}: ${dailyCount}/${dailyCap}`);
        skipped++;
        continue;
      }

      const logEntry: Record<string, unknown> = {
        lead_id: lead.id,
        owner_user_id: lead.owner_user_id,
        action_key: lead.next_action_key,
        status: "pending",
        created_at: new Date().toISOString(),
      };

      try {
        // ── Load execution settings for this owner ──────────────────
        const execSettings = await loadExecutionSettings(lead.owner_user_id, supabase);

        // ── SEND WINDOW CHECK ───────────────────────────────────────
        // If we're outside the configured send window or on a weekend,
        // push eligible_at forward rather than skipping permanently.
        const windowCheck = checkSendWindow(execSettings);
        if (!windowCheck.allowed) {
          console.log(`[automation-executor] Lead ${lead.id}: ${windowCheck.reason} — deferring`);
          const nextWindow = computeNextEligibleAt(0, lead.id, lead.next_action_key || "defer", execSettings);
          await supabase.from("leads").update({ eligible_at: nextWindow.toISOString() }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = windowCheck.reason!;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // SAFETY RE-CHECK
        const { data: freshLead, error: freshErr } = await supabase
          .from("leads")
          .select("last_inbound_at, last_outbound_at, has_future_meeting, motion, stage, needs_action, eligible_at, status, unsubscribed, automation_mode, workspace_id")
          .eq("id", lead.id)
          .single();

        if (freshErr || !freshLead) {
          logEntry.status = "skipped";
          logEntry.error_message = "Could not re-fetch lead";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── EARLY CONSENT-GATE RACE GUARD (Phase 1.6) ───────────────
        // First of two layers (see also the LATE check immediately
        // before the provider fetch below). This early check is the
        // CHEAP PATH: the candidate query gated on automation_mode IS
        // NOT NULL, but a consent withdrawal (bulk move-to-nurture,
        // manual mode flip, etc.) could have landed between that query
        // and this refetch. Bailing here lets us skip the entire
        // multi-await chain that follows (stop-conditions, multi-
        // participant query, min-gap, caps, draft fetch, the `ai_task`
        // HTTP roundtrip) — meaning no wasted `ai_task` tokens on a
        // lead whose consent we already know is gone. The LATE check
        // closes the race window THIS check cannot see — withdrawals
        // landing AFTER this refetch but BEFORE the provider call.
        // Per-lead skip via `continue` — one consent withdrawal must
        // not abort the entire tick.
        //
        // SIGNAL: `automation_mode IS NULL` is the consent signal.
        // Motion is orthogonal: a `motion === "nurture"` lead with
        // `nurture_mode === "automatic"` is a legitimate auto-send
        // path and is gated downstream at the
        // `lead.nurture_mode !== "automatic"` review-mode check, not
        // here. Bulk-move-to-nurture clears `automation_mode` in the
        // same UPDATE as the motion flip, so the consent withdrawal
        // is visible through this column regardless of the motion.
        if (freshLead.automation_mode == null) {
          logger.info("automation.skipped_consent_race", {
            lead_id: lead.id,
            workspace_id: freshLead.workspace_id,
          });
          logEntry.status = "skipped";
          logEntry.error_message = "Consent withdrawn mid-flight";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── DYNAMIC STOP CONDITIONS (from cadence settings) ─────────
        const stopCheck = checkStopConditions(execSettings.stop_pause_rules, {
          has_reply: freshLead.motion !== "nurture" && !!freshLead.last_inbound_at,
          has_meeting: freshLead.has_future_meeting,
          is_unsubscribed: freshLead.unsubscribed,
        });

        if (!stopCheck.allowed) {
          console.log(`[automation-executor] Lead ${lead.id}: ${stopCheck.reason}`);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
            action_reason_code: null,
          }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = stopCheck.reason!;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── MULTI-PARTICIPANT GUARD ─────────────────────────────────
        // If the most recent inbound email has more than one participant
        // (To+Cc total > 1), flip the lead into manual_mode and skip.
        // The user takes over from here via the reply-all UI.
        const { data: lastInbound } = await supabase
          .from("interactions")
          .select("to_emails, cc_emails")
          .eq("lead_id", lead.id)
          .eq("direction", "inbound")
          .order("occurred_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastInbound) {
          const toCount = (lastInbound.to_emails as string[] | null)?.length ?? 0;
          const ccCount = (lastInbound.cc_emails as string[] | null)?.length ?? 0;
          if (toCount + ccCount > 1) {
            console.log(`[automation-executor] Lead ${lead.id}: multi-participant thread (${toCount + ccCount}) — pausing automation`);
            await supabase.from("leads").update({
              manual_mode: true,
              manual_mode_reason: "Multi-participant thread",
              manual_mode_set_at: new Date().toISOString(),
              needs_action: false,
              eligible_at: null,
            }).eq("id", lead.id);
            logEntry.status = "skipped";
            logEntry.error_message = "Multi-participant thread — manual mode";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            skipped++;
            continue;
          }
        }

        // ── MIN GAP CHECK ───────────────────────────────────────────
        const gapCheck = checkMinGap(
          freshLead.last_outbound_at,
          execSettings.guardrails.min_gap_hours_between_emails,
        );
        if (!gapCheck.allowed) {
          console.log(`[automation-executor] Lead ${lead.id}: ${gapCheck.reason} — deferring`);
          const deferMs = execSettings.guardrails.min_gap_hours_between_emails * 3_600_000;
          const deferAt = new Date(new Date(freshLead.last_outbound_at!).getTime() + deferMs);
          await supabase.from("leads").update({ eligible_at: deferAt.toISOString() }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = gapCheck.reason!;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── PER-LEAD CAPS CHECK (7d / 30d) ──────────────────────────
        const capCheck = await checkPerLeadCaps(lead.id, execSettings.guardrails, supabase);
        if (!capCheck.allowed) {
          console.log(`[automation-executor] Lead ${lead.id}: ${capCheck.reason} — pausing automation`);
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = capCheck.reason!;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── HARD STATUS CHECKS (not configurable) ───────────────────
        const isClosed = freshLead.stage === "closed_won" || freshLead.stage === "closed_lost";
        const motionChanged = freshLead.motion !== "outbound_prospecting" && freshLead.motion !== "inbound_response" && freshLead.motion !== "nurture";
        const statusInactive = freshLead.status !== "active" && freshLead.status !== "new";
        const noLongerNeeded = !freshLead.needs_action || !freshLead.eligible_at;

        if (isClosed || motionChanged || statusInactive || noLongerNeeded) {
          console.log(`[automation-executor] Lead ${lead.id} safety block:`, {
            isClosed, motionChanged, statusInactive, noLongerNeeded,
          });
          await supabase.from("leads").update({
            needs_action: false,
            eligible_at: null,
          }).eq("id", lead.id);
          logEntry.status = "skipped";
          logEntry.error_message = `Safety block: ${isClosed ? "closed" : motionChanged ? "motion" : statusInactive ? "inactive" : "not needed"}`;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // ── WhatsApp automation safety guard ─────────────────────────
        const isWaActionKey = (lead.next_action_key || "").startsWith("whatsapp_");
        if (isWaActionKey) {
          const waEnabled = execSettings.whatsapp.automation_enabled;
          const { data: waLead } = await supabase
            .from("leads")
            .select("wa_opted_in")
            .eq("id", lead.id)
            .single();
          const leadOptedIn = (waLead as any)?.wa_opted_in === true;

          if (!waEnabled || !leadOptedIn) {
            logEntry.status = "skipped";
            logEntry.error_message = waEnabled
              ? "Lead not opted in to WhatsApp automation"
              : "WhatsApp automation disabled at workspace level";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            console.log(`[automation-executor] WA auto-send blocked for lead ${lead.id}: wa_automation=${waEnabled}, opted_in=${leadOptedIn}`);
            skipped++;
            continue;
          }
        }

        // Check for unsubscribe keyword in last inbound
        if (freshLead.last_inbound_at) {
          const { data: lastInbound } = await supabase
            .from("interactions")
            .select("body_text")
            .eq("lead_id", lead.id)
            .eq("direction", "inbound")
            .order("occurred_at", { ascending: false })
            .limit(1)
            .single();

          if (lastInbound?.body_text) {
            const bodyLower = lastInbound.body_text.toLowerCase();
            if (isHumanUnsubscribeRequest(bodyLower)) {
              console.log(`[automation-executor] Lead ${lead.id} requested unsubscribe`);
              await supabase.from("leads").update({
                unsubscribed: true,
                needs_action: false,
                eligible_at: null,
                next_action_key: null,
                next_action_label: null,
                action_reason_code: null,
                nurture_status: "inactive",
              }).eq("id", lead.id);

              await supabase.from("interactions").insert({
                lead_id: lead.id,
                type: "system_note",
                source: "automation",
                body_text: "Lead requested to unsubscribe — automation stopped permanently.",
                occurred_at: new Date().toISOString(),
                dedupe_key: `automation:unsubscribe:${lead.id}:${new Date().toISOString().slice(0, 10)}`,
              });

              logEntry.status = "skipped";
              logEntry.error_message = "Unsubscribe detected in last inbound";
              logEntry.completed_at = new Date().toISOString();
              await supabase.from("automation_log").insert(logEntry);
              skipped++;
              continue;
            }
          }
        }

        // Get connected mail account (Gmail or Outlook)
        let mailProvider: "gmail" | "outlook" = "gmail";
        let mailAccountId: string | null = null;

        // Check mail_accounts table first (unified multi-mailbox)
        const { data: wsMember } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", lead.owner_user_id)
          .limit(1)
          .maybeSingle();

        if (wsMember?.workspace_id) {
          const { data: mailAcct } = await supabase
            .from("mail_accounts")
            .select("id, provider, email_address")
            .eq("workspace_id", wsMember.workspace_id)
            .eq("status", "connected")
            .order("is_default", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (mailAcct) {
            mailProvider = mailAcct.provider as "gmail" | "outlook";
            mailAccountId = mailAcct.id;
          }
        }

        // Fall back to legacy gmail_connections if no mail_account found
        let resolvedSenderEmail: string | null = null;

        if (!mailAccountId) {
          const { data: gmailConn } = await supabase
            .from("gmail_connections")
            .select("user_id, gmail_email")
            .eq("user_id", lead.owner_user_id)
            .maybeSingle();

          if (!gmailConn) {
            logEntry.status = "skipped";
            logEntry.error_message = "No mail connection (Gmail or Outlook)";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            skipped++;
            continue;
          }
          mailProvider = "gmail";
          resolvedSenderEmail = gmailConn.gmail_email;

          // ── SENDER MISMATCH GUARD ──────────────────────────────────
          // No mail_accounts entry found — sending would use the legacy
          // gmail_connections fallback. This is the exact scenario that
          // caused emails from the wrong address. Block the send.
          console.warn(
            `[automation-executor] SENDER MISMATCH: lead ${lead.id} — ` +
            `no mail_accounts entry, fallback would send from ${resolvedSenderEmail}. ` +
            `Blocking send. Configure a mail_accounts row for this workspace.`
          );
          logEntry.status = "skipped";
          logEntry.error_message = `Sender mismatch: no mail_accounts configured, would fallback to ${resolvedSenderEmail}`;
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        } else {
          // Verify the resolved mail_account email matches expectations
          const { data: resolvedAcct } = await supabase
            .from("mail_accounts")
            .select("email_address")
            .eq("id", mailAccountId)
            .single();

          resolvedSenderEmail = resolvedAcct?.email_address ?? null;

          // Cross-check: if the workspace has a gmail_connection with a
          // different email than the mail_account, warn but allow the
          // mail_account (authoritative) to proceed.
          const { data: gmailCheck } = await supabase
            .from("gmail_connections")
            .select("gmail_email")
            .eq("user_id", lead.owner_user_id)
            .maybeSingle();

          if (gmailCheck?.gmail_email && resolvedSenderEmail
              && gmailCheck.gmail_email !== resolvedSenderEmail) {
            console.warn(
              `[automation-executor] SENDER INFO: lead ${lead.id} — ` +
              `gmail_connections has ${gmailCheck.gmail_email} but mail_accounts ` +
              `will send from ${resolvedSenderEmail} (authoritative). OK to proceed.`
            );
          }
        }

        logEntry.mail_account_id = mailAccountId;

        const actionKey = lead.next_action_key;

        // Determine AI task type — motion-aware resolution
        // SAFETY: nurture leads in "review" mode require manual approval — block auto-send.
        // Only nurture leads with nurture_mode="automatic" are allowed through.
        if (lead.motion === "nurture" && lead.nurture_mode !== "automatic") {
          console.log(`[automation-executor] Nurture lead ${lead.id} in review mode — skipping (requires manual approval)`);
          logEntry.status = "skipped";
          logEntry.error_message = "Nurture lead in review mode — manual approval required";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        let aiTask: string;
        // Re-engagement leads always use re_engagement_intro task
        const isInboundLead = lead.motion === "inbound_response" || ["contact_form", "gmail_inbound", "referral", "whatsapp_inbound"].includes(lead.source_type || "");

        if (lead.motion === "re_engagement") {
          aiTask = "re_engagement_intro";
        } else if (actionKey) {
          // Inbound leads stay on the warm cadence for the entire sequence (decision: switch to warm).
          // Step 4 still uses the cold breakup task — there's no inbound-specific breakup variant.
          //
          // CAP (Outreach Unit B → Unit C): only steps 1–4 map to AI tasks. The
          // campaign resolver now supports up to 9 touches for STRUCTURED campaigns,
          // but mapping send_pre_5..9 to tasks AND advancing the cadence past step 4
          // (see NEXT_STEP / breakup branch ~L1351) is a REQUIRED Unit C deliverable —
          // it must land in the same unit that lets a >4-step campaign be activated.
          // Until then the live path is intentionally capped at 4; drafts never reach
          // here (loadCampaignForLead is active-only).
          if (actionKey.startsWith("send_pre_1")) aiTask = isInboundLead ? "inbound_intro" : "pre_email_1_intro";
          else if (actionKey.startsWith("send_pre_2")) aiTask = isInboundLead ? "inbound_followup_1" : "pre_email_2_followup";
          else if (actionKey.startsWith("send_pre_3")) aiTask = isInboundLead ? "inbound_followup_2" : "pre_email_3_followup";
          else if (actionKey.startsWith("send_pre_4")) aiTask = "pre_email_4_breakup";
          else if (actionKey.startsWith("send_nurture") || actionKey.startsWith("nurture_")) aiTask = "nurture_email_single";
          else aiTask = isInboundLead ? "inbound_followup_1" : "pre_email_2_followup"; // unknown key fallback
        } else {
          aiTask = isInboundLead ? "inbound_intro" : "pre_email_1_intro"; // first touch if no key (non-nurture leads only at this point)
        }

        logEntry.ai_task = aiTask;

        // GUARD 0: Short-window dedup — prevent concurrent executor runs
        // from spamming the same lead within a 1-hour window.
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count: recentSentCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .in("status", ["sent", "pending"])
          .gte("created_at", oneHourAgo);

        if ((recentSentCount || 0) >= 1) {
          console.log(`[automation-executor] Lead ${lead.id}: Recent send detected within 1h (${recentSentCount}) — skipping`);
          logEntry.status = "skipped";
          logEntry.error_message = "Duplicate send guard: email sent/pending within last hour";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          skipped++;
          continue;
        }

        // GUARD 1: Daily per-lead cap — enforced atomically at DB level via unique index.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const { count: todaySentCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .eq("status", "sent")
          .gte("created_at", todayStart.toISOString());

        if ((todaySentCount || 0) >= 1) {
          console.log(`[automation-executor] Lead ${lead.id}: Pre-flight daily cap hit (${todaySentCount} sent today) — pushing to tomorrow`);
          logEntry.status = "skipped";
          logEntry.error_message = "Daily send limit reached (1 per lead per day)";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 30, 0, 0);
          await supabase.from("leads").update({ eligible_at: tomorrow.toISOString() }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // GUARD 2: Action-level dedup — prevent re-sending the same step within
        // 7 days. Scoped to a recent window so that leads can be re-enrolled in
        // automation after completing a previous sequence.
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { count: actionSentCount } = await supabase
          .from("automation_log")
          .select("id", { count: "exact", head: true })
          .eq("lead_id", lead.id)
          .eq("action_key", actionKey)
          .eq("status", "sent")
          .gte("created_at", sevenDaysAgo);

        if ((actionSentCount || 0) >= 1) {
          console.log(`[automation-executor] Lead ${lead.id}: Action ${actionKey} already sent within 7d — skipping duplicate`);
          logEntry.status = "skipped";
          logEntry.error_message = "Action already sent within 7 days — skipping duplicate";
          logEntry.completed_at = new Date().toISOString();
          await supabase.from("automation_log").insert(logEntry);
          await supabase.from("leads").update({ needs_action: false, eligible_at: null, next_action_key: null, next_action_label: null }).eq("id", lead.id);
          skipped++;
          continue;
        }

        // --- STRATEGY 1: Draft Caching ---
        // Priority 1: Check for user-approved drafts (no time limit — user explicitly saved these)
        const { data: approvedDraft } = await supabase
          .from("drafts")
          .select("id, body_text, subject")
          .eq("lead_id", lead.id)
          .eq("step_key", actionKey)
          .eq("status", "approved")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Priority 2: Fall back to pending (AI-generated) drafts within 24h
        let cachedDraft = approvedDraft;
        if (!cachedDraft?.body_text) {
          const { data: pendingDraft } = await supabase
            .from("drafts")
            .select("id, body_text, subject")
            .eq("lead_id", lead.id)
            .eq("step_key", actionKey)
            .eq("status", "pending")
            .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          cachedDraft = pendingDraft;
        }

        let draftBody: string;
        let subject: string;
        let resolvedChannel: string = "email"; // default, overridden by campaign resolver
        const { profile: repProfile, signature: repSignature } = await getRepContext(lead.owner_user_id);

        if (cachedDraft?.body_text) {
          const draftType = approvedDraft?.body_text ? "approved" : "pending";
          console.log(`[automation-executor] ♻️ Reusing ${draftType} draft for lead ${lead.id}, step ${actionKey}`);
          draftBody = cachedDraft.body_text;
          subject = cachedDraft.subject || `Following up - ${lead.name.split(" ")[0]}`;
          // Mark the draft as sent
          if (cachedDraft.id) {
            await supabase.from("drafts").update({ status: "sent" }).eq("id", cachedDraft.id);
          }
        } else {
          // --- Fetch last outbound body for follow-up context ---
          let lastOutboundBody = "";
          let previousEmailSummary = "";
          const isFollowUpTask = ["pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup"].includes(aiTask);

          if (isFollowUpTask) {
            try {
              const { data: lastOutbound } = await supabase
                .from("interactions")
                .select("body_text, subject, occurred_at")
                .eq("lead_id", lead.id)
                .eq("direction", "outbound")
                .eq("type", "email_outbound")
                .order("occurred_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (lastOutbound?.body_text) {
                // Strip signature and unsubscribe footer for context
                const bodyClean = lastOutbound.body_text
                  .split("\n\n---\n")[0]  // remove unsubscribe footer
                  .slice(0, 500);         // cap length
                lastOutboundBody = bodyClean;
                previousEmailSummary = lastOutbound.subject
                  ? `Last email subject: "${lastOutbound.subject}" sent ${lastOutbound.occurred_at}`
                  : `Last email sent ${lastOutbound.occurred_at}`;
                console.log(`[automation-executor] ✅ Loaded last outbound for follow-up context (${bodyClean.length} chars)`);
              }
            } catch (err) {
              console.error(`[automation-executor] Failed to load last outbound for lead ${lead.id}:`, err);
            }
          }

          // ── STRUCTURED CAMPAIGN RESOLVER ──────────────────────────
          // Uses the canonical resolver instead of ad-hoc text parsing.
          // Prefers structured campaign steps from DB when available,
          // falls back to legacy text parsing from action_instructions.
          let structuredCampaign = null;
          try {
            structuredCampaign = await loadCampaignForLead(lead.id, supabase);
            if (structuredCampaign) {
              console.log(`[automation-executor] ✅ Loaded structured campaign ${structuredCampaign.id} for lead ${lead.id}`);
            }
          } catch (err) {
            console.warn(`[automation-executor] Failed to load structured campaign for lead ${lead.id}:`, err);
          }

          const campaignInput: CampaignResolverInput = {
            lead_id: lead.id,
            action_key: lead.next_action_key,
            motion: isInboundLead ? "inbound_response" : lead.motion,
            outbound_tone: (lead as any).outbound_tone || "direct",
            action_instructions: lead.action_instructions,
            structured_campaign: structuredCampaign,
            prior_steps_sent: undefined,
            has_reply: !!freshLead.last_inbound_at,
            meeting_booked: freshLead.has_future_meeting,
            include_meeting_cta: structuredCampaign?.include_meeting_cta ?? false,
            calendar_link: repProfile?.calendar_link || null,
            playbook_id: undefined,
          };
          const resolvedInstruction = resolveCampaignInstruction(campaignInput);
          const structuredInstructionBlock = formatInstructionForPrompt(resolvedInstruction);

          // Legacy fallback: still pass custom_instructions for backward compat
          // with the existing ai_task prompt injection pipeline
          const resolvedInstructions = buildStepInstructions(lead.action_instructions, lead.next_action_key);
          if (resolvedInstructions) {
            console.log(`[automation-executor] ✅ Campaign instructions resolved for lead ${lead.id}, step ${lead.next_action_key}: "${resolvedInstructions.slice(0, 120)}..."`);
          }
          console.log(`[automation-executor] ✅ Structured instruction: ch=${resolvedInstruction.channel}, fw=${resolvedInstruction.framework}, step=${resolvedInstruction.sequence_context.step_number}, words=${resolvedInstruction.max_word_count}`);

          // Generate draft via ai_task
          const aiResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify({
              task: aiTask,
              payload: {
                lead_id: lead.id,
                motion: isInboundLead ? "inbound_response" : lead.motion,
                source_type: lead.source_type || "manual_entry",
                outbound_tone: (lead as any).outbound_tone || "direct",
                lead_context: `Name: ${lead.name}\nCompany: ${lead.company}\nEmail: ${lead.email}\nMotion: ${isInboundLead ? "inbound_response" : lead.motion}\nSource: ${lead.source_type || "manual_entry"}\nStage: ${lead.stage}${lead.job_title ? `\nJob Title: ${lead.job_title}` : ""}${lead.industry ? `\nIndustry: ${lead.industry}` : ""}${(lead as any).initial_message ? `\nInitial Message: ${(lead as any).initial_message}` : ""}${lead.country ? `\nCountry: ${lead.country}` : ""}${lead.city ? `\nCity: ${lead.city}` : ""}${lead.state ? `\nState: ${lead.state}` : ""}${lead.website ? `\nWebsite: ${lead.website}` : ""}${lead.linkedin_url ? `\nLinkedIn: ${lead.linkedin_url}` : ""}${lead.company_linkedin_url ? `\nCompany LinkedIn: ${lead.company_linkedin_url}` : ""}`,
                lead_card_message: (lead as any).initial_message || "",
                rep_context: repProfile ? `Sender Name: ${repProfile.full_name || "Sales Rep"}\nSender Title: ${repProfile.job_title || ""}\nSender Company: ${repProfile.company_name || ""}\nCalendar Link: ${repProfile.calendar_link || ""}` : "",
                meeting_link: repProfile?.calendar_link || "",
                custom_instructions: resolvedInstructions,
                // NEW: structured campaign instruction block for deterministic prompt assembly
                campaign_instruction: structuredInstructionBlock,
                campaign_meta: {
                  channel: resolvedInstruction.channel,
                  framework: resolvedInstruction.framework,
                  step_number: resolvedInstruction.sequence_context.step_number,
                  max_word_count: resolvedInstruction.max_word_count,
                  cta_type: resolvedInstruction.cta_type,
                  has_custom_instructions: !!resolvedInstruction.raw_custom_instructions,
                },
                last_outbound_body: lastOutboundBody || undefined,
                previous_email_summary: previousEmailSummary || undefined,
              },
            }),
          });

          if (!aiResponse.ok) {
            const errText = await aiResponse.text();
            console.error(`[automation-executor] AI task failed for lead ${lead.id}:`, errText);
            logEntry.status = "failed";
            logEntry.error_message = `AI generation failed: ${errText.substring(0, 200)}`;
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            await supabase.from("leads").update({
              eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            }).eq("id", lead.id);
            errors.push(`Lead ${lead.id}: AI failed`);
            continue;
          }

          const aiResult = await aiResponse.json();
          if (!aiResult.ok || !aiResult.content) {
            logEntry.status = "failed";
            logEntry.error_message = "AI returned no content";
            logEntry.completed_at = new Date().toISOString();
            await supabase.from("automation_log").insert(logEntry);
            await supabase.from("leads").update({
              eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            }).eq("id", lead.id);
            errors.push(`Lead ${lead.id}: No AI content`);
            continue;
          }

          // Resolve placeholders
          const repFirstName = repProfile?.full_name?.split(" ")[0] || "";
          draftBody = aiResult.content
            .replace(/\{Rep'?s?\s*first\s*name\}/gi, repFirstName)
            .replace(/\[Rep'?s?\s*first\s*name\]/gi, repFirstName)
            .replace(/\{Your\s*Name\}/gi, repFirstName)
            .replace(/\[Your\s*Name\]/gi, repFirstName)
            .replace(/\{Sender\s*Name\}/gi, repFirstName)
            .replace(/\[Sender\s*Name\]/gi, repFirstName)
            .replace(/\{First\s*Name\}/gi, repFirstName)
            .replace(/\[First\s*Name\]/gi, repFirstName);

          // Determine resolved channel for this step
          resolvedChannel = resolvedInstruction?.channel || "email";

          // Append signature + footer only for email channel
          if (resolvedChannel === "email") {
            draftBody = stripAISignOff(draftBody);
            if (repSignature?.signature_text) {
              draftBody += `\n\n${repSignature.signature_text}`;
            } else if (repProfile?.full_name) {
              const sigParts = [repProfile.full_name];
              if (repProfile.job_title) sigParts.push(repProfile.job_title);
              if (repProfile.company_name) sigParts.push(repProfile.company_name);
              if (repProfile.phone) sigParts.push(repProfile.phone);
              if (repProfile.email) sigParts.push(repProfile.email);
              draftBody += `\n\n${sigParts.join("\n")}`;
            }

            // Unsubscribe footer
            draftBody += `\n\n---\nIf you'd prefer not to receive these emails, simply reply with "unsubscribe" and we'll remove you from our list.`;
          }

          // Subject line (only for email)
          const leadFirstName = lead.name.split(" ")[0];
          const companyName = lead.company !== "Unknown Company" ? lead.company : null;
          if (resolvedChannel === "email") {
            if (aiTask === "inbound_intro") {
              subject = companyName ? `Thanks for reaching out - ${companyName}` : `Thanks for reaching out, ${leadFirstName}`;
            } else if (aiTask === "pre_email_1_intro") {
              subject = companyName ? `Introduction - ${companyName}` : `Connecting with you, ${leadFirstName}`;
            } else if (aiTask === "pre_email_2_followup") {
              subject = `Following up - ${leadFirstName}`;
            } else if (aiTask === "pre_email_3_followup") {
              subject = `Checking in - ${leadFirstName}`;
            } else if (aiTask === "pre_email_4_breakup") {
              subject = `Closing the loop - ${leadFirstName}`;
            } else if (aiTask === "nurture_email_single") {
              subject = companyName ? `Thought you'd find this valuable, ${leadFirstName}` : `Thought you'd find this valuable`;
            } else {
              subject = `Following up - ${leadFirstName}`;
            }
          } else {
            // SMS/WhatsApp: no subject line
            subject = "";
          }
        } // end else (no cached draft)

        logEntry.subject = subject;

        // Save as draft for audit trail
        await supabase.from("drafts").insert({
          lead_id: lead.id,
          channel: resolvedChannel || "email",
          draft_type: aiTask,
          subject,
          body_text: draftBody,
          status: "auto_sent",
          step_key: lead.next_action_key,
          created_by: lead.owner_user_id,
        });

        // ── PRE-SEND CLAIM ──────────────────────────────────────
        // Insert a "claiming" reservation BEFORE calling the provider.
        // The unique index (automation_log_claim_unique) blocks concurrent
        // executor runs from both claiming the same lead+action+day.
        // claimed_at / claim_expires_at enable stale-claim recovery:
        // if a claim is older than CLAIM_TTL_MINUTES without being
        // upgraded to sent/failed, recovery logic can expire it.
        const CLAIM_TTL_MINUTES = 10;
        const claimDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const claimedAt = new Date().toISOString();
        const claimExpiresAt = new Date(Date.now() + CLAIM_TTL_MINUTES * 60 * 1000).toISOString();
        logEntry.status = "claiming";
        (logEntry as Record<string, unknown>).claim_date = claimDate;
        (logEntry as Record<string, unknown>).claimed_at = claimedAt;
        (logEntry as Record<string, unknown>).claim_expires_at = claimExpiresAt;
        const { data: claimRow, error: claimError } = await supabase.from("automation_log").insert(logEntry).select("id").single();

        if (claimError) {
          const isDuplicate = claimError.code === "23505";
          if (isDuplicate) {
            console.warn(`[automation-executor] Pre-send claim blocked (duplicate) for lead ${lead.id}, action ${actionKey}: ${claimError.message}`);
          } else {
            console.error(`[automation-executor] Pre-send claim failed for lead ${lead.id}: ${claimError.message}`);
          }
          skipped++;
          continue;
        }
        const claimId = claimRow?.id;

        // ── LATE CONSENT-GATE RACE GUARD (Phase 1.6 follow-up) ─────────────
        // Two-layer consent check by design:
        //   • The early check (after the safety refetch above) is the CHEAP
        //     PATH — it catches consent withdrawals that landed before the
        //     refetch and lets us bail before spending `ai_task` tokens on
        //     an already-withdrawn lead.
        //   • This late check is the TRUE RACE CLOSER. The window between
        //     the early check and here covers the multi-second await chain
        //     (stop-conditions, multi-participant query, min-gap, per-lead
        //     caps, draft lookup, the `ai_task` HTTP roundtrip — usually
        //     the longest leg — and the pre-send claim insert above). A
        //     consent withdrawal landing anywhere in that window is
        //     invisible to the early check. The minimal SELECT here
        //     immediately before the provider fetch shrinks the remaining
        //     race window to a single network roundtrip to the provider.
        // Skip shape is intentionally indistinguishable from the early
        // check (same status, same error_message, same telemetry event) —
        // operators don't need to tell them apart in production logs.
        // Fail-closed: if the lookup itself errors (null `lateLead`), we
        // skip rather than send — better one extra skipped tick than one
        // stale outbound. The claim row is left for stale-claim recovery
        // to expire on the next tick if the .update() also fails.
        //
        // SIGNAL: `automation_mode IS NULL` is the consent signal — same
        // as the early check. Motion is orthogonal (see early-check
        // comment above for the full reasoning). Selecting only that one
        // column keeps this check as cheap as possible.
        const { data: lateLead } = await supabase
          .from("leads")
          .select("automation_mode")
          .eq("id", lead.id)
          .single();

        if (lateLead == null || lateLead.automation_mode == null) {
          logger.info("automation.skipped_consent_race", {
            lead_id: lead.id,
            workspace_id: freshLead.workspace_id,
          });
          await supabase.from("automation_log")
            .update({
              status: "skipped",
              error_message: "Consent withdrawn mid-flight",
              completed_at: new Date().toISOString(),
            })
            .eq("id", claimId);
          skipped++;
          continue;
        }

        // Send via appropriate channel + provider
        let sendResponse: Response;
        if (resolvedChannel === "sms") {
          // ── SMS SEND ──────────────────────────────────────────
          if (!lead.phone) {
            console.warn(`[automation-executor] Lead ${lead.id}: SMS channel but no phone number — skipping`);
            await supabase.from("automation_log")
              .update({ status: "skipped", error_message: "No phone number for SMS", completed_at: new Date().toISOString() })
              .eq("id", claimId);
            skipped++;
            continue;
          }
          sendResponse = await fetch(`${supabaseUrl}/functions/v1/sms-send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
              "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
            },
            body: JSON.stringify({
              to: lead.phone,
              body: draftBody,
              leadId: lead.id,
              ownerUserId: lead.owner_user_id,
              skipStateUpdate: true,
            }),
          });
        } else if (mailProvider === "outlook" && mailAccountId) {
          const bodyHtml = plainTextToHtml(draftBody);
          sendResponse = await fetch(`${supabaseUrl}/functions/v1/outlook-send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
              "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
            },
            body: JSON.stringify({
              mail_account_id: mailAccountId,
              to: lead.email,
              subject,
              bodyHtml,
              leadId: lead.id,
              ownerUserId: lead.owner_user_id,
              skipStateUpdate: true,
            }),
          });
        } else {
          sendResponse = await fetch(`${supabaseUrl}/functions/v1/gmail-send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
              "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
            },
            body: JSON.stringify({
              to: lead.email,
              subject,
              body: draftBody,
              leadId: lead.id,
              ownerUserId: lead.owner_user_id,
              skipStateUpdate: true,
            }),
          });
        }

        // gmail-send always returns HTTP 200 (even on error) so the JSON body is readable.
        // We must check sendResult.ok (the JSON field) — NOT sendResponse.ok (the HTTP status).
        const sendResult = await sendResponse.json();

        if (!sendResult.ok) {
          const sendErr = sendResult.error || "Unknown send error";
          console.error(`[automation-executor] Send failed for lead ${lead.id}:`, sendErr);

          // Upgrade claim to "failed" — use claim ID for precision
          await supabase.from("automation_log")
            .update({ status: "failed", error_message: `${mailProvider} send failed: ${String(sendErr).substring(0, 200)}`, completed_at: new Date().toISOString() })
            .eq("id", claimId);

          if (sendResult.needsReconnect) {
            console.warn(`[automation-executor] ${mailProvider} needs reconnect for user ${lead.owner_user_id}`);
            await supabase.from("leads").update({
              needs_action: false,
              eligible_at: null,
            }).eq("id", lead.id);
            skipped++;
            continue;
          }

          // Retry: push eligible_at forward 15 min
          await supabase.from("leads").update({
            eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          }).eq("id", lead.id);
          errors.push(`Lead ${lead.id}: Send failed`);
          continue;
        }

        const gmailMessageId = sendResult.messageId || sendResult.messageSid || null;
        const sendChannelLabel = resolvedChannel === "sms" ? "SMS" : "Email";
        console.log(`[automation-executor] ${sendChannelLabel} sent for lead ${lead.id}: ${gmailMessageId}`);

        // ── UPGRADE CLAIM TO SENT ───────────────────────────────
        // The interaction + timeline records are created by gmail-send / outlook-send
        // (the sole writers for outbound email). We only update the automation_log here.
        // Use claim ID for precision — avoids stale WHERE mismatches.
        const { error: upgradeError } = await supabase.from("automation_log")
          .update({ status: "sent", gmail_message_id: gmailMessageId, completed_at: new Date().toISOString() })
          .eq("id", claimId);

        if (upgradeError) {
          // COMPENSATING LOG: The provider already sent the email.
          // Log a hard warning so operators can reconcile manually.
          console.error(
            `[automation-executor] ⚠️ CRITICAL: Provider sent email for lead ${lead.id} ` +
            `(messageId=${gmailMessageId}) but claim upgrade failed: ${upgradeError.message}. ` +
            `ClaimId=${claimId}. Manual reconciliation may be needed.`
          );
          // Do NOT skip — the email was sent, so proceed with post-send state update
        }

        // ── STYLE LEARNING: capture auto-sent message for style engine ──
        try {
          const styleChannel = resolvedChannel === "sms" ? "sms" : resolvedChannel === "whatsapp" ? "whatsapp" : "email";
          const styleMotion = aiTask === "nurture_email_single" ? "nurture"
            : aiTask === "reply_to_thread" ? "reply_to_thread"
            : lead.next_action_key?.includes("follow") ? "follow_up"
            : "outbound_cold";
          await supabase.from("style_examples").insert({
            user_id: lead.owner_user_id,
            workspace_id: lead.workspace_id,
            channel: styleChannel,
            motion_type: styleMotion,
            body_text: draftBody.slice(0, 5000),
            subject: subject?.slice(0, 500) || null,
            feedback: "sent",
          });
        } catch (styleErr) {
          console.warn("[automation-executor] Style capture failed (non-blocking):", styleErr);
        }

        // --- POST-SEND STATE UPDATE ---
        const postUpdate: Record<string, unknown> = {
          needs_action: false,
          eligible_at: null,
          last_outbound_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
        };

        // Load structured campaign for delay resolution
        let postSendCampaign = structuredCampaign;
        if (!postSendCampaign) {
          try { postSendCampaign = await loadCampaignForLead(lead.id, supabase); } catch (_) {}
        }

        if (aiTask === "nurture_email_single") {
          // Nurture: increment count and schedule next using campaign delay or lead cadence
          const nextCount = (lead.nurture_outbound_count || 0) + 1;
          const nextStepNumber = nextCount + 1;
          const nurtureDelay = resolveStepDelay(
            nextStepNumber,
            postSendCampaign?.steps?.map(s => ({ step_number: s.step_number, delay_days: s.delay_days, active: s.active })) || null,
            null, // no legacy intervals for nurture — use lead cadence as fallback below
          );
          // If no structured step found, fall back to lead-level nurture cadence
          const fallbackDays = lead.nurture_cadence === "weekly" ? 7
            : lead.nurture_cadence === "monthly" ? 30 : 14;
          const delayDays = nurtureDelay !== 2 ? nurtureDelay : fallbackDays; // 2 = hardcoded fallback means no step found
          const nextEligible = computeNextEligibleAt(delayDays, lead.id, `send_nurture_${nextCount + 1}`, execSettings);

          Object.assign(postUpdate, {
            nurture_outbound_count: nextCount,
            last_nurture_outbound_at: new Date().toISOString(),
            next_action_key: `send_nurture_${nextCount + 1}`,
            next_action_label: `Nurture email #${nextCount + 1}`,
            needs_action: true,
            eligible_at: nextEligible.toISOString(),
            action_reason_code: "NURTURE_DUE",
          });
        } else if ([
          "pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup",
          "inbound_intro", "inbound_followup_1",
        ].includes(aiTask)) {
          // Outbound + inbound sequence: schedule next step using structured campaign
          // or legacy intervals. Inbound branch: inbound_intro → inbound_followup_1
          // → inbound_followup_2 → stop. Cold branch: intro → followup → followup → breakup.
          const NEXT_STEP: Record<string, { key: string; label: string; stepNum: number }> = {
            pre_email_1_intro: { key: "send_pre_2", label: "Step 2 of 4", stepNum: 2 },
            pre_email_2_followup: { key: "send_pre_3", label: "Step 3 of 4", stepNum: 3 },
            pre_email_3_followup: { key: "send_pre_4", label: "Step 4 of 4", stepNum: 4 },
            inbound_intro: { key: "send_pre_2", label: "Step 2 of 3", stepNum: 2 },
            inbound_followup_1: { key: "send_pre_3", label: "Step 3 of 3", stepNum: 3 },
          };
          const nextStep = NEXT_STEP[aiTask];
          if (nextStep) {
            // Resolve delay: structured campaign > legacy intervals > 2-day fallback
            const legacyIntervals = postSendCampaign ? null : [0, 2, 4, 7]; // only used if no campaign
            const delayDays = resolveStepDelay(
              nextStep.stepNum,
              postSendCampaign?.steps?.map(s => ({ step_number: s.step_number, delay_days: s.delay_days, active: s.active })) || null,
              legacyIntervals,
            );
            const nextEligible = computeNextEligibleAt(delayDays, lead.id, nextStep.key, execSettings);

            Object.assign(postUpdate, {
              next_action_key: nextStep.key,
              next_action_label: nextStep.label,
              needs_action: true,
              eligible_at: nextEligible.toISOString(),
              action_reason_code: "FOLLOWUP_DUE",
            });
          }
        } else if (aiTask === "pre_email_4_breakup" || aiTask === "inbound_followup_2") {
          // Breakup or end of inbound 3-step sequence: explicitly clear sequence fields — no next step.
          //
          // Unit C dependency: the NEXT_STEP map above stops at step 4. A structured
          // campaign with more than 4 active steps therefore stops here today — the
          // resolver supports steps 5–9 (Unit B) but executor SCHEDULING for them is
          // Unit C (enrollment + sending). This cannot happen via Unit A/B (drafts are
          // loader-gated and there is no activation path yet); the warn below makes the
          // truncation loud rather than silent if a >4-step campaign is ever activated
          // before Unit C wires the advance map.
          const extraSteps = postSendCampaign?.steps?.filter((s) => s.active && s.step_number > 4).length ?? 0;
          if (extraSteps > 0) {
            console.warn(
              `[automation-executor] Campaign ${postSendCampaign?.id} (lead ${lead.id}) has ${extraSteps} active step(s) beyond step 4, but executor scheduling for steps 5–9 is not wired yet (Unit C). Cadence stops at step 4.`,
            );
          }
          Object.assign(postUpdate, {
            next_action_key: null,
            next_action_label: null,
            action_reason_code: null,
          });
        }

        await supabase.from("leads").update(postUpdate).eq("id", lead.id);
        console.log(`[automation-executor] Post-send state updated for lead ${lead.id}:`, JSON.stringify(postUpdate));

        // Update deal memory with outbound info
        try {
          const { data: wsInfo } = await supabase.from("leads").select("workspace_id").eq("id", lead.id).single();
          if (wsInfo?.workspace_id) {
            const mem = await loadDealMemory(supabase, lead.id, wsInfo.workspace_id);
            const updated = updateFromOutboundLite(mem, draftBody, subject);
            await saveDealMemory(supabase, updated);
          }
        } catch (memErr) {
          console.error(`[automation-executor] Deal memory update failed for lead ${lead.id}:`, memErr);
        }

        sentLeads.push({ leadId: lead.id, leadName: lead.name, subject });
        processed++;
        // Increment daily send counter for this owner
        dailySendCounts.set(lead.owner_user_id, (dailySendCounts.get(lead.owner_user_id) ?? 0) + 1);

        // ── INTER-SEND STAGGER ──────────────────────────────
        // Delay 30–90 seconds between sends to avoid mailbox
        // flagging from rapid-fire outbound bursts.
        if (processed < eligibleLeads.length) {
          const staggerMs = 30_000 + Math.floor(Math.random() * 60_000); // 30–90s
          console.log(`[automation-executor] Stagger delay: ${Math.round(staggerMs / 1000)}s before next send`);
          await new Promise(r => setTimeout(r, staggerMs));
        }
      } catch (leadErr) {
        console.error(`[automation-executor] Error processing lead ${lead.id}:`, leadErr);
        logEntry.status = "failed";
        logEntry.error_message = leadErr instanceof Error ? leadErr.message : "Unknown error";
        logEntry.completed_at = new Date().toISOString();
        await supabase.from("automation_log").insert(logEntry);
        // Retry: push eligible_at forward 15 min
        await supabase.from("leads").update({
          eligible_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        }).eq("id", lead.id);
        errors.push(`Lead ${lead.id}: ${leadErr instanceof Error ? leadErr.message : "Unknown error"}`);
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // COLD OUTREACH — AUTOMATIC email touches (Outreach Unit C, PR 2)
    //
    // ADDITIVE + SELF-CONTAINED. The legacy loop above is byte-unchanged: cold
    // leads never carry `automation_mode`, so the legacy candidate query never
    // sees them. Here we query due AUTOMATIC-mode cold email touches DIRECTLY and
    // send them through the SAME guardrail engine + provider path. Key safety:
    //   • Ordering: a touch is processed ONLY when its step_number ==
    //     enrollment.current_step_number + 1, so touches can't fire out of order
    //     even though all rows are pre-created.
    //   • No double-send: the per-touch CLAIM (action_key = cold_touch_<id>) on
    //     the existing automation_log unique index is the single guard; a
    //     duplicate insert (23505) means another run already claimed it → skip.
    //   • No stall: on send failure the touch is LEFT scheduled (no state change)
    //     and retries next run; advance happens ONLY on a confirmed send.
    // REVIEW-mode and manual touches are NOT handled here — the scheduler surfaces
    // those as Queue cards (this branch only fires when the campaign is automatic
    // AND the workspace gate + timezone + postal address are all set).
    //
    // SCOPING: cold AUTOMATIC sends are a cron/internal background concern. Only a
    // PRIVILEGED caller (X-Internal-Secret / service-role, i.e. the cron dispatch)
    // runs this pass. User-JWT entry points (automation-check, NurturePreviewCard)
    // must NOT trigger cold sends — the cold query is service-role + unscoped, so
    // letting a user call it would send across other owners/workspaces.
    // ════════════════════════════════════════════════════════════════════════
    if (privileged) try {
      const internalSecret = Deno.env.get("INTERNAL_API_SECRET") ?? "";
      const unsubSecret = getUnsubscribeSecret();
      const { data: coldDue } = await supabase
        .from("campaign_touch")
        .select("id, enrollment_id, campaign_id, lead_id, step_number, eligible_at")
        .eq("channel", "email")
        .eq("status", "scheduled")
        .lte("eligible_at", new Date().toISOString())
        .order("eligible_at", { ascending: true })
        .limit(50);

      for (const touch of (coldDue || [])) {
        // Honor the SAME per-run send cap as the legacy loop — cold sends count
        // toward MAX_SENDS_PER_RUN so one tick can't blow past the throttle.
        if (processed >= maxSendsPerRun) {
          console.log(`[automation-executor:cold] MAX_SENDS_PER_RUN reached (${maxSendsPerRun}), stopping cold pass`);
          break;
        }
        try {
          // Re-check the touch FRESH (the batch snapshot can go stale within this
          // run: sending an earlier step re-anchors the next step's eligible_at to
          // the future, so this guards against bunching two sends for one lead in
          // one run, and against a touch a concurrent run already advanced).
          const { data: freshTouch } = await supabase.from("campaign_touch")
            .select("status, eligible_at").eq("id", touch.id).maybeSingle();
          if (!freshTouch || freshTouch.status !== "scheduled") continue;
          if (!freshTouch.eligible_at || new Date(freshTouch.eligible_at) > new Date()) continue;

          const { data: enr } = await supabase.from("campaign_enrollment")
            .select("id, status, current_step_number, started_at").eq("id", touch.enrollment_id).maybeSingle();
          if (!enr || !["scheduled", "active"].includes(enr.status)) continue;
          if (touch.step_number !== (enr.current_step_number ?? 0) + 1) continue; // not next-in-line

          const { data: camp } = await supabase.from("campaigns")
            .select("id, status, send_mode, workspace_id").eq("id", touch.campaign_id).maybeSingle();
          if (!camp || camp.status !== "active" || camp.send_mode !== "automatic") continue;

          // Gate: cold auto-send on + timezone set + postal address present. Else
          // it's not auto-sendable — the scheduler surfaces it for review instead.
          const { data: ws } = await supabase.from("workspaces")
            .select("timezone, cold_outreach_postal_address").eq("id", camp.workspace_id).maybeSingle();
          const { data: autoSet } = await supabase.from("workspace_automation_settings")
            .select("cold_auto_send_enabled").eq("workspace_id", camp.workspace_id).maybeSingle();
          const postal = (ws?.cold_outreach_postal_address || "").trim();
          if (!autoSet?.cold_auto_send_enabled || !ws?.timezone || !postal) continue;

          const { data: lead } = await supabase.from("leads")
            .select("id, name, email, owner_user_id, workspace_id, industry, unsubscribed, last_inbound_at, last_outbound_at, created_at, status")
            .eq("id", touch.lead_id).maybeSingle();
          if (!lead || lead.unsubscribed || !lead.email) continue;
          if (!["active", "new"].includes(lead.status)) continue;

          // Reply bridge: a reply since starting pulls the lead out of the cold cadence.
          if (lead.last_inbound_at && enr.started_at && new Date(lead.last_inbound_at) > new Date(enr.started_at)) {
            await supabase.from("campaign_enrollment").update({ status: "replied" }).eq("id", enr.id);
            continue;
          }

          // 24h new-lead cooldown (Unit 0): never blast a brand-new address.
          if (lead.created_at && (Date.now() - new Date(lead.created_at).getTime()) < 24 * 60 * 60 * 1000) continue;

          const exec = await loadExecutionSettings(lead.owner_user_id, supabase);

          // Reuse the SAME guardrail engine as the legacy path.
          if (!checkSendWindow(exec).allowed) continue;                                   // send window / business hours
          if (!checkMinGap(lead.last_outbound_at, exec.guardrails.min_gap_hours_between_emails).allowed) continue;
          if (!(await checkPerLeadCaps(lead.id, exec.guardrails, supabase)).allowed) continue;

          // Per-mailbox daily cap (shared across ALL automation — oldest-due first).
          const dailyCap = await getDailyCapForOwner(lead.owner_user_id);
          if ((await getDailySendCount(lead.owner_user_id)) >= dailyCap) continue;

          // Fail-closed floor: unsubscribed + workspace do-not-contact list.
          const floor = await coldSendFloor(supabase, lead.id, lead.workspace_id);
          if (!floor.ok) {
            await supabase.from("campaign_enrollment").update({ status: "stopped" }).eq("id", enr.id);
            continue;
          }

          // Sender-mismatch guard: require a connected mail_accounts row; never
          // fall back to legacy gmail_connections (the wrong-address failure mode).
          const { data: mailAcct } = await supabase.from("mail_accounts")
            .select("id, provider").eq("workspace_id", lead.workspace_id).eq("status", "connected")
            .order("is_default", { ascending: false }).limit(1).maybeSingle();
          if (!mailAcct) continue;

          const firstName = (lead.name || "").split(" ")[0] || "there";
          const content = await resolveTouchContent(supabase, camp.id, touch.step_number, lead.industry, firstName);
          if (!content) {
            console.warn(`[automation-executor:cold] no content for campaign ${camp.id} step ${touch.step_number} — skipping touch ${touch.id}`);
            continue;
          }

          // Unsubscribe link (signed token). Fail closed if the secret is unset.
          if (!unsubSecret) { console.error("[automation-executor:cold] UNSUBSCRIBE_TOKEN_SECRET unset — cannot send (fail closed)"); continue; }
          const token = await signUnsubscribeToken(
            { lid: lead.id, wid: lead.workspace_id, cid: camp.id, iat: Math.floor(Date.now() / 1000) }, unsubSecret);
          const unsubscribeUrl = buildUnsubscribeUrl(supabaseUrl, token);

          // Per-touch CLAIM — the single double-send guard.
          const actionKey = `cold_touch_${touch.id}`;
          // Column set matches the legacy claim exactly (no workspace_id — that
          // column is not written to automation_log in the legacy path either).
          const claimRow: Record<string, unknown> = {
            lead_id: lead.id,
            owner_user_id: lead.owner_user_id,
            action_key: actionKey,
            status: "claiming",
            claim_date: new Date().toISOString().slice(0, 10),
            claimed_at: new Date().toISOString(),
            claim_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            subject: content.subject,
            mail_account_id: mailAcct.id,
          };
          const { data: claim, error: claimErr } = await supabase.from("automation_log").insert(claimRow).select("id").single();
          if (claimErr || !claim) continue; // 23505 → already claimed by a concurrent run; no double-send

          const sendRes = await sendColdEmailTouch({
            supabase, supabaseUrl, serviceKey: supabaseServiceKey, internalSecret,
            lead: { id: lead.id, email: lead.email, owner_user_id: lead.owner_user_id },
            mailProvider: mailAcct.provider as "gmail" | "outlook", mailAccountId: mailAcct.id,
            subject: content.subject, body: content.body, unsubscribeUrl, postalAddress: postal,
          });

          if (!sendRes.ok) {
            await supabase.from("automation_log").update({
              status: "failed", error_message: String(sendRes.reason || "send failed").slice(0, 200), completed_at: new Date().toISOString(),
            }).eq("id", claim.id);
            continue; // touch LEFT scheduled → retries next run (no stall, no advance)
          }

          await supabase.from("automation_log").update({
            status: "sent", gmail_message_id: sendRes.messageId ?? null, completed_at: new Date().toISOString(),
          }).eq("id", claim.id);
          await advanceColdEnrollment(supabase, exec, touch, "sent", { automationLogId: claim.id });
          dailySendCounts.set(lead.owner_user_id, (dailySendCounts.get(lead.owner_user_id) ?? 0) + 1);
          processed++;
          sentLeads.push({ leadId: lead.id, leadName: lead.name, subject: content.subject });
          console.log(`[automation-executor:cold] sent cold touch ${touch.id} (step ${touch.step_number}) for lead ${lead.id}`);
        } catch (touchErr) {
          console.error(`[automation-executor:cold] error on touch ${touch.id}:`, touchErr);
        }
      }
    } catch (coldErr) {
      console.error("[automation-executor:cold] section error:", coldErr);
    }

    return new Response(JSON.stringify({
      ok: true,
      processed,
      skipped,
      sentLeads,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[automation-executor] Fatal error:", err);
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
