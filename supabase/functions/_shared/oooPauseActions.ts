/**
 * Shared lead-pause helpers for OOO auto-replies and human "defer / reconnect later"
 * signals. Centralizes the lead UPDATE + system_note pattern that was previously
 * duplicated across gmail-sync, gmail-bulk-sync, outlook-sync, and outlook-webhook.
 *
 * IMPORTANT: These helpers ONLY pause an existing automation / clear pending action
 * fields. They never set automation_mode, never schedule outbound sends, and never
 * bypass the consent gate. They are safe to call regardless of automation_mode.
 */

import { createCanonicalInteraction } from "./canonicalInteraction.ts";
import {
  type DeferResult,
  getOOOEligibleAt,
  type OOOResult,
} from "./oooDetection.ts";

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface ApplyOOOArgs {
  supabase: SupabaseClient;
  leadId: string;
  workspaceId: string | null;
  leadName?: string | null;
  oooResult: OOOResult;
  occurredAt: string;
  gmailMessageId?: string | null;
  gmailThreadId?: string | null;
  logPrefix?: string;
}

/**
 * Apply OOO pause: set ooo_until, clear pending action, log a system_note.
 * Returns true when an OOO was detected & applied.
 */
export async function applyOOOPause(args: ApplyOOOArgs): Promise<boolean> {
  const { supabase, leadId, workspaceId, leadName, oooResult, occurredAt } = args;
  if (!oooResult.isOOO) return false;

  const eligibleAt = getOOOEligibleAt(oooResult.returnDate);
  const returnDateStr = oooResult.returnDate
    ? oooResult.returnDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : "approximately 7 days";
  const who = leadName || "Lead";
  const prefix = args.logPrefix || "[ooo-pause]";

  console.log(
    `${prefix} Lead ${leadId}: OOO auto-reply detected (confidence: ${oooResult.confidence}). ` +
      `Return: ${returnDateStr}. Pausing until ${eligibleAt}`,
  );

  await supabase.from("leads").update({
    ooo_until: oooResult.returnDate ? oooResult.returnDate.toISOString() : eligibleAt,
    eligible_at: eligibleAt,
    needs_action: false,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
  }).eq("id", leadId);

  await createCanonicalInteraction(supabase, {
    lead_id: leadId,
    type: "system_note",
    source: "automation",
    body_text:
      `📵 OOO auto-reply detected (${oooResult.confidence} signal). ${who} is out of office — ` +
      `returning ${returnDateStr}. Automation paused until then.`,
    occurred_at: occurredAt,
    gmail_message_id: args.gmailMessageId ?? null,
    gmail_thread_id: args.gmailThreadId ?? null,
    workspace_id: workspaceId,
    provider: "automation",
  });

  return true;
}

interface ApplyDeferArgs {
  supabase: SupabaseClient;
  leadId: string;
  workspaceId: string | null;
  deferResult: DeferResult;
  logPrefix?: string;
}

/**
 * Apply defer / "reconnect later" pause: set ooo_until + reconnect note,
 * pause nurture, append context to personal_notes, log a system_note.
 * Returns true when a defer signal with a parsable date was detected & applied.
 */
export async function applyDeferPause(args: ApplyDeferArgs): Promise<boolean> {
  const { supabase, leadId, workspaceId, deferResult } = args;
  if (!deferResult.isDefer || !deferResult.reconnectDate) return false;

  const reconnectDateStr = deferResult.reconnectDate.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
  const eligibleAt = deferResult.reconnectDate.toISOString();
  const reasonSnippet = (deferResult.reason || "Lead requested to reconnect later.").slice(0, 200);
  const prefix = args.logPrefix || "[defer-pause]";

  console.log(`${prefix} Lead ${leadId}: Defer signal detected. Reconnect: ${reconnectDateStr}`);

  await supabase.from("leads").update({
    ooo_until: eligibleAt,
    eligible_at: eligibleAt,
    needs_action: false,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
    next_step: `Reconnect on ${reconnectDateStr} — ${deferResult.rawMatch}`,
    next_step_reason: reasonSnippet,
    nurture_status: "paused",
    motion: "nurture",
  }).eq("id", leadId);

  // Append context to personal_notes (preserve existing).
  const { data: currentLead } = await supabase
    .from("leads")
    .select("personal_notes")
    .eq("id", leadId)
    .single();

  const newNote =
    `\n\n[Auto-detected ${new Date().toLocaleDateString()}] Lead asked to reconnect after ` +
    `${reconnectDateStr}. Context: "${reasonSnippet}". Follow up with relevant updates and ` +
    `reference their stated timeline.`;

  await supabase.from("leads").update({
    personal_notes: (currentLead?.personal_notes || "") + newNote,
  }).eq("id", leadId);

  await createCanonicalInteraction(supabase, {
    lead_id: leadId,
    type: "system_note",
    source: "automation",
    body_text:
      `📅 Reconnect reminder set for ${reconnectDateStr}. Lead indicated: ` +
      `"${deferResult.rawMatch}". Automation paused until then.`,
    occurred_at: new Date().toISOString(),
    workspace_id: workspaceId,
    provider: "automation",
  });

  return true;
}
