import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { setOnboardingStep } from "@/lib/supabaseQueries";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, ArrowLeft, Upload, FileText, Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

interface AddKnowledgeStepProps {
  onNext: () => void;
  onBack: () => void;
}

type InputMode = "choose" | "manual" | "upload";

export default function AddKnowledgeStep({ onNext, onBack }: AddKnowledgeStepProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<InputMode>("choose");
  const [formData, setFormData] = useState({
    title: "",
    content: "",
    customerFacing: true,
  });
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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

    setUploadedFile(file);
  };

  const handleFileUpload = async () => {
    if (!uploadedFile) return;

    setIsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error("You must be logged in");

      const formData = new FormData();
      formData.append("file", uploadedFile);

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const parseResponse = await fetch(`${supabaseUrl}/functions/v1/parse-document`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
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
          title: parseData.title || uploadedFile.name.replace(/\.(pdf|docx)$/i, ""),
          source: uploadedFile.name,
          allowed_customer_facing: true,
        },
      });

      if (processError) throw processError;
      if (!processData.ok) throw new Error(processData.error || "Failed to process document");

      await setOnboardingStep(3);
      toast.success(`Document processed: ${processData.chunks_created} chunks created`);
      onNext();
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Failed to process document");
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

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-bold text-foreground">Add Product Knowledge</h2>
        <p className="text-muted-foreground">
          Help the AI write better by adding information about your product or service.
        </p>
      </div>

      {mode === "choose" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => {
                setMode("upload");
                setTimeout(() => fileInputRef.current?.click(), 100);
              }}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-border bg-card hover:border-primary/50 hover:bg-accent/50 transition-all cursor-pointer"
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <div className="text-center">
                <p className="font-medium text-foreground text-sm">Upload a file</p>
                <p className="text-xs text-muted-foreground mt-1">PDF or Word doc</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-border bg-card hover:border-primary/50 hover:bg-accent/50 transition-all cursor-pointer"
            >
              <Keyboard className="h-8 w-8 text-muted-foreground" />
              <div className="text-center">
                <p className="font-medium text-foreground text-sm">Type it in</p>
                <p className="text-xs text-muted-foreground mt-1">Paste or write</p>
              </div>
            </button>
          </div>

          <div className="p-4 rounded-lg bg-muted/50 text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">What to add:</p>
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

          <div
            className={cn(
              "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
              uploadedFile ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
            )}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadedFile ? (
              <div className="flex flex-col items-center gap-2">
                <FileText className="h-10 w-10 text-primary" />
                <p className="text-sm font-medium text-foreground">{uploadedFile.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(uploadedFile.size / 1024).toFixed(0)} KB — click to change
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Click to select a file</p>
                <p className="text-xs text-muted-foreground">PDF or DOCX, up to 6MB</p>
              </div>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={() => { setMode("choose"); setUploadedFile(null); }} disabled={isLoading}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              className="flex-1"
              onClick={handleFileUpload}
              disabled={isLoading || !uploadedFile}
            >
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Upload & Continue
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
  );
}
