// LeadDetailHeader — the top of the ONE-COLUMN lead page (Unit L2).
//
// Order on a 390px phone: identity → chips (status / away / automation switch)
// → status sentence → "What to do next" hero card with a single primary button
// → provenance line ("From N messages · checked … · Update") → action row
// (Call · WhatsApp · More about this deal). Everything secondary (Text, Edit,
// mailbox sync, add a message, delete) lives in the "…" overflow at the far
// right of the top row.
//
// No send / draft-generation / automation LOGIC changed here — only structure,
// labels and placement.

import { Link, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft, Mail, Trash2, Plane, AlertTriangle, Handshake, ShoppingCart, Check,
  MessageSquare, MessageCircle, MoreHorizontal, Pencil, Plus, Loader2, ChevronRight,
} from "lucide-react";
import { ClickToCallButton } from "@/components/call/ClickToCallButton";
import { resolveLeadQuickActions } from "@/lib/leadQuickActions";
import { smsLink, whatsappLink } from "@/lib/outreachDeepLinks";
import StakeholderAvatarRow from "@/components/lead/StakeholderAvatarRow";
import type { LeadDetail, LeadIntelligence } from "@/lib/supabaseQueries";
import { triggerIntelligenceRecompute } from "@/lib/supabaseQueries";
import { getLeadStatusLine } from "@/lib/leadStatusLine";
import { buildAwayChip, buildProvenanceLine, buildStatusChip } from "@/components/lead/leadHeaderText";
import { GmailSyncButton } from "@/components/gmail/GmailSyncButton";
import { MailReconnectChip } from "@/components/mail/MailReconnectChip";
import { EditLeadDialog } from "@/components/lead/EditLeadDialog";
import AutomationToggleCard from "@/components/lead/AutomationToggleCard";
import { useMailSync } from "@/hooks/useMailSync";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import ReEngagementCard from "@/components/lead/ReEngagementCard";
import { isReEngagementCandidate } from "@/lib/reEngagement";
import type { MilestoneItem } from "@/lib/supabaseQueries";

type OriginContext = "dashboard" | "leads" | "inbox";

interface LeadDetailHeaderProps {
  lead: LeadDetail;
  /** Canonical lead_intelligence row (loaded by LeadDetail). Next move reads
   *  recommended_next_step / next_step_reason from here; falls back to the
   *  leads.next_step mirror only when no row exists yet. */
  intelligence?: LeadIntelligence | null;
  isConnected: boolean;
  isDeleting: boolean;
  originContext: OriginContext;
  onDelete: () => void;
  onUpdate: () => void;
  onSyncComplete: () => void;
  /** One-tap: generate the recommended draft and open it for review-and-send. */
  onDraftIt?: () => void;
  /** "Already did it" — dismiss the suggested next move (reversible, no send). */
  onMarkHandled?: () => void;
  /** True while a mark-handled request is in flight — disables the link so a
   *  double-tap can't fire a second dismiss (which would break Undo). */
  markHandledBusy?: boolean;
  /** Opens the "More about this deal" sheet. */
  onOpenDeal: () => void;
  /** Opens the History "+ Add a message" form (logs an inbound WhatsApp reply). */
  onAddMessage: () => void;
}

const BACK_ROUTES: Record<OriginContext, string> = {
  dashboard: "/app",
  leads: "/app/leads",
  inbox: "/app/inbox",
};

const CHIP = "inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border shrink-0";

export default function LeadDetailHeader({
  lead, intelligence, isDeleting, originContext, onDelete, onUpdate, onSyncComplete,
  onDraftIt, onMarkHandled, markHandledBusy, onOpenDeal, onAddMessage,
}: LeadDetailHeaderProps) {
  const navigate = useNavigate();
  const statusLine = getLeadStatusLine(lead);
  const statusChip = buildStatusChip(lead);
  const awayChip = buildAwayChip((lead as any).ooo_until);
  const nextStep = intelligence ? intelligence.recommended_next_step : lead.next_step;
  const nextStepReason = intelligence ? intelligence.next_step_reason : lead.next_step_reason;
  // Whether a mailbox is connected — read from the canonical mail_accounts
  // source (falls back to legacy gmail_connections inside the hook), scoped to
  // the ACTIVE workspace so a multi-workspace user doesn't pick another
  // workspace's mailbox. The `isConnected` prop passed from LeadDetail comes
  // from the legacy-only check and is intentionally ignored here so the sync
  // control shows for reps connected via the current flow (Gmail or Outlook).
  const { workspaceId } = useWorkspace();
  const { isConnected: mailConnected, isLoading: mailLoading } = useMailSync(workspaceId);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  // Which "reach out directly" buttons to show (hide-when-missing + opt-out).
  const quick = resolveLeadQuickActions(lead);
  const handled = (lead as any).action_permanently_dismissed === true;
  // Only offer "Already did it" when the lead is ACTUALLY action-required now.
  // Gate strictly on needs_action: syncEngine also stores next_action_key for
  // WAITING/PAUSED states (e.g. wait_reply_threshold, paused_meeting_scheduled)
  // with needs_action=false — dismissing those would set the permanent-dismiss
  // flag and suppress the eventual reply/follow-up reminder until a fresh inbound
  // (Codex P2).
  const hasPendingAction = lead.needs_action === true;

  // Re-engagement lead? Then the hero's single primary button is the
  // re-engagement draft ("Win them back") — never a second competing button.
  const reEngagementGate = {
    motion: (lead as any).motion ?? null,
    source_type: (lead as any).source_type ?? null,
    last_outbound_at: lead.last_outbound_at ?? null,
    last_inbound_at: lead.last_inbound_at ?? null,
    next_action_key: lead.next_action_key ?? null,
    has_future_meeting: !!lead.has_future_meeting,
    stage: lead.stage ?? null,
  };
  const reEngage = isReEngagementCandidate(reEngagementGate);

  const provenance = buildProvenanceLine({
    sourceCounts: intelligence?.source_counts_json ?? null,
    lastComputedAt: intelligence?.last_computed_at ?? null,
  });

  // Same recompute action the "What we know" pane uses.
  const handleRecompute = async () => {
    setRecomputing(true);
    try {
      const result = await triggerIntelligenceRecompute(lead.id);
      if (!result.ok) {
        toast.error(result.error || "Couldn't update");
      } else {
        toast.success("Updated");
        onUpdate();
      }
    } catch (err: any) {
      toast.error(err?.message || "Couldn't update");
    } finally {
      setRecomputing(false);
    }
  };

  // Lightweight context badge counts
  const [contextFlags, setContextFlags] = useState<{ hasCaution: boolean; hasRelationship: boolean; hasProduct: boolean }>({
    hasCaution: false, hasRelationship: false, hasProduct: false,
  });

  useEffect(() => {
    supabase
      .from("lead_context_items")
      .select("category, content_text")
      .eq("lead_id", lead.id)
      .eq("is_active", true)
      .then(({ data }) => {
        if (!data) return;
        const cats = new Set(data.map(i => i.category));
        const hasProduct = cats.has("commercial_signal") &&
          data.some(i => i.category === "commercial_signal" && /product|owns|using|license/i.test(i.content_text));
        setContextFlags({
          hasCaution: cats.has("caution"),
          hasRelationship: cats.has("relationship_history"),
          hasProduct,
        });
      });
  }, [lead.id]);

  return (
    <div className="space-y-3">
      {/* TOP ROW — back, mailbox warning, overflow "…" */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" className="h-9 w-9 -ml-2" onClick={() => navigate(BACK_ROUTES[originContext])}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          {/* Reconnect chip renders ONLY when a workspace mail_account has
              needs_reconnect=true or status='error'. */}
          <MailReconnectChip compact />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {quick.sms && (
                <DropdownMenuItem asChild>
                  <a href={smsLink(quick.sms.phone, "")}>
                    <MessageSquare className="h-4 w-4 mr-2" /> Text
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4 mr-2" /> Edit details
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddMessage()}>
                <Plus className="h-4 w-4 mr-2" /> Add a message
              </DropdownMenuItem>
              {/* Mailbox sync — rendered as a plain row (not a menu item) so the
                  menu stays open while the sync runs and the rep sees it finish. */}
              {mailLoading ? null : mailConnected ? (
                <div className="px-2 py-1.5">
                  <GmailSyncButton
                    leadId={lead.id}
                    leadEmail={lead.email}
                    workspaceId={workspaceId}
                    onSyncComplete={onSyncComplete}
                    variant="ghost"
                    showLastSync={false}
                  />
                </div>
              ) : (
                <DropdownMenuItem asChild>
                  <Link to="/app/settings"><Mail className="h-4 w-4 mr-2" />Connect Gmail</Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={(e) => { e.preventDefault(); setDeleteOpen(true); }}
              >
                <Trash2 className="h-4 w-4 mr-2" /> Delete lead
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* IDENTITY */}
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-foreground leading-tight break-words">{lead.name}</h1>
        <p className="text-sm text-muted-foreground leading-snug break-words">
          {lead.job_title ? `${lead.job_title} · ` : ""}{lead.company}
        </p>
        <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{lead.email}</p>
        {/* Plain-English status sentence */}
        <p className="text-sm font-medium text-foreground mt-2">{statusLine}</p>
        {/* Stakeholder avatars — only when this is a 2+ person deal. */}
        <StakeholderAvatarRow leadId={lead.id} currentLeadId={lead.id} />
      </div>

      {/* CHIPS — status, away, and the automation switch itself */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`${CHIP} bg-muted/50 text-muted-foreground border-border`}>{statusChip}</span>
        {awayChip && (
          <span className={`${CHIP} bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/50`}>
            <Plane className="h-3 w-3" />
            {awayChip}
          </span>
        )}
        {/* The automation chip IS the switch — shown on every screen size now
            (it used to live in a desktop-only rail). Returns null when the lead
            isn't automation-eligible. */}
        <AutomationToggleCard lead={lead} onUpdate={onUpdate} />
        {contextFlags.hasCaution && (
          <span className={`${CHIP} bg-destructive/10 text-destructive border-destructive/20`}>
            <AlertTriangle className="h-3 w-3" /> Caution
          </span>
        )}
        {contextFlags.hasRelationship && (
          <span className={`${CHIP} bg-primary/10 text-primary border-primary/20`}>
            <Handshake className="h-3 w-3" /> Prior relationship
          </span>
        )}
        {contextFlags.hasProduct && (
          <span className={`${CHIP} bg-muted text-muted-foreground border-border`}>
            <ShoppingCart className="h-3 w-3" /> Product owned
          </span>
        )}
      </div>

      {/* HERO — "What to do next": one sentence, one primary button. */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground block">What to do next</span>

        {handled ? (
          <>
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
              <span>You've handled this — it'll come back if they reply.</span>
            </div>
            {onDraftIt && (
              <Button variant="secondary" onClick={onDraftIt} className="w-full min-h-[44px]">
                Send a message
              </Button>
            )}
          </>
        ) : (
          <>
            <div>
              <p className="text-sm font-medium text-foreground">
                {nextStep || "Send a quick check-in to keep this moving"}
              </p>
              {nextStepReason && (
                <p className="text-xs text-muted-foreground mt-1">{nextStepReason}</p>
              )}
            </div>

            {reEngage ? (
              // One-line summary + the single primary button for this lead.
              <ReEngagementCard
                variant="hero"
                lead={{
                  id: lead.id,
                  name: lead.name,
                  company: lead.company ?? null,
                  email: lead.email ?? null,
                  stage: lead.stage ?? null,
                  motion: (lead as any).motion ?? null,
                  next_action_key: lead.next_action_key ?? null,
                  next_action_label: (lead as any).next_action_label ?? null,
                  job_title: (lead as any).job_title ?? null,
                  industry: (lead as any).industry ?? null,
                }}
                gate={reEngagementGate}
                milestones={(lead.milestones_json as unknown as MilestoneItem[] | null) ?? null}
              />
            ) : (
              onDraftIt && (
                <Button
                  onClick={onDraftIt}
                  variant={hasPendingAction ? "default" : "secondary"}
                  className="w-full min-h-[44px]"
                >
                  Send a message
                </Button>
              )
            )}

            {onMarkHandled && hasPendingAction && (
              <button
                type="button"
                onClick={onMarkHandled}
                disabled={markHandledBusy}
                className="block w-full text-center text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
              >
                Already did it
              </button>
            )}
          </>
        )}
      </div>

      {/* PROVENANCE — what the suggestion was built from + when, always visible. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{provenance}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={handleRecompute}
          disabled={recomputing}
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {recomputing && <Loader2 className="h-3 w-3 animate-spin" />}
          {recomputing ? "Updating…" : "Update"}
        </button>
      </div>

      {/* ACTION ROW — three thumb-sized buttons. */}
      <div className="flex items-stretch gap-2">
        {lead.phone && (
          <div className="flex-1 [&>button]:w-full [&>button]:h-11 [&>button]:text-sm">
            <ClickToCallButton leadId={lead.id} leadName={lead.name} leadPhone={lead.phone ?? null} />
          </div>
        )}
        {quick.whatsapp && (
          <Button variant="outline" className="flex-1 h-11 gap-1.5" asChild>
            <a href={whatsappLink(quick.whatsapp.number, "")} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-4 w-4" />
              WhatsApp
            </a>
          </Button>
        )}
        <Button variant="outline" className="flex-1 h-11 gap-1 min-w-0" onClick={onOpenDeal}>
          <span className="truncate">More about this deal</span>
          <ChevronRight className="h-4 w-4 shrink-0" />
        </Button>
      </div>

      {/* Overflow-menu dialogs, rendered outside the menu so they survive it closing. */}
      <EditLeadDialog lead={lead} onUpdate={onUpdate} open={editOpen} onOpenChange={setEditOpen} />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lead</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{lead.name}</strong> from <strong>{lead.company}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting ? "Deleting..." : "Delete Lead"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
