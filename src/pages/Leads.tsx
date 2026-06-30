// ============================================================================
// /app/leads — merged Leads page (Unit A).
//
// One page, two views toggled by a pill at the top:
//   • All leads — the full lead table (this PR).
//   • To-do     — placeholder; built in Unit B.
//
// Data comes from ONE source: getDashboardMetrics() (enriched leads, with the
// non-admin owner filter applied in the service). The old standalone Leads
// fetch (getLeadsList) is no longer used here. Counts therefore match whatever
// the To-do view will show off the same source.
//
// Guardrail: "Draft emails" generates drafts the rep reviews + sends manually
// (EmailActionDialog). Generated drafts are NEVER handed to the automated
// sender.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createLead, deleteLead, type CreateLeadInput } from "@/lib/supabaseQueries";
import { getDashboardMetrics } from "@/lib/dashboardMetricsService";
import type { EnrichedLead } from "@/lib/dashboardUtils";
import { leadStatus, isInAutomation, isNewLead } from "@/lib/leadStatus";
import { updateMotionFromTable, updateSourceFromTable, type SourcePresetKey } from "@/lib/motionUpdater";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Search, Trash2, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useBackgroundDraftQueue } from "@/hooks/useBackgroundDraftQueue";
import { LeadImportDialog } from "@/components/leads/LeadImportDialog";
import PendingLeadsTab, { usePendingCandidatesCount } from "@/components/leads/PendingLeadsTab";
import { AddToAutomationDialog } from "@/components/leads/AddToAutomationDialog";
import { ShowMoreFooter } from "@/components/leads/ShowMoreFooter";
import { TodoView } from "@/components/leads/TodoView";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { useMailSync } from "@/hooks/useMailSync";

type ViewMode = "todo" | "all";
type Chip = "all" | "new" | "automation";

const LEADS_PAGE_SIZE = 25;

const SOURCE_PRESETS: { key: SourcePresetKey; label: string }[] = [
  { key: "outbound", label: "Outbound Prospect" },
  { key: "inbound_website", label: "Inbound – Website" },
  { key: "event", label: "Event Lead" },
  { key: "referral", label: "Referral" },
  { key: "other", label: "Manual" },
];

export default function Leads() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const { enqueue, getStatus, consume } = useBackgroundDraftQueue();

  const [view, setView] = useState<ViewMode>("all");
  const [subTab, setSubTab] = useState<"leads" | "pending">("leads");

  const [leads, setLeads] = useState<EnrichedLead[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  const [visibleCount, setVisibleCount] = useState(LEADS_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newLead, setNewLead] = useState<CreateLeadInput>({
    name: "",
    company: "",
    email: "",
    source_type: "manual_entry",
  });

  const [deleteTarget, setDeleteTarget] = useState<EnrichedLead | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [addToAutomationOpen, setAddToAutomationOpen] = useState(false);

  // Draft review dialog (opened from a "Draft ready" tag).
  const [draftLead, setDraftLead] = useState<EnrichedLead | null>(null);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);

  const pendingCount = usePendingCandidatesCount();

  // Manual "Refresh": pull new mail for the leads currently on screen, then
  // reload the list. Sync also runs automatically server-side every ~20 min —
  // this is just the on-demand nudge. The whole control is hidden when no
  // mailbox is connected (see header).
  const { isConnected: mailConnected, isLoading: mailLoading, syncLeads, activeAccount, providerLabel } = useMailSync(workspaceId);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  // Monotonic load token — only the most recent load may apply its result, so a
  // slower stale response (e.g. the initial null-workspace load) can't overwrite
  // a newer active-workspace load and briefly show another workspace's leads
  // (Codex P2 on PR #107).
  const loadTokenRef = useRef(0);

  const loadLeads = async () => {
    const token = ++loadTokenRef.current;
    try {
      // Pass the active workspace so the fetch is scoped to it (Codex PR #107) —
      // a multi-workspace member won't see leads they own in other workspaces.
      const m = await getDashboardMetrics(workspaceId);
      if (loadTokenRef.current !== token) return; // superseded — ignore stale result
      setLeads(m.leads);
    } catch {
      if (loadTokenRef.current === token) toast.error("Failed to load leads");
    } finally {
      if (loadTokenRef.current === token) setIsLoading(false);
    }
  };

  // Refetch when the active workspace resolves or changes. On first mount
  // workspaceId is often still undefined (WorkspaceProvider resolves async), so
  // without this dependency the initial load wouldn't be workspace-scoped and
  // would never correct itself (Codex P1 on PR #107).
  useEffect(() => {
    loadLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // ── Filtering ──────────────────────────────────────────────────────────
  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return leads.filter((lead) => {
      if (chip === "new" && !isNewLead(lead)) return false;
      if (chip === "automation" && !isInAutomation(lead)) return false;
      if (!q) return true;
      return (
        lead.name.toLowerCase().includes(q) ||
        (lead.company || "").toLowerCase().includes(q) ||
        (lead.email || "").toLowerCase().includes(q)
      );
    });
  }, [leads, chip, searchQuery]);

  // Chip counts come off the full set (not the search), so they're stable.
  const chipCounts = useMemo(
    () => ({
      all: leads.length,
      new: leads.filter(isNewLead).length,
      automation: leads.filter(isInAutomation).length,
    }),
    [leads],
  );

  // Pagination: render 25 at a time with Show next / Show all. Reset back to
  // the first page whenever the search or chip narrows the list.
  useEffect(() => {
    setVisibleCount(LEADS_PAGE_SIZE);
  }, [searchQuery, chip]);

  const pageLeads = useMemo(
    () => filteredLeads.slice(0, visibleCount),
    [filteredLeads, visibleCount],
  );

  // Drop stale selections when the visible list changes.
  useEffect(() => {
    setSelectedIds((prev) => {
      const visible = new Set(filteredLeads.map((l) => l.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredLeads]);

  const allVisibleSelected =
    pageLeads.length > 0 && pageLeads.every((l) => selectedIds.has(l.id));

  const toggleSelectAll = () => {
    setSelectedIds(allVisibleSelected ? new Set() : new Set(pageLeads.map((l) => l.id)));
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // "Updated N ago" hint — shows the most recent of a manual refresh in this
  // session or the mailbox's own last sync. Hidden if neither is known.
  const lastUpdatedAt = refreshedAt ?? activeAccount?.last_sync_at ?? null;

  const handleRefresh = async () => {
    // Only refresh what's on screen — the leads currently rendered that have an
    // email address. Server-side sync covers the rest of the book on its own.
    const ids = pageLeads.filter((l) => l.email).map((l) => l.id);
    if (ids.length === 0) {
      toast.success("You're up to date");
      return;
    }
    setIsRefreshing(true);
    try {
      const result = await syncLeads(ids, workspaceId);
      if (result.needsReconnect) {
        toast.error(`${providerLabel} needs reconnecting`, {
          description: "Reconnect your mailbox in Settings, then try Refresh again.",
        });
        return;
      }
      if (!result.ok) {
        toast.error("Couldn't refresh — please try again");
        return;
      }
      await loadLeads();
      setRefreshedAt(new Date().toISOString());
      toast.success(
        result.totalSynced > 0
          ? `${result.totalSynced} new ${result.totalSynced === 1 ? "reply" : "replies"}`
          : "You're up to date",
      );
    } finally {
      setIsRefreshing(false);
    }
  };

  // ── Add lead ───────────────────────────────────────────────────────────
  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createLead({ ...newLead, workspace_id: workspaceId });
      toast.success("Lead created!");
      setIsAddOpen(false);
      setNewLead({ name: "", company: "", email: "", source_type: "manual_entry" });
      loadLeads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create lead");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────
  const handleDeleteLead = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteLead(deleteTarget.id);
      toast.success("Lead deleted");
      setDeleteTarget(null);
      loadLeads();
    } catch {
      toast.error("Failed to delete lead");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    try {
      await Promise.all(Array.from(selectedIds).map((id) => deleteLead(id)));
      toast.success(`${selectedIds.size} lead(s) deleted`);
      setSelectedIds(new Set());
      setShowBulkDeleteDialog(false);
      loadLeads();
    } catch {
      toast.error("Failed to delete some leads");
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Draft emails (bulk) ────────────────────────────────────────────────
  const handleDraftEmails = () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    ids.forEach((id) => enqueue(id));
    toast.success(`Drafting ${ids.length} email${ids.length === 1 ? "" : "s"}…`);
    setSelectedIds(new Set());
  };

  const openDraft = (lead: EnrichedLead) => {
    // Clear the "Draft ready" indicator now that the rep is acting on it, then
    // open the composer WITHOUT prefill so it generates (which hydrates reply
    // threading). The bulk pre-draft already warmed the draft cache, so this is
    // fast. Passing prefill would skip the dialog's threading hydration and send
    // replies as new, unthreaded emails (Codex P1 on PR #108).
    consume(lead.id);
    setDraftLead(lead);
    setDraftDialogOpen(true);
  };

  // ── Move to Nurture (bulk) ─────────────────────────────────────────────
  const handleMoveToNurture = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    try {
      const results = await Promise.all(ids.map((id) => updateMotionFromTable(id, "Nurture")));
      const ok = results.filter(Boolean).length;
      if (ok > 0) toast.success(`Moved ${ok} lead(s) to Nurture`);
      if (ok < ids.length) toast.warning(`${ids.length - ok} lead(s) couldn't be moved`);
      setSelectedIds(new Set());
      loadLeads();
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Change source (bulk) ───────────────────────────────────────────────
  const handleChangeSource = async (preset: SourcePresetKey) => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    try {
      const results = await Promise.all(ids.map((id) => updateSourceFromTable(id, preset)));
      const ok = results.filter(Boolean).length;
      if (ok > 0) toast.success(`Updated source for ${ok} lead(s)`);
      if (ok < ids.length) toast.warning(`${ids.length - ok} lead(s) couldn't be updated`);
      setSelectedIds(new Set());
      loadLeads();
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────
  const chipClass = (active: boolean) =>
    cn(
      "rounded-full px-3 py-1 text-xs font-medium",
      active
        ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        : "border border-border bg-background text-muted-foreground hover:text-foreground",
    );

  const renderDraftTag = (lead: EnrichedLead) => {
    const ds = getStatus(lead.id);
    if (!ds) return null;
    if (ds.status === "generating") {
      return <span className="text-xs text-muted-foreground">Drafting…</span>;
    }
    if (ds.status === "ready") {
      return (
        <button
          type="button"
          onClick={() => openDraft(lead)}
          className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300"
        >
          Draft ready
        </button>
      );
    }
    if (ds.status === "error") {
      return (
        <button
          type="button"
          onClick={() => enqueue(lead.id)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Draft failed — retry
        </button>
      );
    }
    return null;
  };

  // ── Markup ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Leads</h1>
        <div className="flex items-center gap-2">
          {/* Refresh — quiet outline action, left of Import/Add so "Add Lead"
              stays the loud primary. Hidden entirely when no mailbox is
              connected. The muted "Updated …" line is desktop-only to keep the
              one-handed mobile header uncluttered. Only shown on the all-leads
              list (it refreshes those rows); the To-do and Pending views own a
              different data path, so Refresh would target the wrong set there. */}
          {view === "all" && subTab === "leads" && mailConnected && !mailLoading && (
            <>
              {lastUpdatedAt && (
                <span className="hidden sm:inline text-xs text-muted-foreground">
                  Updated {formatDistanceToNow(new Date(lastUpdatedAt), { addSuffix: true })}
                </span>
              )}
              <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
                {isRefreshing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Refreshing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Refresh
                  </>
                )}
              </Button>
            </>
          )}
          <LeadImportDialog onImportComplete={loadLeads} />
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Lead
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Lead</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleAddLead} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={newLead.name}
                    onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
                    placeholder="John Smith"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    value={newLead.company}
                    onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
                    placeholder="Acme Corp"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={newLead.email}
                    onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
                    placeholder="john@acme.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="source_type">Source</Label>
                  <Select
                    value={newLead.source_type || "manual_entry"}
                    onValueChange={(value) =>
                      setNewLead({ ...newLead, source_type: value as CreateLeadInput["source_type"] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual_entry">Manual Entry</SelectItem>
                      <SelectItem value="outbound_prospecting">Outbound Prospecting</SelectItem>
                      <SelectItem value="contact_form">Contact Form</SelectItem>
                      <SelectItem value="gmail_inbound">Inbound Email</SelectItem>
                      <SelectItem value="event_lead">Event Lead</SelectItem>
                      <SelectItem value="referral">Referral</SelectItem>
                      <SelectItem value="csv_import">CSV Import</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? "Creating..." : "Create Lead"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* View toggle — white pill on a light gray track */}
      <div className="inline-flex rounded-lg bg-muted p-0.5">
        {(["todo", "all"] as ViewMode[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium",
              view === v ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "todo" ? "To-do" : "All leads"}
          </button>
        ))}
      </div>

      {view === "todo" ? (
        <TodoView />
      ) : (
        <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "leads" | "pending")} className="space-y-4">
          <TabsList>
            <TabsTrigger value="leads">Leads</TabsTrigger>
            <TabsTrigger value="pending" className="gap-2">
              Pending
              {pendingCount > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {pendingCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="leads" className="space-y-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Find any lead by name or company"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {/* Filter chips */}
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setChip("new")} className={chipClass(chip === "new")}>
                New · {chipCounts.new}
              </button>
              <button
                type="button"
                onClick={() => setChip("automation")}
                className={chipClass(chip === "automation")}
              >
                In outreach · {chipCounts.automation}
              </button>
              <button type="button" onClick={() => setChip("all")} className={chipClass(chip === "all")}>
                All · {chipCounts.all}
              </button>
            </div>

            {/* Selection bar */}
            {selectedIds.size > 0 && (
              <div className="flex items-center justify-between gap-3 rounded-md bg-blue-50 px-4 py-2.5 dark:bg-blue-950/40">
                <span className="text-sm font-medium text-blue-900 dark:text-blue-200">
                  {selectedIds.size} selected
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={bulkBusy} onClick={() => setAddToAutomationOpen(true)}>
                    Add to outreach
                  </Button>
                  <Button size="sm" variant="outline" disabled={bulkBusy} onClick={handleDraftEmails}>
                    Draft emails
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" disabled={bulkBusy}>
                        {bulkBusy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        More
                        <ChevronDown className="h-3.5 w-3.5 ml-1" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={handleMoveToNurture}>Move to Nurture</DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Change source</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {SOURCE_PRESETS.map((s) => (
                            <DropdownMenuItem key={s.key} onClick={() => handleChangeSource(s.key)}>
                              {s.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setShowBulkDeleteDialog(true)}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )}

            {/* Table */}
            {isLoading ? (
              <p className="text-muted-foreground py-8 text-center">Loading…</p>
            ) : filteredLeads.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {searchQuery || chip !== "all" ? "No leads match this filter" : "No leads yet. Add your first lead!"}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead className="w-[40px]">
                        <Checkbox checked={allVisibleSelected} onCheckedChange={toggleSelectAll} />
                      </TableHead>
                      <TableHead>Lead</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last reply</TableHead>
                      <TableHead>Auto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageLeads.map((lead) => {
                      const status = leadStatus(lead);
                      const auto = isInAutomation(lead);
                      return (
                        <TableRow key={lead.id} className="hover:bg-accent/50">
                          <TableCell className="py-3">
                            <Checkbox
                              checked={selectedIds.has(lead.id)}
                              onCheckedChange={() => toggleSelect(lead.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </TableCell>
                          <TableCell className="py-3">
                            <Link
                              to={`/app/leads/${lead.id}`}
                              state={{ originContext: "leads" }}
                              className="font-semibold text-foreground hover:underline"
                            >
                              {lead.name}
                            </Link>
                            <div className="text-xs text-muted-foreground">{lead.company}</div>
                            <div className="mt-1 empty:hidden">{renderDraftTag(lead)}</div>
                          </TableCell>
                          <TableCell className="py-3">
                            <span className={cn("text-sm font-medium", status.className)}>{status.label}</span>
                          </TableCell>
                          <TableCell className="py-3 text-sm text-muted-foreground">
                            {lead.last_inbound_at
                              ? formatDistanceToNow(new Date(lead.last_inbound_at), { addSuffix: true })
                              : "—"}
                          </TableCell>
                          <TableCell className="py-3">
                            <span
                              className={cn(
                                "text-sm font-medium",
                                auto ? "text-green-600 dark:text-green-400" : "text-muted-foreground",
                              )}
                            >
                              {auto ? "On" : "Off"}
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <ShowMoreFooter
                  shown={pageLeads.length}
                  total={filteredLeads.length}
                  pageSize={LEADS_PAGE_SIZE}
                  onShowMore={() => setVisibleCount((c) => c + LEADS_PAGE_SIZE)}
                  onShowAll={() => setVisibleCount(filteredLeads.length)}
                />
              </div>
            )}
          </TabsContent>

          <TabsContent value="pending">
            <PendingLeadsTab onApproved={loadLeads} />
          </TabsContent>
        </Tabs>
      )}

      {/* Add to automation */}
      <AddToAutomationDialog
        open={addToAutomationOpen}
        onOpenChange={setAddToAutomationOpen}
        leadIds={Array.from(selectedIds)}
        onEnrolled={() => {
          setSelectedIds(new Set());
          loadLeads();
        }}
      />

      {/* Draft review */}
      {draftLead && (
        <EmailActionDialog
          lead={draftLead}
          open={draftDialogOpen}
          actionKey={draftLead.next_action_key ?? undefined}
          onOpenChange={(open) => {
            setDraftDialogOpen(open);
            if (!open) {
              setDraftLead(null);
              loadLeads();
            }
          }}
        />
      )}

      {/* Single delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lead</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong> from{" "}
              <strong>{deleteTarget?.company}</strong>? This will permanently remove all associated
              data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteLead}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk delete confirm */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Lead(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{selectedIds.size}</strong> selected lead(s)?
              This will permanently remove all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : `Delete ${selectedIds.size} Lead(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
