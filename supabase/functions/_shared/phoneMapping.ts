// ============================================================
// Phone Number → Contact/Agent Mapping
// Resolves phone numbers to internal entities
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

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

  // Normalize numbers (strip whitespace)
  const from = fromNumber.trim();
  const to = toNumber.trim();

  // The "customer" number is from (inbound) or to (outbound)
  const customerNumber = direction === "inbound" ? from : to;

  try {
    // 1. Find workspace — deterministic resolution via call_settings or phone number match
    //    NEVER fall back to "first workspace" — that is a multi-tenant leak.
    const agentNumber = direction === "inbound" ? to : from;

    // Strategy A: Match via call_settings with a configured Twilio number
    const { data: settings } = await supabase
      .from("call_settings")
      .select("workspace_id, default_twilio_number")
      .not("default_twilio_number", "is", null);

    if (settings && settings.length > 0) {
      // Try exact match on the agent-side number
      const exactMatch = settings.find(
        (s: any) => s.default_twilio_number === agentNumber,
      );
      if (exactMatch) {
        result.workspaceId = exactMatch.workspace_id;
      } else if (settings.length === 1) {
        // Single workspace with call_settings — safe to use
        result.workspaceId = settings[0].workspace_id;
      }
    }

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

    // 3. Find lead by phone number
    const { data: leads } = await supabase
      .from("leads")
      .select("id")
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
