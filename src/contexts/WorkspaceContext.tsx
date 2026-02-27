import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface WorkspaceMembership {
  workspace_id: string;
  role: string;
  workspace_name: string;
}

interface WorkspaceContextType {
  workspaceId: string | null;
  workspaceRole: string | null;
  workspaceName: string | null;
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
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const switchWorkspace = useCallback((wsId: string) => {
    const ws = workspaces.find(w => w.workspace_id === wsId);
    if (!ws) return;
    setWorkspaceId(ws.workspace_id);
    setWorkspaceRole(ws.role);
    setWorkspaceName(ws.workspace_name);
    localStorage.setItem(STORAGE_KEY, wsId);
  }, [workspaces]);

  const resolveWorkspace = useCallback(async () => {
    if (!user) {
      setWorkspaceId(null);
      setWorkspaceRole(null);
      setWorkspaceName(null);
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
        // Fetch workspace names
        const wsIds = memberships.map(m => m.workspace_id);
        const { data: wsData } = await supabase
          .from("workspaces")
          .select("id, name")
          .in("id", wsIds);

        const nameMap = new Map((wsData ?? []).map(w => [w.id, w.name]));
        const allWs: WorkspaceMembership[] = memberships.map(m => ({
          workspace_id: m.workspace_id,
          role: m.role,
          workspace_name: nameMap.get(m.workspace_id) ?? "Workspace",
        }));
        setWorkspaces(allWs);

        // Pick active: saved preference → first
        const savedId = localStorage.getItem(STORAGE_KEY);
        const active = allWs.find(w => w.workspace_id === savedId) ?? allWs[0];
        setWorkspaceId(active.workspace_id);
        setWorkspaceRole(active.role);
        setWorkspaceName(active.workspace_name);
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
              .select("name")
              .eq("id", invitation.workspace_id)
              .maybeSingle();

            const name = ws?.name ?? "Workspace";
            const membership: WorkspaceMembership = {
              workspace_id: invitation.workspace_id,
              role: invitation.role,
              workspace_name: name,
            };
            setWorkspaces([membership]);
            setWorkspaceId(invitation.workspace_id);
            setWorkspaceRole(invitation.role);
            setWorkspaceName(name);
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
          const membership: WorkspaceMembership = {
            workspace_id: newMembership.workspace_id,
            role: newMembership.role,
            workspace_name: "My Workspace",
          };
          setWorkspaces([membership]);
          setWorkspaceId(newMembership.workspace_id);
          setWorkspaceRole(newMembership.role);
          setWorkspaceName("My Workspace");
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
