import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Building2, ChevronsUpDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  rep: "Rep",
};

export function WorkspaceSwitcher() {
  const { workspaceId, workspaceName, workspaceRole, workspaces, switchWorkspace } = useWorkspace();

  if (workspaces.length <= 1) {
    // Single workspace — show name without dropdown
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-md">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Building2 className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{workspaceName ?? "Workspace"}</p>
          {workspaceRole && (
            <p className="text-[10px] text-muted-foreground capitalize">{ROLE_LABELS[workspaceRole] ?? workspaceRole}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-2 rounded-md w-full hover:bg-accent transition-colors text-left">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary flex-shrink-0">
            <Building2 className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{workspaceName ?? "Workspace"}</p>
            {workspaceRole && (
              <p className="text-[10px] text-muted-foreground capitalize">{ROLE_LABELS[workspaceRole] ?? workspaceRole}</p>
            )}
          </div>
          <ChevronsUpDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Switch workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((ws) => (
          <DropdownMenuItem
            key={ws.workspace_id}
            onClick={() => switchWorkspace(ws.workspace_id)}
            className="flex items-center gap-2 cursor-pointer"
          >
            <div className={cn(
              "flex h-6 w-6 items-center justify-center rounded bg-primary/10 text-primary flex-shrink-0",
              ws.workspace_id === workspaceId && "bg-primary text-primary-foreground"
            )}>
              <Building2 className="h-3.5 w-3.5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm truncate">{ws.workspace_name}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{ROLE_LABELS[ws.role] ?? ws.role}</p>
            </div>
            {ws.workspace_id === workspaceId && (
              <Check className="h-4 w-4 text-primary flex-shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
