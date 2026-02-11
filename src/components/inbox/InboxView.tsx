import { useState, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ConversationList } from "./ConversationList";
import { ConversationThread } from "./ConversationThread";
import { IntelligencePanel } from "./IntelligencePanel";
import { ReplyComposer } from "./ReplyComposer";
import type { ConversationListItem, ConversationAnalysis, ReplySuggestion } from "@/lib/inboxQueries";

export function InboxView() {
  const [selectedConvo, setSelectedConvo] = useState<ConversationListItem | null>(null);
  const [analysis, setAnalysis] = useState<ConversationAnalysis | null>(null);
  const [replySuggestions, setReplySuggestions] = useState<ReplySuggestion[]>([]);
  const [recommendedChannel, setRecommendedChannel] = useState<"whatsapp" | "email">("whatsapp");

  const handleConvoSelect = useCallback((convo: ConversationListItem) => {
    setSelectedConvo(convo);
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

              {/* Center: Thread */}
              <div className={`flex-1 flex flex-col min-w-0 ${!selectedConvo ? "hidden md:flex" : "flex"}`}>
                {selectedConvo ? (
                  <>
                    <ConversationThread
                      conversation={selectedConvo}
                      onBack={() => setSelectedConvo(null)}
                      onAnalysisLoaded={handleAnalysisLoaded}
                    />
                    <ReplyComposer
                      conversation={selectedConvo}
                      recommendedChannel={recommendedChannel}
                      suggestions={replySuggestions}
                    />
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    Select a conversation
                  </div>
                )}
              </div>

              {/* Right: Intelligence Panel (desktop only) */}
              {selectedConvo && (
                <div className="hidden lg:block w-80 border-l border-border overflow-y-auto">
                  <IntelligencePanel
                    contactId={selectedConvo.contact_id}
                    analysis={analysis}
                  />
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
