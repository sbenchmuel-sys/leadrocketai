import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getLeadDetail, LeadDetail as LeadDetailType } from "@/lib/supabaseQueries";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Mail, Briefcase, Phone, Building2, Globe, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import TimelineTab from "@/components/lead/TimelineTab";
import DraftsTab from "@/components/lead/DraftsTab";
import UploadTab from "@/components/lead/UploadTab";
import RecommendationsTab from "@/components/lead/RecommendationsTab";
import { GmailSyncButton } from "@/components/gmail/GmailSyncButton";
import { useGmailConnection } from "@/hooks/useGmailConnection";

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState<LeadDetailType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const { isConnected } = useGmailConnection();

  const loadLead = async () => {
    if (!id) return;
    try {
      const data = await getLeadDetail(id);
      setLead(data);
    } catch (err) {
      toast.error("Failed to load lead");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    await loadLead();
    setRefreshKey(prev => prev + 1);
  };

  useEffect(() => {
    loadLead();
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Lead not found</p>
        <Button asChild className="mt-4">
          <Link to="/dashboard/leads">Back to Leads</Link>
        </Button>
      </div>
    );
  }

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
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/leads">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{lead.name}</h1>
            <Badge variant="outline">{lead.strategy}</Badge>
            <Badge variant="secondary">{lead.status}</Badge>
            {lead.deal_outlook && (
              <Badge className={getOutlookColor(lead.deal_outlook)}>
                {lead.deal_outlook}
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground mt-1">
            {lead.company} • {lead.email}
          </p>
          
          {/* Lead Metadata */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
            {lead.job_title && (
              <span className="flex items-center gap-1">
                <Briefcase className="h-3.5 w-3.5" />
                {lead.job_title}
              </span>
            )}
            {lead.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" />
                {lead.phone}
              </span>
            )}
            {lead.industry && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3.5 w-3.5" />
                {lead.industry}
              </span>
            )}
            {lead.country && (
              <span className="flex items-center gap-1">
                <Globe className="h-3.5 w-3.5" />
                {lead.country}
              </span>
            )}
          </div>

          {lead.initial_message && (
            <div className="mt-3 p-3 bg-muted/50 rounded-md border">
              <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                Initial Message
              </p>
              <p className="text-sm text-foreground">{lead.initial_message}</p>
            </div>
          )}

          {lead.next_step && (
            <p className="text-sm mt-3 text-foreground">
              <span className="font-medium">Next step:</span> {lead.next_step}
            </p>
          )}
        </div>
        {isConnected ? (
          <GmailSyncButton 
            leadId={lead.id} 
            leadEmail={lead.email} 
            onSyncComplete={loadLead} 
          />
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/settings">
              <Mail className="h-4 w-4 mr-2" />
              Connect Gmail
            </Link>
          </Button>
        )}
      </div>

      <Tabs defaultValue="timeline" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="drafts">Drafts</TabsTrigger>
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-6">
          <TimelineTab leadId={lead.id} />
        </TabsContent>

        <TabsContent value="drafts" className="mt-6">
          <DraftsTab lead={lead} onUpdate={handleUpdate} />
        </TabsContent>

        <TabsContent value="upload" className="mt-6">
          <UploadTab leadId={lead.id} onSuccess={handleUpdate} />
        </TabsContent>

        <TabsContent value="recommendations" className="mt-6">
          <RecommendationsTab key={refreshKey} lead={lead} onUpdate={handleUpdate} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
