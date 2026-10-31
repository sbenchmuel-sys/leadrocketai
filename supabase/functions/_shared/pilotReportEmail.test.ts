import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildAlertEmail, buildWeeklyEmail, headline, type PilotReport, weeklyDue, weekNumber } from "./pilotReportEmail.ts";

const zero: PilotReport = {
  emails_sent: 0, replies: 0, positive_replies: 0, bounces: 0, linkedin_done: 0, linkedin_accepted: 0,
  calls_dialled: 0, conversations: 0, calls_answered: 0, meetings_booked: 0, waiting_on_rep: 0,
  leads_by_stage: {}, call_recaps: [], reply_summaries: [],
};
const ctx = { clientName: "Paythings", weekNumber: 1, totalWeeks: 12, meetingsTarget: 12, upcoming: { email: 30, linkedin: 0, voice: 12 }, appUrl: "https://www.drivepilot.app", preview: false };

Deno.test("headline picks the strongest signal and never a zero", () => {
  assertEquals(headline(zero), "Setting up the pipeline");
  assertEquals(headline({ ...zero, emails_sent: 40, calls_dialled: 12 }), "52 touches across 2 channels");
  assertEquals(headline({ ...zero, emails_sent: 40, conversations: 1 }), "1 live conversation with prospects");
  assertEquals(headline({ ...zero, positive_replies: 2, conversations: 3 }), "2 interested replies");
  assertEquals(headline({ ...zero, meetings_booked: 1, positive_replies: 2 }), "1 meeting booked");
});

Deno.test("weekly email hides all-zero rows, escapes names, shows preview banner", () => {
  const week = { ...zero, emails_sent: 40, reply_summaries: [{ lead: "<Ann>", company: "Acme & Co", intent: "book_meeting", summary: "Wants a demo" }] };
  const { subject, html } = buildWeeklyEmail(week, { ...week, calls_dialled: 5 }, { ...ctx, preview: true });
  assertEquals(subject, "Paythings pilot, week 1: 40 touches across 1 channel");
  assert(html.includes("Emails sent") && html.includes("Calls made"), "rows with a pilot total stay");
  assert(!html.includes("Meetings booked"), "all-zero rows are hidden");
  assert(html.includes("&lt;Ann&gt;, Acme &amp; Co") && !html.includes("<Ann>"), "names are escaped");
  assert(html.includes("Preview:"));
  assert(html.includes("30 emails, 12 calls scheduled"));
});

Deno.test("an empty first week still reads as a start, not a wall of zeros", () => {
  const { html } = buildWeeklyEmail(zero, zero, { ...ctx, upcoming: { email: 0, linkedin: 0, voice: 0 } });
  assert(html.includes("Outreach starts this week"));
  assert(!html.includes("What we heard"));
});

Deno.test("alert subject names the lead and what they want", () => {
  const one = buildAlertEmail([{ leadId: "L1", lead: "Ann", company: "Acme", intent: "book_meeting", summary: "Tuesday works" }], "Paythings", "https://x");
  assertEquals(one.subject, "Paythings pilot: Ann at Acme wants to meet");
  assert(one.html.includes("https://x/app/leads/L1"));
  const blank = { leadId: "L", lead: null, company: null, intent: null, summary: null };
  assertEquals(buildAlertEmail([blank, blank], "P", "u").subject, "P pilot: 2 hot replies");
});

Deno.test("weeklyDue: Monday from 8am in the workspace zone, once per week", () => {
  const tz = "America/New_York";
  assertEquals(weeklyDue(new Date("2026-11-09T12:59:00Z"), tz, null), false); // Mon 07:59 ET
  assertEquals(weeklyDue(new Date("2026-11-09T13:00:00Z"), tz, null), true);  // Mon 08:00 ET
  assertEquals(weeklyDue(new Date("2026-11-09T15:00:00Z"), tz, new Date("2026-11-09T13:00:00Z")), false); // already sent
  assertEquals(weeklyDue(new Date("2026-11-16T13:15:00Z"), tz, new Date("2026-11-09T13:00:00Z")), true);  // next Monday
  assertEquals(weeklyDue(new Date("2026-11-10T13:00:00Z"), tz, null), false); // Tuesday
});

Deno.test("weekNumber counts from the pilot start", () => {
  const start = new Date("2026-11-04T00:00:00Z");
  assertEquals(weekNumber(new Date("2026-11-09T13:00:00Z"), start), 1);
  assertEquals(weekNumber(new Date("2026-11-16T13:00:00Z"), start), 2);
});
