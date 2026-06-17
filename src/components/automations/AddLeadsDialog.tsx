import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Search, Loader2, AlertTriangle, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { getLeadsList, type LeadListItem } from "@/lib/supabaseQueries";
import {
  previewEnrollment,
  enrollLeadsInCampaign,
  type EnrollmentPreview,
} from "@/lib/campaignEnrollment";

interface AddLeadsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaignId: string;
  /** Lead ids already on the People list — hidden from the picker. */
  excludeIds: string[];
  onAdded: () => void;
}

type Phase = "pick" | "review";

export function AddLeadsDialog({
  open,
  onOpenChange,
  campaignId,
  excludeIds,
  onAdded,
}: AddLeadsDialogProps) {
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [phase, setPhase] = useState<Phase>("pick");
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<EnrollmentPreview | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch("");
    setPhase("pick");
    setPreview(null);
    setLoading(true);
    getLeadsList()
      .then(setLeads)
      .catch(() => toast.error("Couldn't load your people"))
      .finally(() => setLoading(false));
  }, [open]);

  const excluded = useMemo(() => new Set(excludeIds), [excludeIds]);

  const available = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads
      .filter((l) => !excluded.has(l.id))
      .filter(
        (l) =>
          !q ||
          l.name.toLowerCase().includes(q) ||
          (l.company || "").toLowerCase().includes(q) ||
          (l.email || "").toLowerCase().includes(q),
      );
  }, [leads, excluded, search]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  // Step 1 → 2: show the honest plan (capacity + who'll be skipped) before committing.
  const handleContinue = async () => {
    if (selected.size === 0) return;
    setPreviewing(true);
    try {
      const p = await previewEnrollment(campaignId, Array.from(selected));
      setPreview(p);
      setPhase("review");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't build the plan");
    } finally {
      setPreviewing(false);
    }
  };

  // Step 2: commit the enrollment.
  const handleEnroll = async () => {
    setEnrolling(true);
    try {
      const result = await enrollLeadsInCampaign(campaignId, Array.from(selected));
      if (result.enrolled === 0) {
        toast.info("No one new was enrolled — everyone selected was skipped.");
      } else {
        toast.success(`Enrolled ${result.enrolled} ${result.enrolled === 1 ? "person" : "people"}`);
      }
      onAdded();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't enroll those people");
    } finally {
      setEnrolling(false);
    }
  };

  const skipLines = useMemo(() => {
    if (!preview) return [];
    const s = preview.skips;
    const lines: string[] = [];
    if (s.unsubscribed) lines.push(`${s.unsubscribed} opted out — won't be contacted`);
    if (s.suppressed) lines.push(`${s.suppressed} on your do-not-contact list`);
    if (s.alreadyEnrolled) lines.push(`${s.alreadyEnrolled} already in another outreach`);
    if (s.missingEmail) lines.push(`${s.missingEmail} have no email address`);
    if (s.activeOrCustomer) lines.push(`${s.activeOrCustomer} skipped — already a customer or closed deal, have a meeting booked, or recently replied`);
    return lines;
  }, [preview]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {phase === "pick" ? (
          <>
            <DialogHeader>
              <DialogTitle>Add people</DialogTitle>
              <DialogDescription>
                Pick who should go into this outreach. You can add more anytime.
              </DialogDescription>
            </DialogHeader>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, company, or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : available.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {leads.length === 0
                    ? "You don't have any people yet. Add leads first."
                    : search
                      ? "No matches."
                      : "Everyone is already in this outreach."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {available.map((l) => (
                    <li key={l.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-accent">
                        <Checkbox
                          checked={selected.has(l.id)}
                          onCheckedChange={() => toggle(l.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {l.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[l.company, l.email].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {selected.size > 0 ? `${selected.size} selected` : "None selected"}
              </span>
              <Button onClick={handleContinue} disabled={selected.size === 0 || previewing}>
                {previewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Here's the plan</DialogTitle>
              <DialogDescription>
                A quick, honest preview before anyone is enrolled.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-md border border-border p-3">
                <p className="text-sm font-medium text-foreground">
                  {preview?.enrollableCount ?? 0} of {selected.size}{" "}
                  {selected.size === 1 ? "person" : "people"} will be enrolled
                </p>
                {preview?.capacity?.summary && (
                  <p className="mt-1 text-xs text-muted-foreground">{preview.capacity.summary}</p>
                )}
              </div>

              {preview?.capacity?.warning && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{preview.capacity.warning}</AlertDescription>
                </Alert>
              )}

              {(skipLines.length > 0 || (preview?.channelSkips.lines.length ?? 0) > 0) && (
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  {skipLines.map((line, i) => (
                    <p key={`skip-${i}`}>• {line}</p>
                  ))}
                  {preview?.channelSkips.lines.map((line, i) => (
                    <p key={`chan-${i}`}>• {line}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setPhase("pick")} disabled={enrolling}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              <Button
                onClick={handleEnroll}
                disabled={enrolling || (preview?.enrollableCount ?? 0) === 0}
              >
                {enrolling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Enroll {preview?.enrollableCount ?? 0}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
