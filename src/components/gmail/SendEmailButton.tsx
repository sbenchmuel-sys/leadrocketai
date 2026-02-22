import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Send, Loader2 } from "lucide-react";
import { useMailSync } from "@/hooks/useMailSync";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SendEmailButtonProps {
  to: string;
  subject: string;
  body: string;
  leadId?: string;
  draftId?: string;
  onSent?: () => void;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  showDialog?: boolean;
}

export function SendEmailButton({
  to,
  subject,
  body,
  leadId,
  draftId,
  onSent,
  variant = "default",
  size = "sm",
  showDialog = true,
}: SendEmailButtonProps) {
  const { isConnected, isLoading: isLoadingConnection, sendEmail, isSyncing, providerLabel } = useMailSync();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editedTo, setEditedTo] = useState(to);
  const [editedSubject, setEditedSubject] = useState(subject);
  const [editedBody, setEditedBody] = useState(body);

  const handleOpenDialog = () => {
    setEditedTo(to);
    setEditedSubject(subject);
    setEditedBody(body);
    setDialogOpen(true);
  };

  const handleSend = async () => {
    // Validate before sending
    if (!editedTo.trim()) {
      toast.error("Recipient email is required");
      return;
    }
    if (!editedSubject.trim()) {
      toast.error("Subject is required");
      return;
    }
    if (!editedBody.trim()) {
      toast.error("Message body is required");
      return;
    }
    
    const result = await sendEmail(
      editedTo.trim(),
      editedSubject.trim(),
      editedBody.trim(),
      leadId,
      draftId
    );
    if (result.ok) {
      setDialogOpen(false);
      onSent?.();
    }
  };

  const handleDirectSend = async () => {
    // Validate before sending
    if (!to.trim()) {
      toast.error("Recipient email is required");
      return;
    }
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }
    if (!body.trim()) {
      toast.error("Message body is required");
      return;
    }
    
    const result = await sendEmail(to.trim(), subject.trim(), body.trim(), leadId, draftId);
    if (result.ok) {
      onSent?.();
    }
  };

  if (isLoadingConnection) {
    return (
      <Button variant={variant} size={size} disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!isConnected) {
    return null;
  }

  if (!showDialog) {
    return (
      <Button
        variant={variant}
        size={size}
        onClick={handleDirectSend}
        disabled={isSyncing}
      >
        {isSyncing ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Send className="h-4 w-4 mr-2" />
        )}
        Send via {providerLabel}
      </Button>
    );
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={handleOpenDialog}>
        <Send className="h-4 w-4 mr-2" />
        Send via {providerLabel}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send Email via {providerLabel}</DialogTitle>
            <DialogDescription>
              Review and edit the email before sending
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                value={editedTo}
                onChange={(e) => setEditedTo(e.target.value)}
                placeholder="recipient@example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={editedSubject}
                onChange={(e) => setEditedSubject(e.target.value)}
                placeholder="Email subject"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="body">Message</Label>
              <Textarea
                id="body"
                value={editedBody}
                onChange={(e) => setEditedBody(e.target.value)}
                placeholder="Email body"
                className="min-h-[200px]"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={isSyncing}>
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Send Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
