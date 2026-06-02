import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Megaphone, ShieldOff, Loader2, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import {
  fetchWorkspaceCampaigns,
  type Campaign,
} from "@/lib/campaignQueries";
import { SuppressionListDialog } from "@/components/automations/SuppressionListDialog";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Finished",
};

export default function Automations() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [suppressionOpen, setSuppressionOpen] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    fetchWorkspaceCampaigns(workspaceId)
      .then(setCampaigns)
      .catch(() => toast.error("Couldn't load your outreaches"))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Outreach</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSuppressionOpen(true)}>
            <ShieldOff className="mr-2 h-4 w-4" />
            Do-not-contact
          </Button>
          <Button onClick={() => navigate("/app/automations/new")}>
            <Plus className="mr-2 h-4 w-4" />
            New outreach
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Megaphone className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium text-foreground">No outreaches yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Build a set of messages once, then add people to it whenever you like.
              </p>
            </div>
            <Button onClick={() => navigate("/app/automations/new")}>
              <Plus className="mr-2 h-4 w-4" />
              New outreach
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => (
            <Link key={c.id} to={`/app/automations/${c.id}`}>
              <Card className="transition-colors hover:bg-accent">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">{c.name}</span>
                      <Badge variant="secondary" className="text-xs font-normal">
                        {STATUS_LABEL[c.status] ?? c.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {c.campaign_type === "industry" ? "Tailored by industry" : "For everyone"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <SuppressionListDialog open={suppressionOpen} onOpenChange={setSuppressionOpen} />
    </div>
  );
}
