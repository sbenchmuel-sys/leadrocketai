// StakeholderAvatarRow — Unit 3. A compact avatar strip shown in the lead
// header ONLY when the lead belongs to a group with 2+ people. Solo leads
// render nothing here (no empty placeholder); "Add person" for a solo lead
// lives in the More menu (People & partners). Read-only and workspace-scoped
// via getLeadGroupContext (RLS), so it surfaces only this lead's own group.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Crown } from "lucide-react";
import { cn } from "@/lib/utils";
import { getLeadGroupContext, type GroupMember } from "@/lib/leadGroupQueries";

interface Props {
  leadId: string;
  /** The lead currently being viewed — its avatar is highlighted. */
  currentLeadId: string;
}

function initials(name: string | null): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MAX_AVATARS = 5;

export default function StakeholderAvatarRow({ leadId, currentLeadId }: Props) {
  const [members, setMembers] = useState<GroupMember[]>([]);

  useEffect(() => {
    let cancelled = false;
    getLeadGroupContext(leadId)
      .then((ctx) => { if (!cancelled) setMembers(ctx.members); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [leadId]);

  // Only a true multi-person deal gets the row.
  if (members.length < 2) return null;

  // Champion first, then the rest; keep it stable and compact.
  const ordered = [...members].sort((a, b) => Number(b.is_champion) - Number(a.is_champion));
  const shown = ordered.slice(0, MAX_AVATARS);
  const overflow = ordered.length - shown.length;

  return (
    <div className="flex items-center gap-1.5 mt-2" aria-label={`${members.length} people on this deal`}>
      <div className="flex -space-x-1.5">
        {shown.map((m) => (
          <Link
            key={m.id}
            to={`/app/leads/${m.id}`}
            title={[m.name, m.job_title].filter(Boolean).join(" · ") + (m.is_champion ? " · champion" : "")}
            className={cn(
              "relative inline-flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-semibold transition-transform hover:z-10 hover:scale-110",
              m.id === currentLeadId
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted text-muted-foreground border-background",
            )}
          >
            {initials(m.name)}
            {m.is_champion && (
              <Crown className="absolute -top-1 -right-1 h-2.5 w-2.5 text-amber-500 fill-amber-500" />
            )}
          </Link>
        ))}
      </div>
      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground tabular-nums">+{overflow}</span>
      )}
      <span className="text-[11px] text-muted-foreground ml-0.5">on this deal</span>
    </div>
  );
}
