import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Mail, Trash2, Pause, Plane, AlertTriangle, Handshake, ShoppingCart, PenLine, Check, MessageSquare, MessageCircle } from "lucide-react";
import { ClickToCallButton } from "@/components/call/ClickToCallButton";
import { resolveLeadQuickActions } from "@/lib/leadQuickActions";
import { smsLink, whatsappLink } from "@/lib/outreachDeepLinks";
import StakeholderAvatarRow from "@/components/lead/StakeholderAvatarRow";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { getLeadStatusLine } from "@/lib/leadStatusLine";
import { GmailSyncButton } from "@/components/gmail/GmailSyncButton";
import { MailReconnectChip } from "@/components/mail/MailReconnectChip";
import { EditLeadDialog } from "@/components/lead/EditLeadDialog";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type OriginContext = "dashboard" | "leads" | "inbox";

interface LeadDetailHeaderProps {
  lead: LeadDetail;
  isConnected: boolean;
  isDeleting: boolean;
  originContext: OriginContext;
  onDelete: () => void;
  onUpdate: () => void;
  onSyncComplete: () => void;
  /** One-tap: generate the recommended draft and open it for review-and-send. */
  onDraftIt?: () => void;
  /** "I handled this" — dismiss the suggested next move (reversible, no send). */
  onMarkHandled?: () => void;
}

const BACK_ROUTES: Record<OriginContext, string> = {
  dashboard: "/app",
  leads: "/app/leads",
  inbox: "/app/inbox",
};

export default function LeadDetailHeader({
  lead, isConnected, isDeleting, originContext, onDelete, onUpdate, onSyncComplete, onDraftIt, onMarkHandled,
}: LeadDetailHeaderProps) {
  const navigate = useNavigate();
  const statusLine = getLeadStatusLine(lead);

  // Which "reach out directly" buttons to show (hide-when-missing + opt-out).
  // Call is the existing in-app ClickToCallButton; Unit 4b adds WhatsApp + SMS.
  const quick = resolveLeadQuickActions(lead);
  const handled = (lead as any).action_permanently_dismissed === true;
  // Only offer "I handled this" when there's an ACTUAL pending action to dismiss.
  // The next-move card shows a generic fallback line even when nothing is pending;
  // dismissing that would set the permanent-dismiss flag and could suppress a
  // FUTURE follow-up reminder until a fresh inbound (Codex P2).
  const hasPendingAction = lead.needs_action === true || !!lead.next_action_key;

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
    <div className="space-y-0">
      {/* Back + Actions row — slim */}
      <div className="flex items-center justify-between pb-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(BACK_ROUTES[originContext])}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex gap-1.5">
          <ClickToCallButton leadId={lead.id} leadName={lead.name} leadPhone={lead.phone ?? null} />
          {/* Reach out directly (Unit 4b): WhatsApp + SMS open the rep's OWN apps
              via deep-links. Hidden when the number's missing or the lead opted
              out (WhatsApp also needs wa_opted_in). No Email here — "Draft it"
              below is the single compose entry. */}
          {quick.whatsapp && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" asChild>
              <a href={whatsappLink(quick.whatsapp.number, "")} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="h-3.5 w-3.5" />
                WhatsApp
              </a>
            </Button>
          )}
          {quick.sms && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" asChild>
              <a href={smsLink(quick.sms.phone, "")}>
                <MessageSquare className="h-3.5 w-3.5" />
                Text
              </a>
            </Button>
          )}
          {/* LinkedIn message button removed from the lead header (Unit 3) — it
              didn't belong among the page-level actions. LinkedIn outreach stays
              available in the Outreach flow (campaign LinkedIn touches). */}
          <EditLeadDialog lead={lead} onUpdate={onUpdate} />
          {/* Reconnect chip renders ONLY when a workspace mail_account has
              needs_reconnect=true or status='error'. Rendered outside the
              isConnected ternary because `isConnected` here comes from the
              legacy gmail_connections check — a token can be revoked while
              the legacy row still exists, leaving isConnected=true and
              hiding the chip exactly when the user needs it. */}
          <MailReconnectChip compact />
          {isConnected ? (
            <GmailSyncButton leadId={lead.id} leadEmail={lead.email} onSyncComplete={onSyncComplete} />
          ) : (
            <Button variant="outline" size="sm" className="h-8 text-xs" asChild>
              <Link to="/app/settings"><Mail className="h-3.5 w-3.5 mr-1.5" />Connect Gmail</Link>
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
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
      </div>

      {/* ROW 1 — Identity + Status Strip + Closing Power */}
      <div className="flex items-center gap-6 py-3">
        {/* LEFT — Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold text-foreground leading-tight truncate">{lead.name}</h1>
            {(lead as any).ooo_until && new Date((lead as any).ooo_until) > new Date() && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50 shrink-0">
                <Plane className="h-2.5 w-2.5" />
                OOO until {new Date((lead as any).ooo_until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
            {lead.manual_mode === true && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50 shrink-0"
                title={lead.manual_mode_reason || "Automation paused"}
              >
                <Pause className="h-2.5 w-2.5" />
                Automation paused
              </span>
            )}
            {contextFlags.hasCaution && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-destructive/10 text-destructive border border-destructive/20 shrink-0">
                <AlertTriangle className="h-2.5 w-2.5" />
                Caution
              </span>
            )}
            {contextFlags.hasRelationship && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20 shrink-0">
                <Handshake className="h-2.5 w-2.5" />
                Prior Relationship
              </span>
            )}
            {contextFlags.hasProduct && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-muted text-muted-foreground border border-border shrink-0">
                <ShoppingCart className="h-2.5 w-2.5" />
                Product Owned
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground leading-snug truncate">
            {lead.job_title ? `${lead.job_title} · ` : ""}{lead.company}{lead.country ? ` · ${lead.country}` : ""}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{lead.email}</p>

          {/* Plain-English status line — replaces the phase/closing-power cluster */}
          <p className="text-sm font-medium text-foreground mt-1.5">{statusLine}</p>

          {/* Stakeholder avatars — only when this is a 2+ person deal. */}
          <StakeholderAvatarRow leadId={lead.id} currentLeadId={lead.id} />
        </div>
      </div>

      {/* ROW 2 — Next move + one-tap Draft it (never a dead card). When the rep
          has marked it handled, show a calm state instead of nagging — it comes
          back on its own when the customer replies (existing re-arm). */}
      <div className="border-t border-border/40" />
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 py-3">
        {handled ? (
          <>
            <div className="flex-1 min-w-0 flex items-center gap-2 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-emerald-500 shrink-0" />
              <span>You've handled this — it'll come back if they reply.</span>
            </div>
            {onDraftIt && (
              <Button variant="ghost" size="sm" onClick={onDraftIt} className="shrink-0 text-muted-foreground gap-1.5">
                <PenLine className="h-4 w-4" />
                Draft it anyway
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5">Next move</span>
              <p className="text-sm font-medium text-foreground">
                {lead.next_step || "Send a quick check-in to keep this moving"}
              </p>
              {lead.next_step_reason && (
                <p className="text-xs text-muted-foreground mt-0.5">{lead.next_step_reason}</p>
              )}
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
              {onMarkHandled && hasPendingAction && (
                <Button variant="ghost" size="sm" onClick={onMarkHandled} className="text-muted-foreground gap-1.5">
                  <Check className="h-4 w-4" />
                  I handled this
                </Button>
              )}
              {onDraftIt && (
                <Button onClick={onDraftIt} className="flex-1 sm:flex-none gap-1.5">
                  <PenLine className="h-4 w-4" />
                  Draft it
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
