import { useEffect, useState } from "react";
import { format, isToday, isTomorrow } from "date-fns";
import { Aperture, CalendarClock, Users, Video } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";

type CalendarPlatform = "google_meet" | "teams" | "zoom" | "other";

interface CalendarEventRow {
  id: string;
  title: string | null;
  start_time: string;
  end_time: string | null;
  platform: CalendarPlatform | null;
  attendees_emails: string[] | null;
  meeting_url: string | null;
  organizer_email: string | null;
  provider: "google" | "microsoft";
}

interface Props {
  leadId: string;
}

function formatRelative(startIso: string): string {
  const d = new Date(startIso);
  const time = format(d, "h:mm a");
  if (isToday(d)) return `Today ${time}`;
  if (isTomorrow(d)) return `Tomorrow ${time}`;
  return format(d, "EEE MMM d, h:mm a");
}

function PlatformIcon({ platform }: { platform: CalendarPlatform | null }) {
  if (platform === "google_meet") return <Video className="h-4 w-4 text-blue-500" />;
  if (platform === "teams") return <Users className="h-4 w-4 text-indigo-500" />;
  if (platform === "zoom") return <Aperture className="h-4 w-4 text-sky-500" />;
  return <CalendarClock className="h-4 w-4 text-muted-foreground" />;
}

function platformLabel(platform: CalendarPlatform | null): string {
  if (platform === "google_meet") return "Google Meet";
  if (platform === "teams") return "Teams";
  if (platform === "zoom") return "Zoom";
  return "Calendar";
}

function AttendeeChips({ emails, organizer }: { emails: string[]; organizer: string | null }) {
  const filtered = emails.filter((e) => e && e !== organizer);
  const shown = filtered.slice(0, 3);
  const extra = filtered.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((email) => (
        <Badge key={email} variant="outline" className="text-xs font-normal">
          {email}
        </Badge>
      ))}
      {extra > 0 && (
        <Badge variant="outline" className="text-xs font-normal">
          +{extra} more
        </Badge>
      )}
    </div>
  );
}

export function UpcomingMeetingsSection({ leadId }: Props) {
  const [events, setEvents] = useState<CalendarEventRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("calendar_events")
        .select(
          "id, title, start_time, end_time, platform, attendees_emails, meeting_url, organizer_email, provider",
        )
        .eq("lead_id", leadId)
        .gt("start_time", new Date().toISOString())
        .order("start_time", { ascending: true })
        .limit(10);
      if (cancelled) return;
      if (error) {
        console.error("[UpcomingMeetingsSection] load failed:", error.message);
        setEvents([]);
      } else {
        setEvents((data ?? []) as CalendarEventRow[]);
      }
      setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, [leadId]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-5 w-5 text-primary" />
        <h3 className="font-medium">Upcoming Meetings</h3>
        {!isLoading && events.length > 0 && (
          <Badge variant="secondary" className="text-xs">{events.length}</Badge>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {!isLoading && events.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No upcoming meetings with this lead.
        </p>
      )}

      {!isLoading && events.length > 0 && (
        <div className="space-y-2">
          {events.map((ev) => (
            <div
              key={ev.id}
              className="rounded-md border p-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex items-start gap-3 min-w-0">
                <div className="mt-0.5"><PlatformIcon platform={ev.platform} /></div>
                <div className="min-w-0 space-y-1">
                  <div className="font-medium truncate">{ev.title || "(no title)"}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatRelative(ev.start_time)} · {platformLabel(ev.platform)}
                  </div>
                  <AttendeeChips
                    emails={ev.attendees_emails ?? []}
                    organizer={ev.organizer_email}
                  />
                </div>
              </div>
              {ev.meeting_url && (
                <a
                  href={ev.meeting_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline shrink-0"
                >
                  Join
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
