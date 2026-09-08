import { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { getLeadDetail, getLeadIntelligence, LeadDetail as LeadDetailType, LeadIntelligence, deleteLead, markActionHandled, undoMarkActionHandled } from "@/lib/supabaseQueries";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";
import TimelineTab from "@/components/lead/TimelineTab";
import DraftsTab from "@/components/lead/DraftsTab";
import UploadTab from "@/components/lead/UploadTab";
import RecommendationsTab from "@/components/lead/RecommendationsTab";
import MeetingsTab from "@/components/lead/MeetingsTab";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { useVisibilityRefresh } from "@/hooks/useVisibilityRefresh";
import LeadDetailHeader from "@/components/lead/LeadDetailHeader";
import LeadContextPanel from "@/components/lead/LeadContextPanel";
import PostMeetingRecapHint from "@/components/lead/PostMeetingRecapHint";
import StakeholdersPartnersPanel from "@/components/lead/StakeholdersPartnersPanel";
import AutomationPreviewCard from "@/components/lead/AutomationPreviewCard";
import NurturePreviewCard from "@/components/lead/NurturePreviewCard";
import { getAutomationToggleState } from "@/lib/leadAutomationActions";
import { UnifiedIntelligenceCard } from "@/components/leads/UnifiedIntelligenceCard";
import { EmailActionDialog } from "@/components/dashboard/EmailActionDialog";
import { useWorkspace } from "@/contexts/WorkspaceContext";

/** One section of the "More about this deal" sheet. */
function DealSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  // Canonical intelligence row, passed to the header so "What to do next" reads
  // lead_intelligence rather than the leads.next_step mirror.
  const [intelligence, setIntelligence] = useState<LeadIntelligence | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDraftDialog, setShowDraftDialog] = useState(false);
  const [draftActionKey, setDraftActionKey] = useState<string | undefined>(undefined);
  // "More about this deal" — bottom sheet on a phone, side panel on desktop.
  const [dealOpen, setDealOpen] = useState(false);
  // History "+ Add a message" form (lives in TimelineTab, opened from the "…" menu).
  const [addMessageOpen, setAddMessageOpen] = useState(false);
  // Latest route id — so an in-flight mark-handled / undo doesn't reload the
  // previous lead's data onto a lead the rep has since navigated to (Codex P2).
  const currentIdRef = useRef(id);
  currentIdRef.current = id;
  // In-flight guard for "Already did it" — a double-tap would otherwise fire a
  // second RPC that snapshots the already-cleared state, so its Undo would restore
  // the DISMISSED state instead of the original action (Codex P2). Ref = synchronous
  // guard against fast double-clicks; state = disables the control.
  const markingHandledRef = useRef(false);
  const [markingHandled, setMarkingHandled] = useState(false);
  const location = useLocation();
  const originContext: "dashboard" | "leads" | "inbox" = location.state?.originContext || "dashboard";
  const { isConnected } = useGmailConnection();
  const { workspaceId } = useWorkspace();

  const backRoute = originContext === "leads" ? "/app/leads" : originContext === "inbox" ? "/app/inbox" : "/app";

  const handleDraftIt = () => {
    // Open the recommended draft in the review-and-send composer. The dialog
    // auto-generates from the lead's next_action_key (or its own sensible
    // default when there's no recommendation) and always ends in manual Send.
    setDraftActionKey(lead?.next_action_key ?? undefined);
    setShowDraftDialog(true);
  };

  // Belt and braces on top of the render guard below: act on the lead that is
  // ON SCREEN (`lead.id`), never on the raw URL id — the confirmation names
  // `lead.name`, so the two can never disagree.
  const handleDelete = async () => {
    if (!lead) return;
    setIsDeleting(true);
    try {
      await deleteLead(lead.id);
      toast.success("Lead deleted successfully");
      navigate(backRoute);
    } catch (err) {
      toast.error("Failed to delete lead");
    } finally {
      setIsDeleting(false);
    }
  };

  const loadLead = async () => {
    if (!id) return;
    try {
      const [data, intel] = await Promise.all([getLeadDetail(id), getLeadIntelligence(id)]);
      // If the rep navigated to another lead while this fetch was in flight, drop
      // the result — never render the previous lead's data on the new route (Codex P2).
      if (currentIdRef.current !== id) return;
      setLead(data);
      setIntelligence(intel);
    } catch (err) {
      if (currentIdRef.current !== id) return;
      toast.error("Failed to load lead");
    } finally {
      if (currentIdRef.current === id) setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    await loadLead();
  };

  // "Already did it" — dismiss the suggested next move WITHOUT sending. Reuses the
  // same atomic RPC + Undo pattern as the Queue's "Mark as handled" (sets the
  // suggestion-dismissal flag only; sends/deletes nothing). syncEngine re-arms it
  // when a fresh inbound arrives. Reversible via the 5s Undo toast — no confirm.
  const handleMarkHandled = async () => {
    if (!lead || markingHandledRef.current) return;
    markingHandledRef.current = true;
    setMarkingHandled(true);
    // Same rule as delete: dismiss the action of the lead being displayed.
    const actedId = lead.id;
    try {
      const snapshot = await markActionHandled(actedId, { permanent: true });
      toast.success("Marked as handled", {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await undoMarkActionHandled(actedId, snapshot);
              // Skip the view refresh if the rep has since navigated to another lead.
              if (currentIdRef.current !== actedId) return;
              await handleUpdate();
            } catch (err) {
              console.error("Undo mark-handled failed:", err);
              toast.error("Undo failed");
            }
          },
        },
      });
      // Don't reload the previous lead onto a lead the rep navigated to mid-RPC.
      if (currentIdRef.current !== actedId) return;
      await handleUpdate();
    } catch (err) {
      console.error("Mark handled failed:", err);
      toast.error("Couldn't mark as handled");
    } finally {
      markingHandledRef.current = false;
      setMarkingHandled(false);
    }
  };

  useEffect(() => {
    // Unit L2: do NOT blank the lead on an id change — the page keeps the header
    // it already has and shows a skeleton in the hero + history while the new
    // lead loads, instead of collapsing to a spinner.
    setIsLoading(true);
    setDealOpen(false);
    setAddMessageOpen(false);
    loadLead();
  }, [id]);

  useVisibilityRefresh(() => {
    if (!id) return;
    loadLead();
  });

  // Show the skeleton whenever the lead in state is not the lead in the URL.
  // Keeping a stale lead on screen while a NEW id loads would let the rep act on
  // the wrong person: Delete/"Already did it"/WhatsApp all use the URL id, so the
  // confirmation would name Bob while the action hit Jane. An in-place refresh of
  // the SAME lead still re-renders without a flicker.
  if (!lead || lead.id !== id) {
    if (isLoading) {
      return (
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-36 w-full rounded-xl" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Lead not found</p>
        <Button asChild className="mt-4">
          <Link to="/app/leads">Back to Leads</Link>
        </Button>
      </div>
    );
  }

  // Same gate the automation chip uses — a non-consented manual queue item must
  // not reach AutomationPreviewCard's "Disable Automation" (it would wipe that
  // lead's manual next_action_key). Turning the chip on (consent) reveals it.
  // Slow-drip (nurture) leads are excluded for the same reason the chip is: the
  // generic card's Pause/Disable clear needs_action / eligible_at /
  // automation_mode WITHOUT touching nurture_status, which would leave the
  // slow-drip card reading "Active" for a sequence the executor will never send.
  // NurturePreviewCard above is the control surface for those leads.
  const autoState = getAutomationToggleState(lead);
  const isNurture = (lead as any).motion === "nurture";
  const showAutomationDetails =
    autoState.eligible && !autoState.isUnsubscribed && autoState.consented && !isNurture;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <LeadDetailHeader
        lead={lead}
        intelligence={intelligence}
        isConnected={isConnected}
        isDeleting={isDeleting}
        originContext={originContext}
        onDelete={handleDelete}
        onUpdate={handleUpdate}
        onSyncComplete={loadLead}
        onDraftIt={handleDraftIt}
        onMarkHandled={handleMarkHandled}
        markHandledBusy={markingHandled}
        onOpenDeal={() => setDealOpen(true)}
        onAddMessage={() => setAddMessageOpen(true)}
      />

      {/* Post-meeting recap pending / sent — the one hint that used to live in
          the desktop-only right rail. Renders nothing when there's no meeting. */}
      <PostMeetingRecapHint leadId={lead.id} />

      {/* HISTORY */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-foreground">History</h2>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <TimelineTab
            leadId={lead.id}
            onWhatsAppReply={handleUpdate}
            groupId={(lead as any).group_id ?? null}
            addMessageOpen={addMessageOpen}
            onAddMessageOpenChange={setAddMessageOpen}
            currentLead={{
              id: lead.id,
              name: lead.name,
              email: lead.email,
              company: lead.company,
              stage: lead.stage,
              motion: (lead as any).motion ?? undefined,
              job_title: lead.job_title ?? null,
              unsubscribed: (lead as any).unsubscribed === true,
            }}
          />
        )}
      </div>

      {/* MORE ABOUT THIS DEAL — bottom sheet on a phone, side panel on desktop.
          Replaces the old "More" tab dropdown; every pane it held lives here. */}
      <Sheet open={dealOpen} onOpenChange={setDealOpen}>
        <SheetContent
          side="bottom"
          className="h-[88vh] overflow-y-auto p-4 sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:w-full sm:max-w-xl sm:border-l sm:border-t-0 sm:p-6"
        >
          <SheetHeader className="mb-4">
            <SheetTitle>More about this deal</SheetTitle>
          </SheetHeader>

          <div className="space-y-6 pb-8">
            <DealSection title="Meetings">
              <MeetingsTab leadId={lead.id} leadEmail={lead.email} leadName={lead.name} onMilestonesAdded={handleUpdate} />
            </DealSection>

            <DealSection title="Automation details">
              <NurturePreviewCard lead={lead} onUpdate={handleUpdate} />
              {showAutomationDetails ? (
                <AutomationPreviewCard lead={lead} onUpdate={handleUpdate} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isNurture
                    // Slow-drip leads have no automation chip at the top — their
                    // controls appear in this section once a drip is running.
                    ? "No slow drip running for this lead yet — its controls appear here once one starts."
                    : "Turn on the automation chip at the top to schedule and preview the follow-ups."}
                </p>
              )}
            </DealSection>

            <DealSection title="Other people at this company">
              {workspaceId ? (
                <StakeholdersPartnersPanel
                  leadId={lead.id}
                  leadName={lead.name}
                  leadCompany={lead.company ?? null}
                  workspaceId={workspaceId}
                  onChanged={handleUpdate}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Loading workspace…</p>
              )}
            </DealSection>

            <DealSection title="Files & notes">
              <UploadTab leadId={lead.id} onSuccess={handleUpdate} />
              {workspaceId ? (
                <LeadContextPanel leadId={lead.id} workspaceId={workspaceId} onUpdate={handleUpdate} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading workspace…</p>
              )}
            </DealSection>

            <DealSection title="What we know">
              <UnifiedIntelligenceCard lead={lead} onUpdated={handleUpdate} />
              <RecommendationsTab lead={lead} onUpdate={handleUpdate} />
            </DealSection>

            <DealSection title="Saved drafts">
              {/* Review-only — composing happens via the hero's message button. */}
              <DraftsTab lead={lead} onUpdate={handleUpdate} variant="review" />
            </DealSection>
          </div>
        </SheetContent>
      </Sheet>

      {/* One-tap compose — review-and-send composer (manual send only) */}
      <EmailActionDialog
        lead={lead}
        actionKey={draftActionKey}
        open={showDraftDialog}
        onOpenChange={setShowDraftDialog}
        onSuccess={handleUpdate}
      />
    </div>
  );
}
