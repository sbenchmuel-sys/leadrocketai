import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface WorkspaceContextType {
  workspaceId: string | null;
  workspaceRole: string | null;
  workspaceName: string | null;
  isLoading: boolean;
  refreshWorkspace: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const resolveWorkspace = useCallback(async () => {
    if (!user) {
      setWorkspaceId(null);
      setWorkspaceRole(null);
      setWorkspaceName(null);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);

      // 1. Check existing membership
      const { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id, role")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (membership) {
        setWorkspaceId(membership.workspace_id);
        setWorkspaceRole(membership.role);
        // Fetch workspace name
        const { data: ws } = await supabase
          .from("workspaces")
          .select("name")
          .eq("id", membership.workspace_id)
          .maybeSingle();
        setWorkspaceName(ws?.name ?? null);
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
          // Auto-accept: insert membership and update invitation
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

            setWorkspaceId(invitation.workspace_id);
            setWorkspaceRole(invitation.role);
            const { data: ws } = await supabase
              .from("workspaces")
              .select("name")
              .eq("id", invitation.workspace_id)
              .maybeSingle();
            setWorkspaceName(ws?.name ?? null);
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
        // Trigger auto_add_workspace_creator adds admin membership
        const { data: newMembership } = await supabase
          .from("workspace_members")
          .select("workspace_id, role")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (newMembership) {
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
        isLoading,
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
