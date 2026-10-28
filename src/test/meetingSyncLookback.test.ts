// SOURCE-TEXT guard for the "meeting lost during an outage" fix (Oct 2026).
// A Teams meeting was never captured because (1) the organizer's Outlook was
// expired with no banner, (2) calendar-sync only looked forward from "now",
// and (3) the transcript poller only looked back 24h. These checks fail if
// any of the three pieces drifts back.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MEETING_LOOKBACK_MS, OUTLOOK_MEETING_SYNC_STATUSES } from "@shared/meetingSync";

const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");

describe("meeting pipeline lookback", () => {
  it("is 3 days and keeps 'error' accounts but not 'expired'", () => {
    expect(MEETING_LOOKBACK_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(OUTLOOK_MEETING_SYNC_STATUSES).toContain("error");
    expect(OUTLOOK_MEETING_SYNC_STATUSES).not.toContain("expired");
  });

  it("calendar-sync starts both Google and Outlook windows in the past", () => {
    const src = read("supabase/functions/calendar-sync/index.ts");
    expect(src).toContain("const timeMin = new Date(Date.now() - MEETING_LOOKBACK_MS)");
    expect(src).toContain("const startDateTime = new Date(Date.now() - MEETING_LOOKBACK_MS)");
    expect(src).toContain('.in("status", OUTLOOK_MEETING_SYNC_STATUSES)');
  });

  it("transcript-poller uses the same window everywhere", () => {
    const src = read("supabase/functions/transcript-poller/index.ts");
    expect(src).not.toMatch(/24 \* 60 \* 60 \* 1000/);
    expect(src.match(/now - MEETING_LOOKBACK_MS/g)?.length).toBe(3);
  });

  it("teams-transcript-fetch accepts the same account statuses as calendar-sync", () => {
    const src = read("supabase/functions/teams-transcript-fetch/index.ts");
    expect(src).not.toContain('.eq("status", "connected")');
  });

  it("reconnect banner shows expired accounts", () => {
    expect(read("src/components/MailConnectionBanner.tsx")).toContain("status.eq.expired");
  });
});
