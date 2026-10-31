/**
 * Pure builders for client pilot reports (pilot-reports edge function).
 * No Deno / network here so it can be unit-tested and imported from src/.
 *
 * The numbers come from the pilot_report() SQL function. Wording rules that make
 * an early, low-data week still read as progress (see the pilot plan's "ramp-up"
 * section):
 *   - the headline picks the strongest thing that happened (meeting > interested
 *     reply > live conversation > activity), never a zero;
 *   - rows that are zero for the week AND the whole pilot are left out;
 *   - "What we heard" only appears when there is something to say.
 */

export interface PilotReport {
  emails_sent: number;
  replies: number;
  positive_replies: number;
  bounces: number;
  linkedin_done: number;
  linkedin_accepted: number;
  calls_dialled: number;
  conversations: number;
  calls_answered: number;
  meetings_booked: number;
  waiting_on_rep: number;
  leads_by_stage: Record<string, number>;
  call_recaps: { lead: string | null; company: string | null; duration_sec: number | null; summary: string }[];
  reply_summaries: { lead: string | null; company: string | null; intent: string | null; summary: string }[];
}

export interface WeeklyContext {
  clientName: string;          // "Paythings"
  weekNumber: number;          // 1-based
  totalWeeks: number;          // 12
  meetingsTarget: number | null;
  upcoming: { email: number; linkedin: number; voice: number };
  appUrl: string;              // https://www.drivepilot.app
  preview: boolean;            // true → banner, goes to the founder only
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function headline(week: PilotReport): string {
  if (week.meetings_booked > 0) return `${plural(week.meetings_booked, "meeting")} booked`;
  if (week.positive_replies > 0) return `${plural(week.positive_replies, "interested reply", "interested replies")}`;
  if (week.conversations > 0) return `${plural(week.conversations, "live conversation")} with prospects`;
  const touches = week.emails_sent + week.linkedin_done + week.calls_dialled;
  const channels = [week.emails_sent, week.linkedin_done, week.calls_dialled].filter((n) => n > 0).length;
  if (touches > 0) return `${plural(touches, "touch", "touches")} across ${plural(channels, "channel")}`;
  return "Setting up the pipeline";
}

const ROWS: [keyof PilotReport, string][] = [
  ["emails_sent", "Emails sent"],
  ["replies", "Replies"],
  ["positive_replies", "Interested replies"],
  ["linkedin_done", "LinkedIn touches"],
  ["linkedin_accepted", "LinkedIn connections accepted"],
  ["calls_dialled", "Calls made"],
  ["calls_answered", "Calls answered"],
  ["conversations", "Conversations (1 min+)"],
  ["meetings_booked", "Meetings booked"],
  ["bounces", "Bounced emails"],
];

export function buildWeeklyEmail(week: PilotReport, total: PilotReport, ctx: WeeklyContext): { subject: string; html: string } {
  const head = headline(week);
  const subject = `${ctx.clientName} pilot, week ${ctx.weekNumber}: ${head}`;
  const td = 'style="padding:6px 12px;border-bottom:1px solid #eee"';
  const tdNum = 'style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right"';

  const rows = ROWS
    .filter(([k]) => Number(week[k]) > 0 || Number(total[k]) > 0)
    .map(([k, label]) => `<tr><td ${td}>${label}</td><td ${tdNum}><b>${Number(week[k])}</b></td><td ${tdNum}>${Number(total[k])}</td></tr>`)
    .join("");

  const heard = [
    ...week.reply_summaries.map((r) => `<li><b>${esc(r.lead ?? "A prospect")}${r.company ? `, ${esc(r.company)}` : ""}</b> (reply): ${esc(r.summary)}</li>`),
    ...week.call_recaps.map((r) => `<li><b>${esc(r.lead ?? "A prospect")}${r.company ? `, ${esc(r.company)}` : ""}</b> (call): ${esc(r.summary)}</li>`),
  ];

  const up = ctx.upcoming;
  const nextParts = [
    up.email && plural(up.email, "email"),
    up.linkedin && plural(up.linkedin, "LinkedIn touch", "LinkedIn touches"),
    up.voice && plural(up.voice, "call"),
  ].filter(Boolean);

  const progress = ctx.meetingsTarget
    ? `Week ${ctx.weekNumber} of ${ctx.totalWeeks} · ${total.meetings_booked} of ${ctx.meetingsTarget} target meetings booked`
    : `Week ${ctx.weekNumber} of ${ctx.totalWeeks}`;

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;line-height:1.5">
${ctx.preview ? `<p style="background:#fff4d6;padding:8px 12px;border-radius:4px"><b>Preview:</b> this has not been sent to ${esc(ctx.clientName)} yet.</p>` : ""}
<h2 style="margin:0 0 4px">${esc(head)}</h2>
<p style="margin:0 0 16px;color:#666">${esc(progress)}</p>
${rows ? `<table style="border-collapse:collapse;width:100%;margin-bottom:16px">
<tr><th ${td} align="left"></th><th ${tdNum}>This week</th><th ${tdNum}>Pilot total</th></tr>
${rows}</table>` : `<p>Outreach starts this week. The first numbers will be in next Monday's update.</p>`}
${heard.length ? `<h3 style="margin:16px 0 4px">What we heard</h3><ul style="padding-left:18px;margin:0 0 16px">${heard.join("")}</ul>` : ""}
${week.waiting_on_rep > 0 ? `<p style="color:#8a5a00">${plural(week.waiting_on_rep, "follow-up is", "follow-ups are")} overdue in the queue.</p>` : ""}
${nextParts.length ? `<h3 style="margin:16px 0 4px">Coming up this week</h3><p style="margin:0 0 16px">${esc(nextParts.join(", "))} scheduled.</p>` : ""}
<p><a href="${esc(ctx.appUrl)}/app/leads">Open DrivePilot</a> to see every lead and conversation.</p>
</div>`;
  return { subject, html };
}

export interface AlertItem { leadId: string; lead: string | null; company: string | null; intent: string | null; summary: string | null }

const INTENT_LABEL: Record<string, string> = {
  book_meeting: "wants to meet",
  calendar_accept: "accepted a meeting",
  meeting_confirmation: "confirmed a meeting",
  pricing: "asked about pricing",
  partnership: "is interested in a partnership",
};

export function buildAlertEmail(items: AlertItem[], clientName: string, appUrl: string): { subject: string; html: string } {
  const first = items[0];
  const who = `${first.lead ?? "A prospect"}${first.company ? ` at ${first.company}` : ""}`;
  const subject = items.length === 1
    ? `${clientName} pilot: ${who} ${INTENT_LABEL[first.intent ?? ""] ?? "replied"}`
    : `${clientName} pilot: ${items.length} hot replies`;
  const lis = items.map((i) =>
    `<li><a href="${esc(appUrl)}/app/leads/${esc(i.leadId)}"><b>${esc(i.lead ?? "A prospect")}${i.company ? `, ${esc(i.company)}` : ""}</b></a> ${esc(INTENT_LABEL[i.intent ?? ""] ?? "replied")}${i.summary ? `: ${esc(i.summary)}` : ""}</li>`).join("");
  return { subject, html: `<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;line-height:1.5"><ul style="padding-left:18px">${lis}</ul></div>` };
}

/** Monday, at or after 08:00 in the workspace time zone, and not already sent this week. */
export function weeklyDue(now: Date, timeZone: string, lastSentAt: Date | null): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (weekday !== "Mon" || hour < 8) return false;
  return !lastSentAt || now.getTime() - lastSentAt.getTime() > 2 * 24 * 3600 * 1000;
}

export function weekNumber(now: Date, pilotStart: Date): number {
  return Math.max(1, Math.ceil((now.getTime() - pilotStart.getTime()) / (7 * 24 * 3600 * 1000)));
}
