import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { headline, weekNumber, type PilotReport } from "@shared/pilotReportEmail";

// ponytail: pilot_report_settings and the pilot_report RPC aren't in the
// Lovable-generated types.ts until the migrations are applied and types regenerate;
// a narrow cast keeps this page compiling until then.
const db = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

interface Settings { client_name: string; pilot_start: string; pilot_weeks: number; meetings_target: number | null }
interface Week { n: number; from: Date; report: PilotReport }

const DAY = 24 * 3600 * 1000;

export default function Pilot() {
  const { workspaceId } = useWorkspace();
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  const [total, setTotal] = useState<PilotReport | null>(null);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    (async () => {
      // RLS returns the row to workspace admins only.
      const { data: s } = await db.from("pilot_report_settings")
        .select("client_name, pilot_start, pilot_weeks, meetings_target")
        .eq("workspace_id", workspaceId).maybeSingle();
      if (!live) return;
      setSettings(s ?? null);
      if (!s) return;
      const start = new Date(s.pilot_start);
      const now = new Date();
      const n = Math.min(weekNumber(now, start), s.pilot_weeks);
      const ranges = Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        from: new Date(start.getTime() + i * 7 * DAY),
        to: new Date(Math.min(start.getTime() + (i + 1) * 7 * DAY, now.getTime())),
      }));
      const call = (from: Date, to: Date) =>
        db.rpc("pilot_report", { _workspace_id: workspaceId, _from: from.toISOString(), _to: to.toISOString() });
      const [t, ...ws] = await Promise.all([call(start, now), ...ranges.map((r) => call(r.from, r.to))]);
      if (!live) return;
      const failed = [t, ...ws].find((r) => r.error);
      if (failed) { setError(failed.error!.message); return; }
      setTotal(t.data as PilotReport);
      setWeeks(ranges.map((r, i) => ({ n: r.n, from: r.from, report: ws[i].data as PilotReport })).reverse());
    })();
    return () => { live = false; };
  }, [workspaceId]);

  if (settings === undefined || (settings && !total && !error)) {
    return <div className="p-6 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /></div>;
  }
  if (!settings) {
    return <div className="p-6 text-muted-foreground">There's no pilot set up for this workspace.</div>;
  }
  if (error || !total) {
    return <div className="p-6 text-destructive">Couldn't load the pilot numbers: {error}</div>;
  }

  const thisWeek = weeks[0]?.report;
  const tiles: [string, number][] = [
    ["Emails sent", total.emails_sent],
    ["LinkedIn touches", total.linkedin_done],
    ["Calls made", total.calls_dialled],
    ["Replies", total.replies],
    ["Conversations", total.conversations],
    ["Meetings booked", total.meetings_booked],
  ];
  const heard = [
    ...total.reply_summaries.map((r) => ({ ...r, kind: "reply" })),
    ...total.call_recaps.map((r) => ({ ...r, kind: "call" })),
  ];

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">{settings.client_name} pilot</h1>
        <p className="text-muted-foreground">
          Week {weeks[0]?.n ?? 1} of {settings.pilot_weeks}
          {settings.meetings_target ? ` · ${total.meetings_booked} of ${settings.meetings_target} target meetings booked` : ""}
          {thisWeek ? ` · This week: ${headline(thisWeek)}` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {tiles.map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-6">
              <div className="text-3xl font-semibold">{value}</div>
              <div className="text-sm text-muted-foreground">{label} (pilot total)</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {heard.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-lg">What we heard</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {heard.map((h, i) => (
                <li key={i}>
                  <span className="font-medium">{h.lead ?? "A prospect"}{h.company ? `, ${h.company}` : ""}</span>
                  <span className="text-muted-foreground"> ({h.kind}): </span>{h.summary}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-lg">Week by week</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Week</TableHead>
                <TableHead className="text-right">Emails</TableHead>
                <TableHead className="text-right">LinkedIn</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Answered</TableHead>
                <TableHead className="text-right">Replies</TableHead>
                <TableHead className="text-right">Meetings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((w) => (
                <TableRow key={w.n}>
                  <TableCell>Week {w.n} <span className="text-muted-foreground">({w.from.toLocaleDateString(undefined, { month: "short", day: "numeric" })})</span></TableCell>
                  <TableCell className="text-right">{w.report.emails_sent}</TableCell>
                  <TableCell className="text-right">{w.report.linkedin_done}</TableCell>
                  <TableCell className="text-right">{w.report.calls_dialled}</TableCell>
                  <TableCell className="text-right">{w.report.calls_answered}</TableCell>
                  <TableCell className="text-right">{w.report.replies}</TableCell>
                  <TableCell className="text-right font-medium">{w.report.meetings_booked}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
