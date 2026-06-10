// ============================================================================
// Rep caller-ID resolution — the Twilio number a browser call dials FROM.
//
// Shared by every browser-call entry point (ClickToCallButton on Lead Detail,
// and the device-aware call action on the Outreach queue card) so the lookup
// lives in ONE place. Resolution order:
//   1. the rep's own number (rep_profiles.twilio_phone_number), else
//   2. the workspace default (call_settings.default_twilio_number).
// Returns null when neither is configured — callers fall back to a tel: link.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

/**
 * Resolve the caller ID for a browser call: the rep's own Twilio number, else
 * the workspace default. Returns null when calling isn't configured for this
 * rep/workspace (the caller should fall back to a native `tel:` dialer link).
 */
export async function fetchRepCallerNumber(): Promise<string | null> {
  // 1. Rep's own number.
  const { data: repProfile } = await supabase
    .from("rep_profiles")
    .select("twilio_phone_number")
    .limit(1)
    .maybeSingle();

  let repNumber = (repProfile as any)?.twilio_phone_number as string | null | undefined;

  // 2. Fall back to the workspace default.
  if (!repNumber) {
    const userId = (await supabase.auth.getUser()).data.user?.id ?? "";
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    if (membership?.workspace_id) {
      const { data: callSettings } = await supabase
        .from("call_settings")
        .select("default_twilio_number")
        .eq("workspace_id", membership.workspace_id)
        .maybeSingle();

      repNumber = (callSettings as any)?.default_twilio_number;
    }
  }

  return repNumber || null;
}
