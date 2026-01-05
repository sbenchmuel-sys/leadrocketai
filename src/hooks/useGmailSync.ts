import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface SyncResult {
  ok: boolean;
  synced?: number;
  total?: number;
  errors?: string[];
  error?: string;
}

export function useGmailSync() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncLead = async (leadId: string, leadEmail: string, maxResults = 20): Promise<SyncResult> => {
    try {
      setIsSyncing(true);
      setError(null);

      const { data, error: fnError } = await supabase.functions.invoke("gmail-sync", {
        body: { leadId, leadEmail, maxResults },
      });

      if (fnError) {
        const errorMsg = fnError.message || "Failed to sync Gmail";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      if (!data.ok) {
        const errorMsg = data.error || "Gmail sync failed";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      if (data.synced > 0) {
        toast.success(`Synced ${data.synced} email${data.synced > 1 ? 's' : ''} from Gmail`);
      } else {
        toast.info("No new emails found");
      }

      return data as SyncResult;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      toast.error(errorMsg);
      return { ok: false, error: errorMsg };
    } finally {
      setIsSyncing(false);
    }
  };

  const sendEmail = async (
    to: string,
    subject: string,
    body: string,
    leadId?: string,
    draftId?: string
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> => {
    try {
      setIsSyncing(true);
      setError(null);

      const { data, error: fnError } = await supabase.functions.invoke("gmail-send", {
        body: { to, subject, body, leadId, draftId },
      });

      if (fnError) {
        const errorMsg = fnError.message || "Failed to send email";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      if (!data.ok) {
        const errorMsg = data.error || "Send email failed";
        setError(errorMsg);
        toast.error(errorMsg);
        return { ok: false, error: errorMsg };
      }

      toast.success("Email sent successfully!");
      return { ok: true, messageId: data.messageId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      setError(errorMsg);
      toast.error(errorMsg);
      return { ok: false, error: errorMsg };
    } finally {
      setIsSyncing(false);
    }
  };

  return {
    syncLead,
    sendEmail,
    isSyncing,
    error,
  };
}
