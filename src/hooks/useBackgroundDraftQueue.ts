import { useState, useCallback, useRef } from "react";
import { streamDraft, type DraftPipelineResult } from "@/lib/generateDraft";
import { toast } from "sonner";

export interface QueuedDraft {
  leadId: string;
  status: "generating" | "ready" | "error";
  result?: DraftPipelineResult;
  subject?: string;
  error?: string;
}

const MAX_CONCURRENT = 20;

/**
 * Background draft generation queue.
 * Users can trigger up to 20 drafts in parallel.
 * Each draft independently generates in the background.
 */
export function useBackgroundDraftQueue() {
  const [queue, setQueue] = useState<Map<string, QueuedDraft>>(new Map());
  const activeCount = useRef(0);

  const getStatus = useCallback(
    (leadId: string): QueuedDraft | undefined => queue.get(leadId),
    [queue]
  );

  const enqueue = useCallback(async (leadId: string) => {
    // Already queued
    if (queue.get(leadId)?.status === "generating") return;

    // Check limit
    if (activeCount.current >= MAX_CONCURRENT) {
      toast.error(`Maximum ${MAX_CONCURRENT} background drafts at once`);
      return;
    }

    // Set generating state
    setQueue((prev) => {
      const next = new Map(prev);
      next.set(leadId, { leadId, status: "generating" });
      return next;
    });
    activeCount.current++;

    let draftSubject = "";

    try {
      const result = await streamDraft({
        lead_id: leadId,
        channel: "email",
        onToken: () => {}, // discard streaming tokens — we use the final result
        onSubject: (s) => { draftSubject = s; },
        onPipelineReady: () => {},
      });

      setQueue((prev) => {
        const next = new Map(prev);
        next.set(leadId, {
          leadId,
          status: "ready",
          result,
          subject: result.suggested_subject || draftSubject,
        });
        return next;
      });
    } catch (err) {
      console.error("[BackgroundDraftQueue] Failed for", leadId, err);
      setQueue((prev) => {
        const next = new Map(prev);
        next.set(leadId, {
          leadId,
          status: "error",
          error: err instanceof Error ? err.message : "Generation failed",
        });
        return next;
      });
    } finally {
      activeCount.current--;
    }
  }, [queue]);

  const consume = useCallback(
    (leadId: string): QueuedDraft | undefined => {
      const entry = queue.get(leadId);
      if (entry?.status === "ready") {
        // Remove from queue after consuming
        setQueue((prev) => {
          const next = new Map(prev);
          next.delete(leadId);
          return next;
        });
      }
      return entry;
    },
    [queue]
  );

  const clear = useCallback((leadId: string) => {
    setQueue((prev) => {
      const next = new Map(prev);
      next.delete(leadId);
      return next;
    });
  }, []);

  return { enqueue, getStatus, consume, clear, queue };
}
