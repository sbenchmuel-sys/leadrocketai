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
import { toast } from "sonner";
import { Plus, Search, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { LeadImportDialog } from "@/components/leads/LeadImportDialog";

export default function Leads() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LeadListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [newLead, setNewLead] = useState<CreateLeadInput>({
    name: "",
    company: "",
    email: "",
    strategy: "fast",
  });

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
      await createLead(newLead);
      toast.success("Lead created!");
      setIsAddOpen(false);
      setNewLead({ name: "", company: "", email: "", strategy: "fast" });
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
                <Label htmlFor="strategy">Strategy</Label>
                <Select
                  value={newLead.strategy}
                  onValueChange={(value: "fast" | "nurture") =>
                    setNewLead({ ...newLead, strategy: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fast">Fast</SelectItem>
                    <SelectItem value="nurture">Nurture</SelectItem>
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
          </div>
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
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Outlook</TableHead>
                    <TableHead>Last Activity</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLeads.map((lead) => (
                    <TableRow key={lead.id} className="cursor-pointer hover:bg-accent">
                      <TableCell>
                        <Link
                          to={`/dashboard/leads/${lead.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {lead.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{lead.company}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{lead.strategy}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{lead.status}</Badge>
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
                            <DropdownMenuItem onClick={() => navigate(`/dashboard/leads/${lead.id}`)}>
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
    </div>
  );
}
