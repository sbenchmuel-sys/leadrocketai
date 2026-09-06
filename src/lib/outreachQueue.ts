// ============================================================================
// Outreach queue (cold campaign touches) — client data layer (Unit C, PR 3)
//
// The "Outreach" tab of the Queue shows COLD campaign touches that are due for
// the rep (campaign_touch.status = 'queued'): review-mode emails to approve, and
// manual touches (call / SMS / WhatsApp / LinkedIn) the rep does from their own
// phone/apps. Kept SEPARATE from the reactive Replied / Follow-up lists so cold
// volume never floods them.
//
// Every send/advance goes through the outreach-touch-action edge function (which
// funnels into the shared sendColdEmailTouch / advanceColdEnrollment) — there is
// NO client-side send path. The list is capped per render so even a big book
// stays workable; excess waits its turn.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { resolveStepMeetingCta } from "@/lib/campaignResolver";
import { interpolateMergeFields } from "@/lib/mergeFieldInterpolate";

// Mirrors buildMeetingCtaLine in supabase/functions/_shared/meetingCtaLine.ts —
// keep the wording in sync so the review preview matches the live send byte for byte.
function meetingCtaLine(link: string): string {
  return `P.S. If it's easier, grab a time that works for you here: ${link}`;
}
export function appendMeetingCtaLocal(body: string | null, link: string | null): string | null {
  if (!body || !link) return body;
  if (body.includes(link)) return body; // idempotent — never double-append
  return `${body.trimEnd()}\n\n${meetingCtaLine(link)}`;
}

/**
 * The booking link to SHOW in a review preview for a touch (null = none).
 * Fail-closed, per-rep: email-only, only when the step is force_on, only the
 * CURRENT user's own link, and ONLY on a touch whose lead THEY own — so an admin
 * viewing a coworker's touch never sees (or sends) their own link on it.
 */
export function previewMeetingLink(args: {
  channel: string;
  leadOwnerUserId: string | null;
  currentUserId: string | null;
  myCalendarLink: string | null;
  stepFlag: boolean | null | undefined;
}): string | null {
  if (args.channel !== "email" || !args.myCalendarLink) return null;
  if (!args.currentUserId || args.leadOwnerUserId !== args.currentUserId) return null;
  return resolveStepMeetingCta(args.stepFlag) === "force_on" ? args.myCalendarLink : null;
}

export type OutreachChannel = "email" | "voice" | "sms" | "whatsapp" | "linkedin";

/** Subtype of a LinkedIn touch — drives URL + clipboard + toast on the card. */
export type LinkedinAction = "connect" | "react" | "message";

export interface OutreachTouch {
  id: string;
  campaignId: string;
  campaignName: string;
  leadId: string;
  leadName: string;
  company: string | null;
  channel: OutreachChannel;
  stepNumber: number;
  eligibleAt: string | null;
  // Contact handles for manual deep-links.
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  whatsappNumber: string | null;
  // Resolved, rep-reviewed content for this step (from campaign_step_content).
  subject: string | null;       // email
  body: string | null;          // email body / LinkedIn message
  smsText: string | null;       // sms / whatsapp prefilled message
  talkingPoints: string | null; // call
  voicemailScript: string | null;
  // LinkedIn-only: which kind of touch (connect/react/message), derived from the
  // step's step_type. Undefined for non-linkedin touches.
  linkedinAction?: LinkedinAction;
}

/** Map a step_type to a LinkedIn touch subtype. Mirrors touchLabel() in
 *  campaignDefaults.ts (intro → Connect, value_add → React, else → Message). */
export function linkedinActionFromStepType(stepType: string | null | undefined): LinkedinAction {
  if (stepType === "intro") return "connect";
  if (stepType === "value_add") return "react";
  return "message";
}


// How many due touches one page shows. The query is owner-scoped server-side
// (leads!inner), so this applies to the rep's OWN due touches — a busy shared
// workspace can't push their work past it. Beyond one page the rep pages through
// with "Show more"; the true total always comes back alongside (see fetchOutreachQueue),
// so the tab badge reads "312", never a silent "50".
export const OUTREACH_PAGE_SIZE = 50;

// Thin wrapper around the shared canonical-token interpolator. We keep the same
// signature the call-site already uses (string | null), but route ALL token
// substitution — {FirstName}, {Company}, {RepFirstName}, etc. — through the one
// helper so the preview matches the wire-side render exactly.
interface PreviewMergeCtx {
  firstName: string;
  lastName?: string | null;
  company?: string | null;
  industry?: string | null;
  repFirstName?: string | null;
}
function interpolate(s: string | null, ctx: PreviewMergeCtx): string | null {
  if (!s) return s;
  return interpolateMergeFields(s, ctx);
}

export interface OutreachQueuePage {
  touches: OutreachTouch[];
  /** Every due touch matching the query, NOT just the ones on this page. */
  total: number;
}

/**
 * Load the due cold touches for the Outreach tab, oldest-due first, with each
 * touch's resolved (industry-variant + name-interpolated) content attached so
 * the card's deep-links and review preview are ready without extra round-trips.
 *
 * `limit` is a GROWING window, not an offset page: "Show more" re-requests
 * 100/150/… from the top. ponytail: re-fetching the pages already on screen costs
 * one extra query at these sizes and buys us no append/merge/dedupe state, and no
 * stale-page drift when the scheduler queues a touch mid-session. Ceiling: a rep
 * paging into the thousands re-reads it all — swap to keyset paging on eligible_at
 * if that ever shows up.
 */
export async function fetchOutreachQueue(limit = OUTREACH_PAGE_SIZE): Promise<OutreachQueuePage> {
  const nowIso = new Date().toISOString();

  // Resolve ACTIVE campaigns FIRST (RLS scopes this to the rep's workspace), then
  // constrain the touch query to them BEFORE applying the page limit — so a
  // paused campaign's stale queued rows can't consume the page and hide active,
  // currently-due work that sits beyond the cap.
  const { data: activeCamps } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("status", "active");
  const campaignMap = new Map(((activeCamps || []) as any[]).map((c) => [c.id, c]));
  const activeIds = [...campaignMap.keys()];
  if (activeIds.length === 0) return { touches: [], total: 0 };

  // Scope the touch query to leads this rep can actually SEE by INNER-joining leads:
  // PostgREST applies the leads table's own RLS (owner-or-admin) to the embedded rows,
  // and `!inner` drops any touch whose lead is hidden BEFORE the order + cap run on the
  // server. This is correct regardless of campaign_touch's own RLS (workspace- vs
  // owner-scoped) — a busy shared workspace can't bury the rep's own due work behind a
  // page of coworkers' (hidden) touches, and there are no blank "—" cards. The lead's
  // card fields come back embedded, so no second round-trip.
  // `count: "exact"` rides along on the SAME request — PostgREST reports how many
  // rows matched BEFORE the limit, so the badge and "Show more" get the real total
  // without a second round-trip.
  const { data: touches, count } = await supabase
    .from("campaign_touch" as any)
    .select(
      "id, campaign_id, lead_id, step_number, channel, eligible_at, " +
        "leads!inner(id, name, company, email, phone, linkedin_url, whatsapp_number, industry, owner_user_id)",
      { count: "exact" },
    )
    .eq("status", "queued")
    .in("campaign_id", activeIds)
    .lte("eligible_at", nowIso)
    .order("eligible_at", { ascending: true })
    .limit(limit);
  const rows = (touches || []) as any[];
  const total = count ?? rows.length;
  if (rows.length === 0) return { touches: [], total };
  const leadOf = (t: any) => (Array.isArray(t.leads) ? t.leads[0] : t.leads) || {};

  const campaignIds = [...new Set(rows.map((t) => t.campaign_id))];
  const { data: content } = await supabase
    .from("campaign_step_content" as any)
    .select("campaign_id, step_number, variant_group, subject, body, sms_text, talking_points, voicemail_script")
    .in("campaign_id", campaignIds);
  // Resolve content to MATCH the server sender (resolveTouchContent in coldOutreach.ts):
  // the lead's industry variant (case-insensitive), then the General/NULL variant, else
  // NOTHING. The sender no longer falls back to an arbitrary first row — that could send
  // industry-specific copy to the wrong industry — so neither do we. A card with no
  // matching content renders as not-sendable (see OutreachCard) instead of previewing
  // copy the sender would refuse to send. Keys are lowercased so matching is
  // case-insensitive, mirroring the server.
  const contentMap = new Map<string, any>();
  for (const c of (content || []) as any[]) {
    const variantKey = String(c.variant_group ?? "").trim().toLowerCase();
    contentMap.set(`${c.campaign_id}|${c.step_number}|${variantKey}`, c);
  }

  const resolveContent = (campaignId: string, step: number, industry: string | null) => {
    const variant = (industry || "").trim().toLowerCase();
    return (
      (variant && contentMap.get(`${campaignId}|${step}|${variant}`)) ||
      contentMap.get(`${campaignId}|${step}|`) ||
      null
    );
  };

  // Always pull each due step's metadata — step_type (drives LinkedIn subtype
  // for ALL reps) plus include_meeting_cta (only used when the rep owns the
  // lead and has their own booking link). One query, used for both.
  const stepFlag = new Map<string, boolean | null>();
  const stepTypeMap = new Map<string, string | null>();
  {
    const { data: steps } = await supabase
      .from("campaign_steps" as any)
      .select("campaign_id, step_number, step_type, include_meeting_cta")
      .in("campaign_id", campaignIds)
      .is("variant_group", null);
    for (const s of (steps || []) as any[]) {
      const key = `${s.campaign_id}|${s.step_number}`;
      stepFlag.set(key, s.include_meeting_cta ?? null);
      stepTypeMap.set(key, s.step_type ?? null);
    }
  }

  const { data: authData } = await supabase.auth.getUser();
  const meId = authData?.user?.id ?? null;
  let myCalLink: string | null = null;
  if (meId) {
    const { data: prof } = await supabase
      .from("rep_profiles")
      .select("calendar_link")
      .eq("user_id", meId)
      .maybeSingle();
    myCalLink = ((prof as any)?.calendar_link ?? "").trim() || null;
  }
  const meetingLinkFor = (t: any, lead: any): string | null =>
    previewMeetingLink({
      channel: t.channel,
      leadOwnerUserId: lead.owner_user_id ?? null,
      currentUserId: meId,
      myCalendarLink: myCalLink,
      stepFlag: stepFlag.get(`${t.campaign_id}|${t.step_number}`) ?? null,
    });

  // Lead-owner → rep first name map for {RepFirstName}. The preview must use the
  // OWNER's name (the sender), not the viewer's, so a coworker reviewing the
  // queue still sees what the lead will actually receive.
  const ownerIds = [...new Set(rows.map((t) => leadOf(t).owner_user_id).filter(Boolean))] as string[];
  const ownerFirstName = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: reps } = await supabase
      .from("rep_profiles")
      .select("user_id, full_name")
      .in("user_id", ownerIds);
    for (const r of (reps || []) as any[]) {
      const first = String(r.full_name || "").trim().split(/\s+/)[0] || "";
      if (first) ownerFirstName.set(r.user_id, first);
    }
  }

  // `rows` is already (a) constrained to active campaigns, (b) owner-scoped via the
  // leads!inner join (no hidden-lead or blank-card rows, no buried work), and (c)
  // capped. Each row's lead is embedded.
  const mapped = rows.map((t): OutreachTouch => {
    const lead = leadOf(t);
    const firstName = String(lead.name || "").split(" ")[0] || "there";
    const lastName = String(lead.name || "").split(" ").slice(1).join(" ");
    const c = resolveContent(t.campaign_id, t.step_number, lead.industry);
    const stepType = stepTypeMap.get(`${t.campaign_id}|${t.step_number}`) ?? null;
    const mctx = {
      firstName,
      lastName,
      company: lead.company ?? null,
      industry: lead.industry ?? null,
      repFirstName: ownerFirstName.get(lead.owner_user_id) ?? null,
    };
    return {
      id: t.id,
      campaignId: t.campaign_id,
      campaignName: campaignMap.get(t.campaign_id)?.name || "Outreach",
      leadId: t.lead_id,
      leadName: lead.name || "—",
      company: lead.company ?? null,
      channel: t.channel,
      stepNumber: t.step_number,
      eligibleAt: t.eligible_at,
      email: lead.email ?? null,
      phone: lead.phone ?? null,
      linkedinUrl: lead.linkedin_url ?? null,
      whatsappNumber: lead.whatsapp_number ?? null,
      subject: interpolate(c?.subject ?? null, mctx),
      body: appendMeetingCtaLocal(interpolate(c?.body ?? null, mctx), meetingLinkFor(t, lead)),
      smsText: interpolate(c?.sms_text ?? null, mctx),
      talkingPoints: interpolate(c?.talking_points ?? null, mctx),
      voicemailScript: interpolate(c?.voicemail_script ?? null, mctx),
      linkedinAction: t.channel === "linkedin" ? linkedinActionFromStepType(stepType) : undefined,
    };
  });
  return { touches: mapped, total };
}


// ── Rep actions (all funnel through the edge function → shared helpers) ────────

type ActionResult = {
  ok: boolean;
  error?: string;
  /** Enrollment is gone/locked (replied / inactive / opted out) — don't restore the card. */
  terminal?: boolean;
};

async function invokeAction(body: Record<string, unknown>): Promise<ActionResult> {
  const { data, error } = await supabase.functions.invoke("outreach-touch-action", { body });
  if (error) {
    // `supabase.functions.invoke` throws away the response body on any non-2xx;
    // the edge function deliberately returns rich JSON at 400/403/404/409
    // (`{ ok:false, error:"...", replied?/inactive?/optedOut? }`). Pull it back
    // out so reps see the real reason instead of the generic wrapper string.
    let msg = error.message;
    let terminal = false;
    if (error instanceof FunctionsHttpError) {
      try {
        const parsed = await error.context.clone().json();
        if (parsed?.error) msg = String(parsed.error);
        if (parsed?.replied || parsed?.inactive || parsed?.optedOut) terminal = true;
      } catch {
        /* keep generic message if the body isn't JSON */
      }
    }
    // Mobile app-switch (LinkedIn / WhatsApp / etc.) can drop the Supabase session;
    // surface something the rep can actually act on.
    if (/JWT|token|Not authenticated|401|Unauthorized/i.test(msg)) {
      msg = "Your session expired — sign in again.";
    }
    return { ok: false, error: msg, terminal };
  }
  if (data && (data as any).ok === false) return { ok: false, error: (data as any).error };
  return { ok: true };
}

/** Review-mode "Send" — sends the (optionally rep-edited) email and advances. */
export function sendReviewEmail(touchId: string, subject?: string, body?: string): Promise<ActionResult> {
  return invokeAction({ action: "send_review_email", touchId, subject, body });
}

/** Manual "Sent it" — the rep sent via their own app; just advance the cadence. */
export function markTouchSent(touchId: string): Promise<ActionResult> {
  return invokeAction({ action: "mark_sent", touchId });
}

/** Skip this touch and advance. */
export function skipTouch(touchId: string): Promise<ActionResult> {
  return invokeAction({ action: "mark_skipped", touchId });
}

/** Snooze this touch — push its eligible_at forward N days, keep it queued. */
export function snoozeTouch(touchId: string, days: 3 | 5 | 7): Promise<ActionResult> {
  return invokeAction({ action: "snooze_touch", touchId, days });
}

/** Record a call outcome (shapes the next draft). Does not advance. */
export function setCallOutcome(touchId: string, outcome: "got_them" | "no_answer"): Promise<ActionResult> {
  return invokeAction({ action: "set_call_outcome", touchId, outcome });
}

// ── Campaign pause / stop (halts every touch for every enrolled lead) ─────────
// Both the scheduler and the executor gate on campaigns.status === 'active', so
// flipping it away from 'active' halts ALL cold sends + surfacing at once.

export async function pauseCampaign(campaignId: string): Promise<void> {
  const { error } = await supabase.from("campaigns").update({ status: "paused" } as any).eq("id", campaignId);
  if (error) throw new Error(error.message || "Couldn't pause the outreach");
}

export async function resumeCampaign(campaignId: string): Promise<void> {
  const { error } = await supabase.from("campaigns").update({ status: "active" } as any).eq("id", campaignId);
  if (error) throw new Error(error.message || "Couldn't resume the outreach");
}

/**
 * Launch a draft outreach — flips status from 'draft' to 'active'. Once active,
 * the campaign-touch-scheduler creates per-step touch rows for enrolled leads,
 * and fetchOutreachQueue surfaces due touches in the rep's Outreach tab.
 *
 * Caller is responsible for the safety check (at least one active step + at
 * least one campaign_step_content row); we still narrow the update to the
 * draft state so we can never silently re-activate a paused/completed campaign.
 */
export async function launchCampaign(campaignId: string): Promise<void> {
  const { error } = await supabase
    .from("campaigns")
    .update({ status: "active" } as any)
    .eq("id", campaignId)
    .eq("status", "draft");
  if (error) throw new Error(error.message || "Couldn't launch the outreach");
}
