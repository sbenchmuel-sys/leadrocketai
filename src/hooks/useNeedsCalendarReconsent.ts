import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useWorkspace } from "@/contexts/WorkspaceContext";

const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const OUTLOOK_CALENDAR_SCOPE = "Calendars.Read";

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
            .select("granted_scopes, needs_reconnect")
            .eq("workspace_id", workspaceId)
            .eq("provider", "outlook")
            .eq("status", "connected")
        : Promise.resolve({ data: null, error: null }),
    ]);

    const gmail = gmailRes.data;
    const googleNeeds = !!gmail && (
      gmail.needs_reconnect === true ||
      !(gmail.granted_scopes ?? []).includes(GOOGLE_CALENDAR_SCOPE)
    );

    const outlookRows = (outlookRes.data ?? []) as Array<{
      granted_scopes: string[] | null;
      needs_reconnect: boolean | null;
    }>;
    const microsoftNeeds = outlookRows.some((row) =>
      row.needs_reconnect === true ||
      !(row.granted_scopes ?? []).includes(OUTLOOK_CALENDAR_SCOPE)
    );

    setGoogle(googleNeeds);
    setMicrosoft(microsoftNeeds);
    setIsLoading(false);
  }, [user, workspaceId]);

  useEffect(() => {
    void check();
  }, [check]);

  return { google, microsoft, isLoading, refresh: check };
}
