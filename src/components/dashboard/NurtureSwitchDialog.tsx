import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Sprout } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type NurtureCadence = "weekly" | "biweekly" | "monthly";
type NurtureTheme = "balanced" | "educational" | "case_study";

interface NurtureSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  onSuccess?: () => void;
}

const THEME_OPTIONS: { value: NurtureTheme; label: string; description: string }[] = [
  { value: "balanced", label: "Balanced", description: "Mix of insights, case studies & resources" },
  { value: "educational", label: "Educational Heavy", description: "Industry trends & thought leadership" },
  { value: "case_study", label: "Case Study Heavy", description: "Customer stories & proof points" },
];

const CADENCE_OPTIONS: { value: NurtureCadence; label: string; description: string; recommended?: boolean }[] = [
  { value: "weekly", label: "Every 7 days", description: "Higher frequency touch" },
  { value: "biweekly", label: "Every 14 days", description: "Balanced cadence", recommended: true },
  { value: "monthly", label: "Every 30 days", description: "Low-pressure outreach" },
];

const PREVIEW_STEPS: Record<NurtureTheme, string[]> = {
  balanced: ["Industry Insight", "Case Study"],
  educational: ["Market Trend Analysis", "Best Practices Guide"],
  case_study: ["Customer Success Story", "ROI Breakdown"],
};

export function NurtureSwitchDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  onSuccess,
}: NurtureSwitchDialogProps) {
  const [theme, setTheme] = useState<NurtureTheme>("balanced");
  const [cadence, setCadence] = useState<NurtureCadence>("biweekly");
  const [isSaving, setIsSaving] = useState(false);

  const handleConfirm = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          strategy: "nurture",
          motion: "nurture",
          nurture_cadence: cadence,
          nurture_mode: "review",
          nurture_status: "active",
          nurture_theme: theme,
          mode_changed_at: new Date().toISOString(),
          auto_nurture_eligible: false,
          needs_action: true,
          next_action_key: "send_nurture_1",
          next_action_label: "Review first nurture email",
          action_reason_code: null,
        })
        .eq("id", leadId);

      if (error) throw error;

      toast.success(`${leadName} moved to nurture mode (Review)`);
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error("Failed to activate nurture:", err);
      toast.error("Failed to activate nurture mode");
    } finally {
      setIsSaving(false);
    }
  };

  const previewSteps = PREVIEW_STEPS[theme];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sprout className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Activate Nurture Mode
          </DialogTitle>
          <DialogDescription className="text-xs">
            Maintain a longer-term, value-add cadence with {leadName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Theme Mix */}
          <div className="space-y-2">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Theme Mix
            </Label>
            <RadioGroup
              value={theme}
              onValueChange={(val) => setTheme(val as NurtureTheme)}
              className="space-y-1.5"
            >
              {THEME_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-border/60 hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <RadioGroupItem value={opt.value} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{opt.label}</span>
                    {opt.value === "balanced" && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Recommended
                      </span>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          {/* Cadence */}
          <div className="space-y-2">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Cadence
            </Label>
            <RadioGroup
              value={cadence}
              onValueChange={(val) => setCadence(val as NurtureCadence)}
              className="space-y-1.5"
            >
              {CADENCE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-border/60 hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <RadioGroupItem value={opt.value} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{opt.label}</span>
                    {opt.recommended && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Recommended
                      </span>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          {/* Preview First 2 Emails */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Preview first 2 emails
            </Label>
            <div className="space-y-1">
              {previewSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium tabular-nums">
                    {i + 1}
                  </span>
                  {step}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Activating...
              </>
            ) : (
              <>
                <Sprout className="h-3.5 w-3.5 mr-1.5" />
                Start in Review Mode
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
