import { useState, useCallback, useEffect, useRef } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConversationList } from "./ConversationList";
import { ConversationThread } from "./ConversationThread";
import { ReplyComposer } from "./ReplyComposer";
import { LeadContextPanel, fetchLeadSnapshot, type LeadSnapshot } from "./LeadContextPanel";
import { UnifiedInsightsPanel } from "./UnifiedInsightsPanel";
import { EvidenceDrawer } from "./EvidenceDrawer";
import type { ConversationListItem, ConversationAnalysis, ReplySuggestion } from "@/lib/inboxQueries";
import { fetchAllContactAnalysis } from "@/lib/inboxQueries";
import { Button } from "@/components/ui/button";
import { ArrowRight, Lightbulb, BarChart3, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { flags } from "@/lib/featureFlags";

type RightTab = "next" | "insights" | "lead";

export function InboxView() {
  const [selectedConvo, setSelectedConvo] = useState<ConversationListItem | null>(null);
  const [analysis, setAnalysis] = useState<ConversationAnalysis | null>(null);
  const [allAnalysis, setAllAnalysis] = useState<ConversationAnalysis[]>([]);
  const [replySuggestions, setReplySuggestions] = useState<ReplySuggestion[]>([]);
  const [recommendedChannel, setRecommendedChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [leadSnapshot, setLeadSnapshot] = useState<LeadSnapshot | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("next");
  const [threadReloadKey, setThreadReloadKey] = useState(0);

  const handleSent = useCallback(() => {
    setThreadReloadKey((k) => k + 1);
  }, []);

  const handleConvoSelect = useCallback((convo: ConversationListItem) => {
    setSelectedConvo(convo);
    setLeadSnapshot(null);
    setAllAnalysis([]);
    setRightTab("next");
  }, []);

  const handleAnalysisLoaded = useCallback((a: ConversationAnalysis | null) => {
    setAnalysis(a);
    if (a?.recommended_reply_channel) {
      setRecommendedChannel(a.recommended_reply_channel as "whatsapp" | "email");
    }
    const features = a?.extracted_features as any;
    if (features?.reply_suggestions) {
      setReplySuggestions(features.reply_suggestions);
    } else {
      setReplySuggestions([]);
    }
  }, []);

  // Fetch lead snapshot when conversation changes
  useEffect(() => {
    if (!selectedConvo?.lead_id) {
      setLeadSnapshot(null);
      return;
    }
    fetchLeadSnapshot(selectedConvo.lead_id).then(setLeadSnapshot).catch(console.error);
  }, [selectedConvo?.lead_id]);

  // Fetch all contact analysis for insights
  useEffect(() => {
    if (!selectedConvo?.contact_id) return;
    fetchAllContactAnalysis(selectedConvo.contact_id).then(setAllAnalysis).catch(console.error);
  }, [selectedConvo?.contact_id]);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] md:h-[calc(100vh-6rem)]">
      <Tabs defaultValue="active" className="flex flex-col h-full">
        <TabsList className="w-fit shrink-0">
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="new">New</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>

        {(["active", "new", "archived"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="flex-1 mt-3 overflow-hidden">
            <div className="flex h-full gap-0 border border-border rounded-lg overflow-hidden bg-card">
              {/* Left: Conversation List */}
              <div className={`w-full md:w-80 lg:w-72 shrink-0 border-r border-border overflow-y-auto ${selectedConvo ? "hidden md:block" : ""}`}>
                <ConversationList
                  filter={tab}
                  selectedId={selectedConvo?.id ?? null}
                  onSelect={handleConvoSelect}
                />
              </div>

              {/* Center: Thread + Composer */}
              <div className={`flex-1 flex flex-col min-w-0 ${!selectedConvo ? "hidden md:flex" : "flex"}`}>
                {selectedConvo ? (
                  <>
                    <ConversationThread
                      conversation={selectedConvo}
                      onBack={() => setSelectedConvo(null)}
                      onAnalysisLoaded={handleAnalysisLoaded}
                      reloadKey={threadReloadKey}
                    />
                    <ReplyComposer
                      conversation={selectedConvo}
                      recommendedChannel={recommendedChannel}
                      suggestions={replySuggestions}
                      leadId={selectedConvo.lead_id}
                      onSent={handleSent}
                    />
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    Select a conversation
                  </div>
                )}
              </div>

              {/* Right: Tabbed panel (desktop only, v2 only) */}
              {flags.ui_v2 && selectedConvo && (
                <div className="hidden lg:flex lg:flex-col w-80 border-l border-border">
                  {/* Tab bar */}
                  <div className="shrink-0 flex items-center border-b border-border px-2">
                    <RightTabButton
                      active={rightTab === "next"}
                      onClick={() => setRightTab("next")}
                      icon={<ArrowRight className="h-3 w-3" />}
                      label="Next"
                    />
                    <RightTabButton
                      active={rightTab === "insights"}
                      onClick={() => setRightTab("insights")}
                      icon={<BarChart3 className="h-3 w-3" />}
                      label="Insights"
                    />
                    <RightTabButton
                      active={rightTab === "lead"}
                      onClick={() => setRightTab("lead")}
                      icon={<User className="h-3 w-3" />}
                      label="Lead"
                    />
                    <div className="ml-auto">
                      <EvidenceDrawer
                        conversationId={selectedConvo.id}
                        leadId={selectedConvo.lead_id}
                      />
                    </div>
                  </div>

                  {/* Tab content */}
                  <div className="flex-1 overflow-y-auto">
                    {rightTab === "next" && (
                      <NextStepPanel lead={leadSnapshot} analysis={analysis} />
                    )}
                    {rightTab === "insights" && (
                      <UnifiedInsightsPanel
                        analysis={analysis}
                        lead={leadSnapshot}
                        allAnalysis={allAnalysis}
                      />
                    )}
                    {rightTab === "lead" && (
                      <LeadContextPanel leadId={selectedConvo.lead_id} />
                    )}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ── Right tab button ───────────────────────────────────────────────────

function RightTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-3 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ── Next Step panel ────────────────────────────────────────────────────

function NextStepPanel({
  lead,
  analysis,
}: {
  lead: LeadSnapshot | null;
  analysis: ConversationAnalysis | null;
}) {
  const nextAction = lead?.next_action_label || lead?.next_step || null;
  const reason = lead?.next_step_reason || null;
  const sentiment = analysis?.sentiment;
  const urgency = analysis?.urgency;

  if (!lead && !analysis) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground py-8">
        <Lightbulb className="h-5 w-5 mx-auto mb-2 opacity-50" />
        <p>Waiting for context…</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Best next step */}
      <div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">
          Best Next Step
        </span>
        <p className="text-sm font-medium text-foreground">
          {nextAction ?? "Review conversation"}
        </p>
        {reason && (
          <p className="text-xs text-muted-foreground mt-1">{reason}</p>
        )}
      </div>

      {/* Quick signals */}
      <div className="grid grid-cols-2 gap-3">
        {sentiment && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5">Sentiment</span>
            <span className="text-xs font-medium text-foreground capitalize">{sentiment}</span>
          </div>
        )}
        {urgency && (
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-0.5">Urgency</span>
            <span className="text-xs font-medium text-foreground capitalize">{urgency}</span>
          </div>
        )}
      </div>

      {/* CTA */}
      {lead && (
        <Button size="sm" className="w-full text-xs" asChild>
          <a href={`/app/lead/${lead.id}`}>
            Open Lead <ArrowRight className="h-3 w-3 ml-1" />
          </a>
        </Button>
      )}
    </div>
  );
}
