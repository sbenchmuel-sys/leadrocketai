import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Star, Plus, MoreHorizontal, Loader2, Users, Handshake, ExternalLink, Crown, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  getLeadGroupContext,
  removeLeadFromGroup,
  setGroupChampion,
  removePartnerFromGroup,
  type LeadGroupContext,
} from "@/lib/leadGroupQueries";
import { AddStakeholderDialog } from "./AddStakeholderDialog";
import { AddPartnerDialog } from "./AddPartnerDialog";

interface Props {
  leadId: string;
  leadName: string;
  leadCompany: string | null;
  workspaceId: string;
  /** Called whenever a mutation succeeds, so the parent can refresh the lead */
  onChanged?: () => void;
}

export default function StakeholdersPartnersPanel({
  leadId, leadName, leadCompany, workspaceId, onChanged,
}: Props) {
  const [ctx, setCtx] = useState<LeadGroupContext>({ group: null, members: [], partners: [] });
  const [loading, setLoading] = useState(true);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [busyPartner, setBusyPartner] = useState<string | null>(null);
  const [stakeholderDialogOpen, setStakeholderDialogOpen] = useState(false);
  const [partnerDialogOpen, setPartnerDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getLeadGroupContext(leadId);
      setCtx(data);
    } catch (err: any) {
      toast.error(`Failed to load stakeholders: ${err.message ?? "unknown"}`);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const handleAdded = async () => {
    await load();
    onChanged?.();
  };

  const handleMakeChampion = async (memberId: string) => {
    if (!ctx.group) return;
    setBusyMember(memberId);
    try {
      await setGroupChampion(ctx.group.id, memberId);
      toast.success("Champion updated");
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(`Failed: ${err.message ?? "unknown"}`);
    } finally {
      setBusyMember(null);
    }
  };

  const handleRemoveStakeholder = async (memberId: string) => {
    setBusyMember(memberId);
    try {
      await removeLeadFromGroup(memberId);
      toast.success("Removed from group");
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(`Failed: ${err.message ?? "unknown"}`);
    } finally {
      setBusyMember(null);
    }
  };

  const handleRemovePartner = async (contactId: string) => {
    if (!ctx.group) return;
    setBusyPartner(contactId);
    try {
      await removePartnerFromGroup(ctx.group.id, contactId);
      toast.success("Partner removed");
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(`Failed: ${err.message ?? "unknown"}`);
    } finally {
      setBusyPartner(null);
    }
  };

  // Other members (everyone except the lead currently being viewed)
  const otherMembers = ctx.members.filter(m => m.id !== leadId);
  // Is the current lead the champion?
  const currentLeadIsChampion = ctx.group?.champion_lead_id === leadId;
  const champion = ctx.members.find(m => m.is_champion) ?? null;

  return (
    <div className="space-y-3">
      {/* ── Stakeholders ──────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Stakeholders
              {ctx.members.length > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({ctx.members.length})
                </span>
              )}
            </h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setStakeholderDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>

        {loading ? (
          <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : !ctx.group ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            Solo lead. Add a teammate at {leadCompany || "this company"} to start a group.
          </div>
        ) : (
          <>
            {/* Champion banner if current lead isn't champion */}
            {!currentLeadIsChampion && champion && (
              <Link
                to={`/app/leads/${champion.id}`}
                className="flex items-center gap-2 px-3 py-2 text-xs bg-amber-50 dark:bg-amber-900/20 border-b text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
              >
                <Crown className="h-3 w-3 shrink-0" />
                <span>Champion: <span className="font-medium">{champion.name}</span></span>
                <ExternalLink className="h-3 w-3 ml-auto" />
              </Link>
            )}

            <div className="divide-y">
              {otherMembers.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-muted-foreground">
                  Just {leadName} so far. Add another stakeholder to build the group.
                </div>
              ) : (
                otherMembers.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 px-3 py-2">
                    <Link
                      to={`/app/leads/${m.id}`}
                      className="min-w-0 flex-1 group"
                    >
                      <div className="text-sm font-medium text-foreground group-hover:text-primary truncate flex items-center gap-1.5">
                        {m.is_champion && <Star className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />}
                        {m.name}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {[m.job_title, m.email].filter(Boolean).join(" · ")}
                      </div>
                    </Link>
                    {busyMember === m.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {!m.is_champion && (
                            <DropdownMenuItem onClick={() => handleMakeChampion(m.id)}>
                              <Crown className="h-3.5 w-3.5 mr-2" /> Make champion
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => handleRemoveStakeholder(m.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <X className="h-3.5 w-3.5 mr-2" /> Remove from group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Partners ──────────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-2">
            <Handshake className="h-3.5 w-3.5 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Partners
              {ctx.partners.length > 0 && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  ({ctx.partners.length})
                </span>
              )}
            </h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setPartnerDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>

        {loading ? (
          <div className="p-3 text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : ctx.partners.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No partners linked. Use this to track introducers, advisors, or integrators on this deal.
          </div>
        ) : (
          <div className="divide-y">
            {ctx.partners.map((p) => (
              <div key={p.contact_id} className="flex items-center gap-2 px-3 py-2">
                <Link
                  to={`/app/contacts/${p.contact_id}`}
                  className="min-w-0 flex-1 group"
                >
                  <div className="text-sm font-medium text-foreground group-hover:text-primary truncate">
                    {p.display_name || "(no name)"}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {[p.company, p.role_note].filter(Boolean).join(" · ")}
                  </div>
                </Link>
                {busyPartner === p.contact_id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleRemovePartner(p.contact_id)}
                    title="Remove partner"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <AddStakeholderDialog
        open={stakeholderDialogOpen}
        onOpenChange={setStakeholderDialogOpen}
        workspaceId={workspaceId}
        anchorLeadId={leadId}
        anchorLeadName={leadName}
        anchorLeadCompany={leadCompany}
        existingGroupId={ctx.group?.id ?? null}
        existingMemberIds={ctx.members.map(m => m.id)}
        onAdded={handleAdded}
      />
      <AddPartnerDialog
        open={partnerDialogOpen}
        onOpenChange={setPartnerDialogOpen}
        workspaceId={workspaceId}
        anchorLeadId={leadId}
        anchorLeadCompany={leadCompany}
        existingGroupId={ctx.group?.id ?? null}
        existingPartnerContactIds={ctx.partners.map(p => p.contact_id)}
        onAdded={handleAdded}
      />
    </div>
  );
}
