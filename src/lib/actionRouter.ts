import type { CanonicalChannel } from "@/lib/channels";
import { getAvailableChannelsForLead } from "@/lib/channels";

// ── Intent vocabulary ─────────────────────────────────────────────────

export type ActionIntent =
  | "reply_in_inbox"
  | "send_email"
  | "send_whatsapp"
  | "send_sms"
  | "voice_followup"
  | "post_meeting_recap"
  | "start_nurture"
  | "review";

export type Priority = "P0" | "P1" | "P2";

export interface RoutedAction {
  intent: ActionIntent;
  label: string;
  description?: string;
  priority: Priority;
  recommendedChannel?: CanonicalChannel;
}

// ── Priority button labels ────────────────────────────────────────────

export const PRIORITY_LABELS: Record<Priority, string> = {
  P0: "Handle now",
  P1: "Do next",
  P2: "Open",
};

// ── Router ────────────────────────────────────────────────────────────

interface RouteInput {
  nextActionKey?: string | null;
  lastInboundCanonical?: CanonicalChannel;
}

function mapKeyToAction(key: string, lastInbound?: CanonicalChannel): RoutedAction {
  const k = (key || "").toLowerCase();

  // P0 — reply urgently
  if (k === "reply_now" || k === "whatsapp_reply" || k.startsWith("reply_")) {
    return {
      intent: "reply_in_inbox",
      label: "Reply in inbox",
      priority: "P0",
      recommendedChannel: lastInbound,
    };
  }

  // P1 — email
  if (k.startsWith("send_pre_") || k === "send_email" || k === "send_followup") {
    return {
      intent: "send_email",
      label: "Send email",
      priority: "P1",
      recommendedChannel: "email",
    };
  }

  // P1 — SMS
  if (k.startsWith("send_sms")) {
    return {
      intent: "send_sms",
      label: "Send SMS",
      priority: "P1",
      recommendedChannel: "sms",
    };
  }

  // P1 — voice
  if (k.startsWith("call_followup") || k === "voice_followup") {
    return {
      intent: "voice_followup",
      label: "Voice follow-up",
      priority: "P1",
      recommendedChannel: "voice",
    };
  }

  // P1 — post-meeting
  if (k === "generate_post_meeting_recap" || k.startsWith("post_meeting")) {
    return {
      intent: "post_meeting_recap",
      label: "Post-meeting recap",
      priority: "P1",
      recommendedChannel: "meeting",
    };
  }

  // P2 — nurture
  if (k.startsWith("send_nurture") || k === "start_nurture") {
    return {
      intent: "start_nurture",
      label: "Start nurture",
      priority: "P2",
    };
  }

  // Fallback
  return {
    intent: "review",
    label: "Review",
    priority: "P2",
  };
}

// ── Public API ─────────────────────────────────────────────────────────

interface LeadLike {
  next_action_key?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp_number?: string | null;
  wa_opted_in?: boolean;
  sms_opted_in?: boolean;
  country?: string | null;
}

interface WorkspaceLike {
  whatsapp_enabled?: boolean;
  sms_enabled?: boolean;
  voice_enabled?: boolean;
  meetings_enabled?: boolean;
}

export function routeLeadAction(
  lead: LeadLike,
  opts?: {
    lastInboundCanonical?: CanonicalChannel;
    workspace?: WorkspaceLike;
  },
): RoutedAction {
  const action = mapKeyToAction(lead.next_action_key ?? "", opts?.lastInboundCanonical);

  // If a channel is recommended, verify it's available; otherwise fall back
  if (action.recommendedChannel) {
    const available = getAvailableChannelsForLead({
      lead: {
        email: lead.email,
        phone: lead.phone,
        whatsapp_number: lead.whatsapp_number,
        wa_opted_in: lead.wa_opted_in,
        sms_opted_in: (lead as any).sms_opted_in,
        country: lead.country,
      },
      workspace: opts?.workspace ?? {},
      lastInboundCanonical: opts?.lastInboundCanonical,
    });

    const availableChannels = new Set(available.map((a) => a.channel));

    if (!availableChannels.has(action.recommendedChannel)) {
      // Fall back to first available, or drop recommendation entirely
      action.recommendedChannel = available.length > 0 ? available[0].channel : undefined;
    }
  }

  return action;
}

export function primaryButtonLabel(priority: Priority): string {
  return PRIORITY_LABELS[priority];
}
