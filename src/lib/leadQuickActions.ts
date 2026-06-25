// ============================================================================
// Lead quick-action availability (Lead Detail, Unit 4b)
//
// Decides which "reach out directly" buttons to show on the lead header, from the
// lead's existing contact details + consent. Pure + dependency-free so the
// hide-when-missing and opt-out rules are unit-tested. The header reuses the
// outreachDeepLinks builders (tel:/sms:/wa.me) to open the rep's OWN apps — no
// DrivePilot sender is involved. Call is handled separately (in-app
// ClickToCallButton) and is intentionally NOT part of this — Unit 4b adds only
// WhatsApp + SMS.
// ============================================================================

export interface LeadQuickActionInput {
  phone?: string | null;
  whatsapp_number?: string | null;
  /** Lead-level opt-out — when true, no manual messaging quick-actions are offered. */
  unsubscribed?: boolean | null;
  /** SMS consent — required for the Text action (mirrors channels.ts `smsOk`). */
  sms_opted_in?: boolean | null;
  /** WhatsApp consent — required for the WhatsApp action (WhatsApp policy). */
  wa_opted_in?: boolean | null;
}

export interface LeadQuickActions {
  /** Open the texting app to this number, or null to hide the SMS button. */
  sms: { phone: string } | null;
  /** Open WhatsApp to this number, or null to hide the WhatsApp button. */
  whatsapp: { number: string } | null;
}

/**
 * Which messaging quick-actions to show:
 *  - SMS: a phone number exists AND the lead has opted in to SMS AND isn't opted
 *    out. (Mirrors the app's existing SMS availability rule in channels.ts — a
 *    manual text still needs the lead's SMS consent.)
 *  - WhatsApp: a WhatsApp number exists (falls back to the phone number) AND the
 *    lead has opted in to WhatsApp AND isn't opted out.
 * Missing detail, missing consent, or opt-out → that action is null (button
 * hidden — never dead).
 */
export function resolveLeadQuickActions(lead: LeadQuickActionInput): LeadQuickActions {
  const optedOut = lead.unsubscribed === true;
  const phone = (lead.phone || "").trim();
  const waNumber = (lead.whatsapp_number || "").trim() || phone;
  return {
    sms: !optedOut && lead.sms_opted_in === true && phone ? { phone } : null,
    whatsapp: !optedOut && lead.wa_opted_in === true && waNumber ? { number: waNumber } : null,
  };
}
