import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { setOnboardingStep } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowLeft, Upload, FileText, Keyboard, X, CheckCircle2, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface AddKnowledgeStepProps {
  onNext: () => void;
  onBack: () => void;
}

type InputMode = "choose" | "manual" | "upload";

interface UploadedDoc {
  name: string;
  chunks: number;
}

function AIPreviewPanel() {
  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="font-medium text-foreground">Here's how your assistant will write.</span>
      </div>
      <div className="rounded-xl border border-border bg-card p-4 space-y-3 text-sm">
        <div className="text-muted-foreground text-xs uppercase tracking-wider font-medium">Sample Draft</div>
        <p className="text-foreground leading-relaxed">
          Hi Sarah,
        </p>
        <p className="text-foreground leading-relaxed">
          Following up on our conversation about streamlining your team's workflow.
          Based on what you shared about handling 200+ tickets per week, I think our
          automation engine could cut that processing time by roughly 40%.
        </p>
        <p className="text-foreground leading-relaxed">
          Would you be open to a 15-minute walkthrough this Thursday?
        </p>
        <p className="text-muted-foreground text-xs mt-3 pt-3 border-t border-border italic">
          ✨ This draft will adapt to your product knowledge and playbook style.
        </p>
      </div>
    </div>
  );
}

export default function AddKnowledgeStep({ onNext, onBack }: AddKnowledgeStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<InputMode>("choose");
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    customerFacing: true,
  });
  const [uploadedDocs, setUploadedDocs] = useState<UploadedDoc[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.content.trim()) {
      toast.error("Please add some content");
      return;
    }
    setIsLoading(true);
    try {
      const { error } = await supabase.from("kb_chunks").insert({
        title: formData.title.trim() || null,
        content: formData.content.trim(),
        allowed_customer_facing: formData.customerFacing,
        source: "onboarding",
      });
      if (error) throw error;
      await setOnboardingStep(3);
      toast.success("Knowledge added successfully!");
      onNext();
    } catch (err) {
      console.error("Failed to add knowledge:", err);
      toast.error("Failed to add knowledge. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

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
      if (!accessToken) throw new Error("You must be logged in");

      const fd = new FormData();
      fd.append("file", file);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const parseResponse = await fetch(`${supabaseUrl}/functions/v1/parse-document`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: fd,
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
          title: parseData.title || file.name.replace(/\.(pdf|docx)$/i, ""),
          source: file.name,
          allowed_customer_facing: true,
        },
      });
      if (processError) throw processError;
      if (!processData.ok) throw new Error(processData.error || "Failed to process document");

      setUploadedDocs((prev) => [...prev, { name: file.name, chunks: processData.chunks_created }]);
      toast.success(`"${file.name}" processed (${processData.chunks_created} chunks)`);
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Failed to process document");
    } finally {
      setIsUploading(false);
    }
  };

  const handleContinue = async () => {
    setIsLoading(true);
    try {
      await setOnboardingStep(3);
      onNext();
    } catch (err) {
      console.error("Failed to advance:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkip = async () => {
    setIsLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await (supabase as any)
          .from("onboarding_config")
          .upsert(
            { user_id: user.id, extraction_status: "skipped" },
            { onConflict: "user_id" }
          );
      }
      await setOnboardingStep(3);
      onNext();
    } catch (err) {
      console.error("Failed to skip:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const removeDoc = (index: number) => {
    setUploadedDocs((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3 text-center">
        <h2 className="text-3xl font-semibold text-foreground tracking-tight">Add Product Knowledge</h2>
        <p className="text-muted-foreground text-[15px] leading-relaxed">
          Help the AI write better by adding information about your product or service.
        </p>
      </div>

      {/* Two-column layout: input left, preview right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left column: knowledge input */}
        <div className="space-y-4">
          {mode === "choose" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setMode("upload")}
                  className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-border bg-card hover:border-primary/40 hover:shadow-[0_0_20px_hsl(217_91%_60%/0.08)] transition-all cursor-pointer"
                >
                  <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center">
                    <Upload className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-foreground text-sm">Upload files</p>
                    <p className="text-xs text-muted-foreground mt-1">PDF or Word docs</p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("manual")}
                  className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-border bg-card hover:border-primary/40 hover:shadow-[0_0_20px_hsl(217_91%_60%/0.08)] transition-all cursor-pointer"
                >
                  <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center">
                    <Keyboard className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="font-medium text-foreground text-sm">Type it in</p>
                    <p className="text-xs text-muted-foreground mt-1">Paste or write</p>
                  </div>
                </button>
              </div>

              <div className="p-4 rounded-xl bg-muted/30 border border-border text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1.5">What to add:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Your elevator pitch or value proposition</li>
                  <li>Key features and benefits</li>
                  <li>Pricing information</li>
                  <li>Common objection handlers</li>
                </ul>
              </div>

              <div className="flex gap-3 pt-2">
                <Button type="button" variant="outline" onClick={onBack} disabled={isLoading}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 text-muted-foreground"
                  onClick={handleSkip}
                  disabled={isLoading}
                >
                  Skip for now
                </Button>
              </div>
            </>
          )}

          {mode === "upload" && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx"
                onChange={handleFileSelect}
                className="hidden"
              />

              {uploadedDocs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Uploaded documents
                  </p>
                  <div className="space-y-1.5">
                    {uploadedDocs.map((doc, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 border border-border"
                      >
                        <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm text-foreground truncate flex-1">{doc.name}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">{doc.chunks} chunks</span>
                        <button
                          type="button"
                          onClick={() => removeDoc(i)}
                          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div
                className={cn(
                  "border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all",
                  isUploading ? "border-primary/50 bg-primary/5 pointer-events-none" : "border-border hover:border-primary/40"
                )}
                onClick={() => !isUploading && fileInputRef.current?.click()}
              >
                {isUploading ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">Processing document...</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    {uploadedDocs.length > 0 ? (
                      <>
                        <Plus className="h-8 w-8 text-muted-foreground" />
                        <p className="text-sm font-medium text-foreground">Add another document</p>
                        <p className="text-xs text-muted-foreground">PDF or DOCX, up to 6MB</p>
                      </>
                    ) : (
                      <>
                        <Upload className="h-8 w-8 text-muted-foreground" />
                        <p className="text-sm font-medium text-foreground">Click to select a file</p>
                        <p className="text-xs text-muted-foreground">PDF or DOCX, up to 6MB</p>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setMode("choose"); setUploadedDocs([]); }}
                  disabled={isLoading || isUploading}
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleContinue}
                  disabled={isLoading || isUploading || uploadedDocs.length === 0}
                >
                  {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Continue
                </Button>
              </div>
            </>
          )}

          {mode === "manual" && (
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title (optional)</Label>
                <Input
                  id="title"
                  placeholder="e.g., Product Overview, Pricing, Key Features"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  placeholder="Paste your product information here..."
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  disabled={isLoading}
                  rows={6}
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="customerFacing"
                  checked={formData.customerFacing}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, customerFacing: checked as boolean })
                  }
                  disabled={isLoading}
                />
                <label
                  htmlFor="customerFacing"
                  className="text-sm text-muted-foreground cursor-pointer"
                >
                  Safe to include in customer-facing messages
                </label>
              </div>

              <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" onClick={() => setMode("choose")} disabled={isLoading}>
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button type="submit" className="flex-1" disabled={isLoading}>
                  {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Add & Continue
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* Right column: AI preview */}
        <div className="hidden lg:block">
          <AIPreviewPanel />
        </div>
      </div>
    </div>
  );
}
