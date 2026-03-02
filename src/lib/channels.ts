import { Mail, MessageSquare, Phone, PhoneCall, Calendar, type LucideIcon } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────

export type ProviderChannel =
  | "gmail"
  | "outlook"
  | "whatsapp"
  | "sms"
  | "voice"
  | "meeting"
  | (string & {});

export type CanonicalChannel = "email" | "whatsapp" | "sms" | "voice" | "meeting";

// ── Mappers ────────────────────────────────────────────────────────────

const PROVIDER_MAP: Record<string, CanonicalChannel> = {
  gmail: "email",
  outlook: "email",
  whatsapp: "whatsapp",
  sms: "sms",
  voice: "voice",
  meeting: "meeting",
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
  const waOk =
    !!workspace.whatsapp_enabled && !!lead.wa_opted_in && !!lead.whatsapp_number;
  const smsOk = !!workspace.sms_enabled && !!lead.sms_opted_in && !!lead.phone;
  const voiceOk = !!workspace.voice_enabled && !!lead.phone;
  const meetingOk = !!workspace.meetings_enabled;

  const map: Record<CanonicalChannel, boolean> = {
    email: emailOk,
    whatsapp: waOk,
    sms: smsOk,
    voice: voiceOk,
    meeting: meetingOk,
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
