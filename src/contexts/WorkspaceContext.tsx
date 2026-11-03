import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface WorkspaceMembership {
  workspace_id: string;
  role: string;
  workspace_name: string;
  /** IANA timezone name (e.g. "America/New_York"). NULL when the workspace
   *  hasn't been configured — readers should fall back to UTC for display
   *  (see src/lib/eligibleAtFormat.ts). Automation send paths fail closed
   *  on NULL per migration 20260430200000_workspace_timezone.sql. */
  workspace_timezone: string | null;
}

/**
 * Join every workspace this user has a PENDING invitation to (matched on their
 * email) and return the joined workspace ids.
 *
 * Two bugs this replaces: (1) the check only ran for users with NO workspace, so
 * anyone who already had one (e.g. a client admin's old sandbox) was never added;
 * (2) it inserted the membership from the browser, which RLS refuses ("admins or
 * the first member of an empty workspace" only), so even brand-new invitees were
 * silently auto-provisioned an empty workspace instead — no invitation has ever
 * been accepted. The accept-workspace-invite edge function does the insert with
 * server rights after checking the invitation's email matches the signed-in user.
 */
export async function acceptPendingInvitations(
  email: string | null | undefined,
  existingWorkspaceIds: string[],
): Promise<string[]> {
  if (!email) return [];
  const { data: invitations } = await supabase
    .from("workspace_invitations")
    .select("id, workspace_id")
    .eq("email", email.toLowerCase())
    .eq("status", "pending");
  const joined: string[] = [];
  for (const inv of invitations ?? []) {
    const { data, error } = await supabase.functions.invoke("accept-workspace-invite", {
      body: { invitation_id: inv.id },
    });
    // Failure leaves the invitation pending; the next load retries.
    if (!error && data?.ok && !existingWorkspaceIds.includes(inv.workspace_id)) joined.push(inv.workspace_id);
  }
  return joined;
}

interface WorkspaceContextType {
  workspaceId: string | null;
  workspaceRole: string | null;
  workspaceName: string | null;
  /** PR C — exposed for time-aware UI formatters (Queue page eligible_at,
   *  etc.). NULL when not configured; formatters fall back to UTC. */
  workspaceTimezone: string | null;
  workspaces: WorkspaceMembership[];
  isLoading: boolean;
  switchWorkspace: (workspaceId: string) => void;
  refreshWorkspace: () => Promise<void>;
}

const STORAGE_KEY = "active_workspace_id";

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  // Keyed on id/email, not the user object: supabase-js hands out a new object on
  // every token refresh / tab return, which re-ran the whole workspace lookup.
  const userId = user?.id;
  const userEmail = user?.email;
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [workspaceTimezone, setWorkspaceTimezone] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const switchWorkspace = useCallback((wsId: string) => {
    const ws = workspaces.find(w => w.workspace_id === wsId);
    if (!ws) return;
    setWorkspaceId(ws.workspace_id);
    setWorkspaceRole(ws.role);
    setWorkspaceName(ws.workspace_name);
    setWorkspaceTimezone(ws.workspace_timezone);
    localStorage.setItem(STORAGE_KEY, wsId);
  }, [workspaces]);

  const resolveWorkspace = useCallback(async () => {
    if (!userId) {
      setWorkspaceId(null);
      setWorkspaceRole(null);
      setWorkspaceName(null);
      setWorkspaceTimezone(null);
      setWorkspaces([]);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      // 1. Fetch ALL memberships for this user — after joining any workspace they
      //    were invited to (existing users included; see acceptPendingInvitations).
      const fetchMemberships = () => supabase
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", userId)
        // Oldest membership first, so the `allWs[0]` fallback below is deterministic.
        .order("created_at", { ascending: true });
      let { data: memberships } = await fetchMemberships();
      const justJoined = await acceptPendingInvitations(
        userEmail, (memberships ?? []).map(m => m.workspace_id),
      );
      if (justJoined.length > 0) ({ data: memberships } = await fetchMemberships());

      if (memberships && memberships.length > 0) {
        // Fetch workspace names + timezones
        const wsIds = memberships.map(m => m.workspace_id);
        const { data: wsData } = await supabase
          .from("workspaces")
          .select("id, name, timezone")
          .in("id", wsIds);

        const wsByIdRow = new Map(
          (wsData ?? []).map(w => [w.id, { name: w.name, timezone: (w as { timezone?: string | null }).timezone ?? null }]),
        );
        const allWs: WorkspaceMembership[] = memberships.map(m => {
          const row = wsByIdRow.get(m.workspace_id);
          return {
            workspace_id: m.workspace_id,
            role: m.role,
            workspace_name: row?.name ?? "Workspace",
            workspace_timezone: row?.timezone ?? null,
          };
        });
        setWorkspaces(allWs);

        // Pick active: a workspace they were just invited into → saved preference → first
        const savedId = localStorage.getItem(STORAGE_KEY);
        const active =
          allWs.find(w => w.workspace_id === justJoined[0]) ??
          allWs.find(w => w.workspace_id === savedId) ??
          allWs[0];
        if (justJoined.length > 0) localStorage.setItem(STORAGE_KEY, active.workspace_id);
        setWorkspaceId(active.workspace_id);
        setWorkspaceRole(active.role);
        setWorkspaceName(active.workspace_name);
        setWorkspaceTimezone(active.workspace_timezone);
        setIsLoading(false);
        return;
      }

      // 2. No workspace and no invitation → auto-provision a new one.
      const { error: wsErr } = await supabase
        .from("workspaces")
        .insert({ name: "My Workspace", plan: "free" } as any);

      if (!wsErr) {
        const { data: newMembership } = await supabase
          .from("workspace_members")
          .select("workspace_id, role")
          .eq("user_id", userId)
          .limit(1)
          .maybeSingle();

        if (newMembership) {
          // Freshly auto-provisioned workspace has no timezone set yet —
          // owner configures it before automation can fire.
          const membership: WorkspaceMembership = {
            workspace_id: newMembership.workspace_id,
            role: newMembership.role,
            workspace_name: "My Workspace",
            workspace_timezone: null,
          };
          setWorkspaces([membership]);
          setWorkspaceId(newMembership.workspace_id);
          setWorkspaceRole(newMembership.role);
          setWorkspaceName("My Workspace");
          setWorkspaceTimezone(null);
        }
      }
    } catch (err) {
      console.error("[WorkspaceContext] Failed to resolve workspace:", err);
    } finally {
      setIsLoading(false);
    }
  }, [userId, userEmail]);

  useEffect(() => {
    if (!authLoading) {
      resolveWorkspace();
    }
  }, [authLoading, resolveWorkspace]);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaceId,
        workspaceRole,
        workspaceName,
        workspaceTimezone,
        workspaces,
        isLoading,
        switchWorkspace,
        refreshWorkspace: resolveWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (context === undefined) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return context;
}
