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
import { toast } from "sonner";
import { Plus, Trash2, Upload, FileText, Loader2, RefreshCw, ChevronDown, ChevronRight, Check, Clock } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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
}

interface DocumentGroup {
  document_id: string | null;
  title: string | null;
  source: string | null;
  chunks: KBChunk[];
  totalChunks: number;
  processedChunks: number;
}

export default function Knowledge() {
  const [chunks, setChunks] = useState<KBChunk[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newChunk, setNewChunk] = useState({
    title: "",
    content: "",
    source: "",
    allowed_customer_facing: true,
  });
  const [isUploading, setIsUploading] = useState(false);
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [reprocessingDocs, setReprocessingDocs] = useState<Set<string>>(new Set());
  const [isReindexingAll, setIsReindexingAll] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadChunks = async () => {
    try {
      const { data, error } = await supabase
        .from("kb_chunks")
        .select("id, title, content, source, allowed_customer_facing, created_at, document_id, chunk_index, processing_status")
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
      const key = chunk.document_id || chunk.id; // Use chunk id as key for standalone chunks
      
      if (!groups.has(key)) {
        groups.set(key, {
          document_id: chunk.document_id,
          title: chunk.title,
          source: chunk.source,
          chunks: [],
          totalChunks: 0,
          processedChunks: 0,
        });
      }
      
      const group = groups.get(key)!;
      group.chunks.push(chunk);
      group.totalChunks++;
      if (chunk.processing_status === "completed") {
        group.processedChunks++;
      }
    }
    
    // Sort chunks within each group by chunk_index
    for (const group of groups.values()) {
      group.chunks.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    }
    
    return Array.from(groups.values());
  })();

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

      // For manually added snippets, use the process-knowledge-document function
      // to get proper chunking and embeddings
      const { data, error } = await supabase.functions.invoke("process-knowledge-document", {
        body: {
          text: newChunk.content,
          title: newChunk.title || null,
          source: newChunk.source || null,
          allowed_customer_facing: newChunk.allowed_customer_facing,
        },
      });

      if (error) throw error;
      if (!data.ok) throw new Error(data.error || "Failed to process knowledge");

      toast.success(`Knowledge added: ${data.chunks_created} chunk(s) created`);
      setIsAddOpen(false);
      setNewChunk({ title: "", content: "", source: "", allowed_customer_facing: true });
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
        // Delete all chunks in the document
        const { error } = await supabase
          .from("kb_chunks")
          .delete()
          .eq("document_id", documentId);
        if (error) throw error;
        toast.success("Document deleted");
      } else {
        // Delete single chunk
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
      // Get chunks to process - by document_id or by individual chunk id
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
      const DELAY_BETWEEN_CHUNKS_MS = 1000; // Rate limiting protection
      
      for (let i = 0; i < unprocessedChunks.length; i++) {
        const chunk = unprocessedChunks[i];
        
        // Add delay between calls to avoid rate limiting (skip first)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
        }
        
        setReindexProgress({ current: i + 1, total });
        
        try {
          const { data, error } = await supabase.functions.invoke("generate-embedding", {
            body: {
              text: chunk.content,
              chunk_id: chunk.id,
            },
          });
          
          if (error) {
            console.error(`[Reindex] Edge function error for chunk ${chunk.id}:`, error);
            toast.error(`Chunk failed: ${error.message || 'Unknown error'}`);
            failed++;
          } else if (!data?.ok) {
            console.error(`[Reindex] Embedding failed for chunk ${chunk.id}:`, data?.error);
            
            // Show specific error message
            const errMsg = data?.error || 'Unknown error';
            if (errMsg.includes("Rate limit")) {
              toast.warning("Rate limited - adding delay...");
              await new Promise(resolve => setTimeout(resolve, 5000));
            } else if (errMsg.includes("Payment")) {
              toast.error("AI credits depleted. Please add credits to continue.");
              break; // Stop processing
            } else {
              toast.error(`Chunk failed: ${errMsg}`);
            }
            failed++;
          } else {
            processed++;
            // Show progress every 5 chunks
            if (processed % 5 === 0) {
              toast.success(`Indexed ${processed} chunks...`);
            }
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
      // Get current session for auth header
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      
      if (!accessToken) {
        throw new Error("You must be logged in to upload documents");
      }

      // Step 1: Parse the document using direct fetch (supabase.functions.invoke doesn't handle FormData correctly)
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

      // Step 2: Process the document with smart chunking and embeddings
      const { data: processData, error: processError } = await supabase.functions.invoke("process-knowledge-document", {
        body: {
          text: parseData.text,
          title: parseData.title || file.name.replace(/\.(pdf|docx)$/i, ""),
          source: file.name,
          allowed_customer_facing: true,
        },
      });

      if (processError) throw processError;
      if (!processData.ok) throw new Error(processData.error || "Failed to process document");

      toast.success(`Document processed: ${processData.chunks_created} chunks, ${processData.embeddings_generated} embeddings`);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Knowledge Base</h1>
          <p className="text-muted-foreground">
            Upload documents for AI-powered semantic search in email generation
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
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {isUploading ? "Processing..." : "Upload Document"}
          </Button>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Content
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Knowledge Content</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleAdd} className="space-y-4">
                <div className="space-y-2">
                  <Label>Title (optional)</Label>
                  <Input
                    value={newChunk.title}
                    onChange={(e) => setNewChunk({ ...newChunk, title: e.target.value })}
                    placeholder="e.g., HIPAA Compliance Overview"
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
                    Content will be automatically chunked and indexed for semantic search.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Source (optional)</Label>
                  <Input
                    value={newChunk.source}
                    onChange={(e) => setNewChunk({ ...newChunk, source: e.target.value })}
                    placeholder="e.g., Product Deck Q1 2025"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={newChunk.allowed_customer_facing}
                    onCheckedChange={(checked) =>
                      setNewChunk({ ...newChunk, allowed_customer_facing: checked })
                    }
                  />
                  <Label>Customer-facing (can be used in external emails)</Label>
                </div>
                <Button type="submit" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    "Add Content"
                  )}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Documents & Knowledge</CardTitle>
          <CardDescription>
            Documents are split into semantic chunks for intelligent retrieval when generating emails
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
              <p className="text-muted-foreground">
                No documents yet. Upload a PDF/DOCX or add content manually.
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
                          
                          <div className="flex flex-wrap items-center gap-2 ml-6">
                            {isMultiChunk && (
                              <Badge variant="outline" className="text-xs">
                                {group.totalChunks} chunks
                              </Badge>
                            )}
                            
                            {isFullyProcessed ? (
                              <Badge variant="default" className="text-xs bg-green-600">
                                <Check className="h-3 w-3 mr-1" />
                                Indexed
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs">
                                <Clock className="h-3 w-3 mr-1" />
                                {group.processedChunks}/{group.totalChunks} indexed
                              </Badge>
                            )}
                            
                            <Badge
                              variant={group.chunks[0]?.allowed_customer_facing ? "default" : "secondary"}
                              className="text-xs"
                            >
                              {group.chunks[0]?.allowed_customer_facing ? "Customer-facing" : "Internal"}
                            </Badge>
                            
                            {group.source && (
                              <span className="text-xs text-muted-foreground truncate max-w-[200px]">
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
                                    <Badge variant="outline" className="text-xs text-green-600">
                                      <Check className="h-3 w-3 mr-1" />
                                      Indexed
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="text-xs">
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
