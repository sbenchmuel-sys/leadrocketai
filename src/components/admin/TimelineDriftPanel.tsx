// Admin/dev-only drift panel — surfaced inside DevSmokeTests page.
// Gated implicitly by the `flags.dev_smoke` route guard.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Wrench, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  auditTimelineDrift,
  repairTimelineDrift,
  type DriftAuditReport,
  type RepairReport,
} from "@/lib/timelineDriftAudit";

const WINDOW_OPTIONS = [7, 30, 90] as const;

export default function TimelineDriftPanel() {
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30);
  const [audit, setAudit] = useState<DriftAuditReport | null>(null);
  const [repair, setRepair] = useState<RepairReport | null>(null);
  const [busy, setBusy] = useState<"audit" | "preview" | "repair" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(kind: "audit" | "preview" | "repair") {
    setBusy(kind);
    setErr(null);
    setRepair(null);
    try {
      if (kind === "audit") {
        const r = await auditTimelineDrift(windowDays);
        setAudit(r);
      } else {
        // Always re-audit so user sees fresh "before" numbers
        const before = await auditTimelineDrift(windowDays);
        setAudit(before);
        const rep = await repairTimelineDrift(windowDays, {
          dryRun: kind === "preview",
          maxRepairs: 200,
        });
        setRepair(rep);
        if (kind === "repair") {
          // Refresh audit to show residual drift
          const after = await auditTimelineDrift(windowDays);
          setAudit(after);
        }
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  const isClean = audit && audit.missing_timeline_mirror === 0
    && audit.duplicate_dedupe_keys === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          🔧 Timeline ↔ Interactions Drift Audit
          {isClean && <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" /> clean</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Read-only audit + idempotent backfill. Repair replays the same
          projection rules used by <code>insertInteraction</code>.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Window:</span>
          {WINDOW_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={windowDays === d ? "default" : "outline"}
              onClick={() => setWindowDays(d)}
              disabled={busy !== null}
            >
              {d}d
            </Button>
          ))}
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => run("audit")} disabled={busy !== null} className="gap-1">
            {busy === "audit" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            Audit
          </Button>
          <Button size="sm" variant="outline" onClick={() => run("preview")} disabled={busy !== null} className="gap-1">
            {busy === "preview" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Preview repair
          </Button>
          <Button size="sm" onClick={() => run("repair")} disabled={busy !== null} className="gap-1">
            {busy === "repair" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
            Repair (max 200)
          </Button>
        </div>

        {err && (
          <div className="text-xs text-destructive flex items-start gap-2 p-2 rounded bg-destructive/10">
            <AlertTriangle className="h-3 w-3 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        {audit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Stat label="Scanned (interactions)" value={audit.scanned_interactions} />
              <Stat label="Missing timeline mirror" value={audit.missing_timeline_mirror}
                tone={audit.missing_timeline_mirror > 0 ? "warn" : "ok"} />
              <Stat label="Orphan timeline rows" value={audit.orphan_timeline_rows}
                tone={audit.orphan_timeline_rows > 0 ? "warn" : "ok"} />
              <Stat label="Duplicate dedupe keys" value={audit.duplicate_dedupe_keys}
                tone={audit.duplicate_dedupe_keys > 0 ? "fail" : "ok"} />
            </div>

            <Breakdown title="By channel" data={audit.by_channel} />
            <Breakdown title="By source" data={audit.by_source} />
            <Breakdown title="By age" data={audit.by_age_bucket} />

            {audit.sample_missing.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sample missing rows ({audit.sample_missing.length})
                </summary>
                <pre className="mt-2 p-2 bg-muted rounded overflow-auto max-h-48">
                  {JSON.stringify(audit.sample_missing, null, 2)}
                </pre>
              </details>
            )}

            {audit.orphan_sample.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  Sample orphan timeline rows ({audit.orphan_sample.length})
                </summary>
                <pre className="mt-2 p-2 bg-muted rounded overflow-auto max-h-48">
                  {JSON.stringify(audit.orphan_sample, null, 2)}
                </pre>
              </details>
            )}

            <p className="text-[10px] text-muted-foreground">
              Window: last {audit.scan_window_days}d · scan capped at 1000 interactions ·
              scanned at {new Date(audit.scanned_at).toLocaleTimeString()}
            </p>
          </div>
        )}

        {repair && (
          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-medium">
              Repair report {repair.attempted > 0 && repair.repaired === repair.attempted && "✓"}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Stat label="Attempted" value={repair.attempted} />
              <Stat label="Repaired" value={repair.repaired} tone="ok" />
              <Stat label="Skipped (no workspace)" value={repair.skipped_missing_workspace}
                tone={repair.skipped_missing_workspace > 0 ? "warn" : "ok"} />
              <Stat label="Errors" value={repair.skipped_errors}
                tone={repair.skipped_errors > 0 ? "fail" : "ok"} />
            </div>
            {repair.error_samples.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">Error samples</summary>
                <pre className="mt-2 p-2 bg-muted rounded">{repair.error_samples.join("\n")}</pre>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "fail" }) {
  const cls = tone === "fail" ? "text-destructive"
    : tone === "warn" ? "text-yellow-600 dark:text-yellow-400"
    : tone === "ok" ? "text-foreground" : "text-foreground";
  return (
    <div className="rounded border bg-card p-2">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Breakdown({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="text-muted-foreground mb-1">{title}</div>
      <div className="flex flex-wrap gap-1">
        {entries.map(([k, v]) => (
          <Badge key={k} variant="secondary" className="text-[10px]">{k}: {v}</Badge>
        ))}
      </div>
    </div>
  );
}
