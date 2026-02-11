/**
 * Subtle inline Mode dropdown for the Leads table Phase column.
 * Replaces static Phase text with a compact select.
 */

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MODE_OPTIONS, type ModeOption, updateMotionFromTable } from "@/lib/motionUpdater";
import { MOTION_ICONS } from "@/lib/dashboardUtils";
import type { DisplayPhase } from "@/lib/dashboardUtils";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const phaseToMode: Record<DisplayPhase, ModeOption> = {
  Prospecting: "Prospecting",
  Engaged: "Engaged",
  "Post-Meeting": "Post-Meeting",
  Closing: "Closing",
  Nurture: "Nurture",
  Closed: "Closed",
};

const modeIcons: Record<ModeOption, string> = {
  Prospecting: "🚀",
  Engaged: "💬",
  "Pre-Meeting": "📅",
  "Post-Meeting": "📝",
  Closing: "🤝",
  Nurture: "🌱",
  Closed: "🏁",
};

interface ModeDropdownProps {
  leadId: string;
  leadName: string;
  currentPhase: DisplayPhase;
  directionArrow: string;
  onNurtureSelect: () => void;
  onUpdated?: () => void;
}

export function ModeDropdown({
  leadId,
  leadName,
  currentPhase,
  directionArrow,
  onNurtureSelect,
  onUpdated,
}: ModeDropdownProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const currentMode = phaseToMode[currentPhase] || "Prospecting";

  const handleChange = async (value: string) => {
    const mode = value as ModeOption;
    if (mode === currentMode) return;

    // Nurture requires the dialog
    if (mode === "Nurture") {
      onNurtureSelect();
      return;
    }

    setIsUpdating(true);
    const ok = await updateMotionFromTable(leadId, mode);
    setIsUpdating(false);

    if (ok) {
      toast.success(`${leadName} → ${mode}`);
      onUpdated?.();
    } else {
      toast.error("Failed to update mode");
    }
  };

  if (isUpdating) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Updating…
      </span>
    );
  }

  return (
    <Select value={currentMode} onValueChange={handleChange}>
      <SelectTrigger
        className={cn(
          "h-auto border-0 bg-transparent px-0 py-0 shadow-none",
          "text-xs font-medium text-foreground hover:text-primary",
          "focus:ring-0 focus:ring-offset-0 w-auto min-w-0 gap-0.5",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue>
          <span className="flex items-center gap-0.5">
            {currentMode}
            {directionArrow && (
              <span className="text-muted-foreground/60">{directionArrow}</span>
            )}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[150px]">
        {MODE_OPTIONS.map((mode) => (
          <SelectItem key={mode} value={mode} className="text-xs">
            <span className="flex items-center gap-1.5">
              <span>{modeIcons[mode]}</span>
              {mode}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
