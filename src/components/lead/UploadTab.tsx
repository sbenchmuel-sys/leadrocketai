import { useState } from "react";
import { insertInteraction } from "@/lib/supabaseQueries";
import { useAITask } from "@/hooks/useAITask";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";

interface UploadTabProps {
  leadId: string;
  onSuccess: () => void;
}

type InteractionType = "email_inbound" | "email_outbound" | "meeting" | "call" | "note";

export default function UploadTab({ leadId, onSuccess }: UploadTabProps) {
  const [type, setType] = useState<InteractionType>("email_inbound");
  const [subject, setSubject] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { runTask, isLoading: isAnalyzing } = useAITask();

  const isEmailType = type === "email_inbound" || type === "email_outbound";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bodyText.trim()) {
      toast.error("Please enter content");
      return;
    }

    setIsSubmitting(true);

    try {
      // Insert the interaction
      await insertInteraction(leadId, {
        type,
        subject: subject || undefined,
        from_email: fromEmail || undefined,
        to_email: toEmail || undefined,
        body_text: bodyText,
      });

      // If inbound email, run intent router
      if (type === "email_inbound") {
        toast.info("Analyzing email...");
        const result = await runTask("intent_router", {
          lead_context: `Lead ID: ${leadId}`,
          email_text: bodyText,
        });

        if (result.ok && result.content) {
          try {
            const parsed = JSON.parse(result.content);
            // Update the interaction with AI analysis
            const { data: interactions } = await supabase
              .from("interactions")
              .select("id")
              .eq("lead_id", leadId)
              .order("created_at", { ascending: false })
              .limit(1);

            if (interactions && interactions[0]) {
              await supabase
                .from("interactions")
                .update({
                  ai_intent: parsed.intent_primary,
                  ai_summary: `${parsed.tone} tone, ${parsed.urgency} urgency. Strategy: ${parsed.suggested_strategy}`,
                  ai_reply_worthy: parsed.reply_worthy,
                })
                .eq("id", interactions[0].id);
            }
            toast.success(`Email analyzed: ${parsed.intent_primary}, ${parsed.reply_worthy ? "reply needed" : "no reply needed"}`);
          } catch {
            console.error("Failed to parse intent router response");
          }
        }
      } else {
        toast.success("Interaction added");
      }

      // Reset form
      setSubject("");
      setFromEmail("");
      setToEmail("");
      setBodyText("");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add interaction");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add Interaction</CardTitle>
        <CardDescription>
          Upload an email, meeting notes, or call summary. Inbound emails are automatically analyzed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as InteractionType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email_inbound">Inbound Email</SelectItem>
                <SelectItem value="email_outbound">Outbound Email</SelectItem>
                <SelectItem value="meeting">Meeting Notes</SelectItem>
                <SelectItem value="call">Call Notes</SelectItem>
                <SelectItem value="note">Internal Note</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isEmailType && (
            <>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>From</Label>
                  <Input
                    type="email"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    placeholder="sender@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>To</Label>
                  <Input
                    type="email"
                    value={toEmail}
                    onChange={(e) => setToEmail(e.target.value)}
                    placeholder="recipient@example.com"
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label>Content</Label>
            <Textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder={isEmailType ? "Paste email content here..." : "Enter notes..."}
              rows={8}
              required
            />
          </div>

          <Button type="submit" disabled={isSubmitting || isAnalyzing}>
            {isSubmitting || isAnalyzing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Upload className="h-4 w-4 mr-2" />
            )}
            {isAnalyzing ? "Analyzing..." : isSubmitting ? "Saving..." : "Add Interaction"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
