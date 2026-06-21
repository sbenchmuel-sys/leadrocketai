import { Mail, MessageSquare, Phone, PhoneCall, Calendar, Linkedin, type LucideIcon } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────

export type ProviderChannel =
  | "gmail"
  | "outlook"
  | "whatsapp"
  | "sms"
  | "voice"
  | "meeting"
  | "linkedin"
  | (string & {});

export type CanonicalChannel = "email" | "whatsapp" | "sms" | "voice" | "meeting" | "linkedin";

// ── Mappers ────────────────────────────────────────────────────────────

const PROVIDER_MAP: Record<string, CanonicalChannel> = {
  gmail: "email",
  outlook: "email",
  whatsapp: "whatsapp",
  sms: "sms",
  voice: "voice",
  meeting: "meeting",
  linkedin: "linkedin",
};

export function providerToCanonical(provider: ProviderChannel | null | undefined): CanonicalChannel {
  if (!provider) return "email";
  return PROVIDER_MAP[provider.toLowerCase()] ?? "email";
}

const LABELS: Record<CanonicalChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
  voice: "Voice",
  meeting: "Meeting",
  linkedin: "LinkedIn",
};

export function canonicalLabel(ch: CanonicalChannel): string {
  return LABELS[ch] ?? "Email";
}

const ICONS: Record<CanonicalChannel, LucideIcon> = {
  email: Mail,
  whatsapp: MessageSquare,
  sms: Phone,
  voice: PhoneCall,
  meeting: Calendar,
  linkedin: Linkedin,
};

export function canonicalIcon(ch: CanonicalChannel): LucideIcon {
  return ICONS[ch] ?? Mail;
}

// ── Channel colour tokens (HSL CSS vars) ───────────────────────────────

const CHANNEL_COLORS: Record<CanonicalChannel, { bg: string; fg: string }> = {
  email:    { bg: "hsl(var(--info)/0.1)",    fg: "hsl(var(--info))" },
  whatsapp: { bg: "hsl(var(--success)/0.1)", fg: "hsl(var(--success))" },
  sms:      { bg: "hsl(var(--warning)/0.1)", fg: "hsl(var(--warning))" },
  voice:    { bg: "hsl(var(--accent))",      fg: "hsl(var(--accent-foreground))" },
  meeting:  { bg: "hsl(var(--muted))",       fg: "hsl(var(--muted-foreground))" },
  // LinkedIn brand blue, expressed through the info token so it tracks the theme.
  linkedin: { bg: "hsl(var(--info)/0.12)",   fg: "hsl(var(--info))" },
};

export function channelColors(ch: CanonicalChannel) {
  return CHANNEL_COLORS[ch] ?? CHANNEL_COLORS.email;
}

// ── Availability guard ─────────────────────────────────────────────────

type LeadChannelInfo = {
  email?: string | null;
  phone?: string | null;
  whatsapp_number?: string | null;
  wa_opted_in?: boolean;
  sms_opted_in?: boolean;
  country?: string | null;
};

type WorkspaceChannelInfo = {
  whatsapp_enabled?: boolean;
  sms_enabled?: boolean;
  voice_enabled?: boolean;
  meetings_enabled?: boolean;
};

export type AvailableChannel = {
  channel: CanonicalChannel;
  reason?: string;
};

const NA_COUNTRIES = new Set(["US", "CA"]);

export function getAvailableChannelsForLead({
  lead,
  workspace,
  lastInboundCanonical,
}: {
  lead: LeadChannelInfo;
  workspace: WorkspaceChannelInfo;
  lastInboundCanonical?: CanonicalChannel;
}): AvailableChannel[] {
  const available: AvailableChannel[] = [];

  // Determine availability
  const emailOk = !!lead.email;
  // PILOT: WhatsApp recommendations are temporarily disabled to avoid surfacing
  // a channel reps aren't actively using during the live pilot.
  const waOk = false;
  // Original: !!workspace.whatsapp_enabled && !!lead.wa_opted_in && !!lead.whatsapp_number;
  const smsOk = !!workspace.sms_enabled && !!lead.sms_opted_in && !!lead.phone;
  const voiceOk = !!workspace.voice_enabled && !!lead.phone;
  const meetingOk = !!workspace.meetings_enabled;
  // LinkedIn is a planned-cadence / manual channel, not a reactive next-best-action.
  // It is authored inside a campaign plan and run by hand from the Queue — never
  // surfaced here as a recommended reply channel — so it is always false in this map.
  const linkedinOk = false;

  const map: Record<CanonicalChannel, boolean> = {
    email: emailOk,
    whatsapp: waOk,
    sms: smsOk,
    voice: voiceOk,
    meeting: meetingOk,
    linkedin: linkedinOk,
  };

  // Build priority order
  const isNA = NA_COUNTRIES.has((lead.country ?? "").toUpperCase());

  // Default priority differs by region
  const basePriority: CanonicalChannel[] = isNA
    ? ["sms", "voice", "email", "whatsapp", "meeting"]
    : ["whatsapp", "email", "sms", "voice", "meeting"];

  // If last inbound channel is still available, put it first
  let ordered = [...basePriority];
  if (lastInboundCanonical && map[lastInboundCanonical]) {
    ordered = [lastInboundCanonical, ...ordered.filter((c) => c !== lastInboundCanonical)];
  }

  const seen = new Set<CanonicalChannel>();
  for (const ch of ordered) {
    if (seen.has(ch) || !map[ch]) continue;
    seen.add(ch);
    available.push({ channel: ch });
  }

  return available;
}
