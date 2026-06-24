import { useState } from "react";
import {
  Mail,
  Phone,
  PhoneCall,
  MessageSquare,
  Calendar,
  Linkedin,
  Minus,
  Plus,
  X,
  ChevronUp,
  ChevronDown,
  Repeat,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CanonicalChannel } from "@/lib/channels";
import type { StepType } from "@/lib/campaignTypes";
import {
  touchLabel,
  cumulativeDays,
  emailIntent,
  stepNeedsSmsSetup,
  EDITABLE_CHANNELS,
} from "@/lib/campaignDefaults";

// Minimal shape shared by draft steps and DB steps.
export interface ScriptStep {
  channel: CanonicalChannel;
  delay_days: number;
  custom_instructions: string | null;
  // Lets LinkedIn touches read distinctly (connect / react / message) in the
  // review. Optional so callers without step_type still render the channel verb.
  step_type?: StepType;
  // Per-step "Include a meeting link" flag (email touches). Editable mode only.
  include_meeting_cta?: boolean | null;
}

const ICONS: Record<CanonicalChannel, LucideIcon> = {
  email: Mail,
  voice: PhoneCall,
  sms: Phone,
  whatsapp: MessageSquare,
  meeting: Calendar,
  linkedin: Linkedin,
};

// "Add an email" / "Add a call" / "Add a text" — plain labels for the channel
// a rep can add or switch to. "an" before email, "a" before call/text.
function addLabel(label: string): string {
  return /^[aeiou]/i.test(label) ? `Add an ${label}` : `Add a ${label}`;
}
function changeLabel(label: string): string {
  return /^[aeiou]/i.test(label) ? `Change to an ${label}` : `Change to a ${label}`;
}

interface CampaignScriptProps {
  steps: ScriptStep[];
  /** When set, each touch shows the editing controls (timing, reorder, channel,
   *  meeting link, remove) and the "Add a step" affordances. */
  editable?: boolean;
  /** Whether the workspace can send texts. Gates the SMS add/change options and
   *  drives the inline "needs setup" flag on any existing text touch. */
  smsEnabled?: boolean;
  onChangeDelay?: (index: number, delayDays: number) => void;
  onRemove?: (index: number) => void;
  onMove?: (index: number, dir: -1 | 1) => void;
  onChangeChannel?: (index: number, channel: CanonicalChannel) => void;
  onInsert?: (atIndex: number, channel: CanonicalChannel) => void;
  onToggleMeeting?: (index: number, value: boolean) => void;
}

/**
 * Renders the full outreach top to bottom as a readable script:
 * "Day N · Email — <what this message does>". Used both in the setup
 * review screen (editable) and on the campaign page (read-only).
 *
 * In editable mode the rep can fully shape the cadence — add an email/call/text
 * anywhere, reorder, switch a touch's channel, change spacing, and pick which
 * emails carry a meeting link. Message wording is filled in a later step.
 */
export function CampaignScript({
  steps,
  editable,
  smsEnabled = false,
  onChangeDelay,
  onRemove,
  onMove,
  onChangeChannel,
  onInsert,
  onToggleMeeting,
}: CampaignScriptProps) {
  const days = cumulativeDays(steps);
  // Which "Add a step" slot is currently expanded (0..steps.length), or null.
  const [openInsertAt, setOpenInsertAt] = useState<number | null>(null);

  const insertHere = (atIndex: number, channel: CanonicalChannel) => {
    onInsert?.(atIndex, channel);
    setOpenInsertAt(null);
  };

  // Slim divider that expands into "Add an email / a call / a text".
  const renderInsertZone = (atIndex: number) => {
    if (!editable || !onInsert) return null;
    const open = openInsertAt === atIndex;
    if (!open) {
      return (
        <div className="flex items-center gap-2 py-0.5">
          <div className="h-px flex-1 bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => setOpenInsertAt(atIndex)}
          >
            <Plus className="h-3 w-3" />
            Add a step
          </Button>
          <div className="h-px flex-1 bg-border" />
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-2">
        {EDITABLE_CHANNELS.map(({ channel, label }) => {
          const needsSms = channel === "sms" && !smsEnabled;
          return (
            <div key={channel} className="flex flex-col">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={needsSms}
                onClick={() => insertHere(atIndex, channel)}
              >
                {addLabel(label)}
              </Button>
              {needsSms && (
                <span className="mt-1 max-w-[9rem] text-[11px] leading-tight text-muted-foreground">
                  Set up texting in Settings first.
                </span>
              )}
            </div>
          );
        })}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-muted-foreground"
          onClick={() => setOpenInsertAt(null)}
        >
          Cancel
        </Button>
      </div>
    );
  };

  return (
    <div className="space-y-1">
      {steps.map((step, i) => {
        const Icon = ICONS[step.channel] ?? Mail;
        const isEmail = step.channel === "email";
        const needsSms = stepNeedsSmsSetup(step, smsEnabled);
        return (
          <div key={i}>
            {renderInsertZone(i)}
            <div className="my-1 flex gap-3 rounded-lg border border-border bg-card p-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-foreground">
                    {touchLabel(step.channel, step.step_type)}
                  </span>
                  {/* Plain-language intent for emails — keeps the rep honest
                      about what a reordered email becomes (the live template is
                      picked by position at send time). */}
                  {isEmail && step.step_type && (
                    <span className="text-xs text-muted-foreground">
                      · {emailIntent(step.step_type)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {days[i] === 0 ? "Day 1 — right away" : `Day ${days[i] + 1}`}
                  </span>
                </div>
                {step.custom_instructions && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.custom_instructions}
                  </p>
                )}

                {/* Inline flag: a text touch that can't run until SMS is set up.
                    The step is kept, never dropped — just flagged. */}
                {editable && needsSms && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Texting isn't set up yet — turn it on in Settings before this sends.
                  </p>
                )}

                {/* Email-only: pick exactly which emails carry the booking link. */}
                {editable && isEmail && onToggleMeeting && (
                  <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-foreground">
                    <Checkbox
                      checked={step.include_meeting_cta === true}
                      onCheckedChange={(v) => onToggleMeeting(i, v === true)}
                    />
                    Include a meeting link
                  </label>
                )}

                {editable && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                    {/* Timing — gap in days after the previous touch. */}
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

                    {/* Reorder — up/down (no drag; works one-handed on a phone). */}
                    {onMove && (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          disabled={i === 0}
                          onClick={() => onMove(i, -1)}
                          aria-label="Move this message up"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-6 w-6"
                          disabled={i === steps.length - 1}
                          onClick={() => onMove(i, 1)}
                          aria-label="Move this message down"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </div>
                    )}

                    {/* Change channel — turn this touch into an email/call/text. */}
                    {onChangeChannel && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                          >
                            <Repeat className="h-3 w-3" />
                            Change
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {EDITABLE_CHANNELS.filter((c) => c.channel !== step.channel).map(
                            ({ channel, label }) => {
                              const needsSetup = channel === "sms" && !smsEnabled;
                              return (
                                <DropdownMenuItem
                                  key={channel}
                                  disabled={needsSetup}
                                  onSelect={() => onChangeChannel(i, channel)}
                                >
                                  {changeLabel(label)}
                                  {needsSetup && (
                                    <span className="ml-1 text-[11px] text-muted-foreground">
                                      (needs setup)
                                    </span>
                                  )}
                                </DropdownMenuItem>
                              );
                            },
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    {onRemove && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                        disabled={steps.length <= 1}
                        onClick={() => onRemove(i)}
                      >
                        <X className="mr-1 h-3 w-3" />
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {/* Add at the very end. */}
      {renderInsertZone(steps.length)}
    </div>
  );
}
