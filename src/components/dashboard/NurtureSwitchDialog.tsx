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
import { Loader2, RefreshCw, Calendar } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type NurtureCadence = "weekly" | "biweekly" | "monthly";

interface NurtureSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  onSuccess?: () => void;
}

const CADENCE_OPTIONS: { value: NurtureCadence; label: string; description: string }[] = [
  { value: "weekly", label: "Weekly", description: "Touch base every 7 days" },
  { value: "biweekly", label: "Biweekly", description: "Touch base every 14 days" },
  { value: "monthly", label: "Monthly", description: "Touch base every 30 days" },
];

export function NurtureSwitchDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  onSuccess,
}: NurtureSwitchDialogProps) {
  const [cadence, setCadence] = useState<NurtureCadence>("biweekly");
  const [isSaving, setIsSaving] = useState(false);

  const handleConfirm = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("leads")
        .update({
          strategy: "nurture",
          nurture_cadence: cadence,
          mode_changed_at: new Date().toISOString(),
          auto_nurture_eligible: false,
          needs_action: false,
          next_action_key: null,
          next_action_label: null,
          action_reason_code: null,
        })
        .eq("id", leadId);

      if (error) throw error;

      toast.success(`Switched ${leadName} to nurture mode (${cadence})`);
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      console.error("Failed to switch to nurture:", err);
      toast.error("Failed to switch to nurture mode");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            Switch to Nurture Mode
          </DialogTitle>
          <DialogDescription>
            {leadName} hasn't responded to your outreach. Switch to nurture mode
            to maintain a longer-term, lower-pressure cadence.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="p-3 bg-muted/50 rounded-lg text-sm">
            <p className="text-muted-foreground">
              <strong className="text-foreground">What happens:</strong> The AI will
              suggest nurture emails on your chosen schedule with value-add content
              like industry insights, case studies, or helpful resources.
            </p>
          </div>

          <div className="space-y-3">
            <Label className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Select nurture cadence
            </Label>
            <RadioGroup
              value={cadence}
              onValueChange={(val) => setCadence(val as NurtureCadence)}
              className="space-y-2"
            >
              {CADENCE_OPTIONS.map((option) => (
                <div
                  key={option.value}
                  className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
                >
                  <RadioGroupItem value={option.value} id={option.value} />
                  <Label htmlFor={option.value} className="flex-1 cursor-pointer">
                    <span className="font-medium">{option.label}</span>
                    <span className="text-sm text-muted-foreground ml-2">
                      — {option.description}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Switching...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Switch to Nurture
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
