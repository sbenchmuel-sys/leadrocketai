// ============================================================
// Phone Number → Contact/Agent Mapping
// Resolves phone numbers to internal entities
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

/**
 * Normalize a phone number for comparison: strip whitespace/dashes/parens and
 * force a leading `+`. Both sides of every number comparison in this file go
 * through it — a stored "+1 (415) 555-0123" and a Twilio "+14155550123" are the
 * same number and must match.
 */
export function normalizeE164(n: string): string {
  const stripped = (n ?? "").trim().replace(/[\s\-()]/g, "");
  return stripped.startsWith("+") ? stripped : "+" + stripped;
}

/** One `call_settings` row, as far as number matching is concerned. */
export interface WorkspaceNumberRow {
  workspace_id: string;
  default_twilio_number: string | null;
}

/**
 * Find the workspace whose configured Twilio number IS this number.
 * Pure and exported so the match rule has exactly one definition and one test.
 * Returns null when nothing matches — there is deliberately NO "if there is
 * only one row, use it" fallback (C1/9).
 */
export function matchWorkspaceByNumber(
  rows: readonly WorkspaceNumberRow[] | null | undefined,
  agentNumber: string,
): string | null {
  if (!rows || rows.length === 0) return null;
  const target = normalizeE164(agentNumber);
  const hit = rows.find(
    (r) => r.default_twilio_number && normalizeE164(r.default_twilio_number) === target,
  );
  return hit?.workspace_id ?? null;
}

/**
 * Resolve the workspace that owns a Twilio number, by normalized comparison.
 * Returns null when the number is not a configured workspace number.
 */
export async function resolveWorkspaceByAgentNumber(
  supabase: ReturnType<typeof createClient>,
  agentNumber: string,
): Promise<string | null> {
  const { data: settings } = await supabase
    .from("call_settings")
    .select("workspace_id, default_twilio_number")
    .not("default_twilio_number", "is", null);
  return matchWorkspaceByNumber(settings as WorkspaceNumberRow[] | null, agentNumber);
}

interface PhoneMappingResult {
  workspaceId: string | null;
  agentUserId: string | null;
  customerContactId: string | null;
  leadId: string | null;
}

/**
 * Resolve phone numbers to workspace, agent, contact, and lead.
 *
 * Strategy:
 *  - If toNumber matches a call_settings.webhook_base_url workspace config
 *    or we find a workspace via integrations, use that workspace.
 *  - If fromNumber or toNumber matches a contact_identity (type=phone),
 *    link customerContactId.
 *  - If a lead has a matching phone number, link leadId.
 */
export async function resolvePhoneMapping(
  supabase: ReturnType<typeof createClient>,
  fromNumber: string,
  toNumber: string,
  direction: "inbound" | "outbound",
): Promise<PhoneMappingResult> {
  const result: PhoneMappingResult = {
    workspaceId: null,
    agentUserId: null,
    customerContactId: null,
    leadId: null,
  };

  const from = normalizeE164(fromNumber);
  const to = normalizeE164(toNumber);

  // The "customer" number is from (inbound) or to (outbound)
  const customerNumber = direction === "inbound" ? from : to;

  try {
    // 1. Find workspace — deterministic resolution via call_settings or phone number match
    //    NEVER fall back to "first workspace" — that is a multi-tenant leak.
    const agentNumber = direction === "inbound" ? to : from;

    // Strategy A: Match via call_settings with a configured Twilio number.
    // NO "only one workspace configured, so use it" fallback. That was correct
    // at one tenant and a cross-tenant data leak at two (C1/9): a call on an
    // unrecognised number would be filed into someone else's workspace. Fail
    // closed — an unmapped number produces no session rather than a wrong one.
    result.workspaceId = await resolveWorkspaceByAgentNumber(supabase, agentNumber);

    if (!result.workspaceId) {
      logger.warn("phone_mapping_no_workspace", { from, to });
      return result;
    }

    // 2. Find contact by phone number in contact_identities
    const normalizedNumbers = [customerNumber];
    // Also try without leading + or with it
    if (customerNumber.startsWith("+")) {
      normalizedNumbers.push(customerNumber.slice(1));
    } else {
      normalizedNumbers.push("+" + customerNumber);
    }

    const { data: identities } = await supabase
      .from("contact_identities")
      .select("contact_id")
      .eq("workspace_id", result.workspaceId)
      .eq("type", "phone")
      .in("value", normalizedNumbers)
      .limit(1);

    if (identities && identities.length > 0) {
      result.customerContactId = identities[0].contact_id;
    }

    // 3. Find lead by phone number — always workspace-scoped. (The former
    //    unscoped `else` branch was unreachable and a second leak vector.)
    const { data: leads } = await supabase
      .from("leads")
      .select("id")
      .eq("workspace_id", result.workspaceId)
      .in("phone", normalizedNumbers)
      .limit(1);

    if (leads && leads.length > 0) {
      result.leadId = leads[0].id;
    }

    logger.info("phone_mapping_resolved", {
      from,
      to,
      direction,
      workspaceId: result.workspaceId,
      contactId: result.customerContactId,
      leadId: result.leadId,
    });
  } catch (err) {
    logger.error("phone_mapping_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
