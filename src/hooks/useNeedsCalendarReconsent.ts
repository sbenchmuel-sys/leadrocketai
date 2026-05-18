import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";

// Backend mirrors of these lists live at:
//   - Google: supabase/functions/gmail-auth/index.ts (scopes array)
//   - Outlook: supabase/functions/_shared/outlookScopes.ts (OUTLOOK_OAUTH_SCOPES)
// Different runtimes, can't share code — update both together when adding scopes.
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_TRANSCRIPT_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const OUTLOOK_CALENDAR_SCOPE = "Calendars.Read";
const OUTLOOK_TRANSCRIPT_SCOPE = "OnlineMeetingTranscript.Read.All";
// Mirrors supabase/functions/_shared/outlookScopes.ts.
// Personal/Outlook.com tokens always carry this tid. The transcript scope
// is delegated-only for work/school, so consumer accounts can never grant
// it — re-prompting would just send them back into the same dead-end consent.
const OUTLOOK_PERSONAL_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

export interface CalendarReconsentState {
  google: boolean;
  microsoft: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useNeedsCalendarReconsent(): CalendarReconsentState {
  const { user } = useAuth();
  const { workspaceId } = useWorkspace();
  const [google, setGoogle] = useState(false);
  const [microsoft, setMicrosoft] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const check = useCallback(async () => {
    if (!user) {
      setGoogle(false);
      setMicrosoft(false);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    const [gmailRes, outlookRes] = await Promise.all([
      supabase
        .from("gmail_connections")
        .select("granted_scopes, needs_reconnect")
        .eq("user_id", user.id)
        .maybeSingle(),
      workspaceId
        ? supabase
            .from("mail_accounts")
            .select("granted_scopes, needs_reconnect, tenant_id")
            .eq("workspace_id", workspaceId)
            .eq("provider", "outlook")
            .eq("status", "connected")
        : Promise.resolve({ data: null, error: null }),
    ]);

    const gmail = gmailRes.data;
    const gmailScopes = gmail?.granted_scopes ?? [];
    const googleNeeds = !!gmail && (
      gmail.needs_reconnect === true ||
      !gmailScopes.includes(GOOGLE_CALENDAR_SCOPE) ||
      !gmailScopes.includes(GOOGLE_TRANSCRIPT_SCOPE)
    );

    const outlookRows = (outlookRes.data ?? []) as Array<{
      granted_scopes: string[] | null;
      needs_reconnect: boolean | null;
      tenant_id: string | null;
    }>;
    const microsoftNeeds = outlookRows.some((row) => {
      if (row.needs_reconnect === true) return true;
      const scopes = row.granted_scopes ?? [];
      if (!scopes.includes(OUTLOOK_CALENDAR_SCOPE)) return true;
      // Personal accounts can never carry the transcript scope — skip the
      // transcript-scope check rather than send them back into a dead-end
      // consent. Work/school + unknown-tenant accounts still fall through to
      // the transcript check.
      if (row.tenant_id === OUTLOOK_PERSONAL_TENANT_ID) return false;
      // Only escalate to transcript-scope check if calendar is already granted —
      // avoids double-prompting users on a single missing-grant state.
      return !scopes.includes(OUTLOOK_TRANSCRIPT_SCOPE);
    });

    setGoogle(googleNeeds);
    setMicrosoft(microsoftNeeds);
    setIsLoading(false);
  }, [user, workspaceId]);

  useEffect(() => {
    void check();
  }, [check]);

  return { google, microsoft, isLoading, refresh: check };
}
