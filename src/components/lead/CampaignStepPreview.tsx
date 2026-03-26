import { resolveAllSteps, type ResolvedStepPreview } from "@/lib/campaignResolver";
import type { CanonicalChannel } from "@/lib/channels";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Layers } from "lucide-react";
import { useState } from "react";

interface CampaignStepPreviewProps {
  motion: string;
  channel?: CanonicalChannel;
  actionInstructions?: string | null;
  outboundTone?: string;
}

function StepRow({ step }: { step: ResolvedStepPreview }) {
  return (
    <div className="border border-border/50 rounded-md p-2.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          Step {step.step_number}
        </span>
        <div className="flex items-center gap-1">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
            {step.channel}
          </Badge>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
            {step.framework}
          </Badge>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">{step.objective}</p>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>≤{step.max_word_count} words</span>
        <span>CTA: {step.cta_type}</span>
        <span>{step.hard_rules.length} rules</span>
      </div>
    </div>
  );
}

export default function CampaignStepPreview({
  motion,
  channel = "email",
  actionInstructions,
  outboundTone,
}: CampaignStepPreviewProps) {
  const [open, setOpen] = useState(false);
  const steps = resolveAllSteps(motion, channel, actionInstructions, outboundTone);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-sm font-medium text-foreground hover:text-primary transition-colors py-2">
        <Layers className="h-4 w-4" />
        Sequence Preview
        <ChevronDown
          className={`h-3.5 w-3.5 ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-1 pb-2">
        {steps.map(step => (
          <StepRow key={step.step_number} step={step} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
