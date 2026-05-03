import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Search, AlertCircle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import {
  searchLeadsForStakeholder,
  addLeadToGroup,
  createLeadGroupWithChampion,
} from "@/lib/leadGroupQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  // The lead currently being viewed (the anchor for the action)
  anchorLeadId: string;
  anchorLeadName: string;
  anchorLeadCompany: string | null;
  // If the anchor lead already has a group, pass it. Otherwise we'll create one.
  existingGroupId: string | null;
  existingMemberIds: string[];
  onAdded: () => void;
}

export function AddStakeholderDialog({
  open,
  onOpenChange,
  workspaceId,
  anchorLeadId,
  anchorLeadName,
  anchorLeadCompany,
  existingGroupId,
  existingMemberIds,
  onAdded,
}: Props) {
  const [query, setQuery] = useState("");
  const [filterByCompany, setFilterByCompany] = useState(true);
  const [results, setResults] = useState<Array<{ id: string; name: string; company: string | null; email: string | null; job_title: string | null; group_id: string | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null); // lead id currently being added

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setFilterByCompany(!!anchorLeadCompany);
      setResults([]);
    }
  }, [open, anchorLeadCompany]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchLeadsForStakeholder({
          workspaceId,
          excludeLeadIds: existingMemberIds,
          companyFilter: filterByCompany ? anchorLeadCompany : null,
          query: query.trim() || undefined,
          limit: 25,
        });
        setResults(data);
      } catch (err: any) {
        toast.error(`Search failed: ${err.message ?? "unknown"}`);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [open, query, filterByCompany, anchorLeadCompany, workspaceId, existingMemberIds]);

  const handleAdd = async (lead: { id: string; group_id: string | null }) => {
    if (lead.group_id && lead.group_id !== existingGroupId) {
      toast.error("That lead is already in a different group. Remove them from it first.");
      return;
    }
    setAdding(lead.id);
    try {
      let groupId = existingGroupId;
      if (!groupId) {
        // No group yet — create one with the ANCHOR lead as champion,
        // then add the selected lead as a member.
        groupId = await createLeadGroupWithChampion(anchorLeadId, anchorLeadCompany ?? null);
      }
      await addLeadToGroup(lead.id, groupId);
      toast.success("Stakeholder added");
      onAdded();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(`Failed to add: ${err.message ?? "unknown"}`);
    } finally {
      setAdding(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add stakeholder</DialogTitle>
          <DialogDescription>
            Link another lead at {anchorLeadCompany || "this company"} to {anchorLeadName}'s deal.
            {!existingGroupId && " A new stakeholder group will be created automatically."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or company..."
              className="pl-8"
              autoFocus
            />
          </div>

          {anchorLeadCompany && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
              <input
                type="checkbox"
                checked={filterByCompany}
                onChange={(e) => setFilterByCompany(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Limit to {anchorLeadCompany}
            </label>
          )}

          <div className="rounded-md border max-h-72 overflow-auto">
            {loading ? (
              <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </div>
            ) : results.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">
                No matching leads. Try a different search or uncheck the company filter.
              </div>
            ) : (
              <div className="divide-y">
                {results.map((r) => {
                  const inOtherGroup = r.group_id && r.group_id !== existingGroupId;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center gap-3 p-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground truncate">
                          {r.name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {[r.job_title, r.company, r.email].filter(Boolean).join(" · ")}
                        </div>
                        {inOtherGroup && (
                          <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <AlertCircle className="h-3 w-3" /> Already in another group
                          </div>
                        )}
                      </div>
                      {inOtherGroup ? (
                        <Button asChild variant="ghost" size="sm" className="h-7">
                          <Link to={`/app/leads/${r.id}`}>
                            View <ExternalLink className="h-3 w-3 ml-1" />
                          </Link>
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7"
                          disabled={adding === r.id}
                          onClick={() => handleAdd(r)}
                        >
                          {adding === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
