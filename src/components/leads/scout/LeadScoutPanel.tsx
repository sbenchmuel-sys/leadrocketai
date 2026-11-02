// Lead Scout (Unit 2): entry card, setup wizard and active-profile summary.
//
// Everything here renders ONLY when workspace_automation_settings.scout_enabled
// is true for the current workspace. Any error reading it (missing column on a
// database without the Lead Scout migration, missing row, network) = off,
// silently — no toast. The profile sentence + chips come from the shared
// @shared/scoutProfile helpers so they always match what the edge functions build.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_TZ } from "@shared/scoutWeekly";
import {
  clampProfile,
  DOWNVOTE_REASONS,
  profileSegments,
  profileSentence,
  removeChip,
  type ScoutProfile,
} from "@shared/scoutProfile";

// ponytail: scout_profiles and the scout_* settings columns aren't in the
// generated types.ts yet (prod hasn't applied the Unit 1 migration). Untyped
// client + these narrow row types until Lovable regenerates; then drop the cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

interface ProfileRow {
  id: string;
  owner_user_id: string;
  status: "draft" | "active" | "paused";
  profile_json: unknown;
  profile_sentence: string | null;
  weekly_target: number;
  delivery_dow: number;
  delivery_hour: number;
}

const WEEKLY_STOPS = [10, 25, 50, 100];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
const deliveryLine = (dow: number, hour: number) => `Arrives ${DAYS[dow]}s at ${hourLabel(hour)}`;

// ── State hook (one per Lead List page) ─────────────────────────────────────

export function useLeadScout() {
  const { user } = useAuth();
  const { workspaceId, workspaceTimezone } = useWorkspace();
  const [enabled, setEnabled] = useState(false);
  const [cap, setCap] = useState(0);
  const [othersTarget, setOthersTarget] = useState(0);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(async () => {
    const off = () => { setEnabled(false); setProfile(null); };
    if (!workspaceId || !user) return off();
    try {
      const { data: settings, error } = await db
        .from("workspace_automation_settings")
        .select("scout_enabled, scout_weekly_cap")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error || settings?.scout_enabled !== true) return off();
      const { data: rows, error: pErr } = await db
        .from("scout_profiles")
        .select("id, owner_user_id, status, profile_json, profile_sentence, weekly_target, delivery_dow, delivery_hour")
        .eq("workspace_id", workspaceId)
        .in("status", ["active", "paused"]);
      if (pErr) return off();
      const all = (rows ?? []) as ProfileRow[];
      setCap(Number(settings.scout_weekly_cap) || 0);
      setOthersTarget(all.filter((p) => p.owner_user_id !== user.id && p.status === "active").reduce((n, p) => n + p.weekly_target, 0));
      setProfile(all.find((p) => p.owner_user_id === user.id) ?? null);
      setEnabled(true);
    } catch {
      off();
    }
  }, [workspaceId, user]);

  useEffect(() => { void reload(); }, [reload]);

  return {
    enabled,
    profile,
    /** Weekly leads this rep can still claim: workspace cap minus other reps' active targets. */
    available: Math.max(0, cap - othersTarget),
    open,
    setOpen,
    reload,
    workspaceId,
    // Must match scout-weekly-run's fallback, or batches land at the wrong hour.
    timezone: workspaceTimezone || DEFAULT_TZ,
  };
}
export type LeadScoutState = ReturnType<typeof useLeadScout>;

async function callScout<T>(fn: string, body: Record<string, unknown>): Promise<(T & { ok: boolean; reason?: string }) | null> {
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    return error || !data ? null : data;
  } catch {
    return null;
  }
}

// ── Entry card ──────────────────────────────────────────────────────────────

const hiddenKey = (ws: string | null) => `leadScoutCardHidden:${ws ?? ""}`;

export function LeadScoutEntryCard({ scout }: { scout: LeadScoutState }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(hiddenKey(scout.workspaceId)) === "1"; } catch { return false; }
  });
  if (!scout.enabled || scout.profile || hidden) return null;
  const hide = () => {
    setHidden(true);
    try { localStorage.setItem(hiddenKey(scout.workspaceId), "1"); } catch { /* private mode: hide for this visit only */ }
  };
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-3">
        <p className="flex-1 text-sm">✨ Running low on leads? Let DrivePilot find more.</p>
        <Button size="sm" onClick={() => scout.setOpen(true)}>Find leads</Button>
        <Button size="icon" variant="ghost" className="h-11 w-11" aria-label="Hide this" onClick={hide}>
          <X className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Sheet ───────────────────────────────────────────────────────────────────

export function LeadScoutSheet({ scout }: { scout: LeadScoutState }) {
  const [editing, setEditing] = useState(false);
  if (!scout.enabled) return null;
  const showSummary = scout.profile && !editing;
  const close = (o: boolean) => { scout.setOpen(o); if (!o) setEditing(false); };
  return (
    <Sheet open={scout.open} onOpenChange={close}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Lead Scout</SheetTitle>
          <SheetDescription>DrivePilot finds new people for you to contact every week.</SheetDescription>
        </SheetHeader>
        {showSummary
          ? <ScoutSummary scout={scout} onEdit={() => setEditing(true)} />
          : <ScoutWizard scout={scout} onDone={() => { close(false); void scout.reload(); }} />}
      </SheetContent>
    </Sheet>
  );
}

function ScoutSummary({ scout, onEdit }: { scout: LeadScoutState; onEdit: () => void }) {
  const p = scout.profile!;
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const next = p.status === "active" ? "paused" : "active";
    // ponytail: client-side check only; the weekly run (Unit 3) enforces the workspace cap server-side.
    if (next === "active" && p.weekly_target > scout.available) {
      setBusy(false);
      return toast.error("Other reps are using this week's allowance. Tap \"Change who I look for\" to pick a smaller number.");
    }
    const { error } = await db.from("scout_profiles").update({ status: next }).eq("id", p.id);
    setBusy(false);
    if (error) toast.error("Couldn't change that. Please try again.");
    else { toast.success(next === "paused" ? "Lead Scout paused." : "Lead Scout is back on."); void scout.reload(); }
  };
  return (
    <div className="mt-6 space-y-4">
      {p.status === "paused" && <Badge variant="secondary">Paused</Badge>}
      <p className="text-sm">{p.profile_sentence}</p>
      <p className="text-sm text-muted-foreground">
        {p.weekly_target} new leads a week · {deliveryLine(p.delivery_dow, p.delivery_hour)}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={toggle} disabled={busy}>{p.status === "active" ? "Pause" : "Resume"}</Button>
        <Button variant="link" onClick={onEdit}>Change who I look for</Button>
      </div>
    </div>
  );
}

// ── Wizard ──────────────────────────────────────────────────────────────────

interface Sample {
  id: string;
  name: string | null;
  title: string | null;
  company: string | null;
  company_size: string | null;
  location: string | null;
  reason: string;
}
type VoteState = { vote: "up" | "down"; reason: string | null };

function ScoutWizard({ scout, onDone }: { scout: LeadScoutState; onDone: () => void }) {
  const existing = scout.profile;
  const ws = scout.workspaceId;
  const [step, setStep] = useState(1);
  const [profileId, setProfileId] = useState<string | null>(existing?.id ?? null);
  const [profile, setProfile] = useState<ScoutProfile | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [questions, setQuestions] = useState(false);
  const [answers, setAnswers] = useState({ who: "", where: "" });
  const [instruction, setInstruction] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const applyProfile = (res: { profile?: unknown; anchor_names?: Record<string, string>; profile_id?: string }) => {
    const n = res.anchor_names ?? {};
    setNames(n);
    setProfile(clampProfile(res.profile, Object.keys(n)));
    if (res.profile_id) setProfileId(res.profile_id);
  };

  const build = useCallback(async (withAnswers?: { who: string; where: string }) => {
    setLoading(true);
    setFailed(false);
    const res = existing && !withAnswers
      // Editing: start from the saved profile (refine with no feedback just normalizes + names anchors).
      ? await callScout<{ profile: unknown; anchor_names: Record<string, string> }>("scout-refine", {
        workspace_id: ws, profile_id: existing.id, profile: existing.profile_json,
      })
      : await callScout<{ needs_input?: boolean; profile?: unknown; profile_id?: string; anchor_names?: Record<string, string> }>(
        "scout-build-profile",
        { workspace_id: ws, ...(existing ? { profile_id: existing.id } : {}), ...(withAnswers ? { answers: withAnswers } : {}) },
      );
    setLoading(false);
    if (!res?.ok) return setFailed(true);
    if ("needs_input" in res && res.needs_input) {
      if (res.profile_id) setProfileId(res.profile_id);
      return setQuestions(true);
    }
    setQuestions(false);
    applyProfile(res);
  }, [existing, ws]);

  useEffect(() => { void build(); }, [build]);

  const refine = async (body: { instruction?: string; votes?: unknown[] }) => {
    if (!profile || !profileId) return false;
    setLoading(true);
    const res = await callScout<{ profile: unknown; anchor_names: Record<string, string>; note: string | null }>(
      "scout-refine", { workspace_id: ws, profile_id: profileId, profile, ...body },
    );
    setLoading(false);
    if (!res?.ok) { toast.error("I couldn't update that. Try saying it another way."); return false; }
    applyProfile(res);
    setNote(res.note ?? "Got it, I've updated who I look for.");
    return true;
  };

  const save = async (weekly: number, dow: number, hour: number) => {
    if (!profile || !profileId) return;
    const { data, error } = await db
      .from("scout_profiles")
      .update({
        status: "active",
        profile_json: profile,
        profile_sentence: profileSentence(profile, names),
        weekly_target: weekly,
        delivery_dow: dow,
        delivery_hour: hour,
      })
      .eq("id", profileId)
      .select("id");
    if (error?.code === "23505") return toast.error("You already have a Lead Scout running.");
    if (error || !data?.length) return toast.error("Couldn't start scouting. Please try again.");
    toast.success(`First batch arrives ${DAYS[dow]}. I'll keep learning from what you approve.`);
    onDone();
  };

  return (
    <div className="mt-6 space-y-5">
      <p className="text-sm text-muted-foreground">Step {step} of 3</p>
      {step === 1 && (
        <StepProfile
          {...{ profile, names, loading, failed, questions, answers, setAnswers, instruction, setInstruction, note }}
          onRetry={() => void build()}
          onAnswer={() => void build(answers)}
          onRemove={(chip) => profile && setProfile(removeChip(profile, chip))}
          onInstruction={async () => { if (await refine({ instruction })) setInstruction(""); }}
          onNext={() => { setNote(null); setStep(2); }}
        />
      )}
      {step === 2 && profile && profileId && (
        <StepSamples
          workspaceId={ws}
          profileId={profileId}
          profile={profile}
          sentence={profileSentence(profile, names)}
          note={note}
          refining={loading}
          onRefine={(votes) => refine({ votes })}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <StepWeekly
          available={scout.available}
          timezone={scout.timezone}
          initial={existing}
          onBack={() => setStep(2)}
          onSave={save}
        />
      )}
    </div>
  );
}

function StepProfile(props: {
  profile: ScoutProfile | null;
  names: Record<string, string>;
  loading: boolean;
  failed: boolean;
  questions: boolean;
  answers: { who: string; where: string };
  setAnswers: (a: { who: string; where: string }) => void;
  instruction: string;
  setInstruction: (s: string) => void;
  note: string | null;
  onRetry: () => void;
  onAnswer: () => void;
  onRemove: (chip: { field: keyof ScoutProfile; value: string }) => void;
  onInstruction: () => void;
  onNext: () => void;
}) {
  const { profile, loading, failed, questions, answers } = props;
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Here's who I think buys from you.</h3>
      {loading && !profile && <p className="text-sm text-muted-foreground">Reading your best leads…</p>}
      {failed && !loading && (
        <div className="space-y-2">
          <p className="text-sm">Something went wrong. Please try again.</p>
          <Button variant="outline" onClick={props.onRetry}>Try again</Button>
        </div>
      )}
      {questions && !loading && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); props.onAnswer(); }}>
          <p className="text-sm">I don't have enough wins to learn from yet. Two quick questions:</p>
          <div className="space-y-1">
            <Label htmlFor="scout-who">Who do you sell to?</Label>
            <Input id="scout-who" value={answers.who} placeholder="e.g. Sales leaders at payments companies"
              onChange={(e) => props.setAnswers({ ...answers, who: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="scout-where">Where?</Label>
            <Input id="scout-where" value={answers.where} placeholder="e.g. United States"
              onChange={(e) => props.setAnswers({ ...answers, where: e.target.value })} />
          </div>
          <Button type="submit" disabled={!answers.who.trim() && !answers.where.trim()}>Continue</Button>
        </form>
      )}
      {profile && !questions && (
        <>
          <p className="text-sm leading-8">
            {profileSegments(profile, props.names).map((s, i) =>
              typeof s === "string" ? <span key={i}>{s}</span> : (
                <Badge key={i} variant="secondary" className="mx-0.5 gap-1 py-0.5 pr-0.5 text-sm font-medium">
                  {s.label}
                  <button
                    type="button"
                    className="rounded-full p-1 hover:bg-background"
                    aria-label={`Remove ${s.label}`}
                    onClick={() => props.onRemove(s)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ),
            )}
          </p>
          {props.note && <p className="text-sm text-muted-foreground">{props.note}</p>}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (props.instruction.trim()) props.onInstruction(); }}>
            <Input
              aria-label="Tell me what to change"
              placeholder="Tell me what to change…"
              value={props.instruction}
              onChange={(e) => props.setInstruction(e.target.value)}
              disabled={loading}
            />
            <Button type="submit" variant="outline" disabled={loading || !props.instruction.trim()}>
              {loading ? "Updating…" : "Update"}
            </Button>
          </form>
          <div className="flex justify-end">
            <Button onClick={props.onNext} disabled={loading}>Next</Button>
          </div>
        </>
      )}
    </div>
  );
}

const SAMPLE_COPY: Record<string, string> = {
  no_provider_key: "Sample people aren't available yet — you can still save your profile.",
  rate_limited: "You've looked at a lot of samples this hour. You can keep going and save your profile.",
  empty: "I couldn't find anyone for this yet. Try going back and loosening who I look for.",
};

function StepSamples(props: {
  workspaceId: string | null;
  profileId: string;
  profile: ScoutProfile;
  sentence: string;
  note: string | null;
  refining: boolean;
  onRefine: (votes: unknown[]) => Promise<unknown>;
  onBack: () => void;
  onNext: () => void;
}) {
  // Ref so a parent re-render doesn't restart the auto-refine timer.
  const onRefine = useRef(props.onRefine);
  onRefine.current = props.onRefine;
  const [page, setPage] = useState(1);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, VoteState>>({});
  const [refinedPage, setRefinedPage] = useState(0);

  // Samples are fetched with the profile as it is when the page loads (this step
  // opening, or "Show me 5 more" after pending votes were refined) — a refine
  // mid-page doesn't reload the cards.
  const profileRef = useRef(props.profile);
  profileRef.current = props.profile;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setMessage(null);
    void callScout<{ samples: Sample[] }>("scout-sample", {
      workspace_id: props.workspaceId, profile_id: props.profileId, profile: profileRef.current, page,
    }).then((res) => {
      if (!live) return;
      setLoading(false);
      setVotes({});
      if (!res) return setMessage("Couldn't load sample people right now. You can still keep going.");
      if (!res.ok) return setMessage(SAMPLE_COPY[res.reason ?? ""] ?? "Couldn't load sample people right now. You can still keep going.");
      setSamples(res.samples);
      if (res.samples.length === 0) setMessage(SAMPLE_COPY.empty);
    });
    return () => { live = false; };
  }, [page, props.workspaceId, props.profileId]);

  // Send this page's votes once (any that exist). Also called before leaving the
  // step / loading more, so a quick click never drops the rep's feedback.
  const flush = () => {
    const voted = samples.filter((s) => votes[s.id]);
    if (voted.length === 0 || refinedPage === page) return Promise.resolve();
    setRefinedPage(page); // blocks a double-send while in flight
    return onRefine.current(voted.map((s) => ({
      vote: votes[s.id].vote, reason: votes[s.id].reason,
      title: s.title, company: s.company, company_size: s.company_size, location: s.location,
    }))).then((ok) => { if (ok !== true) setRefinedPage(0); }); // failed: keep the votes for a retry
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Refine automatically once every card has a vote (short pause so an optional 👎 reason can be picked).
  const allVoted = samples.length > 0 && samples.every((s) => votes[s.id]);
  useEffect(() => {
    if (!allVoted || refinedPage === page) return;
    const t = setTimeout(() => void flushRef.current(), 1500);
    return () => clearTimeout(t);
  }, [allVoted, votes, samples, page, refinedPage]);

  const setVote = (id: string, v: VoteState) => setVotes((cur) => ({ ...cur, [id]: v }));

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Would you want to talk to these people?</h3>
      <p className="text-sm text-muted-foreground">{props.sentence}</p>
      {props.refining && <p className="text-sm text-muted-foreground">Updating who I look for…</p>}
      {!props.refining && props.note && <p className="text-sm">{props.note}</p>}
      {loading && <p className="text-sm text-muted-foreground">Finding sample people…</p>}
      {!loading && message && <p className="text-sm">{message}</p>}
      {!loading && samples.map((s) => {
        const v = votes[s.id];
        return (
          <Card key={s.id}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name ?? "Name hidden until you add them"}</p>
                  <p className="text-sm">{[s.title, s.company].filter(Boolean).join(" · ")}</p>
                  <p className="text-sm text-muted-foreground">
                    {[s.company_size && `${s.company_size} employees`, s.location].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button size="icon" variant={v?.vote === "up" ? "default" : "outline"} className="h-11 w-11 shrink-0"
                  aria-label="Good fit" aria-pressed={v?.vote === "up"} onClick={() => setVote(s.id, { vote: "up", reason: null })}>
                  <ThumbsUp className="h-4 w-4" />
                </Button>
                <Button size="icon" variant={v?.vote === "down" ? "default" : "outline"} className="h-11 w-11 shrink-0"
                  aria-label="Not a fit" aria-pressed={v?.vote === "down"}
                  onClick={() => setVote(s.id, { vote: "down", reason: v?.vote === "down" ? v.reason : null })}>
                  <ThumbsDown className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">Why I picked them: {s.reason}</p>
              {v?.vote === "down" && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Why not? (optional)">
                  {DOWNVOTE_REASONS.map((r) => (
                    <Button key={r} size="sm" variant={v.reason === r ? "secondary" : "outline"} aria-pressed={v.reason === r}
                      onClick={() => setVote(s.id, { vote: "down", reason: v.reason === r ? null : r })}>
                      {r}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
      {!loading && samples.length > 0 && page < 5 && (
        <Button variant="link" className="px-0" disabled={props.refining}
          onClick={async () => { await flush(); setPage(page + 1); }}>
          Show me 5 more
        </Button>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={props.onBack}>Back</Button>
        <Button disabled={props.refining} onClick={async () => { await flush(); props.onNext(); }}>Next</Button>
      </div>
    </div>
  );
}

function StepWeekly(props: {
  available: number;
  timezone: string;
  initial: ProfileRow | null;
  onBack: () => void;
  onSave: (weekly: number, dow: number, hour: number) => Promise<unknown>;
}) {
  const allowed = WEEKLY_STOPS.filter((n) => n <= props.available);
  const pick = props.initial && allowed.includes(props.initial.weekly_target)
    ? props.initial.weekly_target
    : allowed.includes(25) ? 25 : allowed[allowed.length - 1];
  const [weekly, setWeekly] = useState<number | undefined>(pick);
  const [dow, setDow] = useState(props.initial?.delivery_dow ?? 1);
  const [hour, setHour] = useState(props.initial?.delivery_hour ?? 7);
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">How many new leads a week?</h3>
      <div className="grid grid-cols-4 gap-2" role="group" aria-label="New leads per week">
        {WEEKLY_STOPS.map((n) => (
          <Button key={n} className="h-11" variant={weekly === n ? "default" : "outline"} aria-pressed={weekly === n}
            disabled={n > props.available} onClick={() => setWeekly(n)}>
            {n}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {props.available > 0 ? `${props.available} available` : "None available this week. Ask your admin for more."}
      </p>
      <p className="text-sm">
        {deliveryLine(dow, hour)} ·{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => setChanging(!changing)} aria-expanded={changing}>Change</Button>
      </p>
      {changing && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Select value={String(dow)} onValueChange={(v) => setDow(Number(v))}>
              <SelectTrigger aria-label="Delivery day"><SelectValue /></SelectTrigger>
              <SelectContent>{DAYS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}s</SelectItem>)}</SelectContent>
            </Select>
            <Select value={String(hour)} onValueChange={(v) => setHour(Number(v))}>
              <SelectTrigger aria-label="Delivery time"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">Times are in {props.timezone}.</p>
        </div>
      )}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={props.onBack}>Back</Button>
        <Button disabled={!weekly || saving}
          onClick={async () => { setSaving(true); await props.onSave(weekly!, dow, hour); setSaving(false); }}>
          Start scouting
        </Button>
      </div>
    </div>
  );
}
