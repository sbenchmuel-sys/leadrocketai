import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Linkedin, Copy, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useAITask } from "@/hooks/useAITask";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { validateLinkedInLength, LINKEDIN_CHAR_LIMITS } from "@/prompts/linkedinPrompts";

interface LinkedInMessageButtonProps {
  leadId: string;
  leadName: string;
  leadCompany: string;
  leadTitle?: string | null;
  linkedinUrl?: string | null;
  context?: string;
  /** "connect" for connection notes, "followup" for DMs */
  mode?: "connect" | "followup";
}

export default function LinkedInMessageButton({
  leadId,
  leadName,
  leadCompany,
  leadTitle,
  linkedinUrl,
  context,
  mode = "followup",
}: LinkedInMessageButtonProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const { runTask, isLoading } = useAITask();

  const taskType = mode === "connect" ? "linkedin_connect" : "linkedin_followup";
  const charType = mode === "connect" ? "connectionNote" : "followUpMessage";
  const limit = LINKEDIN_CHAR_LIMITS[charType];

  const generateMessage = async () => {
    setCopied(false);
    const result = await runTask(taskType, {
      lead_id: leadId,
      prospect_name: leadName,
      company: leadCompany,
      title: leadTitle || "",
      context: context || "",
    });

    if (result.ok && result.content) {
      setMessage(result.content);
    }
  };

  const handleOpen = async () => {
    setOpen(true);
    if (!message) {
      await generateMessage();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      toast.success("Message copied to clipboard!");
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleCopyAndOpen = async () => {
    await handleCopy();
    if (linkedinUrl) {
      const opened = window.open(linkedinUrl, "_blank", "noopener,noreferrer");
      if (!opened) {
        toast.info("LinkedIn URL copied! Open it manually: " + linkedinUrl);
      }
    }
  };

  const validation = message ? validateLinkedInLength(message, charType) : null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs gap-1.5"
        onClick={handleOpen}
      >
        <Linkedin className="h-3.5 w-3.5" />
        LinkedIn
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Linkedin className="h-5 w-5 text-[#0A66C2]" />
              LinkedIn {mode === "connect" ? "Connection Note" : "Message"}
            </DialogTitle>
            <DialogDescription>
              AI-generated message for {leadName} at {leadCompany}.
              Edit as needed, then copy & open LinkedIn.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Generating personalized message…</span>
              </div>
            ) : (
              <>
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={mode === "connect" ? 4 : 6}
                  placeholder="Your LinkedIn message will appear here…"
                  className="resize-none text-sm"
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className={validation && !validation.valid ? "text-destructive font-medium" : ""}>
                      {message.length}/{limit} chars
                    </span>
                    {validation && !validation.valid && (
                      <Badge variant="destructive" className="text-[10px] h-4">Over limit</Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={generateMessage}
                    disabled={isLoading}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Regenerate
                  </Button>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopy}
              disabled={!message || isLoading}
              className="gap-1.5"
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Copied!" : "Copy"}
            </Button>
            <Button
              size="sm"
              onClick={handleCopyAndOpen}
              disabled={!message || isLoading}
              className="gap-1.5 bg-[#0A66C2] hover:bg-[#004182] text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {linkedinUrl ? "Copy & Open LinkedIn" : "Copy Message"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
