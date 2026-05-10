import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar, ExternalLink, Loader2, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useNeedsCalendarReconsent } from "@/hooks/useNeedsCalendarReconsent";
import { toast } from "sonner";

const GOOGLE_TRANSCRIPT_GUIDE =
  "https://support.google.com/meet/answer/12849897";
const TEAMS_TRANSCRIPT_GUIDE =
  "https://support.microsoft.com/office/view-live-transcription-in-microsoft-teams-meetings-dc1a8f23-2e20-4684-885e-2152e06a4a8b";

export function CalendarReconsentModal() {
  const { google, microsoft, isLoading, refresh } = useNeedsCalendarReconsent();
  const { workspaceId } = useWorkspace();
  const [connecting, setConnecting] = useState<"google" | "microsoft" | null>(null);

  const open = !isLoading && (google || microsoft);

  const handleReconnectGoogle = async () => {
    try {
      setConnecting("google");
      const { data, error } = await supabase.functions.invoke("gmail-auth", {
        body: { redirectUrl: window.location.href, returnUrl: window.location.pathname },
      });
      if (error) throw new Error(error.message);
      if (!data?.ok || !data.authUrl) throw new Error(data?.error || "Failed to start OAuth");
      window.location.href = data.authUrl;
    } catch (err) {
      setConnecting(null);
      toast.error(err instanceof Error ? err.message : "Could not start Google reconnect");
    }
  };

  const handleReconnectOutlook = async () => {
    try {
      setConnecting("microsoft");
      if (!workspaceId) throw new Error("No active workspace");
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const resp = await fetch(`${supabaseUrl}/functions/v1/outlook-auth`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspaceId, redirectUrl: window.location.href }),
      });
      const data = await resp.json().catch(() => ({ ok: false, error: "Invalid response" }));
      if (!resp.ok || !data.ok || !data.authUrl) {
        throw new Error(data.error || `Outlook auth failed (${resp.status})`);
      }
      window.location.href = data.authUrl;
    } catch (err) {
      setConnecting(null);
      toast.error(err instanceof Error ? err.message : "Could not start Outlook reconnect");
    }
  };

  // Detect post-reconnect redirect and re-check
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail_connected") === "true" || params.get("outlook_connected") === "true") {
      void refresh();
    }
  }, [refresh]);

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-lg"
        hideClose
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            <DialogTitle>DrivePilot now reads your calendar to recap meetings.</DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            We need permission to see your upcoming events and meeting transcripts.
            This stays inside DrivePilot — we never share it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {google && (
            <Button
              onClick={handleReconnectGoogle}
              disabled={connecting !== null}
              className="justify-start"
            >
              {connecting === "google" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              Reconnect Google
            </Button>
          )}
          {microsoft && (
            <Button
              onClick={handleReconnectOutlook}
              disabled={connecting !== null}
              variant={google ? "outline" : "default"}
              className="justify-start"
            >
              {connecting === "microsoft" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Mail className="h-4 w-4 mr-2" />
              )}
              Reconnect Outlook
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground border-t pt-3">
          <strong>Tip:</strong> After reconnecting, make sure transcripts are turned on in your meetings —{" "}
          <a
            href={GOOGLE_TRANSCRIPT_GUIDE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline hover:text-foreground"
          >
            Google Meet guide <ExternalLink className="h-3 w-3" />
          </a>{" "}
          /{" "}
          <a
            href={TEAMS_TRANSCRIPT_GUIDE}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline hover:text-foreground"
          >
            Teams guide <ExternalLink className="h-3 w-3" />
          </a>
          . DrivePilot can only summarize meetings where transcripts are enabled by the host.
        </p>
      </DialogContent>
    </Dialog>
  );
}
