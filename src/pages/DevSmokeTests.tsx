import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { smokeTests, runAllSmokeTests, type SmokeResult } from "@/lib/smokeTests";

const statusIcon = {
  pass: <CheckCircle2 className="h-4 w-4 text-green-500" />,
  fail: <XCircle className="h-4 w-4 text-destructive" />,
  warn: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
};

const statusBadge = {
  pass: "default" as const,
  fail: "destructive" as const,
  warn: "secondary" as const,
};

export default function DevSmokeTests() {
  const [results, setResults] = useState<SmokeResult[]>([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);

  const handleRunAll = async () => {
    setRunning(true);
    setResults([]);
    const r = await runAllSmokeTests();
    setResults(r);
    setRanAt(new Date().toLocaleTimeString());
    setRunning(false);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">🔬 Dev Smoke Tests</h1>
          <p className="text-sm text-muted-foreground">Manual health checks — no real sends</p>
        </div>
        <Button onClick={handleRunAll} disabled={running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run All
        </Button>
      </div>

      {ranAt && (
        <p className="text-xs text-muted-foreground">Last run: {ranAt}</p>
      )}

      <div className="space-y-2">
        {(results.length > 0 ? results : smokeTests.map((t) => ({ name: t.name, status: "pending" as any, detail: "—", durationMs: 0 }))).map((r, i) => (
          <Card key={i} className="py-0">
            <CardContent className="flex items-center gap-3 py-3 px-4">
              {r.status === "pending" ? (
                <div className="h-4 w-4 rounded-full border border-muted-foreground/30" />
              ) : (
                statusIcon[r.status as keyof typeof statusIcon]
              )}
              <span className="font-medium text-sm flex-1">{r.name}</span>
              {r.status !== "pending" && (
                <>
                  <Badge variant={statusBadge[r.status as keyof typeof statusBadge]} className="text-xs">
                    {r.status} ({r.durationMs}ms)
                  </Badge>
                  <span className="text-xs text-muted-foreground max-w-[300px] truncate" title={r.detail}>
                    {r.detail}
                  </span>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
