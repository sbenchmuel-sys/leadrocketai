import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Plus, X, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { z } from "zod";

type ListKind = "domain" | "email" | "internal";

type Row = {
  id: string;
  value: string; // domain or email
  created_at: string;
};

const tableFor = (kind: ListKind) =>
  kind === "domain"
    ? "workspace_dismissed_domains"
    : kind === "email"
    ? "workspace_dismissed_emails"
    : "workspace_internal_domains";

const valueColumn = (kind: ListKind) => (kind === "email" ? "email" : "domain");
const userColumn = (kind: ListKind) =>
  kind === "internal" ? "added_by_user_id" : "dismissed_by_user_id";

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Too short")
  .max(253, "Too long")
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid domain");

const emailSchema = z.string().trim().toLowerCase().email("Invalid email").max(255);

export function ListEditor({ kind, title, description, placeholder }: {
  kind: ListKind;
  title: string;
  description: string;
  placeholder: string;
}) {
  const { workspaceId } = useWorkspace();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const table = tableFor(kind);
  const col = valueColumn(kind);

  const load = async () => {
    if (!workspaceId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from(table as any)
      .select(`id, ${col}, created_at`)
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) {
      toast.error(`Failed to load ${title}`);
    } else {
      setRows(((data ?? []) as any[]).map((r) => ({ id: r.id, value: r[col], created_at: r.created_at })));
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, kind]);

  const handleAdd = async () => {
    if (!workspaceId) return;
    const schema = kind === "email" ? emailSchema : domainSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid value");
      return;
    }
    const value = parsed.data;
    if (rows.some((r) => r.value === value)) {
      toast.info("Already in list");
      return;
    }
    setAdding(true);
    const { data: { user } } = await supabase.auth.getUser();
    const payload: any = {
      workspace_id: workspaceId,
      [col]: value,
      [userColumn(kind)]: user?.id ?? null,
    };
    const { data, error } = await supabase
      .from(table as any)
      .insert(payload)
      .select(`id, ${col}, created_at`)
      .single();
    setAdding(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const row = data as any;
    setRows((prev) => [{ id: row.id, value: row[col], created_at: row.created_at }, ...prev]);
    setInput("");
    toast.success("Added");
  };

  const handleRemove = async (row: Row) => {
    const prev = rows;
    setRows((p) => p.filter((r) => r.id !== row.id));
    const { error } = await supabase.from(table as any).delete().eq("id", row.id);
    if (error) {
      setRows(prev);
      toast.error(error.message);
      return;
    }
    toast.success("Removed", {
      action: {
        label: "Undo",
        onClick: async () => {
          if (!workspaceId) return;
          const { data: { user } } = await supabase.auth.getUser();
          const payload: any = {
            workspace_id: workspaceId,
            [col]: row.value,
            [userColumn(kind)]: user?.id ?? null,
          };
          const { data, error: insErr } = await supabase
            .from(table as any)
            .insert(payload)
            .select(`id, ${col}, created_at`)
            .single();
          if (insErr) {
            toast.error("Could not undo");
            return;
          }
          const r = data as any;
          setRows((p) => [{ id: r.id, value: r[col], created_at: r.created_at }, ...p]);
        },
      },
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-foreground">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
        />
        <Button onClick={handleAdd} disabled={adding || !input.trim()}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </Button>
      </div>
      <div className="rounded-md border divide-y max-h-72 overflow-auto">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">Nothing here yet.</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-2 p-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-foreground truncate">{r.value}</div>
                <div className="text-xs text-muted-foreground">
                  Added {format(new Date(r.created_at), "MMM d, yyyy")}
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleRemove(r)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function DismissedListsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Dismissed lists</DialogTitle>
          <DialogDescription>
            Manage which domains and emails should never appear as lead suggestions.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="domains" className="mt-2">
          <TabsList className="grid grid-cols-3">
            <TabsTrigger value="domains">Reject domains</TabsTrigger>
            <TabsTrigger value="emails">Reject emails</TabsTrigger>
            <TabsTrigger value="internal">Internal team</TabsTrigger>
          </TabsList>
          <TabsContent value="domains" className="mt-4">
            <ListEditor
              kind="domain"
              title="Always-reject domains"
              description="Emails from these domains will never be suggested as leads."
              placeholder="example.com"
            />
          </TabsContent>
          <TabsContent value="emails" className="mt-4">
            <ListEditor
              kind="email"
              title="Always-reject emails"
              description="Specific addresses that should never be suggested."
              placeholder="noreply@example.com"
            />
          </TabsContent>
          <TabsContent value="internal" className="mt-4">
            <ListEditor
              kind="internal"
              title="Internal team domains"
              description="Your team's own domains. Teammates won't be suggested as leads."
              placeholder="yourcompany.com"
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
