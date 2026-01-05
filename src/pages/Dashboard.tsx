import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getLeadsList, LeadListItem } from "@/lib/supabaseQueries";
import { Users, TrendingUp, Clock, Plus } from "lucide-react";

export default function Dashboard() {
  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getLeadsList()
      .then(setLeads)
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, []);

  const recentLeads = leads.slice(0, 5);
  const activeLeads = leads.filter((l) => l.status !== "closed_won" && l.status !== "closed_lost");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground">Welcome to your B2B Deal Assistant</p>
        </div>
        <Button asChild>
          <Link to="/dashboard/leads">
            <Plus className="h-4 w-4 mr-2" />
            Add Lead
          </Link>
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Leads</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "..." : leads.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Deals</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "..." : activeLeads.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Needs Action</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "..." : leads.filter((l) => l.next_step).length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Leads */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Leads</CardTitle>
          <CardDescription>Your most recently active leads</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : recentLeads.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground mb-4">No leads yet</p>
              <Button asChild>
                <Link to="/dashboard/leads">Add Your First Lead</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {recentLeads.map((lead) => (
                <Link
                  key={lead.id}
                  to={`/dashboard/leads/${lead.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-accent transition-colors"
                >
                  <div>
                    <p className="font-medium text-foreground">{lead.name}</p>
                    <p className="text-sm text-muted-foreground">{lead.company}</p>
                  </div>
                  <div className="text-right">
                    <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-secondary text-secondary-foreground">
                      {lead.strategy}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
