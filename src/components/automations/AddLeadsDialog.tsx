import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getLeadsList, type LeadListItem } from "@/lib/supabaseQueries";
import { addLeadsToCampaign } from "@/lib/campaignQueries";

interface AddLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  /** Lead ids already on the People list — hidden from the picker. */
  excludeIds: string[];
  onAdded: () => void;
}

export function AddLeadsDialog({
  open,
  onOpenChange,
  campaignId,
  excludeIds,
  onAdded,
}: AddLeadsDialogProps) {
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch("");
    setLoading(true);
    getLeadsList()
      .then(setLeads)
      .catch(() => toast.error("Couldn't load your people"))
      .finally(() => setLoading(false));
  }, [open]);

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);

  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads
      .filter((l) => !excluded.has(l.id))
      .filter(
        (l) =>
          !q ||
          l.name.toLowerCase().includes(q) ||
          (l.company || "").toLowerCase().includes(q) ||
          (l.email || "").toLowerCase().includes(q),
      );
  }, [leads, excluded, search]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      await addLeadsToCampaign(Array.from(selected), campaignId);
      toast.success(`Added ${selected.size} ${selected.size === 1 ? "person" : "people"}`);
      onAdded();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add those people");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add people</DialogTitle>
          <DialogDescription>
            Pick who should go into this outreach. You can add more anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, company, or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : available.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {leads.length === 0
                ? "You don't have any people yet. Add leads first."
                : search
                  ? "No matches."
                  : "Everyone is already in this outreach."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {available.map((l) => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent">
                    <Checkbox
                      checked={selected.has(l.id)}
                      onCheckedChange={() => toggle(l.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {l.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[l.company, l.email].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : "None selected"}
          </span>
          <Button onClick={handleAdd} disabled={selected.size === 0 || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add {selected.size > 0 ? selected.size : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
