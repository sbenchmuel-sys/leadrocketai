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
import { Plus, Trash2, Upload, FileText, Loader2 } from "lucide-react";

interface KBChunk {
  id: string;
  title: string | null;
  content: string;
  source: string | null;
  allowed_customer_facing: boolean;
  created_at: string;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadChunks = async () => {
    try {
      const { data, error } = await supabase
        .from("kb_chunks")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setChunks(data || []);
    } catch (err) {
      toast.error("Failed to load knowledge base");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadChunks();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newChunk.content.trim()) {
      toast.error("Content is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const { error } = await supabase.from("kb_chunks").insert({
        title: newChunk.title || null,
        content: newChunk.content,
        source: newChunk.source || null,
        allowed_customer_facing: newChunk.allowed_customer_facing,
      });

      if (error) throw error;

      toast.success("Knowledge added");
      setIsAddOpen(false);
      setNewChunk({ title: "", content: "", source: "", allowed_customer_facing: true });
      loadChunks();
    } catch (err) {
      toast.error("Failed to add knowledge. You may need admin permissions.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("kb_chunks").delete().eq("id", id);
      if (error) throw error;
      toast.success("Deleted");
      loadChunks();
    } catch (err) {
      toast.error("Failed to delete. You may need admin permissions.");
    }
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
      const formData = new FormData();
      formData.append("file", file);

      const { data, error } = await supabase.functions.invoke("parse-document", {
        body: formData,
      });

      if (error) throw error;
      if (!data.ok) throw new Error(data.error || "Failed to parse document");

      setNewChunk({
        title: data.title || "",
        content: data.text || "",
        source: data.source || "",
        allowed_customer_facing: true,
      });
      setIsAddOpen(true);
      toast.success("Document parsed! Review the content below.");
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Failed to parse document");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Knowledge Base</h1>
          <p className="text-muted-foreground">
            Add approved content for AI-generated drafts
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
            {isUploading ? "Parsing..." : "Upload Document"}
          </Button>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Snippet
              </Button>
            </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Knowledge Snippet</DialogTitle>
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
                  placeholder="Paste your approved content here..."
                  rows={6}
                  required
                />
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
                {isSubmitting ? "Adding..." : "Add Snippet"}
              </Button>
            </form>
          </DialogContent>
          </Dialog>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Knowledge Snippets</CardTitle>
          <CardDescription>
            These snippets are used by AI to generate accurate, compliant responses
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : chunks.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No knowledge snippets yet. Add your first one!
            </p>
          ) : (
            <div className="space-y-4">
              {chunks.map((chunk) => (
                <div key={chunk.id} className="p-4 border rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        {chunk.title && (
                          <span className="font-medium">{chunk.title}</span>
                        )}
                        <Badge
                          variant={chunk.allowed_customer_facing ? "default" : "secondary"}
                        >
                          {chunk.allowed_customer_facing ? "Customer-facing" : "Internal only"}
                        </Badge>
                        {chunk.source && (
                          <span className="text-xs text-muted-foreground">
                            Source: {chunk.source}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-4">
                        {chunk.content}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(chunk.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
