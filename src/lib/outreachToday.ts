import { OUTREACH_CHANNELS, type OutreachChannel, type OutreachTouch } from "@/lib/outreachQueue";

/** "Email" / "Call" / "Text" — the channel word a rep uses. */
export const CHANNEL_LABEL: Record<OutreachChannel, string> = {
  email: "Email",
  voice: "Call",
  sms: "Text",
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
};

/**
 * Group a page of due touches by channel, keeping each group oldest-due first
 * (the input is already sorted that way). Fixed channel order: email first —
 * it's the one that's actually sendable from here; the manual channels follow
 * in the order the default plan uses them. Pure.
 */
export function groupByChannel(touches: OutreachTouch[]): { channel: OutreachChannel; touches: OutreachTouch[] }[] {
  const groups = new Map<OutreachChannel, OutreachTouch[]>();
  for (const t of touches) {
    const list = groups.get(t.channel) ?? [];
    list.push(t);
    groups.set(t.channel, list);
  }
  return OUTREACH_CHANNELS.filter((ch) => groups.has(ch)).map((ch) => ({ channel: ch, touches: groups.get(ch)! }));
}
