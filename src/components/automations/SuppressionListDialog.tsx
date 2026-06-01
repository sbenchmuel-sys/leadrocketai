import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  fetchSuppressionList,
  addSuppressionEntries,
  removeSuppressionEntry,
  type SuppressionEntry,
} from "@/lib/campaignQueries";

interface SuppressionListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The workspace do-not-contact list — a plain editable list of emails and
 * domains we'll never reach out to. Deliberately minimal (not a console).
 * Separate from a lead unsubscribing themselves.
 */
export function SuppressionListDialog({ open, onOpenChange }: SuppressionListDialogProps) {
  const { workspaceId } = useWorkspace();
  const [entries, setEntries] = useState<SuppressionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const load = () => {
    if (!workspaceId) return;
    setLoading(true);
    fetchSuppressionList(workspaceId)
      .then(setEntries)
      .catch(() => toast.error("Couldn't load the do-not-contact list"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) {
      setDraft("");
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);

  const handleAdd = async () => {
    if (!workspaceId) return;
    const values = draft
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 0) return;
    setSaving(true);
    try {
      const added = await addSuppressionEntries(workspaceId, values);
      if (added === 0) {
        toast.info("Nothing new to add — check the format (email or domain).");
      } else {
        toast.success(`Added ${added} to the do-not-contact list`);
        setDraft("");
        load();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add those");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeSuppressionEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch {
      toast.error("Couldn't remove that one");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Do-not-contact list</DialogTitle>
          <DialogDescription>
            People and companies here are never contacted by any outreach. Add an
            email (jane@acme.com) or a whole company domain (acme.com).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Textarea
            placeholder={"jane@acme.com\nacme.com"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={handleAdd} disabled={saving || !draft.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add
            </Button>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-md border border-border p-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing on the list yet.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {entries.map((e) => (
                <Badge
                  key={e.id}
                  variant="secondary"
                  className="gap-1 py-1 pl-2.5 pr-1 text-xs font-normal"
                >
                  {e.value}
                  <button
                    type="button"
                    onClick={() => handleRemove(e.id)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-background"
                    aria-label={`Remove ${e.value}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
