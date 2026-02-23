import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GmailConnectionCard } from "@/components/gmail/GmailConnectionCard";
import { useGmailConnection } from "@/hooks/useGmailConnection";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowRight, SkipForward, ShieldCheck, Lock, Eye, Mail, Info, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface ConnectInboxStepProps {
  onNext: () => void;
  onBack?: () => void;
  allowSkip?: boolean;
}

type Provider = "gmail" | "outlook" | null;

export default function ConnectInboxStep({ onNext, onBack, allowSkip = true }: ConnectInboxStepProps) {
  const { isConnected: isGmailConnected } = useGmailConnection();
  const [selectedProvider, setSelectedProvider] = useState<Provider>(null);
  const [outlookConfigured, setOutlookConfigured] = useState<boolean | null>(null);
  const [outlookConnectedEmail, setOutlookConnectedEmail] = useState<string | null>(null);

  const checkOutlookCredentials = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) { setOutlookConfigured(false); return; }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(`${supabaseUrl}/functions/v1/outlook-auth`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      // 503 = credentials not configured server-side
      // 400 = credentials exist but workspaceId missing (probe success — configured)
      // Other statuses: assume configured unless explicitly told otherwise
      if (resp.status === 503) {
        const json = await resp.json().catch(() => ({}));
        setOutlookConfigured(!json.not_configured);
      } else {
        setOutlookConfigured(true);
      }
    } catch {
      setOutlookConfigured(null);
    }
  }, []);

  /** After OAuth redirect, fetch the connected Outlook account email via the health endpoint. */
  const fetchOutlookConnectedEmail = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) return;

      // Get workspace id first
      const { data: membership } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .limit(1)
        .maybeSingle();

      if (!membership?.workspace_id) return;

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const resp = await fetch(
        `${supabaseUrl}/functions/v1/outlook-health?workspace_id=${membership.workspace_id}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!resp.ok) return;
      const json = await resp.json();
      const connected = json?.accounts?.find(
        (a: { status: string; email_address: string }) => a.status === "connected"
      );
      if (connected?.email_address) {
        setOutlookConnectedEmail(connected.email_address);
      }
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => {
    checkOutlookCredentials();

    // Detect post-OAuth redirect for Outlook
    const params = new URLSearchParams(window.location.search);
    if (params.get("outlook_connected") === "true") {
      setSelectedProvider("outlook");
      fetchOutlookConnectedEmail();
      // Clean up the URL param without a page reload
      const url = new URL(window.location.href);
      url.searchParams.delete("outlook_connected");
      window.history.replaceState({}, "", url.toString());
    }
  }, [checkOutlookCredentials, fetchOutlookConnectedEmail]);

  const isOutlookConnected = !!outlookConnectedEmail;
  const isAnyConnected = isGmailConnected || isOutlookConnected;

  return (
    <div className="flex flex-col items-center text-center space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold text-foreground tracking-tight">Connect Your Inbox</h1>
        <p className="text-muted-foreground max-w-md text-[15px] leading-relaxed">
          Link your email so the AI can sync conversations, draft replies, and track engagement automatically.
        </p>
      </div>

      {/* Trust badges */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-primary/70" />
          <span>Secure OAuth 2.0</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-primary/70" />
          <span>Enterprise-grade encryption</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Eye className="h-3.5 w-3.5 text-primary/70" />
          <span>Read-only access</span>
        </div>
        </div>

      {/* Connected banners */}
      {isGmailConnected && (
        <div className="w-full max-w-lg rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
          <div className="text-left">
            <p className="text-sm font-medium text-foreground">Gmail connected</p>
          </div>
        </div>
      )}
      {isOutlookConnected && (
        <div className="w-full max-w-lg rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
          <div className="text-left">
            <p className="text-sm font-medium text-foreground">Outlook connected</p>
            <p className="text-xs text-muted-foreground">{outlookConnectedEmail}</p>
          </div>
        </div>
      )}

      {/* Provider selection cards */}
      <div className="w-full max-w-lg grid grid-cols-2 gap-4">
        {/* Gmail card */}
        <button
          type="button"
          onClick={() => !isGmailConnected && setSelectedProvider(selectedProvider === "gmail" ? null : "gmail")}
          className={cn(
            "flex flex-col items-start gap-3 rounded-2xl border p-5 text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isGmailConnected
              ? "border-primary/40 bg-primary/5 cursor-default"
              : selectedProvider === "gmail"
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/30"
          )}
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10">
              <Mail className="h-4 w-4 text-red-500" />
            </div>
            <span className="font-semibold text-foreground">Gmail</span>
            {isGmailConnected && (
              <Badge variant="secondary" className="bg-green-500/10 text-green-600 text-[10px] px-1.5 py-0">
                <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                Connected
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {isGmailConnected ? "Your Gmail account is linked." : "Connect your Google Workspace or personal Gmail account."}
          </p>
        </button>

        {/* Outlook card */}
        {outlookConfigured === false ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-card/50 p-5 text-left opacity-50 cursor-not-allowed"
                >
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                      <Mail className="h-4 w-4 text-blue-500" />
                    </div>
                    <span className="font-semibold text-foreground">Outlook</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 border-yellow-500/60 text-yellow-700 dark:text-yellow-400"
                    >
                      <Info className="h-2.5 w-2.5 mr-0.5" />
                      Beta
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Multi-mailbox supported. Shared mailboxes coming soon.
                  </p>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs max-w-[200px]">
                Outlook integration not fully configured yet.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <button
            type="button"
            onClick={() => setSelectedProvider(selectedProvider === "outlook" ? null : "outlook")}
            className={cn(
              "flex flex-col items-start gap-3 rounded-2xl border p-5 text-left transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selectedProvider === "outlook"
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border bg-card hover:border-muted-foreground/40 hover:bg-muted/30"
            )}
          >
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
                <Mail className="h-4 w-4 text-blue-500" />
              </div>
              <span className="font-semibold text-foreground">Outlook</span>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 border-yellow-500/60 text-yellow-700 dark:text-yellow-400"
              >
                <Info className="h-2.5 w-2.5 mr-0.5" />
                Beta
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Multi-mailbox supported. Shared mailboxes coming soon.
            </p>
          </button>
        )}
      </div>

      {/* Expanded connect UI for selected provider */}
      {selectedProvider === "gmail" && (
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-lg">
            <GmailConnectionCard onConnectionChange={() => {}} />
          </div>
        </div>
      )}

      {selectedProvider === "outlook" && outlookConfigured !== false && (
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-lg text-left">
            <p className="text-sm text-muted-foreground">
              You can connect your Outlook account after completing onboarding in <span className="font-medium text-foreground">Settings → Integrations</span>.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 w-full max-w-sm">
        {isAnyConnected && (
          <Button size="lg" onClick={onNext} className="w-full gap-2 h-12 text-[15px] font-medium">
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}

        {allowSkip && !isAnyConnected && (
          <Button variant="ghost" size="sm" onClick={onNext} className="text-muted-foreground gap-1.5">
            <SkipForward className="h-4 w-4" />
            Skip for now
          </Button>
        )}

        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="text-muted-foreground">
            Back
          </Button>
        )}
      </div>
    </div>
  );
}
