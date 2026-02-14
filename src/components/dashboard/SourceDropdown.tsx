/**
 * Inline Source dropdown for the Leads table Source column.
 * Allows changing a lead's source type directly from the table.
 */

import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SOURCE_PRESETS,
  SOURCE_TYPE_LABELS,
  SOURCE_TYPE_COLORS,
  type SourceType,
} from "@/lib/dashboardUtils";
import { updateSourceFromTable, type SourcePresetKey } from "@/lib/motionUpdater";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESET_LABELS: Record<SourcePresetKey, string> = {
  outbound: "Outbound Prospect",
  inbound_website: "Inbound – Website",
  event: "Event Lead",
  referral: "Referral",
  other: "Manual",
};

const PRESET_DOTS: Record<SourcePresetKey, string> = {
  outbound: "bg-blue-500",
  inbound_website: "bg-green-500",
  event: "bg-purple-500",
  referral: "bg-yellow-500",
  other: "bg-muted-foreground",
};

// Map current source_type back to preset key
function sourceTypeToPresetKey(sourceType: SourceType): SourcePresetKey {
  for (const [key, preset] of Object.entries(SOURCE_PRESETS)) {
    if (preset.source_type === sourceType) return key as SourcePresetKey;
  }
  // gmail_inbound and csv_import map to closest presets
  if (sourceType === "gmail_inbound") return "inbound_website";
  if (sourceType === "csv_import") return "outbound";
  return "other";
}

const PRESET_KEYS: SourcePresetKey[] = ["outbound", "inbound_website", "event", "referral", "other"];

interface SourceDropdownProps {
  leadId: string;
  leadName: string;
  currentSourceType: SourceType;
  onUpdated?: () => void;
}

export function SourceDropdown({
  leadId,
  leadName,
  currentSourceType,
  onUpdated,
}: SourceDropdownProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const currentKey = sourceTypeToPresetKey(currentSourceType);

  const handleChange = async (value: string) => {
    const key = value as SourcePresetKey;
    if (key === currentKey) return;

    setIsUpdating(true);
    const ok = await updateSourceFromTable(leadId, key);
    setIsUpdating(false);

    if (ok) {
      toast.success(`${leadName} → ${PRESET_LABELS[key]}`);
      onUpdated?.();
    } else {
      toast.error("Failed to update source");
    }
  };

  if (isUpdating) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Updating…
      </span>
    );
  }

  return (
    <Select value={currentKey} onValueChange={handleChange}>
      <SelectTrigger
        className={cn(
          "h-auto border-0 bg-transparent px-0 py-0 shadow-none",
          "text-[10px] font-medium hover:text-primary",
          "focus:ring-0 focus:ring-offset-0 w-auto min-w-0 gap-0.5",
          SOURCE_TYPE_COLORS[currentSourceType]?.text,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue>
          <span className="flex items-center gap-1">
            <span className={cn("w-1.5 h-1.5 rounded-full", SOURCE_TYPE_COLORS[currentSourceType]?.dot)} />
            {SOURCE_TYPE_LABELS[currentSourceType] || currentSourceType}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[160px]">
        {PRESET_KEYS.map((key) => (
          <SelectItem key={key} value={key} className="text-xs">
            <span className="flex items-center gap-1.5">
              <span className={cn("w-1.5 h-1.5 rounded-full", PRESET_DOTS[key])} />
              {PRESET_LABELS[key]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
