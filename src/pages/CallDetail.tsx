import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchCallBySessionId } from "@/lib/callQueries";
import { supabase } from "@/integrations/supabase/client";
import type {
  FullCallSession, CallAnalysisOutput, TranscriptSegment,
  ActionItem, RecommendedNextStep, CallObjection, CallRisk, CallCommitment, EvidencePointer,
} from "@/lib/callTypes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Play, Pause, ArrowLeft,
  Search, RefreshCw, AlertTriangle, CheckCircle2, Clock, XCircle,
  ChevronDown, ChevronRight, User, Headphones,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

function formatDuration(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function tsToSeconds(ts: string): number {
  const [m, s] = ts.split(":").map(Number);
  return (m || 0) * 60 + (s || 0);
}

/** Mask phone numbers: show only last 4 digits */
function maskPhone(phone: string): string {
  if (!phone || phone.length < 5) return phone;
  return "•••" + phone.slice(-4);
}

/** Truncate & mask JSON payload for safe display */
function sanitizePayload(payload: unknown): string {
  const raw = JSON.stringify(payload, null, 2);
  // Mask phone numbers in payload (E.164 pattern)
  const masked = raw.replace(/"\+?\d{7,15}"/g, (m) => {
    const digits = m.replace(/["+]/g, "");
    return `"•••${digits.slice(-4)}"`;
  });
  const MAX_DISPLAY = 2048;
  if (masked.length > MAX_DISPLAY) return masked.slice(0, MAX_DISPLAY) + "\n... (truncated)";
  return masked;
}

/* ── Evidence Chip ── */
function EvidenceChip({ ev, onJump }: { ev: EvidencePointer; onJump: (seconds: number) => void }) {
  return (
    <button
      onClick={() => onJump(tsToSeconds(ev.timestamp))}
      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
      title={ev.quote}
    >
      <Clock className="h-2.5 w-2.5" />
      {ev.timestamp} · {ev.speaker}
    </button>
  );
}

/* ── Pipeline Status Indicator ── */
function PipelineStatus({ label, status }: { label: string; status: string }) {
  const icon = status === "completed" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
    : status === "failed" ? <XCircle className="h-3.5 w-3.5 text-destructive" />
    : status === "processing" || status === "queued" ? <RefreshCw className="h-3.5 w-3.5 text-warning animate-spin" />
    : <Clock className="h-3.5 w-3.5 text-muted-foreground" />;

  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium capitalize">{status}</span>
    </div>
  );
}

export default function CallDetail() {
  const { callSessionId } = useParams<{ callSessionId: string }>();
  const [data, setData] = useState<FullCallSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [webhookLog, setWebhookLog] = useState<unknown[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!callSessionId) return;
    try {
      const result = await fetchCallBySessionId(callSessionId);
      setData(result);
      return result;
    } catch {
      toast.error("Failed to load call");
    } finally {
      setIsLoading(false);
    }
    return null;
  }, [callSessionId]);

  useEffect(() => { load(); }, [load]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Load audio signed URL using storage_path (no URL parsing)
  useEffect(() => {
    if (!data?.recordings?.length) return;
    const rec = data.recordings.find(r => r.storage_path || r.storage_url);
    if (!rec) return;

    const path = rec.storage_path || rec.storage_url?.replace(/^.*call-recordings\//, "") || "";
    if (!path) return;

    supabase.storage
      .from("call-recordings")
      .createSignedUrl(path, 3600)
      .then(({ data: signed }) => {
        if (signed?.signedUrl) setAudioUrl(signed.signedUrl);
      });
  }, [data?.recordings]);

  // Load webhook log when diagnostics tab active
  useEffect(() => {
    if (activeTab !== "diagnostics" || !data?.session?.call_sid) return;
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    supabase.auth.getSession().then(async ({ data: { session: authSession } }) => {
      if (!authSession) return;
      const qs = new URLSearchParams({ recent: "webhooks" });
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/call-api?${qs}`, {
        headers: { Authorization: `Bearer ${authSession.access_token}` },
      });
      if (resp.ok) {
        const result = await resp.json();
        const filtered = (result.webhooks || []).filter(
          (w: Record<string, unknown>) => w.call_sid === data.session.call_sid
        );
        setWebhookLog(filtered.slice(0, 20));
      }
    });
  }, [activeTab, data?.session?.call_sid]);

  const jumpAudio = (seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  /** Start polling after retry — stop when status changes or 20s timeout */
  const startPolling = (action: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const startTime = Date.now();
    const prevTranscriptStatus = data?.transcripts?.[0]?.status;
    const prevAnalysisStatus = data?.analyses?.[0]?.status;
    const prevRecordingStatus = data?.recordings?.[0]?.status;

    pollRef.current = setInterval(async () => {
      if (Date.now() - startTime > 20_000) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        return;
      }
      const fresh = await load();
      if (!fresh) return;

      const changed =
        (action === "ingest" && fresh.recordings?.[0]?.status !== prevRecordingStatus) ||
        (action === "transcribe" && fresh.transcripts?.[0]?.status !== prevTranscriptStatus) ||
        (action === "analyze" && fresh.analyses?.[0]?.status !== prevAnalysisStatus);

      if (changed) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);
  };

  const handleRetry = async (action: "ingest" | "transcribe" | "analyze") => {
    if (!data) return;
    setIsRetrying(action);
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    try {
      const { data: { session: authSession } } = await supabase.auth.getSession();
      if (!authSession) throw new Error("Not authenticated");

      let fnName = "";
      let body: Record<string, string> = {};
      if (action === "ingest") {
        fnName = "call-ingest-recording";
        const rec = data.recordings?.[0];
        body = { callSessionId: data.session.id, recordingId: rec?.id || "" };
      } else if (action === "transcribe") {
        fnName = "call-transcribe";
        body = { callSessionId: data.session.id };
      } else {
        fnName = "call-analyze";
        body = { callSessionId: data.session.id };
      }

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authSession.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        toast.success(`Retry ${action} triggered`);
        startPolling(action);
      } else {
        const err = await resp.text();
        toast.error(`Retry failed: ${err}`);
      }
    } catch {
      toast.error("Retry failed");
    } finally {
      setIsRetrying(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Call not found</p>
        <Button asChild className="mt-4"><Link to="/app/dashboard">Back</Link></Button>
      </div>
    );
  }

  const { session } = data;
  const analysis = data.analyses?.[0];
  const transcript = data.transcripts?.[0];
  const recording = data.recordings?.[0];
  const signals = analysis?.signals_json as CallAnalysisOutput | undefined;
  const segments = (transcript?.segments_json || []) as TranscriptSegment[];

  const filteredSegments = segments.filter(seg => {
    if (speakerFilter && seg.speaker !== speakerFilter) return false;
    if (searchQuery && !seg.text.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const DirectionIcon = session.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/app/dashboard"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <DirectionIcon className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            {session.direction === "inbound" ? "Inbound" : "Outbound"} Call
            <Badge variant="outline" className="text-xs capitalize">{session.status}</Badge>
          </h1>
          <p className="text-sm text-muted-foreground">
            {maskPhone(session.from_number)} → {maskPhone(session.to_number)}
            {session.duration_sec != null && ` · ${formatDuration(session.duration_sec)}`}
            {session.started_at && ` · ${format(new Date(session.started_at), "MMM d, yyyy h:mm a")}`}
          </p>
        </div>
        {session.lead_id && (
          <Button variant="outline" size="sm" asChild className="ml-auto">
            <Link to={`/app/leads/${session.lead_id}`}>View Lead</Link>
          </Button>
        )}
      </div>

      {/* Audio Player */}
      {audioUrl && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Button variant="outline" size="icon" onClick={togglePlay}>
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
              <audio
                ref={audioRef}
                src={audioUrl}
                onEnded={() => setIsPlaying(false)}
                className="flex-1"
                controls
                style={{ height: 36 }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
          <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="mt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">Call Info</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Direction</span><span className="capitalize">{session.direction}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span className="capitalize">{session.status}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Duration</span><span>{formatDuration(session.duration_sec)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">From</span><span>{maskPhone(session.from_number)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">To</span><span>{maskPhone(session.to_number)}</span></div>
                {session.started_at && <div className="flex justify-between"><span className="text-muted-foreground">Started</span><span>{format(new Date(session.started_at), "PPpp")}</span></div>}
                {session.ended_at && <div className="flex justify-between"><span className="text-muted-foreground">Ended</span><span>{format(new Date(session.ended_at), "PPpp")}</span></div>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">Pipeline Status</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <PipelineStatus label="Recording" status={recording?.status || "none"} />
                <PipelineStatus label="Transcript" status={transcript?.status || "none"} />
                <PipelineStatus label="Analysis" status={analysis?.status || "none"} />
              </CardContent>
            </Card>
          </div>

          {signals?.summaryShort && (
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">Summary</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm font-medium">{signals.summaryShort}</p>
                {signals.summaryLong && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{signals.summaryLong}</p>}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Transcript Tab */}
        <TabsContent value="transcript" className="mt-6 space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search transcript..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Button
              variant={speakerFilter === "Agent" ? "default" : "outline"}
              size="sm"
              onClick={() => setSpeakerFilter(speakerFilter === "Agent" ? null : "Agent")}
            >
              <Headphones className="h-3.5 w-3.5 mr-1" /> Agent
            </Button>
            <Button
              variant={speakerFilter === "Customer" ? "default" : "outline"}
              size="sm"
              onClick={() => setSpeakerFilter(speakerFilter === "Customer" ? null : "Customer")}
            >
              <User className="h-3.5 w-3.5 mr-1" /> Customer
            </Button>
          </div>

          {filteredSegments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {segments.length === 0 ? "No transcript available" : "No matching segments"}
            </p>
          ) : (
            <ScrollArea className="h-[500px]">
              <div className="space-y-1">
                {filteredSegments.map((seg, i) => {
                  const timeStr = `${Math.floor(seg.startMs / 60000).toString().padStart(2, "0")}:${Math.floor((seg.startMs % 60000) / 1000).toString().padStart(2, "0")}`;
                  const isAgent = seg.speaker === "Agent";
                  return (
                    <button
                      key={i}
                      onClick={() => jumpAudio(seg.startMs / 1000)}
                      className="w-full text-left py-2 px-3 rounded-md hover:bg-accent/30 transition-colors group"
                    >
                      <div className="flex items-start gap-2">
                        <span className="text-[11px] text-muted-foreground font-mono w-10 flex-shrink-0 pt-0.5">
                          {timeStr}
                        </span>
                        <Badge variant="outline" className={cn("text-[10px] flex-shrink-0", isAgent ? "text-primary border-primary/30" : "text-emerald-500 border-emerald-500/30")}>
                          {seg.speaker}
                        </Badge>
                        <p className="text-sm text-foreground leading-relaxed">{seg.text}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        {/* Analysis Tab */}
        <TabsContent value="analysis" className="mt-6 space-y-4">
          {!signals ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No analysis available</p>
          ) : (
            <>
              {/* Outcome + Intent + Sentiment */}
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Outcome</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold capitalize">{signals.outcome?.label || "—"}</p>
                    <p className="text-xs text-muted-foreground">Confidence: {((signals.outcome?.confidence || 0) * 100).toFixed(0)}%</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Intent</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold capitalize">{signals.intent?.type || "—"}</p>
                    <p className="text-xs text-muted-foreground">Confidence: {((signals.intent?.confidence || 0) * 100).toFixed(0)}%</p>
                    {signals.intent?.evidence?.map((ev, i) => (
                      <EvidenceChip key={i} ev={ev} onJump={jumpAudio} />
                    ))}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Sentiment</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold capitalize">{signals.sentiment?.overall || "—"}</p>
                    <p className="text-xs text-muted-foreground">Confidence: {((signals.sentiment?.confidence || 0) * 100).toFixed(0)}%</p>
                  </CardContent>
                </Card>
              </div>

              {/* Action Items */}
              {signals.actionItems?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Action Items</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {signals.actionItems.map((item: ActionItem, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{item.priority}</Badge>
                          <span className="text-sm">{item.text}</span>
                          <span className="text-xs text-muted-foreground">({item.owner})</span>
                        </div>
                        <div className="flex gap-1 flex-wrap">
                          {item.evidence?.map((ev, j) => <EvidenceChip key={j} ev={ev} onJump={jumpAudio} />)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Recommended Next Steps */}
              {signals.recommendedNextSteps?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Recommended Next Steps</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {signals.recommendedNextSteps.map((step: RecommendedNextStep, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-primary">#{step.rank}</span>
                          <span className="text-sm font-medium">{step.text}</span>
                          <span className="text-xs text-muted-foreground">{((step.confidence || 0) * 100).toFixed(0)}%</span>
                        </div>
                        <p className="text-xs text-muted-foreground pl-5">{step.rationale}</p>
                        <div className="flex gap-1 flex-wrap pl-5">
                          {step.evidence?.map((ev, j) => <EvidenceChip key={j} ev={ev} onJump={jumpAudio} />)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Objections */}
              {signals.objections?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Objections</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {signals.objections.map((obj: CallObjection, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn("text-[10px]", obj.severity === "high" ? "border-destructive/30 text-destructive" : "")}>{obj.severity}</Badge>
                          <span className="text-sm capitalize">{obj.type}</span>
                        </div>
                        <div className="flex gap-1 flex-wrap">
                          {obj.evidence?.map((ev, j) => <EvidenceChip key={j} ev={ev} onJump={jumpAudio} />)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Risks */}
              {signals.risks?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Risks</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {signals.risks.map((risk: CallRisk, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                          <Badge variant="outline" className="text-[10px]">{risk.severity}</Badge>
                          <span className="text-sm capitalize">{risk.type}</span>
                        </div>
                        <div className="flex gap-1 flex-wrap">
                          {risk.evidence?.map((ev, j) => <EvidenceChip key={j} ev={ev} onJump={jumpAudio} />)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Commitments */}
              {signals.commitments?.length > 0 && (
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-base">Commitments</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {signals.commitments.map((c: CallCommitment, i: number) => (
                      <div key={i} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{c.who}</Badge>
                          <span className="text-sm">{c.text}</span>
                          {c.dueDate && <span className="text-xs text-muted-foreground">due {c.dueDate}</span>}
                        </div>
                        <div className="flex gap-1 flex-wrap">
                          {c.evidence?.map((ev, j) => <EvidenceChip key={j} ev={ev} onJump={jumpAudio} />)}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Diagnostics Tab */}
        <TabsContent value="diagnostics" className="mt-6 space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Pipeline Status</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <PipelineStatus label="Recording" status={recording?.status || "none"} />
              <PipelineStatus label="Transcript" status={transcript?.status || "none"} />
              <PipelineStatus label="Analysis" status={analysis?.status || "none"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-base">Retry Actions</CardTitle></CardHeader>
            <CardContent className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                disabled={isRetrying !== null}
                onClick={() => handleRetry("ingest")}
              >
                <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isRetrying === "ingest" && "animate-spin")} />
                Retry Ingest
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isRetrying !== null}
                onClick={() => handleRetry("transcribe")}
              >
                <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isRetrying === "transcribe" && "animate-spin")} />
                Retry Transcribe
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isRetrying !== null}
                onClick={() => handleRetry("analyze")}
              >
                <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isRetrying === "analyze" && "animate-spin")} />
                Retry Analyze
              </Button>
            </CardContent>
          </Card>

          {webhookLog.length > 0 && (
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base">Webhook Deliveries</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {webhookLog.map((entry: any, i: number) => (
                    <WebhookLogEntry key={entry.id || i} entry={entry} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WebhookLogEntry({ entry }: { entry: any }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full text-left py-2 px-3 rounded hover:bg-accent/30 transition-colors flex items-center gap-3 text-sm">
          <span className="text-muted-foreground/50">{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
          <span className="text-xs text-muted-foreground font-mono w-36">
            {entry.created_at ? format(new Date(entry.created_at), "MMM d HH:mm:ss") : "—"}
          </span>
          <Badge variant="outline" className="text-[10px]">{entry.event_type}</Badge>
          {entry.error_message && <span className="text-xs text-destructive truncate">{entry.error_message}</span>}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="text-xs bg-muted/50 rounded p-3 overflow-auto max-h-48 ml-8">
          {sanitizePayload(entry.payload)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
