import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bug } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Props = {
  conversationId: string;
  leadId: string | null;
};

type TranscriptSnippet = {
  id: string;
  call_session_id: string;
  full_text: string | null;
  language: string;
  status: string;
  created_at: string;
};

export function EvidenceDrawer({ conversationId, leadId }: Props) {
  const [open, setOpen] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptSnippet[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Only load when drawer opens
  useEffect(() => {
    if (!open || !leadId) return;
    setIsLoading(true);

    (async () => {
      try {
        const { data: sessions } = await supabase
          .from("call_sessions")
          .select("id")
          .eq("lead_id", leadId)
          .order("created_at", { ascending: false })
          .limit(10);

        if (!sessions?.length) {
          setTranscripts([]);
          return;
        }

        const sessionIds = sessions.map((s) => s.id);
        const { data: txData } = await supabase
          .from("call_transcripts")
          .select("id, call_session_id, full_text, language, status, created_at")
          .in("call_session_id", sessionIds)
          .order("created_at", { ascending: false })
          .limit(10);

        setTranscripts((txData ?? []) as TranscriptSnippet[]);
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [open, leadId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground gap-1 px-2">
          <Bug className="h-3 w-3" />
          Evidence (Debug)
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-sm">Evidence & Transcripts</SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-6rem)] mt-4">
          {!leadId ? (
            <p className="text-sm text-muted-foreground p-4">No lead linked — no evidence available.</p>
          ) : isLoading ? (
            <div className="space-y-3 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 bg-muted rounded w-1/2 mb-2" />
                  <div className="h-20 bg-muted rounded" />
                </div>
              ))}
            </div>
          ) : transcripts.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No call transcripts found for this lead.</p>
          ) : (
            <div className="space-y-4 p-4">
              {transcripts.map((t) => (
                <div key={t.id} className="border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-foreground">
                      Call Transcript
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(t.created_at).toLocaleDateString()} · {t.language} · {t.status}
                    </span>
                  </div>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-muted/30 rounded p-2 font-mono">
                    {t.full_text || "(No text available)"}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
