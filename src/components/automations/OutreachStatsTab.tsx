// Outreach → Stats tab. One row per cadence: how many touches went out,
// how many manual touches the rep marked handled, and how many people replied.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  fetchCampaignTouchStats,
  replyRate,
  type CampaignTouchStats,
} from "@/lib/campaignTouchStatsQueries";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Finished",
};

function Metric({ label, value, muted }: { label: string; value: number | string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={`text-lg font-semibold tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </p>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

export function OutreachStatsTab() {
  const { workspaceId } = useWorkspace();
  const [rows, setRows] = useState<CampaignTouchStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    fetchCampaignTouchStats(workspaceId)
      .then(setRows)
      .catch((e) => toast.error(e?.message || "Couldn't load outreach stats"))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <BarChart3 className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="font-medium text-foreground">No outreach activity yet</p>
          <p className="text-sm text-muted-foreground">
            Numbers show up here once people are added to an outreach.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((s) => {
        const rate = replyRate(s);
        return (
          <Link key={s.campaignId} to={`/app/automations/${s.campaignId}`}>
            <Card className="transition-colors hover:bg-accent">
              <CardContent className="space-y-3 py-4">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{s.campaignName}</span>
                  <Badge variant="secondary" className="text-xs font-normal">
                    {STATUS_LABEL[s.campaignStatus] ?? s.campaignStatus}
                  </Badge>
                  {rate !== null && (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {rate}% reply rate
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                  <Metric label="People" value={s.enrolled} />
                  <Metric label="Emails sent" value={s.sent} />
                  <Metric label="Handled" value={s.handled} />
                  <Metric label="Replied" value={s.replied} />
                  <Metric label="Pending" value={s.pending} muted />
                  <Metric label="Skipped" value={s.skipped} muted />
                </div>
                {s.failed > 0 && (
                  <p className="text-xs text-destructive">{s.failed} touch(es) failed to send</p>
                )}
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
