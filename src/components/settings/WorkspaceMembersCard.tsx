import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, UserPlus, Trash2, Crown, Shield, User, Mail } from "lucide-react";

interface Member {
  user_id: string;
  role: string;
  email: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  admin: <Crown className="h-3 w-3" />,
  manager: <Shield className="h-3 w-3" />,
  rep: <User className="h-3 w-3" />,
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  rep: "Rep",
};

export function WorkspaceMembersCard() {
  const { workspaceId, workspaceRole, workspaceName, refreshWorkspace } = useWorkspace();
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("rep");
  const [isInviting, setIsInviting] = useState(false);
  const [wsName, setWsName] = useState(workspaceName ?? "");
  const [isSavingName, setIsSavingName] = useState(false);

  const isAdmin = workspaceRole === "admin";

  const fetchMembers = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setIsLoading(true);

      // Fetch members with role
      const { data: memberRows } = await supabase
        .from("workspace_members")
        .select("user_id, role")
        .eq("workspace_id", workspaceId);

      // We can't query auth.users from client. Use the current user's email
      // for self, and show user_id prefix for others.
      const memberList: Member[] = [];
      if (memberRows) {
        for (const m of memberRows) {
          memberList.push({
            user_id: m.user_id,
            role: m.role,
            email: m.user_id === user?.id ? (user.email ?? "You") : m.user_id.slice(0, 8) + "…",
          });
        }
      }
      setMembers(memberList);

      // Fetch pending invitations
      const { data: inviteRows } = await supabase
        .from("workspace_invitations")
        .select("id, email, role, status, created_at")
        .eq("workspace_id", workspaceId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      setInvitations(inviteRows ?? []);
    } catch (err) {
      console.error("[WorkspaceMembers] fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    setWsName(workspaceName ?? "");
  }, [workspaceName]);

  const handleSaveName = async () => {
    if (!workspaceId || !wsName.trim()) return;
    setIsSavingName(true);
    try {
      const { error } = await supabase
        .from("workspaces")
        .update({ name: wsName.trim() })
        .eq("id", workspaceId);
      if (error) throw error;
      toast.success("Workspace name updated");
      await refreshWorkspace();
    } catch {
      toast.error("Failed to update workspace name");
    } finally {
      setIsSavingName(false);
    }
  };

  const handleInvite = async () => {
    if (!workspaceId || !inviteEmail.trim() || !user) return;
    setIsInviting(true);
    try {
      const { error } = await supabase
        .from("workspace_invitations")
        .insert({
          workspace_id: workspaceId,
          email: inviteEmail.trim().toLowerCase(),
          role: inviteRole as "admin" | "manager" | "rep",
          invited_by: user.id,
        });
      if (error) {
        if (error.code === "23505") {
          toast.error("This email has already been invited");
        } else {
          throw error;
        }
      } else {
        toast.success(`Invitation sent to ${inviteEmail.trim()}`);
        setInviteEmail("");
        await fetchMembers();
      }
    } catch {
      toast.error("Failed to send invitation");
    } finally {
      setIsInviting(false);
    }
  };

  const handleChangeRole = async (userId: string, newRole: string) => {
    if (!workspaceId) return;
    try {
      const { error } = await supabase
        .from("workspace_members")
        .update({ role: newRole })
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId);
      if (error) throw error;
      toast.success("Role updated");
      await fetchMembers();
    } catch {
      toast.error("Failed to update role");
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!workspaceId || userId === user?.id) return;
    try {
      const { error } = await supabase
        .from("workspace_members")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId);
      if (error) throw error;
      toast.success("Member removed");
      await fetchMembers();
    } catch {
      toast.error("Failed to remove member");
    }
  };

  const handleRevokeInvite = async (invitationId: string) => {
    try {
      const { error } = await supabase
        .from("workspace_invitations")
        .delete()
        .eq("id", invitationId);
      if (error) throw error;
      toast.success("Invitation revoked");
      await fetchMembers();
    } catch {
      toast.error("Failed to revoke invitation");
    }
  };

  if (!workspaceId) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Workspace Name */}
      {isAdmin && (
        <div className="space-y-2">
          <Label>Workspace Name</Label>
          <div className="flex gap-2">
            <Input
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              placeholder="My Workspace"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveName}
              disabled={isSavingName || wsName.trim() === workspaceName}
            >
              {isSavingName ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {!isAdmin && workspaceName && (
        <div className="text-sm">
          <span className="text-muted-foreground">Workspace:</span>{" "}
          <span className="font-medium">{workspaceName}</span>
        </div>
      )}

      {/* Current Members */}
      <div className="space-y-3">
        <Label>Team Members ({members.length})</Label>
        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.user_id}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {ROLE_ICONS[member.role] ?? <User className="h-3 w-3" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{member.email}</p>
                  {member.user_id === user?.id && (
                    <span className="text-[10px] text-muted-foreground">You</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && member.user_id !== user?.id ? (
                  <>
                    <Select
                      value={member.role}
                      onValueChange={(v) => handleChangeRole(member.user_id, v)}
                    >
                      <SelectTrigger className="h-7 w-[100px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="rep">Rep</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveMember(member.user_id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    {ROLE_LABELS[member.role] ?? member.role}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pending Invitations */}
      {invitations.length > 0 && (
        <div className="space-y-3">
          <Label>Pending Invitations</Label>
          <div className="space-y-2">
            {invitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between rounded-lg border border-dashed px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">{inv.email}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {ROLE_LABELS[inv.role] ?? inv.role}
                  </Badge>
                </div>
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => handleRevokeInvite(inv.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invite Form (admin only) */}
      {isAdmin && (
        <div className="space-y-3 border-t pt-4">
          <Label>Invite Team Member</Label>
          <div className="flex gap-2">
            <Input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              type="email"
              className="flex-1"
            />
            <Select value={inviteRole} onValueChange={(v: string) => setInviteRole(v)}>
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="rep">Rep</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleInvite} disabled={isInviting || !inviteEmail.trim()}>
              {isInviting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Invited users will be automatically added to the workspace when they log in.
          </p>
        </div>
      )}
    </div>
  );
}
