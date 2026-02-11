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
import { updateMotionFromTable, updateNurtureCadence } from "@/lib/motionUpdater";
import { toast } from "sonner";

type NurtureCadence = "weekly" | "biweekly" | "monthly";

interface NurtureSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  onSuccess?: () => void;
}

const CADENCE_OPTIONS: { value: NurtureCadence; label: string; days: string; recommended?: boolean }[] = [
  { value: "weekly", label: "Fast", days: "7 days", },
  { value: "biweekly", label: "Standard", days: "14 days", recommended: true },
  { value: "monthly", label: "Light", days: "30 days" },
];

export function NurtureSwitchDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  onSuccess,
}: NurtureSwitchDialogProps) {
  const [step, setStep] = useState<"confirm" | "edit">("confirm");
  const [cadence, setCadence] = useState<NurtureCadence>("biweekly");
  const [isSaving, setIsSaving] = useState(false);

  const handleActivate = async () => {
    setIsSaving(true);
    try {
      const ok = await updateMotionFromTable(leadId, "Nurture");
      if (!ok) throw new Error("update failed");

      // If cadence was edited, apply override
      if (cadence !== "biweekly") {
        await updateNurtureCadence(leadId, cadence);
      }

      toast.success(`${leadName} moved to Nurture (Review mode)`);
      onOpenChange(false);
      setStep("confirm");
      onSuccess?.();
    } catch (err) {
      console.error("Failed to activate nurture:", err);
      toast.error("Failed to activate nurture mode");
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = (val: boolean) => {
    if (!val) setStep("confirm");
    onOpenChange(val);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sprout className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Nurture Mode Activated
          </DialogTitle>
          <DialogDescription className="text-xs">
            {step === "confirm"
              ? `Default cadence: Every 14 days. Automation stays off.`
              : `Select the cadence for ${leadName}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "edit" && (
          <div className="space-y-3 py-2">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Select cadence
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
                    <span className="text-sm font-medium">
                      {opt.label}
                      <span className="text-muted-foreground ml-1">({opt.days})</span>
                    </span>
                    {opt.recommended && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Default
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === "confirm" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setStep("edit")}>
                Edit Cadence
              </Button>
              <Button size="sm" onClick={handleActivate} disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Activating…
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setStep("confirm")}>
                Back
              </Button>
              <Button size="sm" onClick={handleActivate} disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Sprout className="h-3.5 w-3.5 mr-1.5" />
                    Activate Nurture
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
