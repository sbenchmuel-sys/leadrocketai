import { Mail, PhoneCall, Phone, Sparkles } from "lucide-react";
import {
  STARTER_CADENCES,
  cadenceUsesSms,
  type StarterCadence,
} from "@/lib/starterCadences";

interface StarterCadencePickerProps {
  /** From workspaces.sms_enabled — gates the "needs SMS enabled" note. */
  smsEnabled: boolean;
  /** Picking a card hands the cadence back to prefill the editable plan. */
  onUse: (cadence: StarterCadence) => void;
}

/** Plain-language "3 emails · 2 calls · 1 text" line for a cadence. */
function channelSummary(cadence: StarterCadence): string {
  const count = (ch: string) => cadence.touches.filter((t) => t.channel === ch).length;
  const parts: string[] = [];
  const emails = count("email");
  const calls = count("voice");
  const texts = count("sms");
  if (emails) parts.push(`${emails} email${emails === 1 ? "" : "s"}`);
  if (calls) parts.push(`${calls} call${calls === 1 ? "" : "s"}`);
  if (texts) parts.push(`${texts} text${texts === 1 ? "" : "s"}`);
  const lastDay = cadence.touches[cadence.touches.length - 1]?.day ?? 0;
  return `${parts.join(" · ")} over ${lastDay} days`;
}

/**
 * The "Use a starter cadence" entry point. Selecting a card prefills the
 * editable Step-2 plan from that starter's touches — the rep edits it like any
 * outreach and the draft is created on Save. Nothing is written on pick, and
 * the draft ships in review/manual mode like any other.
 */
export function StarterCadencePicker({
  smsEnabled,
  onUse,
}: StarterCadencePickerProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h2 className="text-base font-semibold text-foreground">
          Start from a ready-made cadence
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Pick one and we'll lay out the whole sequence for you. You can change
        every step before anything goes out.
      </p>

      <div className="space-y-3">
        {STARTER_CADENCES.map((cadence) => {
          const needsSms = cadenceUsesSms(cadence) && !smsEnabled;
          return (
            <button
              key={cadence.id}
              type="button"
              onClick={() => onUse(cadence)}
              className="w-full rounded-lg border border-border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {cadence.name}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {cadence.tagline}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </span>
                {cadence.touches.some((t) => t.channel === "voice") && (
                  <span className="inline-flex items-center gap-1">
                    <PhoneCall className="h-3.5 w-3.5" />
                    Call
                  </span>
                )}
                {cadence.touches.some((t) => t.channel === "sms") && (
                  <span className="inline-flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5" />
                    Text
                  </span>
                )}
                <span aria-hidden>·</span>
                <span>{channelSummary(cadence)}</span>
              </div>

              {needsSms && (
                <p className="mt-2 text-[11px] leading-tight text-amber-600 dark:text-amber-500">
                  Includes a text — we'll keep that step, but you'll need to turn
                  on texting in Settings before it can send. Everything else
                  works as-is.
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
