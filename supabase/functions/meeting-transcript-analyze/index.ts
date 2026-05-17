// ============================================================
// meeting-transcript-analyze — Phase 3
//
// Per-transcript AI analyzer. Given a ready meeting_transcripts
// row, calls ai_task("post_meeting_recap") with the transcript
// text and persists the structured output to meeting_ai_summaries
// plus enriches the existing timeline row created by the
// per-provider fetcher.
//
// Auth: privileged callers only (X-Internal-Secret or service-role
// bearer). Anonymous and user JWTs are rejected. Called by the
// Phase-2 poller's second sweep — never directly by a user.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requirePrivilegedCaller } from "../_shared/authz.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface TranscriptRow {
  id: string;
  workspace_id: string;
  lead_id: string | null;
  provider: string;
  status: string;
  transcript_text: string | null;
  transcript_format: string | null;
  provider_meeting_id: string | null;
  calendar_event_id: string;
  ready_at: string | null;
}

interface RecapMilestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
}

interface RecapRisk {
  issue: string;
  level: "low" | "medium" | "high";
}

interface RecapActionItem {
  description: string;
  owner: string;
  due_date: string | null;
}

interface RecapShape {
  internal_recap_bullets: string[];
  milestones_from_meeting?: RecapMilestone[];
  risks?: RecapRisk[];
  action_items?: RecapActionItem[];
  open_questions?: string[];
  customer_email: { subject: string; body: string };
}

// Mirrors MeetingsTab.tsx's extractJson — strip optional ```json ... ```
// fences then return the inner payload for JSON.parse.
function extractJson(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function looksLikeRecap(obj: unknown): obj is RecapShape {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.internal_recap_bullets)) return false;
  if (o.internal_recap_bullets.length === 0) return false;
  const email = o.customer_email as Record<string, unknown> | undefined;
  if (!email || typeof email !== "object") return false;
  if (typeof email.subject !== "string" || typeof email.body !== "string") return false;
  return true;
}

function buildReadableRecap(recap: RecapShape): string {
  return recap.internal_recap_bullets.map((b) => `- ${b}`).join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gateResp = requirePrivilegedCaller(req, corsHeaders);
  if (gateResp) return gateResp;

  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  let parsedBody: { meetingTranscriptId?: unknown } = {};
  try {
    parsedBody = await req.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON body" });
  }

  const meetingTranscriptId = parsedBody?.meetingTranscriptId;
  if (typeof meetingTranscriptId !== "string" || meetingTranscriptId.length === 0) {
    return jsonResponse(400, {
      ok: false,
      error: "meetingTranscriptId is required and must be a non-empty string",
    });
  }
  if (!UUID_RE.test(meetingTranscriptId)) {
    return jsonResponse(400, {
      ok: false,
      error: "meetingTranscriptId must be a valid UUID",
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let stage = "load_transcript";
  try {
    // 1. Load the transcript row.
    const { data: rawTranscript, error: trErr } = await supabase
      .from("meeting_transcripts")
      .select(
        "id, workspace_id, lead_id, provider, status, transcript_text, transcript_format, provider_meeting_id, calendar_event_id, ready_at",
      )
      .eq("id", meetingTranscriptId)
      .maybeSingle();
    if (trErr) {
      throw new Error(`meeting_transcripts lookup failed: ${trErr.message}`);
    }
    if (!rawTranscript) {
      return jsonResponse(404, { ok: false, error: "Meeting transcript not found" });
    }
    const transcript = rawTranscript as unknown as TranscriptRow;

    if (transcript.status !== "ready") {
      return jsonResponse(400, {
        ok: false,
        error: `Transcript status is '${transcript.status}', expected 'ready'`,
      });
    }
    if (!transcript.lead_id) {
      return jsonResponse(400, {
        ok: false,
        error: "Transcript not linked to a lead",
      });
    }
    if (!transcript.transcript_text || transcript.transcript_text.length === 0) {
      return jsonResponse(400, {
        ok: false,
        error: "Transcript text is empty",
      });
    }

    // 2. Idempotency — meeting_ai_summaries.meeting_transcript_id is UNIQUE.
    stage = "idempotency_check";
    const { data: existing, error: existErr } = await supabase
      .from("meeting_ai_summaries")
      .select("id")
      .eq("meeting_transcript_id", meetingTranscriptId)
      .maybeSingle();
    if (existErr) {
      throw new Error(`meeting_ai_summaries lookup failed: ${existErr.message}`);
    }
    if (existing) {
      return jsonResponse(200, {
        ok: true,
        status: "already_analyzed",
        meetingAiSummaryId: (existing as { id: string }).id,
      });
    }

    // 3. Invoke ai_task — mirror MeetingsTab.tsx's manual recap caller.
    stage = "ai_task_invoke";
    const aiInvocation = await supabase.functions.invoke("ai_task", {
      body: {
        task: "post_meeting_recap",
        payload: {
          mode: "fast",
          meeting_summary: transcript.transcript_text,
          lead_id: transcript.lead_id,
        },
      },
    });

    if (aiInvocation.error) {
      console.error(
        "[meeting-transcript-analyze] ai_task error",
        JSON.stringify({
          meetingTranscriptId,
          error: aiInvocation.error.message ?? String(aiInvocation.error),
        }),
      );
      return jsonResponse(502, { ok: false, error: "ai_task invocation failed" });
    }

    const aiData = aiInvocation.data as { ok?: boolean; content?: string; error?: string } | null;
    if (!aiData || !aiData.ok || typeof aiData.content !== "string") {
      console.error(
        "[meeting-transcript-analyze] ai_task returned unexpected shape",
        JSON.stringify({ meetingTranscriptId, aiData }),
      );
      return jsonResponse(502, { ok: false, error: "ai_task returned unexpected payload" });
    }

    // 4. Parse — fence-strip then JSON.parse, then sanity-check core fields.
    stage = "parse_recap";
    let recap: RecapShape;
    try {
      recap = JSON.parse(extractJson(aiData.content)) as RecapShape;
    } catch (parseErr) {
      console.error(
        "[meeting-transcript-analyze] recap JSON parse failed",
        JSON.stringify({
          meetingTranscriptId,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          contentSnippet: aiData.content.slice(0, 200),
        }),
      );
      return jsonResponse(502, { ok: false, error: "Recap output was not valid JSON" });
    }
    if (!looksLikeRecap(recap)) {
      console.error(
        "[meeting-transcript-analyze] recap missing core fields",
        JSON.stringify({ meetingTranscriptId, keys: Object.keys(recap ?? {}) }),
      );
      return jsonResponse(502, { ok: false, error: "Recap output missing required fields" });
    }

    const readableRecap = buildReadableRecap(recap);

    // 5. Insert the summary row. workspace_id MUST equal transcript.workspace_id
    //    (consistency triggers abort otherwise). lead_id likewise.
    stage = "insert_summary";
    const { data: insertedRaw, error: insertErr } = await supabase
      .from("meeting_ai_summaries")
      .insert({
        workspace_id: transcript.workspace_id,
        meeting_transcript_id: meetingTranscriptId,
        lead_id: transcript.lead_id,
        summary: readableRecap,
        milestones: recap.milestones_from_meeting ?? [],
        risks: recap.risks ?? [],
        action_items: recap.action_items ?? [],
        open_questions: recap.open_questions ?? [],
        followup_email_subject: recap.customer_email.subject,
        followup_email_body: recap.customer_email.body,
        ai_model_used: "ai_task:post_meeting_recap",
        generated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    let meetingAiSummaryId: string;
    if (insertErr) {
      // 23505 = unique_violation on meeting_transcript_id — concurrent run won.
      // Treat as success: re-query to get the existing row's id for the response.
      if ((insertErr as { code?: string }).code === "23505") {
        const { data: raceWinner } = await supabase
          .from("meeting_ai_summaries")
          .select("id")
          .eq("meeting_transcript_id", meetingTranscriptId)
          .maybeSingle();
        if (raceWinner) {
          return jsonResponse(200, {
            ok: true,
            status: "race_already_analyzed",
            meetingAiSummaryId: (raceWinner as { id: string }).id,
          });
        }
      }
      throw new Error(`meeting_ai_summaries insert failed: ${insertErr.message}`);
    }
    if (!insertedRaw) {
      throw new Error("meeting_ai_summaries insert returned no row");
    }
    meetingAiSummaryId = (insertedRaw as { id: string }).id;

    // 6. Enrich the fetcher's existing timeline row. dedupe_key matches the
    //    fetcher's projection, so the upsert UPDATES rather than inserts.
    //    Re-pass every field the fetcher set — the projector overwrites,
    //    it does not merge.
    stage = "project_timeline";
    const occurredAt = transcript.ready_at ?? new Date().toISOString();
    await projectTimelineItem(
      supabase,
      {
        workspace_id: transcript.workspace_id,
        lead_id: transcript.lead_id,
        channel: "meeting",
        provider: transcript.provider,
        event_type: "meeting_transcript_captured",
        occurred_at: occurredAt,
        source_table: "meeting_transcripts",
        source_id: meetingTranscriptId,
        subject: "Meeting transcript captured",
        snippet_text: readableRecap,
        metadata_json: {
          meeting_transcript_id: meetingTranscriptId,
          calendar_event_id: transcript.calendar_event_id,
          provider_meeting_id: transcript.provider_meeting_id,
          ai_summary: readableRecap,
          meeting_ai_summary_id: meetingAiSummaryId,
        },
        dedupe_key: `meeting_transcript:${meetingTranscriptId}`,
      },
      { triggerRecompute: true },
    );

    return jsonResponse(200, {
      ok: true,
      status: "analyzed",
      meetingAiSummaryId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[meeting-transcript-analyze] unexpected_error", {
      meetingTranscriptId,
      stage,
      error: message,
    });
    return jsonResponse(500, { ok: false, error: "Internal error" });
  }
});
