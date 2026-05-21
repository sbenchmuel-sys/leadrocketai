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
    if (!user) {
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

      // 1. Fetch ALL memberships for this user
      const { data: memberships } = await supabase
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", user.id);

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

        // Pick active: saved preference → first
        const savedId = localStorage.getItem(STORAGE_KEY);
        const active = allWs.find(w => w.workspace_id === savedId) ?? allWs[0];
        setWorkspaceId(active.workspace_id);
        setWorkspaceRole(active.role);
        setWorkspaceName(active.workspace_name);
        setWorkspaceTimezone(active.workspace_timezone);
        setIsLoading(false);
        return;
      }

      // 2. Check pending invitations for user's email
      const userEmail = user.email;
      if (userEmail) {
        const { data: invitation } = await supabase
          .from("workspace_invitations")
          .select("id, workspace_id, role")
          .eq("email", userEmail.toLowerCase())
          .eq("status", "pending")
          .limit(1)
          .maybeSingle();

        if (invitation) {
          const { error: memberErr } = await supabase
            .from("workspace_members")
            .insert({
              workspace_id: invitation.workspace_id,
              user_id: user.id,
              role: invitation.role,
            });

          if (!memberErr) {
            await supabase
              .from("workspace_invitations")
              .update({ status: "accepted", accepted_at: new Date().toISOString() })
              .eq("id", invitation.id);

            const { data: ws } = await supabase
              .from("workspaces")
              .select("name, timezone")
              .eq("id", invitation.workspace_id)
              .maybeSingle();

            const name = ws?.name ?? "Workspace";
            const tz = (ws as { timezone?: string | null } | null)?.timezone ?? null;
            const membership: WorkspaceMembership = {
              workspace_id: invitation.workspace_id,
              role: invitation.role,
              workspace_name: name,
              workspace_timezone: tz,
            };
            setWorkspaces([membership]);
            setWorkspaceId(invitation.workspace_id);
            setWorkspaceRole(invitation.role);
            setWorkspaceName(name);
            setWorkspaceTimezone(tz);
            setIsLoading(false);
            return;
          }
        }
      }

      // 3. Auto-provision a new workspace
      const { error: wsErr } = await supabase
        .from("workspaces")
        .insert({ name: "My Workspace", plan: "free" } as any);

      if (!wsErr) {
        const { data: newMembership } = await supabase
          .from("workspace_members")
          .select("workspace_id, role")
          .eq("user_id", user.id)
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
  }, [user]);

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
