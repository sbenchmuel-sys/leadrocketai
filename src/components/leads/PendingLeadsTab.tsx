import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "sonner";
import { Check, X, Link2, Inbox, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

type Candidate = {
  id: string;
  contact_email: string;
  contact_name: string | null;
  company_domain: string | null;
  source: string;
  ai_score: number | null;
  ai_reason: string | null;
  subject_snippet: string | null;
  body_snippet: string | null;
  email_count: number;
  last_email_at: string;
  owner_user_id: string | null;
  workspace_id: string;
};

type LeadOption = { id: string; name: string; email: string; company: string };

function sourceBadge(source: string) {
  switch (source) {
    case "inbound_explicit":
      return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 hover:bg-blue-100">Mentioned us</Badge>;
    case "inbound_referral":
      return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 hover:bg-green-100">Referred</Badge>;
    case "lookback_seed":
      return <Badge variant="secondary">Historical</Badge>;
    case "outbound":
    default:
      return <Badge variant="outline">Outbound</Badge>;
  }
}

function scorePill(score: number | null) {
  if (score == null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Scoring…
      </span>
    );
  }
  const cls =
    score >= 70
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
      : score >= 40
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      : "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", cls)}>{score}</span>;
}

function deriveName(c: Candidate) {
  if (c.contact_name?.trim()) return c.contact_name.trim();
  const local = c.contact_email.split("@")[0] || c.contact_email;
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function usePendingCandidatesCount() {
  const { workspaceId } = useWorkspace();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const load = async () => {
      const { count: c } = await supabase
        .from("lead_candidates")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("status", "pending");
      if (active) setCount(c ?? 0);
    };
    load();

    const channel = supabase
      .channel(`lead_candidates_count_${workspaceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_candidates", filter: `workspace_id=eq.${workspaceId}` },
        () => load()
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  return count;
}

export default function PendingLeadsTab({ onApproved }: { onApproved?: () => void }) {
  const { workspaceId } = useWorkspace();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<Candidate | null>(null);

  const load = async () => {
    if (!workspaceId) return;
    const { data, error } = await supabase
      .from("lead_candidates")
      .select("id, contact_email, contact_name, company_domain, source, ai_score, ai_reason, subject_snippet, body_snippet, email_count, last_email_at, owner_user_id, workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .order("ai_score", { ascending: false, nullsFirst: false })
      .order("last_email_at", { ascending: false });
    if (error) {
      toast.error("Failed to load pending leads");
      setIsLoading(false);
      return;
    }
    setCandidates((data ?? []) as Candidate[]);
    setIsLoading(false);
  };

  useEffect(() => {
    setIsLoading(true);
    load();

    if (!workspaceId) return;
    const channel = supabase
      .channel(`lead_candidates_list_${workspaceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_candidates", filter: `workspace_id=eq.${workspaceId}` },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const removeLocal = (id: string) => setCandidates((prev) => prev.filter((c) => c.id !== id));

  const handleApprove = async (c: Candidate) => {
    setBusyId(c.id);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const ownerUserId = c.owner_user_id || user?.id;
      if (!ownerUserId) throw new Error("No owner user");

      const company = c.company_domain || c.contact_email.split("@")[1] || "Unknown";
      const insertPayload: any = {
        name: deriveName(c),
        company,
        email: c.contact_email.toLowerCase(),
        strategy: "fast",
        motion: "outbound_prospecting",
        source_type: "lead_candidate",
        owner_user_id: ownerUserId,
        workspace_id: c.workspace_id,
        stage: "new",
        last_activity_at: new Date().toISOString(),
      };

      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .insert(insertPayload)
        .select("id")
        .single();
      if (leadErr) throw leadErr;

      const { error: updErr } = await supabase
        .from("lead_candidates")
        .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_lead_id: lead.id })
        .eq("id", c.id);
      if (updErr) throw updErr;

      removeLocal(c.id);
      toast.success(`Approved ${deriveName(c)}`);
      onApproved?.();
    } catch (err: any) {
      toast.error(err?.message || "Failed to approve");
    } finally {
      setBusyId(null);
    }
  };

  const handleDismiss = async (c: Candidate) => {
    setBusyId(c.id);
    try {
      const { error } = await supabase
        .from("lead_candidates")
        .update({ status: "dismissed", resolved_at: new Date().toISOString() })
        .eq("id", c.id);
      if (error) throw error;
      removeLocal(c.id);
      toast.success("Dismissed. Won't suggest again for 90 days.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to dismiss");
    } finally {
      setBusyId(null);
    }
  };

  const handleLink = async (c: Candidate, lead: LeadOption) => {
    setBusyId(c.id);
    try {
      const { error } = await supabase
        .from("lead_candidates")
        .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_lead_id: lead.id })
        .eq("id", c.id);
      if (error) throw error;
      removeLocal(c.id);
      setLinkTarget(null);
      toast.success(`Linked to ${lead.name}.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to link");
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return <p className="text-muted-foreground py-8 text-center">Loading…</p>;
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Inbox className="h-10 w-10 text-muted-foreground mb-3" />
        <p className="text-foreground font-medium">Nothing pending</p>
        <p className="text-muted-foreground text-sm mt-1">
          New prospects you email will show up here.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {candidates.map((c) => {
          const name = deriveName(c);
          const busy = busyId === c.id;
          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{name}</span>
                      <span className="text-sm text-muted-foreground">{c.contact_email}</span>
                      {sourceBadge(c.source)}
                      {scorePill(c.ai_score)}
                    </div>
                    {c.company_domain && (
                      <div className="text-sm text-muted-foreground mt-1">{c.company_domain}</div>
                    )}
                    {c.ai_reason && (
                      <p className="text-sm text-foreground/80 mt-2 italic">"{c.ai_reason}"</p>
                    )}
                    {(c.subject_snippet || c.body_snippet) && (
                      <div className="mt-2 rounded-md bg-muted/50 p-2 text-sm">
                        {c.subject_snippet && (
                          <div className="font-medium text-foreground truncate">{c.subject_snippet}</div>
                        )}
                        {c.body_snippet && (
                          <div className="text-muted-foreground line-clamp-2">{c.body_snippet}</div>
                        )}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-2">
                      {c.email_count} email{c.email_count === 1 ? "" : "s"} · last {formatDistanceToNow(new Date(c.last_email_at), { addSuffix: true })}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <Button size="sm" disabled={busy} onClick={() => handleApprove(c)}>
                      <Check className="h-4 w-4 mr-1" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setLinkTarget(c)}>
                      <Link2 className="h-4 w-4 mr-1" /> Link
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => handleDismiss(c)}>
                      <X className="h-4 w-4 mr-1" /> Dismiss
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <LinkToLeadDialog
        candidate={linkTarget}
        workspaceId={workspaceId}
        onClose={() => setLinkTarget(null)}
        onPick={(lead) => linkTarget && handleLink(linkTarget, lead)}
      />
    </>
  );
}

function LinkToLeadDialog({
  candidate,
  workspaceId,
  onClose,
  onPick,
}: {
  candidate: Candidate | null;
  workspaceId: string | null;
  onClose: () => void;
  onPick: (lead: LeadOption) => void;
}) {
  const [search, setSearch] = useState("");
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!candidate || !workspaceId) return;
    let active = true;
    setLoading(true);
    const run = async () => {
      let q = supabase
        .from("leads")
        .select("id, name, email, company")
        .eq("workspace_id", workspaceId)
        .order("last_activity_at", { ascending: false })
        .limit(50);
      if (search.trim()) {
        const s = `%${search.trim()}%`;
        q = q.or(`name.ilike.${s},email.ilike.${s}`);
      }
      const { data } = await q;
      if (active) {
        setLeads((data ?? []) as LeadOption[]);
        setLoading(false);
      }
    };
    const t = setTimeout(run, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [candidate, workspaceId, search]);

  return (
    <Dialog open={!!candidate} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Link to existing lead</DialogTitle>
        </DialogHeader>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or email…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>}
            {!loading && leads.length === 0 && <CommandEmpty>No leads found.</CommandEmpty>}
            <CommandGroup>
              {leads.map((l) => (
                <CommandItem
                  key={l.id}
                  value={l.id}
                  onSelect={() => onPick(l)}
                  className="flex flex-col items-start gap-0.5"
                >
                  <span className="font-medium">{l.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {l.email} · {l.company}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
