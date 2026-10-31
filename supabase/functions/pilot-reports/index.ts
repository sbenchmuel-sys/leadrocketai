// ============================================================================
// pilot-reports — client pilot emails (cron every 15 min via cron-dispatcher).
//
// For each enabled pilot_report_settings row:
// Everything is scoped to rep_user_ids (the pilot rep's own leads and calls); a
// row with no reps yet is skipped.
//   1. Hot-reply alerts: inbound emails whose AI intent is a buying signal and
//      that haven't been alerted yet → one email listing them. "Alerted" is
//      recorded in pilot_report_alerts_sent BEFORE sending (insert-wins), so two
//      overlapping runs can't double-alert; a failed send is logged, not retried.
//   2. Monday recap: when weeklyDue() (Monday ≥ 08:00 workspace time, once a
//      week) → pilot_report() for the last 7 days + the whole pilot → email.
//
// preview_only=true sends ONLY to preview_recipients, with a "Preview" banner.
// Sends go out through outlook-send from the configured mailbox.
// ponytail: Outlook senders only (the founder's mailbox is Outlook); add a
// gmail-send branch if a pilot ever needs a Gmail sender.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import { buildAlertEmail, buildWeeklyEmail, type PilotReport, weeklyDue, weekNumber } from "../_shared/pilotReportEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const APP_URL = "https://www.drivepilot.app";
const POSITIVE = ["book_meeting", "calendar_accept", "meeting_confirmation", "pricing", "partnership"];
const DAY = 24 * 3600 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceKey);
  const now = new Date();
  const out: Record<string, unknown>[] = [];

  const send = async (s: any, subject: string, html: string) => {
    const to: string[] = s.preview_only ? s.preview_recipients : s.recipients;
    if (!to?.length) throw new Error("no recipients configured");
    const resp = await fetch(`${url}/functions/v1/outlook-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "X-Internal-Secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
      },
      // No leadId: a report is not a lead conversation, so nothing is recorded on any timeline.
      body: JSON.stringify({ mail_account_id: s.sender_mail_account_id, to, subject, bodyHtml: html, ownerUserId: s.sender_user_id }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || body?.ok === false) throw new Error(`outlook-send failed: ${resp.status} ${body?.error ?? ""}`);
  };

  const { data: settings, error } = await db.from("pilot_report_settings").select("*").eq("enabled", true);
  if (error) {
    console.error("[pilot-reports] settings load failed", error.message);
    return new Response(JSON.stringify({ ok: false }), { status: 500, headers: corsHeaders });
  }

  for (const s of settings ?? []) {
    const result: Record<string, unknown> = { workspace_id: s.workspace_id };
    const reps: string[] = s.rep_user_ids ?? [];
    if (!reps.length) { out.push({ ...result, skipped: "no rep_user_ids yet" }); continue; }
    try {
      // ── 1. Hot-reply alerts ──
      if (s.alerts_enabled) {
        const { data: hot } = await db
          .from("lead_timeline_items")
          .select("id, lead_id, intent, metadata_json, leads!inner(name, company, owner_user_id)")
          .eq("workspace_id", s.workspace_id)
          .in("leads.owner_user_id", reps)
          .eq("event_type", "email_inbound")
          .in("intent", POSITIVE)
          .gte("occurred_at", new Date(Math.max(now.getTime() - 7 * DAY, new Date(s.pilot_start).getTime())).toISOString())
          .limit(50);
        const ids = (hot ?? []).map((h: any) => h.id);
        if (ids.length) {
          // Claim: only rows THIS run inserts get alerted.
          const { data: claimed } = await db
            .from("pilot_report_alerts_sent")
            .upsert(ids.map((id: string) => ({ timeline_item_id: id, workspace_id: s.workspace_id })), { onConflict: "timeline_item_id", ignoreDuplicates: true })
            .select("timeline_item_id");
          const fresh = new Set((claimed ?? []).map((c: any) => c.timeline_item_id));
          const items = (hot ?? []).filter((h: any) => fresh.has(h.id)).map((h: any) => ({
            leadId: h.lead_id,
            lead: h.leads?.name ?? null,
            company: h.leads?.company ?? null,
            intent: h.intent,
            summary: h.metadata_json?.ai_summary ?? null,
          }));
          if (items.length) {
            const { subject, html } = buildAlertEmail(items, s.client_name, APP_URL);
            await send(s, subject, html);
            result.alerts = items.length;
          }
        }
      }

      // ── 2. Monday recap ──
      const { data: ws } = await db.from("workspaces").select("timezone").eq("id", s.workspace_id).maybeSingle();
      const tz = ws?.timezone || "America/New_York";
      if (s.weekly_enabled && weeklyDue(now, tz, s.last_weekly_sent_at ? new Date(s.last_weekly_sent_at) : null)) {
        const weekFrom = new Date(now.getTime() - 7 * DAY);
        const [{ data: week, error: e1 }, { data: total, error: e2 }, upcoming] = await Promise.all([
          db.rpc("pilot_report", { _workspace_id: s.workspace_id, _from: weekFrom.toISOString(), _to: now.toISOString(), _owner_ids: reps }),
          db.rpc("pilot_report", { _workspace_id: s.workspace_id, _from: new Date(s.pilot_start).toISOString(), _to: now.toISOString(), _owner_ids: reps }),
          db.from("campaign_touch")
            .select("channel, campaigns!inner(workspace_id, status), leads!inner(owner_user_id)")
            .eq("campaigns.workspace_id", s.workspace_id)
            .in("leads.owner_user_id", reps)
            .eq("campaigns.status", "active")
            .in("status", ["scheduled", "queued"])
            .lt("eligible_at", new Date(now.getTime() + 7 * DAY).toISOString()),
        ]);
        if (e1 || e2) throw new Error(`pilot_report failed: ${(e1 ?? e2)!.message}`);
        const count = (ch: string) => (upcoming.data ?? []).filter((t: any) => t.channel === ch).length;
        const { subject, html } = buildWeeklyEmail(week as PilotReport, total as PilotReport, {
          clientName: s.client_name,
          weekNumber: weekNumber(now, new Date(s.pilot_start)),
          totalWeeks: s.pilot_weeks,
          meetingsTarget: s.meetings_target,
          upcoming: { email: count("email"), linkedin: count("linkedin"), voice: count("voice") },
          appUrl: APP_URL,
          preview: s.preview_only,
        });
        // Claim the week first (conditional update: only one overlapping run wins), so the
        // client can never get two copies. A failed send then waits a week and shows in
        // the logs — better than spamming the client.
        let claim = db.from("pilot_report_settings").update({ last_weekly_sent_at: now.toISOString() }).eq("workspace_id", s.workspace_id);
        claim = s.last_weekly_sent_at ? claim.eq("last_weekly_sent_at", s.last_weekly_sent_at) : claim.is("last_weekly_sent_at", null);
        const { data: won } = await claim.select("workspace_id");
        if (won?.length) {
          await send(s, subject, html);
          result.weekly = "sent";
        }
      }
    } catch (err) {
      console.error(`[pilot-reports] workspace ${s.workspace_id}:`, err instanceof Error ? err.message : String(err));
      result.error = err instanceof Error ? err.message : String(err);
    }
    out.push(result);
  }

  return new Response(JSON.stringify({ ok: true, results: out }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
