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
import { resolveStepMeetingCta } from "@/lib/campaignResolver";

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


// Keep the surfaced list workable; excess waits for the next render. The query is
// owner-scoped server-side (leads!inner), so this cap applies to the rep's OWN due
// touches — a busy shared workspace can't push their work past it.
export const OUTREACH_SURFACE_CAP = 50;

function interpolateName(s: string | null, first: string): string | null {
  if (!s) return s;
  return s
    .replace(/\{first[_\s]*name\}/gi, first)
    .replace(/\[first[_\s]*name\]/gi, first)
    .replace(/\{name\}/gi, first)
    .replace(/\[name\]/gi, first);
}

/**
 * Load the due cold touches for the Outreach tab, oldest-due first, with each
 * touch's resolved (industry-variant + name-interpolated) content attached so
 * the card's deep-links and review preview are ready without extra round-trips.
 */
export async function fetchOutreachQueue(): Promise<OutreachTouch[]> {
  const nowIso = new Date().toISOString();

  // Resolve ACTIVE campaigns FIRST (RLS scopes this to the rep's workspace), then
  // constrain the touch query to them BEFORE applying OUTREACH_SURFACE_CAP — so a
  // paused campaign's stale queued rows can't consume the page and hide active,
  // currently-due work that sits beyond the cap.
  const { data: activeCamps } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("status", "active");
  const campaignMap = new Map(((activeCamps || []) as any[]).map((c) => [c.id, c]));
  const activeIds = [...campaignMap.keys()];
  if (activeIds.length === 0) return [];

  // Scope the touch query to leads this rep can actually SEE by INNER-joining leads:
  // PostgREST applies the leads table's own RLS (owner-or-admin) to the embedded rows,
  // and `!inner` drops any touch whose lead is hidden BEFORE the order + cap run on the
  // server. This is correct regardless of campaign_touch's own RLS (workspace- vs
  // owner-scoped) — a busy shared workspace can't bury the rep's own due work behind a
  // page of coworkers' (hidden) touches, and there are no blank "—" cards. The lead's
  // card fields come back embedded, so no second round-trip.
  const { data: touches } = await supabase
    .from("campaign_touch" as any)
    .select(
      "id, campaign_id, lead_id, step_number, channel, eligible_at, " +
        "leads!inner(id, name, company, email, phone, linkedin_url, whatsapp_number, industry, owner_user_id)",
    )
    .eq("status", "queued")
    .in("campaign_id", activeIds)
    .lte("eligible_at", nowIso)
    .order("eligible_at", { ascending: true })
    .limit(OUTREACH_SURFACE_CAP);
  const rows = (touches || []) as any[];
  if (rows.length === 0) return [];
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

  // `rows` is already (a) constrained to active campaigns, (b) owner-scoped via the
  // leads!inner join (no hidden-lead or blank-card rows, no buried work), and (c)
  // capped. Each row's lead is embedded.
  return rows.map((t): OutreachTouch => {
    const lead = leadOf(t);
    const first = String(lead.name || "").split(" ")[0] || "there";
    const c = resolveContent(t.campaign_id, t.step_number, lead.industry);
    const stepType = stepTypeMap.get(`${t.campaign_id}|${t.step_number}`) ?? null;
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
      subject: interpolateName(c?.subject ?? null, first),
      body: appendMeetingCtaLocal(interpolateName(c?.body ?? null, first), meetingLinkFor(t, lead)),
      smsText: interpolateName(c?.sms_text ?? null, first),
      talkingPoints: interpolateName(c?.talking_points ?? null, first),
      voicemailScript: interpolateName(c?.voicemail_script ?? null, first),
      linkedinAction: t.channel === "linkedin" ? linkedinActionFromStepType(stepType) : undefined,
    };
  });
}


// ── Rep actions (all funnel through the edge function → shared helpers) ────────

type ActionResult = { ok: boolean; error?: string };

async function invokeAction(body: Record<string, unknown>): Promise<ActionResult> {
  const { data, error } = await supabase.functions.invoke("outreach-touch-action", { body });
  if (error) return { ok: false, error: error.message };
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
