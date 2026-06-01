import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  ArrowLeft,
  ChevronDown,
  MoreHorizontal,
  Trash2,
  UserPlus,
  Users,
  X,
  Loader2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchCampaignById,
  fetchCampaignLeads,
  updateCampaign,
  deleteCampaign,
  assignCampaignToLead,
  type CampaignWithSteps,
  type CampaignLead,
} from "@/lib/campaignQueries";
import { CampaignScript } from "@/components/automations/CampaignScript";
import { AddLeadsDialog } from "@/components/automations/AddLeadsDialog";

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Finished",
};

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [campaign, setCampaign] = useState<CampaignWithSteps | null>(null);
  const [people, setPeople] = useState<CampaignLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadPeople = useCallback(() => {
    if (!id) return;
    fetchCampaignLeads(id).then(setPeople).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetchCampaignById(id)
      .then((c) => {
        setCampaign(c);
        setInstructions(c?.global_instructions ?? "");
      })
      .catch(() => toast.error("Couldn't load this outreach"))
      .finally(() => setLoading(false));
    loadPeople();
  }, [id, loadPeople]);

  const handleSaveInstructions = async () => {
    if (!id) return;
    setSavingInstructions(true);
    try {
      await updateCampaign(id, { global_instructions: instructions });
      toast.success("Instructions saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSavingInstructions(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteCampaign(id);
      toast.success("Outreach deleted");
      navigate("/app/automations");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete");
    }
  };

  const handleRemovePerson = async (leadId: string) => {
    try {
      await assignCampaignToLead(leadId, null);
      setPeople((prev) => prev.filter((p) => p.id !== leadId));
    } catch {
      toast.error("Couldn't remove that person");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-muted-foreground">This outreach couldn't be found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/app/automations")}>
          Back to outreach
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-12">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/app/automations")}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-bold text-foreground">{campaign.name}</h1>
            <Badge variant="secondary" className="text-xs font-normal">
              {STATUS_LABEL[campaign.status] ?? campaign.status}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {campaign.campaign_type === "industry" ? "Tailored by industry" : "For everyone"}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete outreach
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The script */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">The messages</h2>
        {campaign.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages in this outreach.</p>
        ) : (
          <CampaignScript
            steps={campaign.steps.map((s) => ({
              channel: s.channel,
              delay_days: s.delay_days,
              custom_instructions: s.custom_instructions,
            }))}
          />
        )}

        {/* Edit instructions */}
        <Collapsible open={instructionsOpen} onOpenChange={setInstructionsOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Edit instructions
            <ChevronDown
              className={`ml-auto h-3.5 w-3.5 transition-transform ${instructionsOpen ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={6}
              className="resize-none text-sm"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={handleSaveInstructions} disabled={savingInstructions}>
                {savingInstructions ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* People */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">
            People {people.length > 0 && <span className="text-muted-foreground">({people.length})</span>}
          </h2>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Add people
          </Button>
        </div>

        {people.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
              <Users className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No one's in this outreach yet. Add people whenever you're ready.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-2">
              <ul className="divide-y divide-border">
                {people.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[p.company, p.email].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemovePerson(p.id)}
                      aria-label={`Remove ${p.name}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      <AddLeadsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        campaignId={campaign.id}
        excludeIds={people.map((p) => p.id)}
        onAdded={loadPeople}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this outreach?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the outreach and its messages. The people in it stay as leads —
              they're just no longer part of this outreach. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
