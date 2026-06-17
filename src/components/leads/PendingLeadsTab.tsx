import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "sonner";
import { Check, X, Link2, Inbox, Loader2, Settings2, Ban } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";
import DismissedListsDialog from "./DismissedListsDialog";

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
  return local.replace(/[._-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function domainOf(c: Candidate) {
  return (c.company_domain || c.contact_email.split("@")[1] || "unknown").toLowerCase();
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

// Map a candidate's detected source to the proper lead motion / source_type / stage.
// Inbound-detected candidates (mentioned us / referral) are warm — they must NOT
// land in the cold outbound prospecting playbook. Lookback-seeded candidates are
// historical mail-history matches whose true direction is unknown until we sync
// the thread: default to the warm bucket and demote to outbound_prospecting only
// after backfill proves the rep sent first and the lead never replied.
function deriveLeadDefaults(c: Candidate): {
  motion: "outbound_prospecting" | "inbound_response";
  source_type: "outbound_prospecting" | "gmail_inbound" | "referral" | "manual_entry";
  stage: "new" | "engaged";
} {
  switch (c.source) {
    case "inbound_explicit":
      return { motion: "inbound_response", source_type: "gmail_inbound", stage: "engaged" };
    case "inbound_referral":
      return { motion: "inbound_response", source_type: "referral", stage: "engaged" };
    case "lookback_seed":
      // Warm-by-default: never land a historical contact in cold prospecting.
      // Real direction is reconciled after backfill (see reconcileLookbackMotion).
      return { motion: "inbound_response", source_type: "gmail_inbound", stage: "engaged" };
    case "outbound":
    case "outbound_detection":
    default:
      return { motion: "outbound_prospecting", source_type: "outbound_prospecting", stage: "new" };
  }
}

// Detect which mail provider(s) the lead's owner has connected. Returns the
// providers we should hit for per-lead history backfill.
async function getOwnerMailProviders(ownerUserId: string): Promise<Array<"gmail" | "outlook">> {
  const providers = new Set<"gmail" | "outlook">();
  try {
    const { data } = await supabase
      .from("mail_accounts")
      .select("provider")
      .eq("user_id", ownerUserId)
      .eq("status", "active");
    for (const row of data ?? []) {
      const p = (row as any).provider;
      if (p === "gmail" || p === "google") providers.add("gmail");
      else if (p === "outlook" || p === "microsoft") providers.add("outlook");
    }
  } catch (e) {
    console.warn("[PendingLeads] mail_accounts lookup failed", e);
  }
  // Legacy gmail_connections fallback for older workspaces.
  if (providers.size === 0) {
    try {
      const { data } = await supabase
        .from("gmail_connections")
        .select("id")
        .eq("user_id", ownerUserId)
        .limit(1);
      if ((data ?? []).length > 0) providers.add("gmail");
    } catch {
      /* ignore */
    }
  }
  return Array.from(providers);
}

// Backfill the new lead with prior mail history (interactions + lead_timeline_items)
// and recompute lead intelligence so motion / next_action_key / signals reflect the
// real conversation. Best-effort — failure here must not block approval.
async function backfillLeadHistory(leadId: string, leadEmail: string, ownerUserId: string) {
  const providers = await getOwnerMailProviders(ownerUserId);
  // If we couldn't detect a provider, fall back to gmail (historical default).
  const targets: Array<"gmail" | "outlook"> = providers.length > 0 ? providers : ["gmail"];
  await Promise.all(
    targets.map(async (p) => {
      const fn = p === "outlook" ? "outlook-sync" : "gmail-sync";
      try {
        const { error } = await supabase.functions.invoke(fn, {
          body: { leadId, leadEmail, maxResults: 50 },
        });
        if (error) console.warn(`[PendingLeads] ${fn} backfill failed`, error);
      } catch (e) {
        console.warn(`[PendingLeads] ${fn} backfill threw`, e);
      }
    })
  );
  try {
    await supabase.functions.invoke("recompute-lead-intelligence", {
      body: { lead_id: leadId, force: true },
    });
  } catch (e) {
    console.warn("[PendingLeads] recompute-lead-intelligence failed", e);
  }
}

// After lookback backfill, look at real thread direction and demote to cold
// outbound_prospecting only when the rep sent first and the lead never replied.
// If neither timestamp exists (backfill found nothing), leave the warm default —
// safer than mis-cold-prospecting a contact we know nothing about yet.
async function reconcileLookbackMotion(leadId: string) {
  try {
    const { data } = await supabase
      .from("leads")
      .select("last_inbound_at, first_outbound_at")
      .eq("id", leadId)
      .maybeSingle();
    if (!data) return;
    const hasInbound = !!(data as any).last_inbound_at;
    const hasOutbound = !!(data as any).first_outbound_at;
    if (!hasInbound && hasOutbound) {
      await supabase
        .from("leads")
        .update({ motion: "outbound_prospecting", stage: "engaged" })
        .eq("id", leadId);
    }
  } catch (e) {
    console.warn("[PendingLeads] reconcileLookbackMotion failed", e);
  }
}

async function createLeadFromCandidate(c: Candidate, ownerFallback: string, extraNotes?: string) {
  const ownerUserId = c.owner_user_id || ownerFallback;
  const company = c.company_domain || c.contact_email.split("@")[1] || "Unknown";
  const defaults = deriveLeadDefaults(c);
  const payload: any = {
    name: deriveName(c),
    company,
    email: c.contact_email.toLowerCase(),
    strategy: "fast",
    motion: defaults.motion,
    source_type: defaults.source_type,
    owner_user_id: ownerUserId,
    workspace_id: c.workspace_id,
    stage: defaults.stage,
    last_activity_at: new Date().toISOString(),
    ...(extraNotes ? { personal_notes: extraNotes } : {}),
  };
  const { data, error } = await supabase.from("leads").insert(payload).select("id").single();
  if (error) throw error;
  const leadId = data.id as string;
  const email = c.contact_email.toLowerCase();
  if (c.source === "lookback_seed") {
    // Await backfill so we can reconcile real thread direction before the user
    // sees the lead in (potentially) the wrong playbook.
    await backfillLeadHistory(leadId, email, ownerUserId);
    await reconcileLookbackMotion(leadId);
  } else {
    // Other sources keep responsive UI — backfill is supplementary.
    void backfillLeadHistory(leadId, email, ownerUserId);
  }
  return leadId;
}


export default function PendingLeadsTab({ onApproved }: { onApproved?: () => void }) {
  const { workspaceId } = useWorkspace();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [linkTarget, setLinkTarget] = useState<Candidate | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState(false);
  const [showDismissedLists, setShowDismissedLists] = useState(false);
  const [confirmApproveAll, setConfirmApproveAll] = useState(false);
  const [confirmDomain, setConfirmDomain] = useState<string | null>(null);

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

  // Drop stale selections when list changes
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(candidates.map((c) => c.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [candidates]);

  const removeLocal = (ids: string[] | string) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    setCandidates((prev) => prev.filter((c) => !set.has(c.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      set.forEach((id) => next.delete(id));
      return next;
    });
  };

  const grouped = useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const d = domainOf(c);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(c);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [candidates, groupBy]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id))
    );
  };

  const getCurrentUserId = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Not signed in");
    return user.id;
  };

  const handleApprove = async (c: Candidate) => {
    setBusyId(c.id);
    try {
      const uid = await getCurrentUserId();
      const leadId = await createLeadFromCandidate(c, uid);
      const { error } = await supabase
        .from("lead_candidates")
        .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_lead_id: leadId })
        .eq("id", c.id);
      if (error) throw error;
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

  // ===== Bulk actions =====
  const selectedCandidates = useMemo(
    () => candidates.filter((c) => selected.has(c.id)),
    [candidates, selected]
  );

  const runBulkApprove = async (items: Candidate[], successMsg?: string) => {
    setBulkBusy(true);
    const ids = items.map((c) => c.id);
    const prevSnapshot = candidates;
    removeLocal(ids); // optimistic
    try {
      const uid = await getCurrentUserId();
      let ok = 0;
      let fail = 0;
      // Process with bounded concurrency so lookback_seed approvals (which await
      // mail backfill per lead) don't serialise to a crawl on large batches.
      const CONCURRENCY = 4;
      const queue = [...items];
      const worker = async () => {
        while (queue.length > 0) {
          const c = queue.shift();
          if (!c) break;
          try {
            const leadId = await createLeadFromCandidate(c, uid);
            const { error } = await supabase
              .from("lead_candidates")
              .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_lead_id: leadId })
              .eq("id", c.id);
            if (error) throw error;
            ok++;
          } catch {
            fail++;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
      if (fail === 0) {
        toast.success(successMsg || `Approved ${ok} candidate${ok === 1 ? "" : "s"}`);
      } else {
        toast.error(`Approved ${ok}, failed ${fail}`, {
          action: { label: "Retry", onClick: () => runBulkApprove(items, successMsg) },
        });
        setCandidates(prevSnapshot);
      }
      onApproved?.();
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkApprove = () => {
    if (selectedCandidates.length > 5) {
      setConfirmApproveAll(true);
      return;
    }
    runBulkApprove(selectedCandidates);
  };

  const handleBulkDismiss = async () => {
    setBulkBusy(true);
    const ids = [...selected];
    const prev = candidates;
    removeLocal(ids);
    try {
      const { error } = await supabase
        .from("lead_candidates")
        .update({ status: "dismissed", resolved_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
      toast.success(`Dismissed ${ids.length} candidate${ids.length === 1 ? "" : "s"}`);
    } catch (err: any) {
      setCandidates(prev);
      toast.error(err?.message || "Failed to dismiss", {
        action: { label: "Retry", onClick: handleBulkDismiss },
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const dismissDomainsForSelected = async () => {
    const domains = Array.from(new Set(selectedCandidates.map(domainOf)));
    setBulkBusy(true);
    try {
      const uid = await getCurrentUserId();
      const rows = domains.map((d) => ({
        workspace_id: workspaceId!,
        domain: d,
        dismissed_by_user_id: uid,
      }));
      const { error: insErr } = await supabase
        .from("workspace_dismissed_domains")
        .upsert(rows, { onConflict: "workspace_id,domain", ignoreDuplicates: true });
      if (insErr) throw insErr;

      // Dismiss all pending candidates from these domains for the workspace
      const candIdsToDismiss = candidates
        .filter((c) => domains.includes(domainOf(c)))
        .map((c) => c.id);

      if (candIdsToDismiss.length > 0) {
        const { error: updErr } = await supabase
          .from("lead_candidates")
          .update({ status: "dismissed", resolved_at: new Date().toISOString() })
          .in("id", candIdsToDismiss);
        if (updErr) throw updErr;
        removeLocal(candIdsToDismiss);
      }
      toast.success(`Always rejecting ${domains.length} domain${domains.length === 1 ? "" : "s"}`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to update dismiss list");
    } finally {
      setBulkBusy(false);
      setConfirmDomain(null);
    }
  };

  // Group approve actions
  const approveGroupAsOne = async (items: Candidate[]) => {
    if (items.length === 0) return;
    const [primary, ...rest] = items;
    setBulkBusy(true);
    try {
      const uid = await getCurrentUserId();
      const note =
        rest.length > 0
          ? `Other contacts at ${domainOf(primary)}: ${rest.map((r) => r.contact_email).join(", ")}`
          : undefined;
      const leadId = await createLeadFromCandidate(primary, uid, note);
      const ids = items.map((c) => c.id);
      const { error } = await supabase
        .from("lead_candidates")
        .update({ status: "approved", resolved_at: new Date().toISOString(), resolved_lead_id: leadId })
        .in("id", ids);
      if (error) throw error;
      removeLocal(ids);
      toast.success(`Approved as 1 lead with ${items.length} contact${items.length === 1 ? "" : "s"}`);
      onApproved?.();
    } catch (err: any) {
      toast.error(err?.message || "Failed to approve group");
    } finally {
      setBulkBusy(false);
    }
  };

  // ===== Render =====
  if (isLoading) {
    return <p className="text-muted-foreground py-8 text-center">Loading…</p>;
  }

  const headerBar = (
    <div className="flex flex-wrap items-center gap-3 justify-between">
      <div className="flex items-center gap-3">
        {candidates.length > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={candidates.length > 0 && selected.size === candidates.length}
              onCheckedChange={toggleAll}
            />
            Select all
          </label>
        )}
        <div className="flex items-center gap-2">
          <Switch id="group-by" checked={groupBy} onCheckedChange={setGroupBy} />
          <Label htmlFor="group-by" className="text-sm">Group by company</Label>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => setShowDismissedLists(true)}>
        <Settings2 className="h-4 w-4 mr-2" />
        Dismissed lists
      </Button>
    </div>
  );

  if (candidates.length === 0) {
    return (
      <div className="space-y-4">
        {headerBar}
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="text-foreground font-medium">Nothing pending</p>
          <p className="text-muted-foreground text-sm mt-1">
            New prospects you email will show up here.
          </p>
        </div>
        <DismissedListsDialog open={showDismissedLists} onOpenChange={setShowDismissedLists} />
      </div>
    );
  }

  const selectionBar = selected.size > 0 && (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card p-3 shadow-sm">
      <span className="text-sm font-medium mr-2">{selected.size} selected</span>
      <Button size="sm" disabled={bulkBusy} onClick={handleBulkApprove}>
        <Check className="h-4 w-4 mr-1" /> Approve all
      </Button>
      <Button size="sm" variant="outline" disabled={bulkBusy} onClick={handleBulkDismiss}>
        <X className="h-4 w-4 mr-1" /> Dismiss all
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={bulkBusy}
        onClick={() => {
          const domains = Array.from(new Set(selectedCandidates.map(domainOf)));
          setConfirmDomain(domains.join(", "));
        }}
      >
        <Ban className="h-4 w-4 mr-1" /> Dismiss domain forever
      </Button>
      <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
        Cancel
      </Button>
    </div>
  );

  return (
    <>
      <div className="space-y-4">
        {headerBar}
        {selectionBar}

        {grouped ? (
          <div className="space-y-6">
            {grouped.map(([dom, items]) => (
              <div key={dom} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                  <div className="font-medium text-foreground">
                    {dom} <span className="text-muted-foreground">— {items.length} contact{items.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => approveGroupAsOne(items)}>
                      Approve as 1 lead with {items.length} contact{items.length === 1 ? "" : "s"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => runBulkApprove(items, `Approved ${items.length} separate leads`)}>
                      Approve as {items.length} separate lead{items.length === 1 ? "" : "s"}
                    </Button>
                  </div>
                </div>
                <div className="space-y-3">
                  {items.map((c) => (
                    <CandidateCard
                      key={c.id}
                      c={c}
                      checked={selected.has(c.id)}
                      onToggle={() => toggleOne(c.id)}
                      busy={busyId === c.id || bulkBusy}
                      onApprove={() => handleApprove(c)}
                      onDismiss={() => handleDismiss(c)}
                      onLink={() => setLinkTarget(c)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {candidates.map((c) => (
              <CandidateCard
                key={c.id}
                c={c}
                checked={selected.has(c.id)}
                onToggle={() => toggleOne(c.id)}
                busy={busyId === c.id || bulkBusy}
                onApprove={() => handleApprove(c)}
                onDismiss={() => handleDismiss(c)}
                onLink={() => setLinkTarget(c)}
              />
            ))}
          </div>
        )}
      </div>

      <LinkToLeadDialog
        candidate={linkTarget}
        workspaceId={workspaceId}
        onClose={() => setLinkTarget(null)}
        onPick={(lead) => linkTarget && handleLink(linkTarget, lead)}
      />

      <DismissedListsDialog open={showDismissedLists} onOpenChange={setShowDismissedLists} />

      <AlertDialog open={confirmApproveAll} onOpenChange={setConfirmApproveAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {selectedCandidates.length} candidates as new leads?</AlertDialogTitle>
            <AlertDialogDescription>
              One new lead will be created per candidate. You can still edit them afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmApproveAll(false);
                runBulkApprove(selectedCandidates);
              }}
            >
              Approve {selectedCandidates.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDomain} onOpenChange={(o) => !o && setConfirmDomain(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Always reject emails from {confirmDomain}?</AlertDialogTitle>
            <AlertDialogDescription>
              Existing pending candidates from this domain will be dismissed. Future emails from this
              domain won't be suggested as leads.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={dismissDomainsForSelected}>Always reject</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CandidateCard({
  c,
  checked,
  onToggle,
  busy,
  onApprove,
  onDismiss,
  onLink,
}: {
  c: Candidate;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  onLink: () => void;
}) {
  const name = deriveName(c);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-1" />
          <div className="flex items-start justify-between gap-4 flex-1">
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
                {c.email_count} email{c.email_count === 1 ? "" : "s"} · last{" "}
                {formatDistanceToNow(new Date(c.last_email_at), { addSuffix: true })}
              </div>
            </div>
            <div className="flex flex-col gap-2 shrink-0">
              <Button size="sm" disabled={busy} onClick={onApprove}>
                <Check className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={onLink}>
                <Link2 className="h-4 w-4 mr-1" /> Link
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
                <X className="h-4 w-4 mr-1" /> Dismiss
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
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
