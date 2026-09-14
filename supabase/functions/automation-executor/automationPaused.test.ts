// Deno test (npm run test:edge): the shared settings loader.
//
//  1. cadence_settings.automation_paused → ExecutionSettings.owner_automation_paused.
//     Only a literal boolean true pauses; anything else (missing, "true", 1)
//     leaves automation running. The field is named for its real blast radius:
//     workspace_profiles is UNIQUE(user_id), so the switch pauses the OWNER in
//     every workspace they belong to, not one workspace.
//  2. The timezone comes from THE workspace passed in, not an arbitrary
//     workspace_members row — an owner in two workspaces must get each
//     workspace's own send-window timezone, and an unknown id must yield null
//     (checkSendWindow then fails closed).
//
// Runs against a stub client.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { checkEmailMinGap, checkMinGap, checkSendWindow, clearSettingsCache, loadExecutionSettings } from "../_shared/executionSettings.ts";

/** `timezones` maps workspace id → workspaces.timezone (missing id → no row). */
function stubClient(
  cadenceSettings: Record<string, unknown> | null,
  timezones: Record<string, string> = { ws: "UTC" },
) {
  const profileChain = {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cadenceSettings ? { cadence_settings: cadenceSettings } : null, error: null }) }) }),
  };
  const wsChain = {
    select: () => ({
      eq: (_col: string, id: string) => ({
        maybeSingle: async () => ({ data: timezones[id] ? { timezone: timezones[id] } : null, error: null }),
      }),
    }),
  };
  return {
    from: (table: string) => {
      if (table === "workspace_profiles") return profileChain;
      if (table === "workspaces") return wsChain;
      throw new Error(`unexpected table ${table} — the loader must not read workspace_members any more`);
    },
  } as any;
}

Deno.test("owner_automation_paused defaults to false when the key is absent", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-a", stubClient({}), "ws");
  assertEquals(s.owner_automation_paused, false);
});

Deno.test("owner_automation_paused is true only for a literal boolean true", async () => {
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-b", stubClient({ automation_paused: true }), "ws")).owner_automation_paused, true);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-c", stubClient({ automation_paused: "true" }), "ws")).owner_automation_paused, false);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-d", stubClient({ automation_paused: 1 }), "ws")).owner_automation_paused, false);
});

Deno.test("one owner in two workspaces gets each workspace's OWN timezone (not an arbitrary first pick)", async () => {
  clearSettingsCache();
  const client = stubClient({}, { "ws-ny": "America/New_York", "ws-syd": "Australia/Sydney" });
  const ny = await loadExecutionSettings("owner-multi", client, "ws-ny");
  const syd = await loadExecutionSettings("owner-multi", client, "ws-syd");
  assertEquals(ny.timezone, "America/New_York");
  assertEquals(syd.timezone, "Australia/Sydney");
});

Deno.test("an unknown workspace id yields no timezone and checkSendWindow fails closed", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-e", stubClient({}, { ws: "UTC" }), "ws-does-not-exist");
  assertEquals(s.timezone, null);
  assertEquals(checkSendWindow(s).allowed, false);
});

Deno.test("an empty workspace id never queries workspaces and fails closed", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-f", stubClient({}, {}), "");
  assertEquals(s.timezone, null);
  assertEquals(checkSendWindow(s).allowed, false);
});

// ── Fail-closed behaviour (Codex round 3) ────────────────────────────────────

/** Profile read returns an ERROR (not "no row"); workspaces still succeeds. */
function stubClientProfileError() {
  return {
    from: (table: string) => {
      if (table === "workspace_profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) }) }) };
      }
      if (table === "workspaces") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone: "UTC" }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

Deno.test("a workspace_profiles READ ERROR pauses the owner (fail closed), flagged as a read failure", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-err", stubClientProfileError(), "ws");
  assertEquals(s.owner_automation_paused, true);
  assertEquals(s.settings_read_failed, true);
  // The independent timezone read still succeeded — which is exactly how the
  // old code carried on through the send window and sent.
  assertEquals(s.timezone, "UTC");
  assertEquals(checkSendWindow(s).allowed, true);
});

Deno.test("a failed read is NOT cached — the next lead retries and a healthy read un-pauses", async () => {
  clearSettingsCache();
  const failed = await loadExecutionSettings("owner-retry", stubClientProfileError(), "ws");
  assertEquals(failed.owner_automation_paused, true);
  // Same owner + workspace, database recovered.
  const healthy = await loadExecutionSettings("owner-retry", stubClient({}), "ws");
  assertEquals(healthy.owner_automation_paused, false);
  assertEquals(healthy.settings_read_failed, false);
});

Deno.test("NO workspace_profiles row is 'never configured', not 'unreadable' — stays unpaused", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-new", stubClient(null), "ws");
  assertEquals(s.owner_automation_paused, false);
  assertEquals(s.settings_read_failed, false);
});

// ── checkEmailMinGap: the email gap must not count a text as an email ────────

// ── A stub that ACTUALLY EVALUATES the filters ──────────────────────────────
// The previous stub returned whatever row the test handed it, regardless of the
// query's filters. That made it fake safety: it passed against a predicate
// (`direction = 'outbound'`) that matches NONE of the rows gmail-send writes,
// because gmail-send omits `direction` and the column is bare nullable text.
// This stub stores rows and applies the real predicate, so a wrong filter fails.

type Row = Record<string, unknown>;

/** Split on top-level commas, respecting parentheses. */
function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Evaluate one PostgREST term: `col.eq.value` or `and(term,term)`. */
function matchTerm(row: Row, term: string): boolean {
  const t = term.trim();
  if (t.startsWith("and(")) {
    return splitTop(t.slice(4, -1)).every((inner) => matchTerm(row, inner));
  }
  const [col, op, ...rest] = t.split(".");
  const value = rest.join(".");
  if (op !== "eq") throw new Error(`stub does not model operator "${op}"`);
  // SQL three-valued logic: NULL never equals anything.
  const actual = row[col];
  return actual !== null && actual !== undefined && actual === value;
}

/** Minimal PostgREST-ish builder over an in-memory row set. */
function tableStub(rows: Row[], onRead?: () => void, failWith?: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let desc = false;
  const node: any = {
    select: () => node,
    eq: (col: string, val: unknown) => {
      preds.push((r) => r[col] !== null && r[col] !== undefined && r[col] === val);
      return node;
    },
    in: (col: string, vals: unknown[]) => {
      preds.push((r) => r[col] !== null && r[col] !== undefined && vals.includes(r[col]));
      return node;
    },
    or: (expr: string) => {
      const terms = splitTop(expr);
      preds.push((r) => terms.some((t) => matchTerm(r, t)));
      return node;
    },
    order: (_c: string, o?: { ascending?: boolean }) => { desc = o?.ascending === false; return node; },
    limit: () => node,
    maybeSingle: async () => {
      onRead?.();
      if (failWith) return { data: null, error: { message: failWith } };
      const hits = rows.filter((r) => preds.every((p) => p(r)));
      hits.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      if (desc) hits.reverse();
      return { data: hits[0] ?? null, error: null };
    },
  };
  return node;
}

interface GapStub {
  mirror?: Row[];        // lead_timeline_items rows
  interactions?: Row[];  // authoritative rows
  mirrorError?: string;
  authError?: string;
  onMirror?: () => void;
  onAuth?: () => void;
}

function gapClient(o: GapStub = {}) {
  return {
    from: (table: string) => {
      if (table === "lead_timeline_items") return tableStub(o.mirror ?? [], o.onMirror, o.mirrorError);
      if (table === "interactions") return tableStub(o.interactions ?? [], o.onAuth, o.authError);
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** EXACT shape gmail-send/index.ts inserts — note: NO `direction` key. */
function gmailSentRow(leadId: string, occurredAt: string): Row {
  return {
    lead_id: leadId,
    type: "email_outbound",
    source: "gmail",
    occurred_at: occurredAt,
    subject: "s",
    from_email: "rep@acme.com",
    to_email: "lead@x.com",
    to_emails: ["lead@x.com"],
    cc_emails: [],
    body_text: "b",
    gmail_message_id: "m1",
    gmail_thread_id: "t1",
  };
}

/** EXACT shape outlook-send/index.ts inserts — this one DOES set direction. */
function outlookSentRow(leadId: string, occurredAt: string): Row {
  return {
    lead_id: leadId,
    type: "email_outbound",
    source: "outlook",
    occurred_at: occurredAt,
    subject: "s",
    from_email: "rep@acme.com",
    to_email: "lead@x.com",
    to_emails: ["lead@x.com"],
    cc_emails: [],
    body_text: "b",
    direction: "outbound",
    gmail_message_id: "m1",
    gmail_thread_id: "t1",
  };
}

const mirrorRow = (leadId: string, occurredAt: string): Row =>
  ({ lead_id: leadId, event_type: "email_outbound", occurred_at: occurredAt });

Deno.test("cheap path: neither table is read when the cross-channel gap already allows", async () => {
  let mirror = 0, auth = 0;
  const res = await checkEmailMinGap("L", hoursAgo(20), 16,
    gapClient({ onMirror: () => mirror++, onAuth: () => auth++ }));
  assertEquals(res.allowed, true);
  assertEquals(mirror, 0);
  assertEquals(auth, 0);
});

Deno.test("an SMS two hours ago no longer defers the next EMAIL", async () => {
  // last_outbound_at is 2h old (the SMS, which sms-send stamps); the last EMAIL
  // was 40h ago — well outside the 16h email gap.
  const smsAt = hoursAgo(2);
  const lastEmail = hoursAgo(40);
  let auth = 0;
  const res = await checkEmailMinGap("L", smsAt, 16,
    gapClient({ mirror: [mirrorRow("L", lastEmail)], onAuth: () => auth++ }));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, lastEmail);  // anchored on the email, never the text
  assertEquals(auth, 0);                  // a present mirror row answers alone
  assertEquals(checkMinGap(smsAt, 16).allowed, false); // the old behaviour blocked
});

Deno.test("a real EMAIL inside the gap still defers, anchored on that email", async () => {
  const lastEmail = hoursAgo(3);
  const res = await checkEmailMinGap("L", hoursAgo(2), 16,
    gapClient({ mirror: [mirrorRow("L", lastEmail)] }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, lastEmail);
});

Deno.test("the MIRROR read erroring keeps the conservative block (fail closed)", async () => {
  const crossChannel = hoursAgo(1);
  const res = await checkEmailMinGap("L", crossChannel, 16,
    gapClient({ mirrorError: "boom" }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, crossChannel);
});

// ── An ABSENT mirror row is not evidence (Codex P2) ─────────────────────────
// lead_timeline_items is a projection and a missing row is a supported failure
// mode, so "never emailed" and "the mirror lost the row" look identical there.
// Only the first may send. `interactions` is the source of truth.
//
// These rows are built by copying the INSERTS in gmail-send / outlook-send, not
// by writing what the query hopes to find. gmail-send omits `direction`
// entirely, and `direction` is bare nullable text — so a predicate requiring
// direction='outbound' matches none of them.

Deno.test("missing mirror + a GMAIL-shaped authoritative row (no direction column) → BLOCKED", async () => {
  let auth = 0;
  const emailAt = hoursAgo(3);
  const res = await checkEmailMinGap("L", hoursAgo(2), 16, gapClient({
    interactions: [gmailSentRow("L", emailAt)], onAuth: () => auth++,
  }));
  assertEquals(res.allowed, false);   // was: allowed → a second email inside the gap
  assertEquals(res.anchorAt, emailAt);
  assertEquals(auth, 1);
});

Deno.test("missing mirror + an OUTLOOK-shaped authoritative row (direction set) → BLOCKED", async () => {
  const emailAt = hoursAgo(3);
  const res = await checkEmailMinGap("L", hoursAgo(2), 16, gapClient({
    interactions: [outlookSentRow("L", emailAt)],
  }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, emailAt);
});

Deno.test("missing mirror + a LEGACY 'email' + direction='outbound' row → BLOCKED", async () => {
  const emailAt = hoursAgo(3);
  const res = await checkEmailMinGap("L", hoursAgo(2), 16, gapClient({
    interactions: [{ lead_id: "L", type: "email", direction: "outbound", occurred_at: emailAt }],
  }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, emailAt);
});

Deno.test("missing mirror + only INBOUND email in the authoritative record → ALLOWED", async () => {
  const res = await checkEmailMinGap("L", hoursAgo(2), 16, gapClient({
    interactions: [{ lead_id: "L", type: "email_inbound", occurred_at: hoursAgo(1) }],
  }));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, null);
});

Deno.test("missing mirror + NO email anywhere → ALLOWED (the case this helper exists for)", async () => {
  // Last touch was an SMS; the lead has genuinely never been emailed. Blocking
  // here would be the cross-channel over-blocking this helper removes.
  let auth = 0;
  const res = await checkEmailMinGap("L", hoursAgo(2), 16,
    gapClient({ interactions: [], onAuth: () => auth++ }));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, null);
  assertEquals(auth, 1);
});

Deno.test("missing mirror + the AUTHORITATIVE read errors → BLOCKED (fail closed)", async () => {
  const crossChannel = hoursAgo(2);
  const res = await checkEmailMinGap("L", crossChannel, 16,
    gapClient({ authError: "authoritative boom" }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, crossChannel);
});

Deno.test("the newest authoritative outbound email wins when several exist", async () => {
  const older = hoursAgo(50), newer = hoursAgo(3);
  const res = await checkEmailMinGap("L", hoursAgo(2), 16, gapClient({
    interactions: [gmailSentRow("L", older), gmailSentRow("L", newer)],
  }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, newer);
});

// ── Guardrail coercion (Codex P1 sibling) ───────────────────────────────────
// cadence_settings is workspace JSON spread over typed defaults. A non-numeric
// value landed straight on a guardrail, and NaN loses every comparison — so the
// per-lead 7d/30d caps and the per-mailbox daily cap silently stopped capping.
// A limit that cannot be read must fall back to the documented default, never to
// "no limit". Zero is preserved everywhere (see the helper's doc comment).

function guardrailClient(cadenceSettings: Record<string, unknown>) {
  return {
    from: (table: string) => {
      if (table === "workspace_profiles") return tableStub([{ cadence_settings: cadenceSettings }]);
      if (table === "workspaces") return tableStub([{ id: "ws", timezone: "UTC" }]);
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

async function guardrailsFor(guardrails: Record<string, unknown> | undefined) {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-g", guardrailClient({ guardrails }), "ws");
  return s.guardrails;
}

Deno.test("an unreadable cap falls back to the documented default and really caps", async () => {
  const g = await guardrailsFor({ max_emails_per_lead_per_7d: "oops" });
  assertEquals(g.max_emails_per_lead_per_7d, 3);
  // The bug: NaN made this comparison false, i.e. no cap at all.
  assertEquals(99 >= g.max_emails_per_lead_per_7d, true);
});

Deno.test("every numeric guardrail falls back when unreadable — never to 'no limit'", async () => {
  assertEquals((await guardrailsFor({ max_sends_per_day_per_mailbox: " " })).max_sends_per_day_per_mailbox, 40);
  assertEquals((await guardrailsFor({ min_gap_hours_between_emails: "abc" })).min_gap_hours_between_emails, 16);
  assertEquals((await guardrailsFor({ jitter_percent: {} })).jitter_percent, 0.15);
  for (const bad of [null, "", true, -1, Infinity]) {
    assertEquals((await guardrailsFor({ max_emails_per_lead_per_30d: bad })).max_emails_per_lead_per_30d, 8);
  }
});

Deno.test("ZERO is preserved: a legitimate no-gap setting, and a deliberately stricter cap", async () => {
  const noGap = await guardrailsFor({ min_gap_hours_between_emails: 0 });
  assertEquals(noGap.min_gap_hours_between_emails, 0);
  assertEquals(checkMinGap(new Date().toISOString(), noGap.min_gap_hours_between_emails).allowed, true);

  // 0 means "never send" — STRICTER than the default. Raising it to the default
  // would weaken a guardrail an operator deliberately set.
  const neverSend = await guardrailsFor({ max_emails_per_lead_per_7d: 0 });
  assertEquals(neverSend.max_emails_per_lead_per_7d, 0);
  assertEquals(0 >= neverSend.max_emails_per_lead_per_7d, true);
});

Deno.test("legitimate values are untouched; a numeric string becomes a real number", async () => {
  const g = await guardrailsFor({ min_gap_hours_between_emails: 24, max_emails_per_lead_per_7d: 5 });
  assertEquals(g.min_gap_hours_between_emails, 24);
  assertEquals(g.max_emails_per_lead_per_7d, 5);
  const asString = await guardrailsFor({ max_emails_per_lead_per_7d: "5" });
  assertEquals(asString.max_emails_per_lead_per_7d, 5);
  assertEquals(typeof asString.max_emails_per_lead_per_7d, "number");
});

Deno.test("absent guardrails give the defaults; non-numeric guardrails pass through", async () => {
  const d = await guardrailsFor(undefined);
  assertEquals([d.min_gap_hours_between_emails, d.max_emails_per_lead_per_7d, d.max_sends_per_day_per_mailbox], [16, 3, 40]);
  assertEquals((await guardrailsFor({ same_day_send_allowed: true })).same_day_send_allowed, true);
});
