// Lead Scout (Unit 3): weekly batch review in the Pending tab + the "Why this
// lead" card on Lead Detail.
//
// Rendered only when scout_enabled (the caller passes useLeadScout().enabled).
// Approving calls the scout-enrich edge function — never the client-side
// createLeadFromCandidate — because approval spends Apollo/Lusha credits and
// must run the opt-out filters again once the email is known.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { format, parseISO } from "date-fns";
import { Check, Linkedin, MoreVertical, Target, X } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DOWNVOTE_REASONS } from "@shared/scoutProfile";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLeadScout } from "./LeadScoutPanel";

// ponytail: scout columns/tables aren't in the generated types.ts yet (prod
// hasn't applied the Lead Scout migrations). Untyped client + narrow row types
// until Lovable regenerates; then drop the cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export interface ScoutCandidate {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  company_domain: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  ai_reason: string | null;
  fit_label: string | null;
  scout_batch_id: string | null;
  created_at: string;
}

export const SCOUT_CANDIDATE_COLS =
  "id, contact_name, company_name, company_domain, job_title, linkedin_url, ai_reason, fit_label, scout_batch_id, created_at";

interface BatchMeta {
  slot_key: string | null;
  profile_id: string | null;
  /** Unit 4 learning step's one line; absent on DBs without the column. */
  learned_note?: string | null;
}
interface ProfileMeta {
  id: string;
  owner_user_id: string;
  profile_sentence: string | null;
  approved_batches: number;
  auto_approve: boolean;
}

export interface EnrichResult {
  added: number;
  skipped_no_email: number;
  skipped_other: number;
  retry: number;
}

/** "23 added · 2 skipped (no verified email)". */
export function scoutToastText(r: EnrichResult): string {
  const parts = [`${r.added} added`];
  if (r.skipped_no_email) parts.push(`${r.skipped_no_email} skipped (no verified email)`);
  if (r.skipped_other) parts.push(`${r.skipped_other} skipped (already known or blocked)`);
  if (r.retry) parts.push(`${r.retry} not done, try again`);
  return parts.join(" · ");
}

/** "Week of Nov 9" from the batch's workspace-local Monday (or the row date). */
export function weekOfLabel(slotKey: string | null | undefined, fallbackIso: string): string {
  const day = slotKey && /^\d{4}-\d{2}-\d{2}$/.test(slotKey) ? parseISO(slotKey) : new Date(fallbackIso);
  return `Week of ${format(day, "MMM d")}`;
}

/** Candidates → batches, newest first, in their original order inside a batch. */
export function groupScoutBatches<T extends { scout_batch_id: string | null; created_at: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.scout_batch_id ?? "none";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()].sort((a, b) => b[1][0].created_at.localeCompare(a[1][0].created_at));
}

/**
 * Queue nudge items: one per pending batch (newest first), none when Scout is
 * off, minus batches snoozed until after `nowMs`.
 */
export function scoutNudges<T extends { scout_batch_id: string | null; created_at: string }>(
  enabled: boolean,
  rows: T[],
  snoozedUntil: Record<string, number>,
  nowMs: number,
): Array<{ batchId: string; count: number }> {
  if (!enabled) return [];
  return groupScoutBatches(rows)
    .filter(([id]) => id !== "none" && !((snoozedUntil[id] ?? 0) > nowMs))
    .map(([batchId, items]) => ({ batchId, count: items.length }));
}

async function enrich(workspaceId: string, ids: string[]): Promise<EnrichResult | "limit" | null> {
  try {
    const { data, error } = await supabase.functions.invoke("scout-enrich", {
      body: { workspace_id: workspaceId, candidate_ids: ids },
    });
    if (data?.reason === "credit_ceiling") return "limit";
    return error || !data?.ok ? null : (data as EnrichResult);
  } catch {
    return null;
  }
}

const offerKey = (profileId: string) => `scoutAutoOfferHidden:${profileId}`;

export function ScoutBatches({
  rows: allRows,
  workspaceId,
  onChanged,
  onlyBatchId,
}: {
  rows: ScoutCandidate[];
  workspaceId: string;
  /** From the Queue nudge (?batch=): show just that batch while it still has rows. */
  onlyBatchId?: string | null;
  /** Rows were approved/dismissed: reload the list (and the lead list). */
  onChanged: (approved: boolean) => void;
}) {
  const { user } = useAuth();
  const [batches, setBatches] = useState<Record<string, BatchMeta>>({});
  const [profiles, setProfiles] = useState<Record<string, ProfileMeta>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ batchId: string; ids: string[] } | null>(null);
  // Just-dismissed cards stay as a one-line row with optional reason chips.
  const [dismissed, setDismissed] = useState<Array<ScoutCandidate & { reason: string | null }>>([]);
  const [offerHidden, setOfferHidden] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => (onlyBatchId && allRows.some((r) => r.scout_batch_id === onlyBatchId)
      ? allRows.filter((r) => r.scout_batch_id === onlyBatchId)
      : allRows),
    [allRows, onlyBatchId],
  );
  const grouped = useMemo(() => groupScoutBatches(rows), [rows]);
  const batchIds = useMemo(() => grouped.map(([id]) => id).filter((id) => id !== "none"), [grouped]);

  const loadMeta = useCallback(async () => {
    if (!batchIds.length) return;
    try {
      // "*" so a DB without the newer learned_note column still loads the header.
      const { data: runs } = await db.from("scout_runs").select("*").in("id", batchIds);
      const meta = Object.fromEntries(((runs ?? []) as Array<BatchMeta & { id: string }>).map((r) => [r.id, r]));
      setBatches(meta);
      const pids = [...new Set(Object.values(meta).map((m) => m.profile_id).filter((x): x is string => !!x))];
      if (!pids.length) return;
      const { data: profs } = await db.from("scout_profiles")
        .select("id, owner_user_id, profile_sentence, approved_batches, auto_approve").in("id", pids);
      setProfiles(Object.fromEntries(((profs ?? []) as ProfileMeta[]).map((p) => [p.id, p])));
    } catch {
      /* header falls back to the row date */
    }
  }, [batchIds]);
  useEffect(() => { void loadMeta(); }, [loadMeta]);

  const mark = (ids: string[], on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  const approve = async (ids: string[]) => {
    mark(ids, true);
    const res = await enrich(workspaceId, ids);
    mark(ids, false);
    if (res === "limit") {
      toast.error("Lead Scout has reached this month's limit. Adding leads resumes next month.");
      return;
    }
    if (!res) {
      toast.error("Couldn't add those leads. Please try again.");
      return;
    }
    if (res.added) toast.success(scoutToastText(res));
    else toast(scoutToastText(res));
    onChanged(res.added > 0);
  };

  const dismiss = async (c: ScoutCandidate) => {
    mark([c.id], true);
    const { error } = await db.from("lead_candidates")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", c.id).eq("status", "pending");
    mark([c.id], false);
    if (error) {
      toast.error("Couldn't dismiss. Please try again.");
      return;
    }
    setDismissed((prev) => [...prev, { ...c, reason: null }]);
    onChanged(false);
  };

  const setReason = async (id: string, reason: string) => {
    setDismissed((prev) => prev.map((d) => (d.id === id ? { ...d, reason } : d)));
    // Optional and never blocking: a failed save just isn't recorded.
    await db.from("lead_candidates").update({ dismiss_reason: reason }).eq("id", id);
  };

  const turnOnAuto = async (p: ProfileMeta) => {
    const { error } = await db.from("scout_profiles").update({ auto_approve: true }).eq("id", p.id);
    if (error) return toast.error("Couldn't change that. Please try again.");
    toast.success("New batches will be added automatically.");
    setProfiles((prev) => ({ ...prev, [p.id]: { ...p, auto_approve: true } }));
  };
  const hideOffer = (profileId: string) => {
    setOfferHidden((prev) => new Set(prev).add(profileId));
    try { localStorage.setItem(offerKey(profileId), "1"); } catch { /* private mode: this visit only */ }
  };
  const offerVisible = (p: ProfileMeta | undefined): p is ProfileMeta => {
    if (!p || p.auto_approve || p.approved_batches < 2 || p.owner_user_id !== user?.id || offerHidden.has(p.id)) return false;
    try { return localStorage.getItem(offerKey(p.id)) !== "1"; } catch { return true; }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>, c: ScoutCandidate) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey || busy.has(c.id)) return;
    const k = e.key.toLowerCase();
    if (k === "a") { e.preventDefault(); void approve([c.id]); }
    else if (k === "d") { e.preventDefault(); void dismiss(c); }
  };

  if (!grouped.length && !dismissed.length) return null;

  return (
    <div className="space-y-6">
      {grouped.map(([batchId, items]) => {
        const meta = batches[batchId];
        const profile = meta?.profile_id ? profiles[meta.profile_id] : undefined;
        const ids = items.map((c) => c.id);
        const anyBusy = ids.some((id) => busy.has(id));
        return (
          <section key={batchId} className="space-y-2" aria-label="Leads found by DrivePilot">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
              <div className="min-w-0">
                <div className="font-medium text-foreground">
                  {weekOfLabel(meta?.slot_key, items[0].created_at)} · {items.length} lead{items.length === 1 ? "" : "s"}
                </div>
                {profile?.profile_sentence && (
                  <p className="truncate text-sm text-muted-foreground">{profile.profile_sentence}</p>
                )}
                {meta?.learned_note && (
                  <p className="text-sm text-muted-foreground">What I learned: {meta.learned_note}</p>
                )}
              </div>
              <Button disabled={anyBusy} onClick={() => setConfirm({ batchId, ids })}>
                <Check className="mr-1 h-4 w-4" /> Approve all
              </Button>
            </div>
            {offerVisible(profile) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Add batches automatically from now on?</span>
                <Button size="sm" variant="link" className="h-auto p-0" onClick={() => turnOnAuto(profile)}>Yes</Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Don't ask again" onClick={() => hideOffer(profile.id)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <div className="space-y-3">
              {items.map((c) => (
                <ScoutCard
                  key={c.id}
                  c={c}
                  busy={busy.has(c.id)}
                  onApprove={() => approve([c.id])}
                  onDismiss={() => dismiss(c)}
                  onKeyDown={(e) => onKey(e, c)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {dismissed.length > 0 && (
        <div className="space-y-2">
          {dismissed.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
              <span>Dismissed {d.contact_name ?? "lead"}.</span>
              {d.reason ? (
                <span>Thanks, noted.</span>
              ) : (
                <>
                  <span>Why? (optional)</span>
                  {DOWNVOTE_REASONS.map((r) => (
                    <Button key={r} size="sm" variant="outline" className="h-8 rounded-full px-3" onClick={() => setReason(d.id, r)}>
                      {r}
                    </Button>
                  ))}
                </>
              )}
              <Button size="icon" variant="ghost" className="ml-auto h-8 w-8" aria-label="Close"
                onClick={() => setDismissed((prev) => prev.filter((x) => x.id !== d.id))}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add {confirm?.ids.length} lead{confirm?.ids.length === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>DrivePilot will look up their contact details.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const ids = confirm?.ids ?? [];
                setConfirm(null);
                void approve(ids);
              }}
            >
              Add {confirm?.ids.length}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ScoutCard({
  c, busy, onApprove, onDismiss, onKeyDown,
}: {
  c: ScoutCandidate;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const company = c.company_name || c.company_domain;
  const line = [c.job_title, company].filter(Boolean).join(" · ");
  return (
    <Card tabIndex={0} onKeyDown={onKeyDown} className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{c.contact_name ?? "Unknown"}</span>
            {c.linkedin_url && (
              <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" aria-label="LinkedIn profile"
                className="text-muted-foreground hover:text-foreground">
                <Linkedin className="h-4 w-4" />
              </a>
            )}
            {c.fit_label === "high" && <Badge variant="secondary">Strong match</Badge>}
          </div>
          {line && <div className="mt-1 text-sm text-muted-foreground">{line}</div>}
          {c.ai_reason && <p className="mt-2 text-sm text-foreground/80">{c.ai_reason}</p>}
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button size="sm" disabled={busy} onClick={onApprove}>
            <Check className="mr-1 h-4 w-4" /> Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            <X className="mr-1 h-4 w-4" /> Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Lead Detail: "Why this lead" ────────────────────────────────────────────

interface ScoutWhy {
  reason?: string | null;
  profile_sentence?: string | null;
  enriched_at?: string | null;
}

/** ≤2 lines from leads.raw_import_json.scout. Renders nothing for other sources. */
export function ScoutWhyCard({ leadId, sourceType }: { leadId: string; sourceType: string | null | undefined }) {
  const [why, setWhy] = useState<ScoutWhy | null>(null);
  useEffect(() => {
    setWhy(null);
    if (sourceType !== "ai_scout") return;
    let active = true;
    void (async () => {
      try {
        const { data } = await db.from("leads").select("scout:raw_import_json->scout").eq("id", leadId).maybeSingle();
        if (active && data?.scout && typeof data.scout === "object") setWhy(data.scout as ScoutWhy);
      } catch { /* nothing to show */ }
    })();
    return () => { active = false; };
  }, [leadId, sourceType]);
  if (!why?.reason) return null;
  const found = why.enriched_at ? ` · ${format(new Date(why.enriched_at), "MMM d")}` : "";
  return (
    <Card>
      <CardContent className="p-3 text-sm">
        <p className="line-clamp-1"><span className="font-medium">Why this lead: </span>{why.reason}</p>
        <p className="line-clamp-1 text-muted-foreground">Found by DrivePilot{found}{why.profile_sentence ? ` · ${why.profile_sentence}` : ""}</p>
      </CardContent>
    </Card>
  );
}

// ── Queue: "N new leads ready for you" ──────────────────────────────────────

const SNOOZE_KEY = "scoutNudgeSnoozes";
// ponytail: the Queue's lead snooze writes leads.action_dismissed_at, which a
// batch doesn't have, so a batch snooze is remembered per browser. Upgrade: a
// snoozed_until column on scout_runs if reps ask for it to follow them.
function readSnoozes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

/** One Queue item per pending Scout batch owned by this rep. Hidden when Scout is off. */
export function ScoutQueueNudge() {
  const { user } = useAuth();
  const scout = useLeadScout();
  const [rows, setRows] = useState<Array<{ scout_batch_id: string | null; created_at: string }>>([]);
  const [snoozed, setSnoozed] = useState<Record<string, number>>(readSnoozes);

  useEffect(() => {
    setRows([]);
    if (!scout.enabled || !scout.workspaceId || !user) return;
    let live = true;
    void (async () => {
      try {
        const { data, error } = await db.from("lead_candidates").select("scout_batch_id, created_at")
          .eq("workspace_id", scout.workspaceId).eq("source", "ai_scout").eq("status", "pending")
          .eq("owner_user_id", user.id).order("created_at", { ascending: true }).limit(500);
        if (live && !error) setRows(data ?? []);
      } catch { /* any error = no nudge */ }
    })();
    return () => { live = false; };
  }, [scout.enabled, scout.workspaceId, user]);

  const snooze = (batchId: string, days: 3 | 5 | 7) => {
    const next = { ...snoozed, [batchId]: Date.now() + days * 86_400_000 };
    setSnoozed(next);
    try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(next)); } catch { /* this visit only */ }
    toast.success(`Snoozed for ${days} days`);
  };

  const nudges = scoutNudges(scout.enabled, rows, snoozed, Date.now());
  if (!nudges.length) return null;
  return (
    <div className="space-y-2">
      {nudges.map((n) => (
        <Card key={n.batchId}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Target className="h-4 w-4 text-primary" aria-hidden />
              {n.count} new lead{n.count === 1 ? "" : "s"} ready for you — 2 min to review
            </div>
            <div className="flex items-center gap-2">
              <Button asChild size="sm">
                <Link to={`/app/leads?tab=pending&batch=${encodeURIComponent(n.batchId)}`}>Review leads</Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" variant="outline" className="h-8 text-xs">
                    Snooze <MoreVertical className="ml-1 h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => snooze(n.batchId, 3)}>Snooze 3 days</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => snooze(n.batchId, 5)}>Snooze 5 days</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => snooze(n.batchId, 7)}>Snooze 7 days</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
