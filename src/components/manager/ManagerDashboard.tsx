import { useEffect, useState, useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Clock,
  MessageSquare,
  AlertTriangle,
  BarChart3,
  Mail,
  Shield,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchManagerMetrics,
  aggregateTeamMetrics,
  type ManagerRepMetrics,
} from "@/lib/managerAnalyticsQueries";

export function ManagerDashboard() {
  const [reps, setReps] = useState<ManagerRepMetrics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    // Get user's workspace
    async function init() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!membership || !["admin", "manager"].includes(membership.role)) {
        setIsLoading(false);
        return;
      }

      setWorkspaceId(membership.workspace_id);

      try {
        const metrics = await fetchManagerMetrics(membership.workspace_id);
        setReps(metrics);
      } catch (err) {
        console.error("Failed to load manager metrics:", err);
      } finally {
        setIsLoading(false);
      }
    }

    init();
  }, []);

  const team = useMemo(() => aggregateTeamMetrics(reps), [reps]);
  const lastComputed = reps[0]?.computed_at;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-64" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-muted rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Manager access required to view team analytics.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Team Analytics</h1>
          <p className="text-sm text-muted-foreground">
            {reps.length} rep{reps.length !== 1 ? "s" : ""} tracked
            {lastComputed && (
              <span> · Updated {formatDistanceToNow(new Date(lastComputed), { addSuffix: true })}</span>
            )}
          </p>
        </div>
      </div>

      {/* Top-level KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard
          icon={Clock}
          label="Avg Response Time"
          value={`${team.avgResponseTime}m`}
          color="info"
        />
        <KPICard
          icon={MessageSquare}
          label="Needs Reply"
          value={String(team.totalNeedsReply)}
          color={team.totalNeedsReply > 5 ? "warning" : "success"}
        />
        <KPICard
          icon={AlertTriangle}
          label="Ghost Risk"
          value={String(team.totalHighGhostRisk)}
          subtitle={`${team.totalMediumGhostRisk} medium`}
          color={team.totalHighGhostRisk > 0 ? "destructive" : "success"}
        />
        <KPICard
          icon={Users}
          label="Active Conversations"
          value={String(team.totalActive)}
          color="info"
        />
      </div>

      {/* 3-column panels */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Response Time per Rep */}
        <Panel title="⏱️ Response Time per Rep" icon={Clock}>
          {reps.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {reps
                .sort((a, b) => a.avg_response_time_minutes - b.avg_response_time_minutes)
                .map((rep) => (
                  <div key={rep.rep_user_id} className="flex items-center justify-between">
                    <span className="text-sm text-foreground truncate">
                      {rep.rep_user_id.slice(0, 8)}…
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            rep.avg_response_time_minutes < 30
                              ? "bg-[hsl(var(--success))]"
                              : rep.avg_response_time_minutes < 120
                              ? "bg-[hsl(var(--warning))]"
                              : "bg-destructive"
                          )}
                          style={{
                            width: `${Math.min(100, (rep.avg_response_time_minutes / 240) * 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground w-12 text-right">
                        {rep.avg_response_time_minutes < 60
                          ? `${Math.round(rep.avg_response_time_minutes)}m`
                          : `${(rep.avg_response_time_minutes / 60).toFixed(1)}h`}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Panel>

        {/* Deal Stage Distribution */}
        <Panel title="📊 Deal Stage Distribution" icon={BarChart3}>
          {Object.keys(team.stageDistribution).length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {Object.entries(team.stageDistribution)
                .sort((a, b) => b[1] - a[1])
                .map(([stage, count]) => {
                  const total = Object.values(team.stageDistribution).reduce((s, v) => s + v, 0);
                  return (
                    <div key={stage} className="flex items-center justify-between">
                      <span className="text-sm capitalize text-foreground">
                        {stage.replace(/_/g, " ")}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${(count / total) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground w-8 text-right">{count}</span>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </Panel>

        {/* Objection Frequency */}
        <Panel title="🛡️ Objection Frequency" icon={Shield}>
          {Object.keys(team.objectionFrequency).length === 0 ? (
            <EmptyState text="No objections detected" />
          ) : (
            <div className="space-y-1.5">
              {Object.entries(team.objectionFrequency)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([obj, count]) => (
                  <div key={obj} className="flex items-center justify-between">
                    <span className="text-sm text-foreground capitalize">
                      {obj.replace(/_/g, " ")}
                    </span>
                    <Badge variant="outline" className="text-xs">
                      {count}×
                    </Badge>
                  </div>
                ))}
            </div>
          )}
        </Panel>

        {/* Ghosting Risk Alerts */}
        <Panel title="👻 Ghosting Risk Alerts" icon={AlertTriangle}>
          {team.allGhostRiskContacts.length === 0 ? (
            <EmptyState text="No ghost risks detected" />
          ) : (
            <div className="space-y-2">
              {team.allGhostRiskContacts.slice(0, 6).map((gc, i) => (
                <div
                  key={i}
                  className={cn(
                    "rounded-md px-3 py-2 text-xs",
                    gc.risk === "high"
                      ? "bg-destructive/5 border border-destructive/20"
                      : "bg-[hsl(var(--warning)/0.05)] border border-[hsl(var(--warning)/0.2)]"
                  )}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-medium text-foreground">
                      {gc.contact_id.slice(0, 8)}…
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        gc.risk === "high" ? "text-destructive border-destructive/30" : "text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.3)]"
                      )}
                    >
                      {gc.risk}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground truncate">{gc.summary || "No summary"}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Channel Effectiveness */}
        <Panel title="📡 Channel Effectiveness" icon={TrendingUp}>
          {Object.keys(team.channelMetrics).length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-3">
              {Object.entries(team.channelMetrics).map(([channel, metrics]) => {
                const total = metrics.sent + metrics.received;
                const responseRate = total > 0 ? Math.round((metrics.received / Math.max(metrics.sent, 1)) * 100) : 0;
                return (
                  <div key={channel} className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {channel === "whatsapp" ? (
                          <MessageSquare className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
                        ) : (
                          <Mail className="h-3.5 w-3.5 text-[hsl(var(--info))]" />
                        )}
                        <span className="text-sm font-medium capitalize text-foreground">{channel}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {metrics.conversations} convos
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="text-center">
                        <span className="block text-muted-foreground">Sent</span>
                        <span className="font-medium text-foreground">{metrics.sent}</span>
                      </div>
                      <div className="text-center">
                        <span className="block text-muted-foreground">Received</span>
                        <span className="font-medium text-foreground">{metrics.received}</span>
                      </div>
                      <div className="text-center">
                        <span className="block text-muted-foreground">Response</span>
                        <span className={cn(
                          "font-medium",
                          responseRate >= 50 ? "text-[hsl(var(--success))]" : responseRate >= 25 ? "text-[hsl(var(--warning))]" : "text-destructive"
                        )}>
                          {responseRate}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Sentiment Overview */}
        <Panel title="💬 Sentiment Overview" icon={Zap}>
          {Object.keys(team.sentimentDistribution).length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {Object.entries(team.sentimentDistribution)
                .sort((a, b) => b[1] - a[1])
                .map(([sentiment, count]) => {
                  const total = Object.values(team.sentimentDistribution).reduce((s, v) => s + v, 0);
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={sentiment} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            sentiment === "positive"
                              ? "bg-[hsl(var(--success))]"
                              : sentiment === "negative"
                              ? "bg-destructive"
                              : "bg-muted-foreground"
                          )}
                        />
                        <span className="text-sm capitalize text-foreground">{sentiment}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{pct}% ({count})</span>
                    </div>
                  );
                })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// --- Sub-components ---

function KPICard({
  icon: Icon,
  label,
  value,
  subtitle,
  color,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  subtitle?: string;
  color: "info" | "success" | "warning" | "destructive";
}) {
  const colorMap = {
    info: "bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]",
    success: "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]",
    warning: "bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
    destructive: "bg-destructive/10 text-destructive",
  };

  return (
    <div className="rounded-lg border border-border p-4 bg-card">
      <div className="flex items-center gap-2 mb-2">
        <div className={cn("rounded-full p-1.5", colorMap[color])}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className="text-2xl font-bold text-foreground">{value}</span>
      {subtitle && <span className="text-xs text-muted-foreground ml-2">{subtitle}</span>}
    </div>
  );
}

function Panel({
  title,
  icon: _Icon,
  children,
}: {
  title: string;
  icon: typeof Clock;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-4 bg-card">
      <h3 className="text-sm font-semibold text-foreground mb-3">{title}</h3>
      <Separator className="mb-3" />
      {children}
    </div>
  );
}

function EmptyState({ text = "No data yet" }: { text?: string }) {
  return <p className="text-xs text-muted-foreground text-center py-4">{text}</p>;
}
