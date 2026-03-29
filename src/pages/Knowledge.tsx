import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, Upload, FileText, Loader2, RefreshCw, ChevronDown, ChevronRight, Check, Clock, BookOpen, ShieldAlert, Tag, Star, Info } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ============================================
// KB CATEGORY PRESETS
// ============================================

interface CategoryPreset {
  label: string;
  description: string;
  content_type: string;
  allowed_customer_facing: boolean;
  priority: number;
  suggested_tags: string[];
  icon: string;
}

const KB_CATEGORY_PRESETS: CategoryPreset[] = [
  {
    label: "Company Overview",
    description: "What you do, who you serve, mission, key differentiators",
    content_type: "knowledge",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["company", "overview"],
    icon: "🏢",
  },
  {
    label: "ICP & Buyer Personas",
    description: "Target roles, industries, company profiles, decision-maker traits",
    content_type: "industry",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["icp", "persona"],
    icon: "🎯",
  },
  {
    label: "Pain Points & Use Cases",
    description: "Problems you solve, real-world scenarios, customer challenges",
    content_type: "discovery",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["pain-points", "use-cases"],
    icon: "🔍",
  },
  {
    label: "Differentiators",
    description: "What makes you unique vs. alternatives and competitors",
    content_type: "competitor",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["differentiator", "competitive"],
    icon: "⚡",
  },
  {
    label: "Objections & Responses",
    description: "Common pushbacks and approved rebuttals for sales conversations",
    content_type: "objection",
    allowed_customer_facing: true,
    priority: 3,
    suggested_tags: ["objection", "rebuttal"],
    icon: "🛡️",
  },
  {
    label: "Proof Points & Case Studies",
    description: "Results, testimonials, customer stories, ROI data",
    content_type: "case_study",
    allowed_customer_facing: true,
    priority: 3,
    suggested_tags: ["proof", "case-study", "testimonial"],
    icon: "📊",
  },
  {
    label: "Product & Offer Knowledge",
    description: "Product details, features, pricing tiers, packages, offers",
    content_type: "knowledge",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["product", "offer"],
    icon: "📦",
  },
  {
    label: "Messaging Guardrails",
    description: "Words to use/avoid, positioning rules, compliance notes",
    content_type: "messaging",
    allowed_customer_facing: true,
    priority: 3,
    suggested_tags: ["guardrails", "messaging"],
    icon: "📝",
  },
  {
    label: "Internal Strategy Notes",
    description: "Strategy notes, competitive intel — never used in customer-facing messages",
    content_type: "strategy",
    allowed_customer_facing: false,
    priority: 1,
    suggested_tags: ["internal", "strategy"],
    icon: "🔒",
  },
  {
    label: "Product / Offer Cards",
    description: "Individual products, packages, pricing tiers, bundles — one card per offer",
    content_type: "knowledge",
    allowed_customer_facing: true,
    priority: 3,
    suggested_tags: ["product-card", "offer", "pricing"],
    icon: "🎁",
  },
  {
    label: "Stakeholder Cards",
    description: "Key buyer personas — role, goals, pain points, preferred messaging angles",
    content_type: "industry",
    allowed_customer_facing: true,
    priority: 2,
    suggested_tags: ["stakeholder", "persona", "decision-maker"],
    icon: "👤",
  },
  {
    label: "Stage Playbooks",
    description: "Strategy guidance per deal stage — what to do, say, and avoid at each step",
    content_type: "strategy",
    allowed_customer_facing: false,
    priority: 3,
    suggested_tags: ["playbook", "stage", "methodology"],
    icon: "📋",
  },
];

const CONTENT_TYPE_OPTIONS = [
  { value: "knowledge", label: "General Knowledge" },
  { value: "messaging", label: "Messaging" },
  { value: "objection", label: "Objection Handling" },
  { value: "discovery", label: "Discovery / Pain Points" },
  { value: "industry", label: "Industry / ICP" },
  { value: "competitor", label: "Competitive Intel" },
  { value: "signal", label: "Signal / Trigger" },
  { value: "strategy", label: "Strategy (Internal)" },
  { value: "case_study", label: "Case Study / Proof" },
];

const PRIORITY_OPTIONS = [
  { value: "1", label: "Normal", description: "Standard retrieval weight" },
  { value: "2", label: "High", description: "Boosted in retrieval" },
  { value: "3", label: "Critical", description: "Strongly prioritized" },
];

// ============================================
// TYPES
// ============================================

interface KBChunk {
  id: string;
  title: string | null;
  content: string;
  source: string | null;
  allowed_customer_facing: boolean;
  created_at: string;
  document_id: string | null;
  chunk_index: number | null;
  processing_status: string | null;
  content_type: string;
  tags: string[] | null;
  segment: string | null;
  priority: number;
}

interface DocumentGroup {
  document_id: string | null;
  title: string | null;
  source: string | null;
  chunks: KBChunk[];
  totalChunks: number;
  processedChunks: number;
  content_type: string;
  tags: string[] | null;
  priority: number;
  allowed_customer_facing: boolean;
}

// ============================================
// UPLOAD METADATA FORM STATE
// ============================================

interface UploadMetadata {
  title: string;
  content: string;
  source: string;
  content_type: string;
  allowed_customer_facing: boolean;
  priority: number;
  tags: string;
  segment: string;
}

const DEFAULT_METADATA: UploadMetadata = {
  title: "",
  content: "",
  source: "",
  content_type: "knowledge",
  allowed_customer_facing: true,
  priority: 1,
  tags: "",
  segment: "",
};

// ============================================
// CATEGORY PICKER COMPONENT
// ============================================

function CategoryPicker({ onSelect }: { onSelect: (preset: CategoryPreset) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {KB_CATEGORY_PRESETS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onSelect(preset)}
          className="flex items-start gap-2.5 p-3 rounded-lg border border-border bg-card hover:border-primary/40 hover:bg-accent/30 transition-all text-left group"
        >
          <span className="text-lg shrink-0 mt-0.5">{preset.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{preset.label}</p>
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{preset.description}</p>
            {!preset.allowed_customer_facing && (
              <div className="flex items-center gap-1 mt-1">
                <ShieldAlert className="h-3 w-3 text-amber-500" />
                <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">Internal only</span>
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

// ============================================
// METADATA FIELDS COMPONENT
// ============================================

function MetadataFields({
  metadata,
  onChange,
  compact = false,
}: {
  metadata: UploadMetadata;
  onChange: (m: UploadMetadata) => void;
  compact?: boolean;
}) {
  return (
    <div className={`space-y-3 ${compact ? "" : "border-t border-border pt-3"}`}>
      {!compact && (
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
          <Tag className="h-3 w-3" />
          Classification & Metadata
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Content Type</Label>
          <Select
            value={metadata.content_type}
            onValueChange={(v) => onChange({ ...metadata, content_type: v })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTENT_TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs flex items-center gap-1">
            Priority
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="text-xs max-w-[200px]">
                  Higher priority chunks are preferred during AI retrieval
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Label>
          <Select
            value={String(metadata.priority)}
            onValueChange={(v) => onChange({ ...metadata, priority: parseInt(v) })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Tags (comma-separated)</Label>
          <Input
            className="h-8 text-xs"
            placeholder="e.g. product, pricing, enterprise"
            value={metadata.tags}
            onChange={(e) => onChange({ ...metadata, tags: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Segment (optional)</Label>
          <Input
            className="h-8 text-xs"
            placeholder="e.g. enterprise, smb, healthcare"
            value={metadata.segment}
            onChange={(e) => onChange({ ...metadata, segment: e.target.value })}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={metadata.allowed_customer_facing}
          onCheckedChange={(checked) => onChange({ ...metadata, allowed_customer_facing: checked })}
        />
        <Label className="text-xs">
          {metadata.allowed_customer_facing ? "Customer-facing" : "Internal only (never used in customer emails)"}
        </Label>
        {!metadata.allowed_customer_facing && (
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 mr-1" />
            Internal
          </Badge>
        )}
      </div>
    </div>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function Knowledge() {
  const [chunks, setChunks] = useState<KBChunk[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addStep, setAddStep] = useState<"category" | "form">("category");
  const [newChunk, setNewChunk] = useState<UploadMetadata>(DEFAULT_METADATA);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMetadata, setUploadMetadata] = useState<UploadMetadata>(DEFAULT_METADATA);
  const [showUploadMeta, setShowUploadMeta] = useState(false);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [reprocessingDocs, setReprocessingDocs] = useState<Set<string>>(new Set());
  const [isReindexingAll, setIsReindexingAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadChunks = async () => {
    try {
      const { data, error } = await supabase
        .from("kb_chunks")
        .select("id, title, content, source, allowed_customer_facing, created_at, document_id, chunk_index, processing_status, content_type, tags, segment, priority")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setChunks((data as KBChunk[]) || []);
    } catch (err) {
      toast.error("Failed to load knowledge base");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadChunks();
  }, []);

  // Group chunks by document
  const documentGroups: DocumentGroup[] = (() => {
    const groups = new Map<string, DocumentGroup>();

    for (const chunk of chunks) {
      const key = chunk.document_id || chunk.id;

      if (!groups.has(key)) {
        groups.set(key, {
          document_id: chunk.document_id,
          title: chunk.title,
          source: chunk.source,
          chunks: [],
          totalChunks: 0,
          processedChunks: 0,
          content_type: chunk.content_type || "knowledge",
          tags: chunk.tags,
          priority: chunk.priority || 1,
          allowed_customer_facing: chunk.allowed_customer_facing,
        });
      }

      const group = groups.get(key)!;
      group.chunks.push(chunk);
      group.totalChunks++;
      if (chunk.processing_status === "completed") {
        group.processedChunks++;
      }
    }

    for (const group of groups.values()) {
      group.chunks.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    }

    return Array.from(groups.values());
  })();

  const parseTags = (tagsStr: string): string[] | null => {
    const tags = tagsStr.split(",").map(t => t.trim()).filter(Boolean);
    return tags.length > 0 ? tags : null;
  };

  const handleCategorySelect = (preset: CategoryPreset) => {
    setNewChunk({
      ...DEFAULT_METADATA,
      content_type: preset.content_type,
      allowed_customer_facing: preset.allowed_customer_facing,
      priority: preset.priority,
      tags: preset.suggested_tags.join(", "),
    });
    setAddStep("form");
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChunk.content.trim()) {
      toast.error("Content is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast.error("You must be logged in to add knowledge");
        return;
      }

      const { data, error } = await supabase.functions.invoke("process-knowledge-document", {
        body: {
          text: newChunk.content,
          title: newChunk.title || null,
          source: newChunk.source || null,
          allowed_customer_facing: newChunk.allowed_customer_facing,
          content_type: newChunk.content_type,
          priority: newChunk.priority,
          tags: parseTags(newChunk.tags),
          segment: newChunk.segment || null,
        },
      });

      if (error) throw error;
      if (!data.ok) throw new Error(data.error || "Failed to process knowledge");

      toast.success(`Knowledge added: ${data.chunks_created} chunk(s) created`);
      setIsAddOpen(false);
      setNewChunk(DEFAULT_METADATA);
      setAddStep("category");
      loadChunks();
    } catch (err: any) {
      console.error("Add error:", err);
      toast.error(err.message || "Failed to add knowledge");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, documentId: string | null) => {
    try {
      if (documentId) {
        const { error } = await supabase
          .from("kb_chunks")
          .delete()
          .eq("document_id", documentId);
        if (error) throw error;
        toast.success("Document deleted");
      } else {
        const { error } = await supabase.from("kb_chunks").delete().eq("id", id);
        if (error) throw error;
        toast.success("Deleted");
      }
      loadChunks();
    } catch (err) {
      toast.error("Failed to delete. You may need admin permissions.");
    }
  };

  const handleReprocess = async (documentId: string | null, chunkId?: string) => {
    const key = documentId || chunkId || "";
    setReprocessingDocs(prev => new Set(prev).add(key));

    try {
      const docChunks = documentId
        ? chunks.filter(c => c.document_id === documentId)
        : chunks.filter(c => c.id === chunkId);

      for (const chunk of docChunks) {
        await supabase.functions.invoke("generate-embedding", {
          body: {
            text: chunk.content,
            chunk_id: chunk.id,
          },
        });
      }

      toast.success("Document reprocessed");
      loadChunks();
    } catch (err) {
      toast.error("Failed to reprocess document");
    } finally {
      setReprocessingDocs(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const [reindexProgress, setReindexProgress] = useState<{ current: number; total: number } | null>(null);

  const handleReindexAll = async () => {
    setIsReindexingAll(true);
    try {
      const unprocessedChunks = chunks.filter(c => c.processing_status !== "completed");
      const total = unprocessedChunks.length;

      if (total === 0) {
        toast.info("All chunks are already indexed");
        return;
      }

      setReindexProgress({ current: 0, total });

      let processed = 0;
      let failed = 0;
      const DELAY_BETWEEN_CHUNKS_MS = 1000;

      for (let i = 0; i < unprocessedChunks.length; i++) {
        const chunk = unprocessedChunks[i];
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
        }
        setReindexProgress({ current: i + 1, total });

        try {
          const { data, error } = await supabase.functions.invoke("generate-embedding", {
            body: { text: chunk.content, chunk_id: chunk.id },
          });

          if (error) {
            console.error(`[Reindex] Edge function error for chunk ${chunk.id}:`, error);
            toast.error(`Chunk failed: ${error.message || 'Unknown error'}`);
            failed++;
          } else if (!data?.ok) {
            console.error(`[Reindex] Embedding failed for chunk ${chunk.id}:`, data?.error);
            const errMsg = data?.error || 'Unknown error';
            if (errMsg.includes("Rate limit")) {
              toast.warning("Rate limited - adding delay...");
              await new Promise(resolve => setTimeout(resolve, 5000));
            } else if (errMsg.includes("Payment")) {
              toast.error("AI credits depleted. Please add credits to continue.");
              break;
            } else {
              toast.error(`Chunk failed: ${errMsg}`);
            }
            failed++;
          } else {
            processed++;
            if (processed % 5 === 0) toast.success(`Indexed ${processed} chunks...`);
          }
        } catch (err) {
          console.error(`[Reindex] Exception for chunk ${chunk.id}:`, err);
          toast.error(`Exception: ${err instanceof Error ? err.message : 'Unknown'}`);
          failed++;
        }
      }

      if (failed > 0) {
        toast.warning(`Re-indexed ${processed} chunks, ${failed} failed. Check console for details.`);
      } else {
        toast.success(`Successfully indexed all ${processed} chunks!`);
      }
      loadChunks();
    } catch (err) {
      console.error("[Reindex] Fatal error:", err);
      toast.error(`Re-index failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsReindexingAll(false);
      setReindexProgress(null);
    }
  };

  const unprocessedCount = documentGroups.filter(g => g.processedChunks < g.totalChunks).length;

  const handleUploadClick = () => {
    setShowUploadMeta(true);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];

    if (!validTypes.includes(file.type) && !file.name.match(/\.(pdf|docx)$/i)) {
      toast.error("Please upload a PDF or Word document (.docx)");
      return;
    }

    if (file.size > 6 * 1024 * 1024) {
      toast.error("File size must be under 6MB");
      return;
    }

    setIsUploading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        throw new Error("You must be logged in to upload documents");
      }

      const formData = new FormData();
      formData.append("file", file);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const parseResponse = await fetch(`${supabaseUrl}/functions/v1/parse-document`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!parseResponse.ok) {
        const errorData = await parseResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to parse document: ${parseResponse.status}`);
      }

      const parseData = await parseResponse.json();
      if (!parseData.ok) throw new Error(parseData.error || "Failed to parse document");

      const { data: processData, error: processError } = await supabase.functions.invoke("process-knowledge-document", {
        body: {
          text: parseData.text,
          title: uploadMetadata.title || parseData.title || file.name.replace(/\.(pdf|docx)$/i, ""),
          source: file.name,
          allowed_customer_facing: uploadMetadata.allowed_customer_facing,
          content_type: uploadMetadata.content_type,
          priority: uploadMetadata.priority,
          tags: parseTags(uploadMetadata.tags),
          segment: uploadMetadata.segment || null,
        },
      });

      if (processError) throw processError;
      if (!processData.ok) throw new Error(processData.error || "Failed to process document");

      toast.success(`Document processed: ${processData.chunks_created} chunks, ${processData.embeddings_generated} embeddings`);
      setShowUploadMeta(false);
      setUploadMetadata(DEFAULT_METADATA);
      loadChunks();
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Failed to process document");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleUploadWithPreset = (preset: CategoryPreset) => {
    setUploadMetadata({
      ...DEFAULT_METADATA,
      content_type: preset.content_type,
      allowed_customer_facing: preset.allowed_customer_facing,
      priority: preset.priority,
      tags: preset.suggested_tags.join(", "),
    });
  };

  const toggleExpanded = (key: string) => {
    setExpandedDocs(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const getContentTypeLabel = (ct: string) => {
    return CONTENT_TYPE_OPTIONS.find(o => o.value === ct)?.label || ct;
  };

  const getContentTypeBadgeVariant = (ct: string): "default" | "secondary" | "outline" | "destructive" => {
    if (ct === "objection" || ct === "case_study") return "default";
    if (ct === "strategy" || ct === "signal") return "secondary";
    return "outline";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Knowledge Base</h1>
          <p className="text-muted-foreground">
            Upload focused documents to power AI-assisted sales conversations
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx"
            onChange={handleFileUpload}
            className="hidden"
          />
          {unprocessedCount > 0 && (
            <Button
              variant="outline"
              onClick={handleReindexAll}
              disabled={isReindexingAll}
            >
              {isReindexingAll ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {reindexProgress
                    ? `${reindexProgress.current}/${reindexProgress.total}`
                    : "Processing..."}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Re-index All ({unprocessedCount})
                </>
              )}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={handleUploadClick}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {isUploading ? "Processing..." : "Upload Document"}
          </Button>
          <Dialog open={isAddOpen} onOpenChange={(open) => { setIsAddOpen(open); if (!open) { setAddStep("category"); setNewChunk(DEFAULT_METADATA); } }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Content
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {addStep === "category" ? "What type of knowledge are you adding?" : "Add Knowledge Content"}
                </DialogTitle>
              </DialogHeader>

              {addStep === "category" ? (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Choose a category to pre-fill metadata. This helps the AI retrieve the right context for each sales situation.
                  </p>
                  <CategoryPicker onSelect={handleCategorySelect} />
                  <div className="text-center pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => setAddStep("form")}
                    >
                      Skip — use custom settings
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleAdd} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Title (optional)</Label>
                    <Input
                      value={newChunk.title}
                      onChange={(e) => setNewChunk({ ...newChunk, title: e.target.value })}
                      placeholder="e.g., Objection Handling — Budget Concerns"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Content</Label>
                    <Textarea
                      value={newChunk.content}
                      onChange={(e) => setNewChunk({ ...newChunk, content: e.target.value })}
                      placeholder="Paste your content here. Large documents will be automatically split into searchable chunks..."
                      rows={8}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      Tip: Upload one focused topic per document for best AI retrieval.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Source (optional)</Label>
                    <Input
                      value={newChunk.source}
                      onChange={(e) => setNewChunk({ ...newChunk, source: e.target.value })}
                      placeholder="e.g., Sales Playbook Q1 2025"
                    />
                  </div>

                  <MetadataFields metadata={newChunk} onChange={setNewChunk} />

                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => setAddStep("category")}>
                      Back
                    </Button>
                    <Button type="submit" className="flex-1" disabled={isSubmitting}>
                      {isSubmitting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        "Add Content"
                      )}
                    </Button>
                  </div>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Upload Document Dialog */}
      <Dialog open={showUploadMeta} onOpenChange={(open) => { setShowUploadMeta(open); if (!open) setUploadMetadata(DEFAULT_METADATA); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose a category first, then select your file. This helps the AI use the document in the right context.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {KB_CATEGORY_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleUploadWithPreset(preset)}
                  className={`flex items-start gap-2 p-2.5 rounded-lg border text-left transition-all ${
                    uploadMetadata.content_type === preset.content_type && uploadMetadata.priority === preset.priority
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  <span className="text-base shrink-0">{preset.icon}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{preset.label}</p>
                    {!preset.allowed_customer_facing && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">Internal only</span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Document Title (optional override)</Label>
              <Input
                className="h-8 text-xs"
                placeholder="Leave empty to use filename"
                value={uploadMetadata.title}
                onChange={(e) => setUploadMetadata({ ...uploadMetadata, title: e.target.value })}
              />
            </div>

            <MetadataFields metadata={uploadMetadata} onChange={setUploadMetadata} compact />

            <Button
              className="w-full"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  Select File (PDF or DOCX)
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* KB Structure Guide */}
      <Card className="border-dashed">
        <Accordion type="single" collapsible>
          <AccordionItem value="guide" className="border-b-0">
            <CardHeader className="pb-0 pt-4 px-6">
              <AccordionTrigger className="py-0 hover:no-underline">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-medium">Recommended KB Structure for Last-Mile Sales</CardTitle>
                </div>
              </AccordionTrigger>
            </CardHeader>
            <AccordionContent>
              <CardContent className="pt-3 pb-4 text-sm text-muted-foreground space-y-4">
                <p>Organize your knowledge base into <strong>focused, single-topic documents</strong> for best AI retrieval — especially for active deal conversations.</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {KB_CATEGORY_PRESETS.map((preset) => (
                    <div key={preset.label} className="rounded-md border border-border p-3 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span>{preset.icon}</span>
                        <p className="font-medium text-foreground text-xs">{preset.label}</p>
                      </div>
                      <p className="text-xs">{preset.description}</p>
                      <div className="flex gap-1 flex-wrap mt-1">
                        <Badge variant="outline" className="text-[10px] h-4">{getContentTypeLabel(preset.content_type)}</Badge>
                        {!preset.allowed_customer_facing && (
                          <Badge variant="secondary" className="text-[10px] h-4">
                            <ShieldAlert className="h-2.5 w-2.5 mr-0.5" />
                            Internal
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rounded-md bg-muted/50 p-3 space-y-1.5">
                  <p className="font-medium text-foreground text-xs">Best Practices for Last-Mile Selling</p>
                  <ul className="text-xs space-y-1 list-disc list-inside">
                    <li><strong>One topic per document</strong> — don't mix objections with product specs</li>
                    <li><strong>Separate customer-safe vs internal-only</strong> — internal strategy notes stay private</li>
                    <li><strong>Prioritize objection & proof docs</strong> — these are most impactful in active deals</li>
                    <li>Use clear headings — they help the AI find the right content</li>
                    <li>Include specific examples, numbers, and outcomes where possible</li>
                    <li>Tag documents by use case (e.g., "enterprise", "pricing", "technical")</li>
                    <li>Update regularly as your messaging and proof points evolve</li>
                  </ul>
                </div>
              </CardContent>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents & Knowledge</CardTitle>
          <CardDescription>
            Documents are split into semantic chunks for intelligent retrieval during sales conversations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : documentGroups.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-2">
                No documents yet. Upload focused docs to power AI-assisted conversations.
              </p>
              <p className="text-xs text-muted-foreground">
                Start with objection handling and proof points for the biggest last-mile impact.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {documentGroups.map((group) => {
                const key = group.document_id || group.chunks[0]?.id || "";
                const isExpanded = expandedDocs.has(key);
                const isMultiChunk = group.totalChunks > 1;
                const isFullyProcessed = group.processedChunks === group.totalChunks;
                const isReprocessing = reprocessingDocs.has(group.document_id || "");

                return (
                  <div key={key} className="border rounded-lg overflow-hidden">
                    <div className="p-4 bg-muted/30">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            {isMultiChunk && (
                              <button
                                onClick={() => toggleExpanded(key)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                            )}
                            <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium truncate">
                              {group.title || "Untitled Document"}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 ml-6">
                            {/* Content type badge */}
                            <Badge variant={getContentTypeBadgeVariant(group.content_type)} className="text-[10px] h-5">
                              {getContentTypeLabel(group.content_type)}
                            </Badge>

                            {isMultiChunk && (
                              <Badge variant="outline" className="text-[10px] h-5">
                                {group.totalChunks} chunks
                              </Badge>
                            )}

                            {isFullyProcessed ? (
                              <Badge variant="default" className="text-[10px] h-5 bg-green-600">
                                <Check className="h-3 w-3 mr-0.5" />
                                Indexed
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] h-5">
                                <Clock className="h-3 w-3 mr-0.5" />
                                {group.processedChunks}/{group.totalChunks}
                              </Badge>
                            )}

                            {!group.allowed_customer_facing && (
                              <Badge variant="secondary" className="text-[10px] h-5 text-amber-600 dark:text-amber-400">
                                <ShieldAlert className="h-3 w-3 mr-0.5" />
                                Internal
                              </Badge>
                            )}

                            {group.priority > 1 && (
                              <Badge variant="outline" className="text-[10px] h-5">
                                <Star className="h-3 w-3 mr-0.5" />
                                P{group.priority}
                              </Badge>
                            )}

                            {group.tags && group.tags.length > 0 && group.tags.slice(0, 3).map(tag => (
                              <Badge key={tag} variant="outline" className="text-[10px] h-5 text-muted-foreground">
                                {tag}
                              </Badge>
                            ))}

                            {group.source && (
                              <span className="text-[10px] text-muted-foreground truncate max-w-[150px]">
                                {group.source}
                              </span>
                            )}
                          </div>

                          {!isMultiChunk && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mt-2 ml-6">
                              {group.chunks[0]?.content}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          {!isFullyProcessed && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleReprocess(group.document_id, group.chunks[0]?.id)}
                              disabled={isReprocessing}
                              title="Reprocess embeddings"
                            >
                              <RefreshCw className={`h-4 w-4 ${isReprocessing ? 'animate-spin' : ''}`} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(group.chunks[0]?.id, group.document_id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    {isMultiChunk && isExpanded && (
                      <div className="border-t divide-y">
                        {group.chunks.map((chunk, idx) => (
                          <div key={chunk.id} className="p-3 pl-10 bg-background">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-xs font-medium text-muted-foreground">
                                    Chunk {idx + 1}
                                  </span>
                                  {chunk.processing_status === "completed" ? (
                                    <Badge variant="outline" className="text-[10px] text-green-600">
                                      <Check className="h-3 w-3 mr-1" />
                                      Indexed
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="text-[10px]">
                                      <Clock className="h-3 w-3 mr-1" />
                                      Pending
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground line-clamp-3">
                                  {chunk.content}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
