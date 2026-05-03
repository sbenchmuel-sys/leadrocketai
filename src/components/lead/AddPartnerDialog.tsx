import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  searchContactsForPartner,
  addPartnerToGroup,
  createContact,
  createLeadGroupWithChampion,
} from "@/lib/leadGroupQueries";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  // Anchor lead (for creating a group on the fly if needed)
  anchorLeadId: string;
  anchorLeadCompany: string | null;
  existingGroupId: string | null;
  existingPartnerContactIds: string[];
  onAdded: () => void;
}

type Mode = "search" | "create";

export function AddPartnerDialog({
  open,
  onOpenChange,
  workspaceId,
  anchorLeadId,
  anchorLeadCompany,
  existingGroupId,
  existingPartnerContactIds,
  onAdded,
}: Props) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; display_name: string | null; company: string | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  // Inline role-note state, keyed by contact id
  const [roleNotes, setRoleNotes] = useState<Record<string, string>>({});

  // Create-new form state
  const [newName, setNewName] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newRoleNote, setNewRoleNote] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setMode("search");
      setQuery("");
      setResults([]);
      setRoleNotes({});
      setNewName("");
      setNewCompany("");
      setNewRoleNote("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "search") return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchContactsForPartner({
          workspaceId,
          excludeContactIds: existingPartnerContactIds,
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
  }, [open, mode, query, workspaceId, existingPartnerContactIds]);

  const ensureGroup = async (): Promise<string> => {
    if (existingGroupId) return existingGroupId;
    return await createLeadGroupWithChampion(anchorLeadId, anchorLeadCompany ?? null);
  };

  const handleAddExisting = async (contactId: string) => {
    setAdding(contactId);
    try {
      const groupId = await ensureGroup();
      await addPartnerToGroup(groupId, contactId, roleNotes[contactId]?.trim() || undefined);
      toast.success("Partner linked");
      onAdded();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(`Failed to link: ${err.message ?? "unknown"}`);
    } finally {
      setAdding(null);
    }
  };

  const handleCreateAndAdd = async () => {
    if (!newName.trim()) {
      toast.error("Name is required");
      return;
    }
    setCreating(true);
    try {
      const contact = await createContact({
        workspaceId,
        displayName: newName.trim(),
        company: newCompany.trim() || null,
      });
      const groupId = await ensureGroup();
      await addPartnerToGroup(groupId, contact.id, newRoleNote.trim() || undefined);
      toast.success("Partner created and linked");
      onAdded();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(`Failed to create: ${err.message ?? "unknown"}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add partner</DialogTitle>
          <DialogDescription>
            Link a third-party contact (introducer, advisor, integrator) to this deal.
            {!existingGroupId && " A new stakeholder group will be created automatically."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2 border-b">
          <button
            type="button"
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "search" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
            }`}
            onClick={() => setMode("search")}
          >
            Existing contact
          </button>
          <button
            type="button"
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
              mode === "create" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
            }`}
            onClick={() => setMode("create")}
          >
            <UserPlus className="h-3.5 w-3.5 inline mr-1" /> New contact
          </button>
        </div>

        {mode === "search" ? (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts by name or company..."
                className="pl-8"
                autoFocus
              />
            </div>

            <div className="rounded-md border max-h-80 overflow-auto">
              {loading ? (
                <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                </div>
              ) : results.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">
                  No contacts found. Switch to "New contact" to create one.
                </div>
              ) : (
                <div className="divide-y">
                  {results.map((r) => (
                    <div key={r.id} className="p-2.5 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-foreground truncate">
                            {r.display_name || "(no name)"}
                          </div>
                          {r.company && (
                            <div className="text-xs text-muted-foreground truncate">{r.company}</div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-7"
                          disabled={adding === r.id}
                          onClick={() => handleAddExisting(r.id)}
                        >
                          {adding === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Link"}
                        </Button>
                      </div>
                      <Input
                        value={roleNotes[r.id] ?? ""}
                        onChange={(e) =>
                          setRoleNotes((prev) => ({ ...prev, [r.id]: e.target.value }))
                        }
                        placeholder="Role note (optional) — e.g. introducer, advisor"
                        className="h-7 text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="partner-name">Name</Label>
              <Input
                id="partner-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Mike Park"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="partner-company">Company (optional)</Label>
              <Input
                id="partner-company"
                value={newCompany}
                onChange={(e) => setNewCompany(e.target.value)}
                placeholder="VendorX"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="partner-role">Role on this deal (optional)</Label>
              <Textarea
                id="partner-role"
                value={newRoleNote}
                onChange={(e) => setNewRoleNote(e.target.value)}
                placeholder='"Introduced via Stuart" or "Tech advisor"'
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {mode === "create" && (
            <Button onClick={handleCreateAndAdd} disabled={creating || !newName.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create & link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
