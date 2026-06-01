import { Mail, Phone, PhoneCall, MessageSquare, Calendar, Minus, Plus, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanonicalChannel } from "@/lib/channels";
import { touchVerb, cumulativeDays } from "@/lib/campaignDefaults";

// Minimal shape shared by draft steps and DB steps.
export interface ScriptStep {
  channel: CanonicalChannel;
  delay_days: number;
  custom_instructions: string | null;
}

const ICONS: Record<CanonicalChannel, LucideIcon> = {
  email: Mail,
  voice: PhoneCall,
  sms: Phone,
  whatsapp: MessageSquare,
  meeting: Calendar,
};

interface CampaignScriptProps {
  steps: ScriptStep[];
  /** When set, each touch shows day-gap nudgers and a remove control. */
  editable?: boolean;
  onChangeDelay?: (index: number, delayDays: number) => void;
  onRemove?: (index: number) => void;
}

/**
 * Renders the full outreach top to bottom as a readable script:
 * "Day 0 · Email — <what this message does>". Used both in the setup
 * review screen (editable) and on the campaign page (read-only).
 * Message content itself is filled in a later step — these are the
 * finished-by-default descriptions, never a blank builder.
 */
export function CampaignScript({ steps, editable, onChangeDelay, onRemove }: CampaignScriptProps) {
  const days = cumulativeDays(steps);

  return (
    <ol className="space-y-3">
      {steps.map((step, i) => {
        const Icon = ICONS[step.channel] ?? Mail;
        return (
          <li
            key={i}
            className="flex gap-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">
                  {touchVerb(step.channel)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {days[i] === 0 ? "Day 1 — right away" : `Day ${days[i] + 1}`}
                </span>
              </div>
              {step.custom_instructions && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {step.custom_instructions}
                </p>
              )}

              {editable && (
                <div className="mt-2 flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Wait</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-6 w-6"
                      disabled={i === 0 || step.delay_days <= 0}
                      onClick={() => onChangeDelay?.(i, Math.max(0, step.delay_days - 1))}
                      aria-label="Fewer days before this message"
                    >
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-16 text-center text-xs text-foreground">
                      {i === 0
                        ? "—"
                        : `${step.delay_days} day${step.delay_days === 1 ? "" : "s"}`}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-6 w-6"
                      disabled={i === 0}
                      onClick={() => onChangeDelay?.(i, step.delay_days + 1)}
                      aria-label="More days before this message"
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => onRemove?.(i)}
                  >
                    <X className="mr-1 h-3 w-3" />
                    Remove
                  </Button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
