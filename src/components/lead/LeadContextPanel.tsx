import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle, FileText, Handshake, ShoppingCart,
  Brain, StickyNote, Plus, ChevronDown, ChevronUp,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ── Types ──────────────────────────────────────────────────────────────

interface LeadContextItem {
  id: string;
  category: string;
  content_type: string;
  content_text: string;
  original_snippet: string | null;
  source_type: string;
  source_column_name: string | null;
  confidence: number | null;
  author_name: string | null;
  context_date: string | null;
  is_active: boolean;
  created_at: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const CATEGORY_META: Record<string, { label: string; icon: typeof AlertTriangle; colorClass: string }> = {
  caution: { label: "Caution", icon: AlertTriangle, colorClass: "text-destructive" },
  relationship_history: { label: "Relationship", icon: Handshake, colorClass: "text-primary" },
  commercial_signal: { label: "Commercial", icon: ShoppingCart, colorClass: "text-accent-foreground" },
  historical_fact: { label: "Fact", icon: FileText, colorClass: "text-foreground" },
  imported_note: { label: "Note", icon: StickyNote, colorClass: "text-muted-foreground" },
  inferred_hypothesis: { label: "Inferred", icon: Brain, colorClass: "text-muted-foreground" },
};

const CATEGORY_ORDER = ["caution", "relationship_history", "commercial_signal", "historical_fact", "imported_note", "inferred_hypothesis"];

const SOURCE_LABELS: Record<string, string> = {
  csv_import: "CSV Import",
  manual_entry: "Manual",
  rep_entry: "Rep Entry",
  ai_extraction: "AI Extracted",
  document_upload: "Document",
};

// ── Component ──────────────────────────────────────────────────────────

interface Props {
  leadId: string;
  workspaceId: string;
  onUpdate?: () => void;
}

export default function LeadContextPanel({ leadId, workspaceId, onUpdate }: Props) {
  const [items, setItems] = useState<LeadContextItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const loadItems = useCallback(async () => {
    const query = supabase
      .from("lead_context_items")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });

    const { data, error } = await query;
    if (error) {
      console.error("Failed to load lead context items:", error);
    } else {
      setItems((data || []) as LeadContextItem[]);
    }
    setIsLoading(false);
  }, [leadId]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const toggleActive = async (item: LeadContextItem) => {
    const newActive = !item.is_active;
    const { error } = await supabase
      .from("lead_context_items")
      .update({ is_active: newActive })
      .eq("id", item.id);

    if (error) {
      toast.error("Failed to update context item");
    } else {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_active: newActive } : i));
      toast.success(newActive ? "Context item re-activated" : "Context item deactivated");
      onUpdate?.();
    }
  };

  const displayItems = showInactive ? items : items.filter(i => i.is_active);
  const grouped = CATEGORY_ORDER.reduce((acc, cat) => {
    const catItems = displayItems.filter(i => i.category === cat);
    if (catItems.length > 0) acc.push({ category: cat, items: catItems });
    return acc;
  }, [] as Array<{ category: string; items: LeadContextItem[] }>);

  // Also include items with categories not in the standard list
  const knownCats = new Set(CATEGORY_ORDER);
  const otherItems = displayItems.filter(i => !knownCats.has(i.category));
  if (otherItems.length > 0) {
    grouped.push({ category: "other", items: otherItems });
  }

  const activeCount = items.filter(i => i.is_active).length;
  const inactiveCount = items.filter(i => !i.is_active).length;

  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse p-4">
        <div className="h-4 bg-muted rounded w-1/2" />
        <div className="h-3 bg-muted rounded w-3/4" />
        <div className="h-3 bg-muted rounded w-2/3" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <FileText className="h-4 w-4" /> Lead Context
          </h3>
          <AddContextDialog leadId={leadId} workspaceId={workspaceId} onAdded={() => { loadItems(); onUpdate?.(); }} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          No imported context for this lead. Context is captured automatically during import or can be added manually.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
      >
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <FileText className="h-4 w-4" /> Lead Context
          <Badge variant="secondary" className="text-[10px] ml-1">{activeCount}</Badge>
          {inactiveCount > 0 && (
            <Badge variant="outline" className="text-[10px] ml-0.5 opacity-50">{inactiveCount} hidden</Badge>
          )}
        </h3>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Controls */}
          <div className="flex items-center justify-between gap-2">
            {inactiveCount > 0 && (
              <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                <Switch
                  checked={showInactive}
                  onCheckedChange={setShowInactive}
                  className="scale-75"
                />
                Show deactivated
              </label>
            )}
            <AddContextDialog leadId={leadId} workspaceId={workspaceId} onAdded={() => { loadItems(); onUpdate?.(); }} />
          </div>

          <Separator />

          {/* Grouped items */}
          {grouped.map(({ category, items: catItems }) => {
            const meta = CATEGORY_META[category] || { label: category, icon: StickyNote, colorClass: "text-muted-foreground" };
            const Icon = meta.icon;

            return (
              <div key={category} className="space-y-1.5">
                <div className={cn("flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium", meta.colorClass)}>
                  <Icon className="h-3 w-3" />
                  {meta.label}
                </div>
                {catItems.map((item) => (
                  <ContextItemRow key={item.id} item={item} onToggle={toggleActive} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Context Item Row ───────────────────────────────────────────────────

function ContextItemRow({ item, onToggle }: { item: LeadContextItem; onToggle: (item: LeadContextItem) => void }) {
  const sourceLabel = SOURCE_LABELS[item.source_type] || item.source_type;
  const confidenceLabel = item.confidence != null ? `${(item.confidence * 100).toFixed(0)}%` : null;

  return (
    <div className={cn(
      "group flex items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
      item.is_active ? "bg-muted/30" : "bg-muted/10 opacity-50",
    )}>
      <div className="flex-1 min-w-0">
        <p className={cn("text-foreground", !item.is_active && "line-through")}>{item.content_text}</p>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground">{sourceLabel}</span>
          {item.source_column_name && (
            <span className="text-[10px] text-muted-foreground">• col: {item.source_column_name}</span>
          )}
          {item.author_name && (
            <span className="text-[10px] text-muted-foreground">• by {item.author_name}</span>
          )}
          {confidenceLabel && (
            <Badge variant="outline" className="text-[9px] px-1 py-0">{confidenceLabel}</Badge>
          )}
          {item.context_date && (
            <span className="text-[10px] text-muted-foreground">• {new Date(item.context_date).toLocaleDateString()}</span>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onToggle(item)}
        title={item.is_active ? "Deactivate this context item" : "Re-activate this context item"}
      >
        {item.is_active ? (
          <AlertTriangle className="h-3 w-3 text-destructive" />
        ) : (
          <Plus className="h-3 w-3 text-primary" />
        )}
      </Button>
    </div>
  );
}

// ── Add Context Dialog ─────────────────────────────────────────────────

function AddContextDialog({ leadId, workspaceId, onAdded }: { leadId: string; workspaceId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("imported_note");
  const [text, setText] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim()) return;
    setIsSaving(true);

    const { error } = await supabase
      .from("lead_context_items")
      .insert({
        lead_id: leadId,
        workspace_id: workspaceId,
        category,
        content_type: "general",
        content_text: text.trim(),
        original_snippet: text.trim(),
        source_type: "rep_entry",
        source_column_name: null,
        confidence: null,
        author_name: null,
        context_date: null,
      });

    if (error) {
      toast.error("Failed to add context");
    } else {
      toast.success("Context added");
      setText("");
      setCategory("imported_note");
      setOpen(false);
      onAdded();
    }
    setIsSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Lead Context</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-foreground">Category</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="caution">⚠️ Caution (do not say)</SelectItem>
                <SelectItem value="relationship_history">🤝 Relationship history</SelectItem>
                <SelectItem value="commercial_signal">🛒 Commercial signal</SelectItem>
                <SelectItem value="historical_fact">📄 Historical fact</SelectItem>
                <SelectItem value="imported_note">📝 Note</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-foreground">Content</label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Do not mention competitor X — they are a close partner"
              className="mt-1"
              rows={3}
            />
          </div>
          <Button onClick={handleSave} disabled={!text.trim() || isSaving} className="w-full">
            {isSaving ? "Saving..." : "Add Context"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
