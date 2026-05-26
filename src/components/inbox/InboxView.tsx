import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConversationList } from "./ConversationList";
import { MailReconnectChip } from "@/components/mail/MailReconnectChip";
import { MailLastSyncedChip } from "@/components/mail/MailLastSyncedChip";
import { useVisibilityRefresh } from "@/hooks/useVisibilityRefresh";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ConversationThread } from "./ConversationThread";
import { ReplyComposer } from "./ReplyComposer";
import { LeadContextPanel, fetchLeadSnapshot, type LeadSnapshot } from "./LeadContextPanel";
import { UnifiedInsightsPanel } from "./UnifiedInsightsPanel";
import { EvidenceDrawer } from "./EvidenceDrawer";
import type { ConversationListItem, ConversationAnalysis, ReplySuggestion } from "@/lib/inboxQueries";
import { fetchAllContactAnalysis } from "@/lib/inboxQueries";
import { getLeadIntelligence } from "@/lib/supabaseQueries";
import type { LeadIntelligence } from "@/lib/supabaseQueries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ArrowRight, Lightbulb, BarChart3, User, Search, SlidersHorizontal,
  ArrowUpDown, Bookmark, X, Flame, Clock, AlertTriangle, Inbox, MessageSquare,
  Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { flags } from "@/lib/featureFlags";
import {
  getInboxState,
  setInboxSearch,
  setInboxQuickChip,
  setInboxSort,
  setInboxChannelFilter,
  setInboxRevenueState,
  setInboxWaitingOn,
  clearInboxFilters,
  applyInboxSnapshot,
  hasActiveFilters,
  type QuickChip,
  type InboxSort,
  type InboxState,
} from "@/lib/inboxStateCache";
import type { CanonicalChannel } from "@/lib/channels";

type RightTab = "next" | "insights" | "lead";

// ── Quick chip config ──────────────────────────────────────────────────

const QUICK_CHIPS: { key: QuickChip; label: string; icon: React.ReactNode }[] = [
  { key: "needs_action", label: "Needs action", icon: <AlertTriangle className="h-3 w-3" /> },
  { key: "new_inbound", label: "New inbound", icon: <Inbox className="h-3 w-3" /> },
  { key: "overdue", label: "Overdue", icon: <Clock className="h-3 w-3" /> },
];

const SORT_OPTIONS: { key: InboxSort; label: string }[] = [
  { key: "recent", label: "Most Recent" },
  { key: "urgent", label: "Most Urgent" },
  { key: "stale", label: "Oldest First" },
  { key: "new_inbound", label: "New Inbound" },
];

// Only show channels that are actually implemented
const CHANNEL_OPTIONS: { key: CanonicalChannel; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "voice", label: "Voice" },
];

// ── Main component ─────────────────────────────────────────────────────

export function InboxView() {
  const [selectedConvo, setSelectedConvo] = useState<ConversationListItem | null>(null);
  const [analysis, setAnalysis] = useState<ConversationAnalysis | null>(null);
  const [allAnalysis, setAllAnalysis] = useState<ConversationAnalysis[]>([]);
  const [replySuggestions, setReplySuggestions] = useState<ReplySuggestion[]>([]);
  const [recommendedChannel, setRecommendedChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [leadSnapshot, setLeadSnapshot] = useState<LeadSnapshot | null>(null);
  const [leadIntelligence, setLeadIntelligence] = useState<LeadIntelligence | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("next");
  const [threadReloadKey, setThreadReloadKey] = useState(0);
  const [convoListReloadKey, setConvoListReloadKey] = useState(0);
  const [isRefreshingList, setIsRefreshingList] = useState(false);

  const handleListRefresh = useCallback(() => {
    setIsRefreshingList(true);
    setConvoListReloadKey(k => k + 1);
    // ConversationList's loader will flip isLoading false on completion,
    // but we don't have direct visibility — release the spinner shortly.
    setTimeout(() => setIsRefreshingList(false), 600);
  }, []);

  useVisibilityRefresh(handleListRefresh);

  // Live-refresh the conversation list when ANY new timeline item lands
  // in the workspace. This catches inbound emails, sent outbound, and
  // system_note rows without needing the user to reload.
  const { workspaceId } = useWorkspace();
  useRealtimeSubscription(
    {
      table: "lead_timeline_items",
      filter: workspaceId ? `workspace_id=eq.${workspaceId}` : undefined,
      enabled: !!workspaceId,
      event: "INSERT",
    },
    () => {
      setConvoListReloadKey(k => k + 1);
    }
  );

  // Filter state — re-render on change
  const [inboxState, setInboxState] = useState<InboxState>(getInboxState);
  const [searchInput, setSearchInput] = useState(inboxState.searchQuery);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const updateState = useCallback((updater: () => void) => {
    updater();
    setInboxState({ ...getInboxState() });
  }, []);

  // Debounced search
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      updateState(() => setInboxSearch(value));
    }, 300);
  }, [updateState]);

  const handleSent = useCallback(() => {
    setThreadReloadKey((k) => k + 1);
  }, []);

  const handleConvoSelect = useCallback((convo: ConversationListItem) => {
    setSelectedConvo(convo);
    setLeadSnapshot(null);
    setLeadIntelligence(null);
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

  // Fetch lead snapshot + canonical intelligence when conversation changes
  useEffect(() => {
    if (!selectedConvo?.lead_id) {
      setLeadSnapshot(null);
      setLeadIntelligence(null);
      return;
    }
    const leadId = selectedConvo.lead_id;
    fetchLeadSnapshot(leadId).then(setLeadSnapshot).catch(console.error);
    getLeadIntelligence(leadId).then(setLeadIntelligence).catch(console.error);
  }, [selectedConvo?.lead_id]);

  // Fetch all contact analysis for insights
  useEffect(() => {
    if (!selectedConvo?.contact_id) return;
    fetchAllContactAnalysis(selectedConvo.contact_id).then(setAllAnalysis).catch(console.error);
  }, [selectedConvo?.contact_id]);

  const filtersActive = hasActiveFilters(inboxState);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] md:h-[calc(100vh-6rem)]">
      <div className="shrink-0 flex items-center justify-between gap-3 mb-2 flex-wrap">
        <MailReconnectChip />
        <MailLastSyncedChip
          prefix="Inbox · "
          onRefresh={handleListRefresh}
          isRefreshing={isRefreshingList}
          className="ml-auto"
        />
      </div>
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
              <div className={`w-full md:w-80 lg:w-72 shrink-0 border-r border-border flex flex-col ${selectedConvo ? "hidden md:flex" : ""}`}>
                {/* Search + Saved views */}
                <div className="p-2 space-y-1.5 border-b border-border shrink-0">
                  <div className="flex gap-1.5">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={searchInput}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        placeholder="Search…"
                        className="h-8 pl-7 text-xs"
                      />
                      {searchInput && (
                        <button
                          className="absolute right-2 top-1/2 -translate-y-1/2"
                          onClick={() => { setSearchInput(""); updateState(() => setInboxSearch("")); }}
                        >
                          <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </button>
                      )}
                    </div>

                    {/* Saved views */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="Saved views">
                          <Bookmark className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[140px]">
                        {inboxState.savedViews.map((sv) => (
                          <DropdownMenuItem
                            key={sv.id}
                            className="text-xs"
                            onClick={() => {
                              updateState(() => applyInboxSnapshot(sv.stateSnapshot));
                              setSearchInput(sv.stateSnapshot.searchQuery);
                            }}
                          >
                            {sv.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Sort */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="Sort">
                          <ArrowUpDown className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[140px]">
                        {SORT_OPTIONS.map((opt) => (
                          <DropdownMenuItem
                            key={opt.key}
                            className={cn("text-xs", inboxState.sortBy === opt.key && "font-semibold")}
                            onClick={() => updateState(() => setInboxSort(opt.key))}
                          >
                            {opt.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    {/* Filter drawer */}
                    <FilterDrawer
                      inboxState={inboxState}
                      onChange={updateState}
                    />
                  </div>

                  {/* Quick chips — only show chips backed by reliable data */}
                  <div className="flex gap-1 overflow-x-auto pb-0.5">
                    {QUICK_CHIPS.map((chip) => (
                      <button
                        key={chip.key}
                        onClick={() => updateState(() => setInboxQuickChip(inboxState.quickChip === chip.key ? null : chip.key))}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-colors shrink-0 border",
                          inboxState.quickChip === chip.key
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        )}
                      >
                        {chip.icon}
                        {chip.label}
                      </button>
                    ))}
                    {filtersActive && (
                      <button
                        onClick={() => { updateState(() => clearInboxFilters()); setSearchInput(""); }}
                        className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                      >
                        <X className="h-3 w-3" />
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* List */}
                <div className="flex-1 overflow-y-auto">
                  <ConversationList
                    filter={tab}
                    selectedId={selectedConvo?.id ?? null}
                    onSelect={handleConvoSelect}
                    inboxState={inboxState}
                    reloadKey={convoListReloadKey}
                  />
                </div>
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
                    {flags.evidence_debug && (
                      <div className="ml-auto">
                        <EvidenceDrawer
                          conversationId={selectedConvo.id}
                          leadId={selectedConvo.lead_id}
                        />
                      </div>
                    )}
                  </div>

                  {/* Tab content */}
                  <div className="flex-1 overflow-y-auto">
                    {rightTab === "next" && (
                      <NextStepPanel lead={leadSnapshot} intelligence={leadIntelligence} analysis={analysis} />
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

// ── Filter Drawer ──────────────────────────────────────────────────────

function FilterDrawer({
  inboxState,
  onChange,
}: {
  inboxState: InboxState;
  onChange: (updater: () => void) => void;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 relative" title="Filters">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {(inboxState.channelFilter.length > 0 || inboxState.revenueState || inboxState.waitingOn) && (
            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72">
        <SheetHeader>
          <SheetTitle className="text-sm">Filters</SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Channels — only implemented ones */}
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">Channels</span>
            <div className="space-y-2">
              {CHANNEL_OPTIONS.map((ch) => (
                <label key={ch.key} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={inboxState.channelFilter.includes(ch.key)}
                    onCheckedChange={(checked) => {
                      onChange(() => {
                        const current = inboxState.channelFilter;
                        if (checked) {
                          setInboxChannelFilter([...current, ch.key]);
                        } else {
                          setInboxChannelFilter(current.filter((c) => c !== ch.key));
                        }
                      });
                    }}
                  />
                  <span className="text-sm">{ch.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Revenue State */}
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">Revenue State</span>
            <div className="flex flex-wrap gap-1.5">
              {["action_required", "heating_up", "long_cycle", "automation"].map((rs) => (
                <button
                  key={rs}
                  onClick={() => onChange(() => setInboxRevenueState(inboxState.revenueState === rs ? null : rs))}
                  className={cn(
                    "text-[11px] px-2 py-1 rounded-full border transition-colors capitalize",
                    inboxState.revenueState === rs
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {rs.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>

          {/* Waiting On */}
          <div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-2">Waiting On</span>
            <div className="flex flex-wrap gap-1.5">
              {(["me", "lead", "automation"] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => onChange(() => setInboxWaitingOn(inboxState.waitingOn === w ? null : w))}
                  className={cn(
                    "text-[11px] px-2 py-1 rounded-full border transition-colors capitalize",
                    inboxState.waitingOn === w
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
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

// ── Next Step panel — reads from canonical lead_intelligence ───────────

function NextStepPanel({
  lead,
  intelligence,
  analysis,
}: {
  lead: LeadSnapshot | null;
  intelligence: LeadIntelligence | null;
  analysis: ConversationAnalysis | null;
}) {
  // Canonical intelligence takes priority over legacy lead fields
  const hasCanonical = intelligence !== null;
  const nextAction = hasCanonical
    ? intelligence.recommended_next_step
    : (lead?.next_action_label || lead?.next_step || null);
  const reason = hasCanonical
    ? intelligence.next_step_reason
    : lead?.next_step_reason;
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
      {/* Source indicator */}
      {hasCanonical && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Brain className="h-2.5 w-2.5" />
          <span>From lead intelligence</span>
        </div>
      )}

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

      {/* Quick signals from conversation */}
      {(sentiment || urgency) && (
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
      )}

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
