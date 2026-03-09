import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { ChevronDown, Calendar, MessageSquare, Layers } from "lucide-react";

export interface CampaignSettings {
  includeMeetingCTA: boolean;
  globalInstructions: string;
  stepInstructions: Record<string, string>; // step number → instructions
}

interface CampaignSettingsPanelProps {
  settings: CampaignSettings;
  onChange: (settings: CampaignSettings) => void;
  isNurture?: boolean;
}

const OUTBOUND_STEPS = [
  { key: "1", label: "Step 1 — Intro Email" },
  { key: "2", label: "Step 2 — Follow-up 1" },
  { key: "3", label: "Step 3 — Follow-up 2" },
  { key: "4", label: "Step 4 — Breakup Email" },
];

const NURTURE_STEPS = [
  { key: "1", label: "Step 1 — First Nurture" },
  { key: "2", label: "Step 2 — Second Nurture" },
  { key: "3", label: "Step 3 — Third Nurture" },
  { key: "4", label: "Step 4 — Fourth Nurture" },
];

export function composeCampaignInstructions(settings: CampaignSettings): string | null {
  const parts: string[] = [];

  // Global / campaign rules
  const globalRules: string[] = [];
  if (settings.includeMeetingCTA) {
    globalRules.push("- Always include a meeting booking CTA with the calendar link");
  }
  if (settings.globalInstructions.trim()) {
    globalRules.push(
      ...settings.globalInstructions
        .split("\n")
        .filter(Boolean)
        .map((l) => (l.startsWith("-") ? l : `- ${l}`))
    );
  }
  if (globalRules.length > 0) {
    parts.push(`CAMPAIGN RULES:\n${globalRules.join("\n")}`);
  }

  // Step-specific instructions
  for (const [step, text] of Object.entries(settings.stepInstructions)) {
    const trimmed = text.trim();
    if (trimmed) {
      parts.push(`STEP ${step} INSTRUCTIONS:\n${trimmed}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function CampaignSettingsPanel({
  settings,
  onChange,
  isNurture = false,
}: CampaignSettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const steps = isNurture ? NURTURE_STEPS : OUTBOUND_STEPS;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-sm font-medium text-foreground hover:text-primary transition-colors py-2">
        <MessageSquare className="h-4 w-4" />
        Campaign Settings
        <ChevronDown
          className={`h-3.5 w-3.5 ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2 pb-3">
        {/* Meeting CTA */}
        <label className="flex items-start gap-2.5 cursor-pointer">
          <Checkbox
            checked={settings.includeMeetingCTA}
            onCheckedChange={(v) =>
              onChange({ ...settings, includeMeetingCTA: !!v })
            }
            className="mt-0.5"
          />
          <div>
            <span className="text-sm font-medium flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              Include meeting link CTA
            </span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Adds a calendar booking link in every email
            </p>
          </div>
        </label>

        {/* Global Instructions */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            Campaign instructions
          </Label>
          <Textarea
            placeholder="E.g. Focus on healthcare compliance, mention our starter kit promotion..."
            value={settings.globalInstructions}
            onChange={(e) =>
              onChange({ ...settings, globalInstructions: e.target.value })
            }
            rows={3}
            className="text-sm resize-none"
          />
          <p className="text-xs text-muted-foreground">
            Applied to all emails in this campaign
          </p>
        </div>

        {/* Step-specific Instructions */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            Step-specific instructions
          </Label>
          <Accordion type="multiple" className="w-full">
            {steps.map((step) => (
              <AccordionItem key={step.key} value={step.key} className="border-b-0">
                <AccordionTrigger className="py-2 text-xs hover:no-underline">
                  {step.label}
                </AccordionTrigger>
                <AccordionContent className="pb-3">
                  <Textarea
                    placeholder={`Instructions specific to ${step.label.toLowerCase()}...`}
                    value={settings.stepInstructions[step.key] || ""}
                    onChange={(e) =>
                      onChange({
                        ...settings,
                        stepInstructions: {
                          ...settings.stepInstructions,
                          [step.key]: e.target.value,
                        },
                      })
                    }
                    rows={2}
                    className="text-sm resize-none"
                  />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
