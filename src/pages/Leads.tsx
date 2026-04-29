import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getLeadsList, createLead, deleteLead, LeadListItem, CreateLeadInput } from "@/lib/supabaseQueries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Plus, Search, MoreHorizontal, Pencil, Trash2, RefreshCw, AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { SOURCE_TYPE_LABELS, SourceType } from "@/lib/dashboardUtils";
import { SourceDropdown } from "@/components/dashboard/SourceDropdown";
import { LeadImportDialog } from "@/components/leads/LeadImportDialog";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { useMailSync } from "@/hooks/useMailSync";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PendingLeadsTab, { usePendingCandidatesCount } from "@/components/leads/PendingLeadsTab";

export default function Leads() {
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const { connectGmail, isConnected: isGmailConnected, isLoading: isGmailLoading } = useGmailConnection();
  const { provider, providerLabel, isConnected: isMailConnected, isLoading: isMailLoading } = useMailSync();
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LeadListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showReconnectPrompt, setShowReconnectPrompt] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [newLead, setNewLead] = useState<CreateLeadInput>({
    name: "",
    company: "",
    email: "",
    source_type: "manual_entry",
  });

  const handleReconnectMail = async () => {
    setIsReconnecting(true);
    try {
      if (provider === "outlook") {
        navigate("/app/settings");
        toast.info("Reconnect Outlook from Settings");
      } else {
        await connectGmail("/leads");
      }
    } catch (err) {
      toast.error(`Failed to start ${providerLabel} reconnection`);
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleDeleteLead = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteLead(deleteTarget.id);
      toast.success("Lead deleted");
      setDeleteTarget(null);
      loadLeads();
    } catch (err) {
      toast.error("Failed to delete lead");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    setIsDeleting(true);
    try {
      await Promise.all(Array.from(selectedIds).map((id) => deleteLead(id)));
      toast.success(`${selectedIds.size} lead(s) deleted`);
      setSelectedIds(new Set());
      setShowBulkDeleteDialog(false);
      loadLeads();
    } catch (err) {
      toast.error("Failed to delete some leads");
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredLeads.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredLeads.map((l) => l.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  // Helper to detect token/auth errors that require Gmail reconnection
  const isReconnectError = (error: string): boolean => {
    const reconnectPhrases = [
      "invalid_grant",
      "revoked",
      "reconnect gmail",
      "refresh token",
      "token expired",
      "no refresh token",
      "gmail not connected",
    ];
    const lowerError = error.toLowerCase();
    return reconnectPhrases.some(phrase => lowerError.includes(phrase));
  };

  const handleBulkSync = async () => {
    if (selectedIds.size === 0) return;

    // Check that *some* mail provider is connected
    if (!isMailConnected) {
      setShowReconnectPrompt(true);
      toast.error("Inbox not connected", {
        description: "Connect Gmail or Outlook to sync emails",
      });
      return;
    }

    setIsSyncing(true);
    setShowReconnectPrompt(false);
    const BATCH_SIZE = 15;
    const leadIds = Array.from(selectedIds);
    let totalSynced = 0;
    let totalProcessed = 0;
    let firstError: string | null = null;

    const fnName = provider === "outlook" ? "outlook-bulk-sync" : "gmail-bulk-sync";

    try {
      for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
        const batchIds = leadIds.slice(i, i + BATCH_SIZE);
        const { data, error } = await supabase.functions.invoke(fnName, {
          body: { leadIds: batchIds },
        });

        if (error) {
          const errorMsg = error.message || "Failed to sync emails";
          if (isReconnectError(errorMsg)) {
            setShowReconnectPrompt(true);
            toast.error(`${providerLabel} needs reconnection`, {
              description: `Go to Settings to reconnect your ${providerLabel} account`,
            });
            return;
          }
          firstError ||= errorMsg;
          continue;
        }

        if (data?.needsReconnect || isReconnectError(data?.error || "")) {
          setShowReconnectPrompt(true);
          toast.error(`${providerLabel} needs reconnection`, {
            description: `Go to Settings to reconnect your ${providerLabel} account`,
          });
          return;
        }

        if (data?.ok) {
          totalSynced += Number(data.totalSynced ?? 0);
          totalProcessed += Number(data.leadsProcessed ?? batchIds.length);
        } else {
          firstError ||= data?.error || "Sync failed";
        }
      }

      if (firstError && totalProcessed === 0) {
        toast.error(firstError);
        return;
      }

      const processedCount = totalProcessed || leadIds.length;
      const msg = totalSynced > 0
        ? `Synced ${totalSynced} new email${totalSynced > 1 ? "s" : ""} for ${processedCount} lead(s)`
        : `Inbox is up to date for ${processedCount} lead(s)`;
      toast.success(msg);

      if (firstError) {
        toast.warning(`Some leads could not be synced: ${firstError}`);
      }

      setSelectedIds(new Set());
      loadLeads();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to sync emails";
      if (isReconnectError(errorMsg)) {
        setShowReconnectPrompt(true);
        toast.error(`${providerLabel} needs reconnection`, {
          description: `Go to Settings to reconnect your ${providerLabel} account`,
        });
      } else {
        toast.error(errorMsg);
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const loadLeads = async () => {
    try {
      const data = await getLeadsList();
      setLeads(data);
    } catch (err) {
      toast.error("Failed to load leads");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLeads();
  }, []);

  const handleAddLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createLead({ ...newLead, workspace_id: workspaceId });
      toast.success("Lead created!");
      setIsAddOpen(false);
      setNewLead({ name: "", company: "", email: "", source_type: "manual_entry" });
      loadLeads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create lead");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredLeads = leads.filter(
    (lead) =>
      lead.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.company.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getOutlookColor = (outlook: string | null) => {
    switch (outlook) {
      case "positive":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "negative":
        return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      default:
        return "bg-secondary text-secondary-foreground";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Leads</h1>
        <div className="flex items-center gap-2">
          <LeadImportDialog onImportComplete={loadLeads} />
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Lead
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Lead</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleAddLead} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={newLead.name}
                  onChange={(e) => setNewLead({ ...newLead, name: e.target.value })}
                  placeholder="John Smith"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company">Company</Label>
                <Input
                  id="company"
                  value={newLead.company}
                  onChange={(e) => setNewLead({ ...newLead, company: e.target.value })}
                  placeholder="Acme Corp"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={newLead.email}
                  onChange={(e) => setNewLead({ ...newLead, email: e.target.value })}
                  placeholder="john@acme.com"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="source_type">Source</Label>
                <Select
                  value={newLead.source_type || "manual_entry"}
                  onValueChange={(value) =>
                    setNewLead({ ...newLead, source_type: value as CreateLeadInput["source_type"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual_entry">Manual Entry</SelectItem>
                    <SelectItem value="outbound_prospecting">Outbound Prospecting</SelectItem>
                    <SelectItem value="contact_form">Contact Form</SelectItem>
                    <SelectItem value="gmail_inbound">Inbound Email</SelectItem>
                    <SelectItem value="event_lead">Event Lead</SelectItem>
                    <SelectItem value="referral">Referral</SelectItem>
                    <SelectItem value="csv_import">CSV Import</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Lead"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search leads..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            {selectedIds.size > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkSync}
                  disabled={isSyncing || isGmailLoading || isMailLoading}
                  title={!isMailConnected ? "Connect Gmail or Outlook first" : undefined}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                  {isSyncing ? "Syncing..." : `Sync ${providerLabel} (${selectedIds.size})`}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setShowBulkDeleteDialog(true)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete ({selectedIds.size})
                </Button>
              </>
            )}
          </div>
          {showReconnectPrompt && (
            <Alert variant="destructive" className="mt-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>
                  {isMailConnected
                    ? `${providerLabel} access has expired. Please reconnect to continue syncing emails.`
                    : `No inbox is connected. Please connect Gmail or Outlook to sync emails.`}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReconnectMail}
                  disabled={isReconnecting}
                  className="ml-4"
                >
                  {isReconnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      {isMailConnected ? `Reconnect ${providerLabel}` : `Connect ${providerLabel}`}
                    </>
                  )}
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : filteredLeads.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              {searchQuery ? "No leads match your search" : "No leads yet. Add your first lead!"}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={filteredLeads.length > 0 && selectedIds.size === filteredLeads.length}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Sentiment</TableHead>
                    <TableHead>Last Activity</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLeads.map((lead) => (
                    <TableRow key={lead.id} className="cursor-pointer hover:bg-accent">
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(lead.id)}
                          onCheckedChange={() => toggleSelect(lead.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/app/leads/${lead.id}`}
                          state={{ originContext: "leads" }}
                          className="font-medium text-foreground hover:underline"
                        >
                          {lead.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{lead.country || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{lead.company}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <SourceDropdown
                          leadId={lead.id}
                          leadName={lead.name}
                          currentSourceType={(lead.source_type || "manual_entry") as SourceType}
                          onUpdated={loadLeads}
                        />
                      </TableCell>
                      <TableCell>
                        {lead.deal_outlook && (
                          <Badge className={getOutlookColor(lead.deal_outlook)}>
                            {lead.deal_outlook}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(lead.last_activity_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/app/leads/${lead.id}`, { state: { originContext: "leads" } })}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(lead)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lead</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong> from <strong>{deleteTarget?.company}</strong>? 
              This will permanently remove all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteLead}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Lead(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{selectedIds.size}</strong> selected lead(s)? 
              This will permanently remove all associated data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : `Delete ${selectedIds.size} Lead(s)`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
