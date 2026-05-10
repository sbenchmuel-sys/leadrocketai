import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Briefcase,
  Building2,
  Check,
  Crown,
  ExternalLink,
  Handshake,
  Mail,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  canEditContact,
  getContactDetail,
  getGroupsForContact,
  updateContact,
  type ContactDetailRow,
  type ContactGroupRow,
  type UpdateContactPatch,
} from "@/lib/leadGroupQueries";

// PR 2.3 — Contact detail page.
// Lays out a list of every group/deal this contact is linked to (main column)
// alongside an editable contact-info card (side panel). Auto-save on blur.
// Visual shell mirrors the LeadDetail right-side panels.

export default function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const [contact, setContact] = useState<ContactDetailRow | null>(null);
  const [groups, setGroups] = useState<ContactGroupRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setIsLoading(true);
    setContact(null);
    setGroups([]);
    setCanEdit(false);

    Promise.all([getContactDetail(id), getGroupsForContact(id)])
      .then(async ([c, g]) => {
        if (cancelled) return;
        setContact(c);
        setGroups(g);
        if (c) {
          const editable = await canEditContact(c);
          if (!cancelled) setCanEdit(editable);
        }
      })
      .catch((err) => {
        console.error("[ContactDetail] load failed:", err);
        if (!cancelled) setContact(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Contact not found</p>
        <Button asChild className="mt-4">
          <Link to="/app">Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  const handleFieldSaved = (patch: { display_name?: string | null; company?: string | null }) => {
    setContact((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground truncate">
          {contact.display_name || "(no name)"}
        </h1>
        {contact.company && (
          <p className="text-sm text-muted-foreground truncate">{contact.company}</p>
        )}
      </div>

      {/* Split layout — mirrors LeadDetail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main: linked groups */}
        <div className="lg:col-span-2 space-y-6">
          <GroupsList groups={groups} />
        </div>

        {/* Side: editable contact info */}
        <div className="hidden lg:block space-y-4">
          <ContactInfoPanel
            contact={contact}
            canEdit={canEdit}
            onFieldSaved={handleFieldSaved}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Linked deals list ─────────────────────────────────────────── */
function GroupsList({ groups }: { groups: ContactGroupRow[] }) {
  if (groups.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <Briefcase className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
        <h3 className="text-sm font-semibold text-foreground mb-1">No deals yet</h3>
        <p className="text-xs text-muted-foreground">
          This contact isn't linked to any deal as a partner. Add them from a lead's
          Stakeholders &amp; Partners panel.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <Handshake className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          Linked deals
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            ({groups.length})
          </span>
        </h3>
      </div>
      <div className="divide-y">
        {groups.map((g) => (
          <GroupRow key={g.group_id} group={g} />
        ))}
      </div>
    </div>
  );
}

function GroupRow({ group }: { group: ContactGroupRow }) {
  const titleText = group.group_name || group.champion_company || "(unnamed group)";
  const subtitleParts: React.ReactNode[] = [];
  if (group.champion_lead_id && group.champion_name) {
    subtitleParts.push(
      <span key="champion">
        Champion: <span className="font-medium">{group.champion_name}</span>
      </span>,
    );
    if (group.champion_company && group.champion_company !== titleText) {
      subtitleParts.push(<span key="champion-company"> · {group.champion_company}</span>);
    }
    if (group.champion_stage) {
      subtitleParts.push(<span key="champion-stage"> · {group.champion_stage}</span>);
    }
  } else {
    subtitleParts.push(
      <span key="no-champion" className="italic">
        (no champion)
      </span>,
    );
  }
  if (group.role_note) {
    subtitleParts.push(<span key="role"> · {group.role_note}</span>);
  }

  const inner = (
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
        {group.champion_lead_id && (
          <Crown className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />
        )}
        {titleText}
      </div>
      <div className="text-[11px] text-muted-foreground truncate">
        {subtitleParts}
      </div>
    </div>
  );

  // Only render a clickable link when the joined champion row resolved
  // (champion_name non-null). A non-null champion_lead_id with a null
  // champion_name signals the lead was hidden by RLS (shared contact, other
  // rep's deal), and lead detail rejects non-owner/non-admin loads.
  if (group.champion_lead_id && group.champion_name) {
    return (
      <Link
        to={`/app/leads/${group.champion_lead_id}`}
        className="flex items-center gap-2 px-3 py-3 hover:bg-accent/30 transition-colors group"
      >
        {inner}
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground shrink-0" />
      </Link>
    );
  }
  // Champion missing or hidden by RLS — non-clickable row.
  return <div className="flex items-center gap-2 px-3 py-3 opacity-70">{inner}</div>;
}

/* ── Contact info panel (editable) ─────────────────────────────── */
function ContactInfoPanel({
  contact,
  canEdit,
  onFieldSaved,
}: {
  contact: ContactDetailRow;
  canEdit: boolean;
  onFieldSaved: (patch: { display_name?: string | null; company?: string | null }) => void;
}) {
  const tooltip = canEdit
    ? undefined
    : "Only the assigned rep or workspace admin can edit this contact.";

  const saveField = async (field: keyof UpdateContactPatch, raw: string): Promise<void> => {
    // Convert empty strings to null so we don't store whitespace.
    const value = raw.trim() === "" ? null : raw.trim();
    const updated = await updateContact(contact.id, { [field]: value });
    onFieldSaved({ [field]: updated[field] });
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b">
        <User className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Contact info</h3>
      </div>
      <div className="px-3 py-3 space-y-3">
        <EditableField
          label="Name"
          icon={User}
          value={contact.display_name ?? ""}
          onSave={(v) => saveField("display_name", v)}
          disabled={!canEdit}
          disabledTooltip={tooltip}
        />
        <ReadOnlyEmail value={contact.primary_email} />
        <EditableField
          label="Company"
          icon={Building2}
          value={contact.company ?? ""}
          onSave={(v) => saveField("company", v)}
          disabled={!canEdit}
          disabledTooltip={tooltip}
        />
      </div>
    </div>
  );
}

/* ── Editable field with auto-save on blur ─────────────────────── */
function EditableField({
  label,
  icon: Icon,
  value,
  onSave,
  disabled,
  disabledTooltip,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onSave: (next: string) => Promise<void>; // throws on failure
  disabled: boolean;
  disabledTooltip?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const checkTimer = useRef<number | null>(null);

  // Resync if the parent's value changes (e.g., another field's save updated the row).
  useEffect(() => {
    setDraft(value);
    setSavedValue(value);
  }, [value]);

  // Cleanup the checkmark timer on unmount.
  useEffect(() => {
    return () => {
      if (checkTimer.current) window.clearTimeout(checkTimer.current);
    };
  }, []);

  const handleBlur = async () => {
    if (disabled) return;
    if (draft === savedValue) return;
    setError(null);
    try {
      await onSave(draft);
      setSavedValue(draft);
      setShowCheck(true);
      if (checkTimer.current) window.clearTimeout(checkTimer.current);
      checkTimer.current = window.setTimeout(() => setShowCheck(false), 1000);
    } catch (err) {
      console.error(`[ContactDetail] save failed for ${label}:`, err);
      setError("Couldn't save — try again.");
      toast.error(`Failed to save ${label.toLowerCase()}`);
    }
  };

  const fieldNode = (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </Label>
      <div className="relative">
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onBlur={handleBlur}
          disabled={disabled}
          className={cn(
            "pr-8 h-9 text-sm",
            error && "border-destructive focus-visible:ring-destructive",
          )}
        />
        {showCheck && !error && (
          <Check className="h-3.5 w-3.5 text-emerald-500 absolute right-2 top-1/2 -translate-y-1/2" />
        )}
      </div>
      {error && (
        <p className="text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );

  if (disabled && disabledTooltip) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* span needed because Input doesn't forward refs to a real element when disabled */}
            <span className="block">{fieldNode}</span>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs text-xs">
            {disabledTooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return fieldNode;
}

/* ── Read-only email row (lives in contact_identities) ─────────── */
function ReadOnlyEmail({ value }: { value: string | null }) {
  return (
    <div className="space-y-1">
      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Mail className="h-3 w-3" />
        Email
      </Label>
      <div className="text-sm text-foreground py-2 px-3 rounded-md bg-muted/40 border border-transparent truncate">
        {value || (
          <span className="text-muted-foreground italic">No email on file</span>
        )}
      </div>
    </div>
  );
}
