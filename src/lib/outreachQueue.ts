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

export type OutreachChannel = "email" | "voice" | "sms" | "whatsapp" | "linkedin";

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
}

// Keep the surfaced list workable; excess waits for the next render.
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

  const { data: touches } = await supabase
    .from("campaign_touch" as any)
    .select("id, campaign_id, lead_id, step_number, channel, eligible_at")
    .eq("status", "queued")
    .in("campaign_id", activeIds)
    .lte("eligible_at", nowIso)
    .order("eligible_at", { ascending: true })
    .limit(OUTREACH_SURFACE_CAP);
  const rows = (touches || []) as any[];
  if (rows.length === 0) return [];

  const leadIds = [...new Set(rows.map((t) => t.lead_id))];
  const campaignIds = [...new Set(rows.map((t) => t.campaign_id))];

  const [{ data: leads }, { data: content }] = await Promise.all([
    supabase.from("leads").select("id, name, company, email, phone, linkedin_url, whatsapp_number, industry").in("id", leadIds),
    supabase.from("campaign_step_content" as any).select("campaign_id, step_number, variant_group, subject, body, sms_text, talking_points, voicemail_script").in("campaign_id", campaignIds),
  ]);

  const leadMap = new Map((leads || []).map((l: any) => [l.id, l]));
  // content keyed by `${campaign}|${step}|${variant ?? ""}`
  const contentMap = new Map<string, any>();
  for (const c of (content || []) as any[]) {
    contentMap.set(`${c.campaign_id}|${c.step_number}|${c.variant_group ?? ""}`, c);
  }

  const resolveContent = (campaignId: string, step: number, industry: string | null) => {
    const variant = (industry || "").trim();
    return (
      (variant && contentMap.get(`${campaignId}|${step}|${variant}`)) ||
      contentMap.get(`${campaignId}|${step}|`) ||
      null
    );
  };

  // Touches are already constrained to active campaigns by the query above (paused
  // outreaches never surface cards; the action endpoint also refuses to advance them).
  //
  // Drop touches whose LEAD row didn't come back: leads are RLS-scoped to the owner
  // (or a workspace admin), so a coworker's lead is invisible to this user even though
  // their campaign_touch row may be readable. Surfacing such a touch would render a
  // blank "—" card with no contact handles that the action endpoint would 403 anyway
  // (it enforces the same owner-or-admin gate). Only show cards the rep can actually act on.
  return rows
    .filter((t) => leadMap.has(t.lead_id))
    .map((t): OutreachTouch => {
    const lead = leadMap.get(t.lead_id) || {};
    const first = String(lead.name || "").split(" ")[0] || "there";
    const c = resolveContent(t.campaign_id, t.step_number, lead.industry);
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
      body: interpolateName(c?.body ?? null, first),
      smsText: interpolateName(c?.sms_text ?? null, first),
      talkingPoints: interpolateName(c?.talking_points ?? null, first),
      voicemailScript: interpolateName(c?.voicemail_script ?? null, first),
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
