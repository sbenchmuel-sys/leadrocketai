// Source-text guards for the automation-executor safety fixes (Unit G-C).
//
// automation-executor is a Deno edge function that imports Deno-only modules, so
// it can't be executed under vitest. Like coldAutoSendGate.test.ts, these tests
// read the file as text and pin the load-bearing shapes: the kill switch runs
// before any claim, the stagger constant is small and actually used, the legacy
// email path runs the same floor + footer helpers as the cold path before the
// provider call, the SMS branch can see `phone`, the cold pass honours OOO, and
// every cold skip branch writes a ledger row.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const EXECUTOR = path.join(ROOT, "supabase/functions/automation-executor/index.ts");
const SETTINGS = path.join(ROOT, "supabase/functions/_shared/executionSettings.ts");
const src = readFileSync(EXECUTOR, "utf8");
const settingsSrc = readFileSync(SETTINGS, "utf8");

/** Text of the cold pass: from the privileged guard to the volume tripwire. */
function coldSection(): string {
  const start = src.indexOf("if (privileged) try {");
  const end = src.indexOf("VOLUME TRIPWIRE", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Text of the legacy per-lead loop: from the for-loop to the cold pass. */
function legacySection(): string {
  const start = src.indexOf("for (const lead of legacyLeads)");
  const end = src.indexOf("if (privileged) try {", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("killSwitch", () => {
  it("AUTOMATION_PAUSED short-circuits before the service client and before any claim", () => {
    const check = src.indexOf("if (killSwitchEngaged())");
    const client = src.indexOf("const supabase = createClient(supabaseUrl, supabaseServiceKey)");
    const firstClaim = src.indexOf('status: "claiming"');
    const firstLogInsert = src.indexOf('from("automation_log").insert');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(client);
    expect(check).toBeLessThan(firstClaim);
    expect(check).toBeLessThan(firstLogInsert);
    // Reads the env secret, accepts "1" or "true", returns 200 with sent=0.
    expect(src).toMatch(/Deno\.env\.get\("AUTOMATION_PAUSED"\)/);
    expect(src).toMatch(/v === "1" \|\| v === "true"/);
    const body = src.slice(check, check + 600);
    expect(body).toContain("paused by kill switch");
    expect(body).toMatch(/sent: 0/);
    expect(body).not.toMatch(/status: 500|status: 4\d\d/);
  });

  it("the pause is an OWNER-scoped settings key (default false) and skips in BOTH the legacy loop and the cold pass", () => {
    // Named for what it actually scopes to. The STORED json key stays
    // `automation_paused` (production rows already use it).
    expect(settingsSrc).toContain("owner_automation_paused: boolean");
    expect(settingsSrc).toContain("owner_automation_paused: false");
    // Was `raw.automation_paused === true`. Now a profile READ ERROR also pauses
    // (Codex P2): `data === null` from maybeSingle means "no row / no key" and
    // stays unpaused, but an `error` means the flag may be true and unreadable.
    expect(settingsSrc).toContain("owner_automation_paused: profileReadFailed || raw.automation_paused === true");
    // Legacy loop: after loading execSettings, before the send-window check.
    const legacy = legacySection();
    const pause = legacy.indexOf("if (execSettings.owner_automation_paused)");
    const window = legacy.indexOf("checkSendWindow(execSettings)");
    expect(pause).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(window);
    // Window widened: the branch now also picks the honest reason string and
    // carries the fallback deferral (Codex P1/P2). Same ledger write as before.
    const pauseBranch = legacy.slice(pause, pause + 1800);
    expect(pauseBranch).toContain('from("automation_log").insert(logEntry)');
    // A read failure is reported as a read failure, never as "you paused it".
    expect(pauseBranch).toContain("execSettings.settings_read_failed");
    expect(pauseBranch).toContain("Could not read this account's automation settings");
    // Cold pass: after loading exec, before any claim.
    const cold = coldSection();
    const coldPause = cold.indexOf("if (exec.owner_automation_paused)");
    const coldClaim = cold.indexOf('status: "claiming"');
    expect(coldPause).toBeGreaterThan(-1);
    expect(coldPause).toBeLessThan(coldClaim);
    expect(cold.slice(coldPause, coldPause + 300)).toContain("logColdSkip(");
  });

  it("no rep-facing string calls the owner pause a WORKSPACE pause (Codex P2 — it pauses every workspace the owner is in)", () => {
    // The switch is stored on workspace_profiles, which is UNIQUE(user_id), so
    // it can only ever be owner-wide. Anything that tells a rep otherwise is a
    // mislabelled safety control.
    for (const m of src.matchAll(/error_message[^\n]*automation_paused[^\n]*/g)) {
      expect(m[0]).not.toMatch(/for this workspace/i);
    }
    for (const m of src.matchAll(/logColdSkip\(touch, "[^"]*automation_paused[^"]*"/g)) {
      expect(m[0]).not.toMatch(/for this workspace/i);
    }
    // Both skip reasons say "account" / "all of this owner's workspaces".
    const reasons = [...src.matchAll(/"Automation paused[^"]*"/g)].map((m) => m[0]);
    expect(reasons.length).toBe(2); // legacy loop + cold pass
    for (const r of reasons) expect(r).toMatch(/all of this owner's workspaces/);
    // The interface doc warns the next reader before they reach for it.
    expect(settingsSrc).toMatch(/UNIQUE\(user_id\)/);
    expect(settingsSrc).toMatch(/ponytail: per-workspace scoping needs a schema change/);
  });

  it("the kill switch is not referenced by the manual/review send function", () => {
    const manual = readFileSync(path.join(ROOT, "supabase/functions/outreach-touch-action/index.ts"), "utf8");
    expect(manual).not.toContain("AUTOMATION_PAUSED");
  });
});

describe("staggerCap", () => {
  it("INTER_SEND_STAGGER_MS is a named constant of at most 8000 ms", () => {
    const m = src.match(/const INTER_SEND_STAGGER_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThanOrEqual(8000);
  });

  it("the legacy loop sleeps on the constant and no longer on a 30–90s random", () => {
    const legacy = legacySection();
    expect(legacy).toContain("setTimeout(r, INTER_SEND_STAGGER_MS)");
    expect(legacy).not.toMatch(/30_000 \+ Math\.floor\(Math\.random\(\) \* 60_000\)/);
    expect(legacy).not.toMatch(/Math\.random\(\)[^\n]*setTimeout|setTimeout\(r, [^)]*Math\.random/);
  });
});

describe("legacyPathFloorAndFooter", () => {
  it("the legacy email path calls coldSendFloor between the claim and the provider call", () => {
    const legacy = legacySection();
    const claim = legacy.indexOf('status: "claiming"');
    const floor = legacy.indexOf("const legacyFloor = await coldSendFloor(supabase, lead.id, lead.workspace_id)");
    const provider = legacy.indexOf("functions/v1/gmail-send");
    const outlook = legacy.indexOf("functions/v1/outlook-send");
    expect(floor).toBeGreaterThan(claim);
    expect(floor).toBeLessThan(provider);
    expect(floor).toBeLessThan(outlook);
    // Blocked → claim row becomes skipped, never sent.
    expect(legacy.slice(floor, floor + 900)).toContain('status: "skipped"');
  });

  it("the legacy email path builds the CAN-SPAM footer with the cold path's helpers (no second implementation)", () => {
    const legacy = legacySection();
    expect(legacy).toContain("signUnsubscribeToken(");
    expect(legacy).toContain("buildUnsubscribeUrl(supabaseUrl, unsubToken)");
    expect(legacy).toContain("buildColdEmailFooter({ unsubscribeUrl:");
    expect(legacy).toContain("draftBody = draftBody.trimEnd() + footer.footerText");
    // Footer is appended BEFORE the audit draft row and the provider call.
    const footer = legacy.indexOf("buildColdEmailFooter(");
    const draftRow = legacy.indexOf('from("drafts").insert(');
    const provider = legacy.indexOf("functions/v1/gmail-send");
    expect(footer).toBeLessThan(draftRow);
    expect(footer).toBeLessThan(provider);
    // List-Unsubscribe headers travel to gmail-send.
    const gmailCall = legacy.slice(provider, provider + 700);
    expect(gmailCall).toContain("headers: emailFooterHeaders");
    // The old reply-to-unsubscribe footer is gone (would be a second footer).
    expect(src).not.toContain("simply reply with \"unsubscribe\"");
    // Missing secret fails closed.
    expect(legacy).toContain("UNSUBSCRIBE_TOKEN_SECRET unset — cannot add unsubscribe link (fail closed)");
    // Postal address honours the same switch as the review path.
    expect(legacy).toContain("requirePostalAddress()");
  });

  it("SMS sends get neither the email floor nor the email footer", () => {
    const legacy = legacySection();
    expect(legacy).toMatch(/if \(resolvedChannel !== "sms"\) \{[^}]*const unsubToken = await signUnsubscribeToken/);
    expect(legacy).toMatch(/if \(resolvedChannel !== "sms"\) \{\s*\n\s*const legacyFloor = await coldSendFloor/);
  });

  it("the unsubscribe-secret and postal-address refusals run BEFORE the draft lookup and the AI call, email steps only", () => {
    const legacy = legacySection();
    const channelResolved = legacy.indexOf("const resolvedChannel: string = resolvedInstruction?.channel");
    const secretCheck = legacy.indexOf('if (resolvedChannel !== "sms" && !unsubSecret) {');
    const postalCheck = legacy.indexOf('if (resolvedChannel !== "sms" && !postalAddress && requirePostalAddress()) {');
    const draftLookup = legacy.indexOf('from("drafts")');
    const approvedConsumed = legacy.indexOf('from("drafts").update({ status: "sent" })');
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    expect(channelResolved).toBeGreaterThan(-1);
    expect(secretCheck).toBeGreaterThan(channelResolved); // channel known before the checks
    expect(postalCheck).toBeGreaterThan(channelResolved);
    expect(secretCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(approvedConsumed);
    expect(postalCheck).toBeLessThan(aiCall);
    // Each refusal writes the skip row and continues (no send, no claim).
    for (const at of [secretCheck, postalCheck]) {
      const branch = legacy.slice(at, at + 800);
      expect(branch).toContain('from("automation_log").insert(logEntry)');
      expect(branch).toContain("continue;");
    }
    // The resolver itself (loadCampaignForLead) also precedes the draft lookup.
    expect(legacy.indexOf("loadCampaignForLead(lead.id, supabase)")).toBeLessThan(draftLookup);
  });

  it("the EARLY floor runs before the cached approved draft is consumed; the LATE floor restores it on a transient failure", () => {
    const legacy = legacySection();
    const earlyFloor = legacy.indexOf("const earlyFloor = await coldSendFloor(supabase, lead.id, lead.workspace_id)");
    const approvedConsumed = legacy.indexOf('from("drafts").update({ status: "sent" })');
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    expect(earlyFloor).toBeGreaterThan(-1);
    expect(earlyFloor).toBeLessThan(approvedConsumed);
    expect(earlyFloor).toBeLessThan(aiCall);
    expect(earlyFloor).toBeGreaterThan(legacy.indexOf("const resolvedChannel: string")); // email-only gate is meaningful
    const lateFloor = legacy.indexOf("const legacyFloor = await coldSendFloor(supabase, lead.id, lead.workspace_id)");
    expect(lateFloor).toBeGreaterThan(approvedConsumed);
    expect(legacy.slice(lateFloor, lateFloor + 1400)).toContain('from("drafts").update({ status: "approved" }).eq("id", approvedDraft.id)');
  });
});

describe("smsPhoneSelected", () => {
  it("the legacy lead select includes `phone` so lead.phone is populated for the SMS branch", () => {
    const start = src.indexOf("// Find eligible leads (existing automation email flow)");
    const selectLine = src.slice(start).match(/\.select\("([^"]+)"\)/)![1];
    const cols = selectLine.split(",").map((c) => c.trim());
    expect(cols).toContain("phone");
    expect(cols).toContain("email");
    expect(src).toContain("if (!lead.phone)");
  });
});

// ── Codex P1: a due SMS step must be able to send ───────────────────────────
// The channel is now resolved BEFORE the email-only gates. Two rules, and the
// second matters more than the first: every EMAIL-SPECIFIC gate must be
// channel-conditional, and every PERSON-level guardrail must NOT be.
describe("smsChannelGating", () => {
  const legacy = legacySection();
  const channelIdx = legacy.indexOf('const resolvedChannel: string = resolvedInstruction?.channel || "email";');

  it("the channel is resolved before the mailbox lookup and before the email gates", () => {
    expect(channelIdx).toBeGreaterThan(-1);
    expect(channelIdx).toBeLessThan(legacy.indexOf("// ── MIN GAP CHECK"));
    expect(channelIdx).toBeLessThan(legacy.indexOf("// ── PER-LEAD CAPS CHECK"));
    expect(channelIdx).toBeLessThan(legacy.indexOf("// Get connected mail account (Gmail or Outlook)"));
    // Exactly one resolution — two would be two sources of truth for the channel.
    expect([...legacy.matchAll(/const resolvedChannel: string/g)].length).toBe(1);
    expect([...legacy.matchAll(/resolveCampaignInstruction\(campaignInput\)/g)].length).toBe(1);
  });

  it("the whole mailbox-existence / sender-identity block is email-only", () => {
    const open = legacy.indexOf('if (resolvedChannel !== "sms") {', legacy.indexOf("// Get connected mail account"));
    const close = legacy.indexOf("} // end email-only mailbox block");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const block = legacy.slice(open, close);
    // The three email-only refusals that used to strand an SMS step all live inside.
    expect(block).toContain('"No mail connection (Gmail or Outlook)"');
    expect(block).toContain("SENDER MISMATCH");
    expect(block).toContain('from("mail_accounts")');
    // ...and nothing about the person leaked in with them.
    expect(block).not.toContain("isHumanUnsubscribeRequest");
    expect(block).not.toContain("checkStopConditions");
  });

  it("the email min-gap and the per-lead EMAIL caps no longer block an SMS step", () => {
    // The email branch now calls checkEmailMinGap, not checkMinGap: the raw
    // leads.last_outbound_at is cross-channel, so a text was deferring the next
    // email (Codex P2). SMS is still exempt from the email gap entirely.
    expect(legacy).toMatch(/const gapCheck = resolvedChannel === "sms"\s*\n\s*\? \{ allowed: true, anchorAt: null \} as const\s*\n\s*: await checkEmailMinGap\(/);
    expect(legacy).toMatch(/const capCheck = resolvedChannel === "sms"\s*\n\s*\? \{ allowed: true \} as const\s*\n\s*: await checkPerLeadCaps\(/);
  });

  it("the per-OWNER daily volume cap still applies to BOTH channels (not weakened)", () => {
    // max_sends_per_day_per_mailbox counts every automation_log 'sent' row for
    // the owner, SMS included — it is a volume ceiling, not a mailbox-existence
    // check, so removing it for SMS would leave texts with no daily ceiling.
    const cap = legacy.indexOf("const dailyCap = await getDailyCapForOwner(lead.owner_user_id, lead.workspace_id);");
    expect(cap).toBeGreaterThan(-1);
    expect(legacy.slice(cap - 400, cap + 400)).not.toContain('resolvedChannel === "sms"');
  });

  it("every PERSON-level guardrail still runs for SMS, unconditionally", () => {
    // These are about who may be contacted, not how. None may be behind a
    // channel check, and all must precede the provider call.
    const personGuards = [
      "checkStopConditions(execSettings.stop_pause_rules",   // reply / meeting / unsubscribed
      "isHumanUnsubscribeRequest(bodyLower)",                 // opt-out keyword in last inbound
      "Duplicate send guard: email sent/pending within last hour", // GUARD 0 dedup
      "Daily send limit reached (1 per lead per day)",        // GUARD 1
      "Action already sent within 7 days",                    // GUARD 2
      "Consent withdrawn mid-flight",                         // consent race
      "Multi-participant thread",                             // manual-mode handover
    ];
    const send = legacy.indexOf("functions/v1/sms-send");
    expect(send).toBeGreaterThan(-1);
    for (const guard of personGuards) {
      const at = legacy.indexOf(guard);
      expect(at, `missing person-level guard: ${guard}`).toBeGreaterThan(-1);
      expect(at, `${guard} must precede the send`).toBeLessThan(send);
      // No `resolvedChannel === "sms"` opt-out introduced around it.
      expect(legacy.slice(Math.max(0, at - 600), at), `${guard} became channel-conditional`)
        .not.toMatch(/resolvedChannel === "sms"\s*\n?\s*\? \{ allowed: true \}/);
    }
    // The lead-level opt-out filter on the candidate query is untouched.
    expect(src).toContain('.eq("unsubscribed", false)');
  });

  it("the SMS send path is actually reachable: no mailbox needed, phone required", () => {
    const smsBranch = legacy.slice(legacy.indexOf('if (resolvedChannel === "sms") {'));
    const body = smsBranch.slice(0, smsBranch.indexOf("} else if (mailProvider"));
    expect(body).toContain("if (!lead.phone)");
    expect(body).toContain("functions/v1/sms-send");
    expect(body).not.toContain("mailAccountId");
  });

  it("SMS re-reads the opt-out flag one hop before the send, like the email late floor", () => {
    // Now that SMS is reachable, the unsubscribe race the email path closes with
    // coldSendFloor applies to it too. Opt-out is about the person, not the channel.
    const smsBranch = legacy.slice(legacy.indexOf('if (resolvedChannel === "sms") {'));
    const body = smsBranch.slice(0, smsBranch.indexOf("} else if (mailProvider"));
    const guard = body.indexOf('.from("leads").select("unsubscribed").eq("id", lead.id)');
    const send = body.indexOf("functions/v1/sms-send");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(send);
    // FAIL CLOSED (Codex P2): an error, a missing row, or the flag all refuse.
    // `smsOptOut?.unsubscribed` alone let a transient read failure text someone
    // who may have just opted out.
    const branch = body.slice(guard, send);
    expect(branch).toContain("const smsOptOutUnreadable = !!smsOptOutErr || !smsOptOut;");
    expect(branch).toContain("if (smsOptOutUnreadable || smsOptOut.unsubscribed)");
    expect(branch).toContain("continue;");
    // Transient → stays eligible and retries; confirmed opt-out → parked.
    expect(branch).toContain("if (!smsOptOutUnreadable) {");
    expect(branch).toContain('.update({ needs_action: false, eligible_at: null })');
  });
});

describe("coldOooSkip", () => {
  it("the cold lead select includes ooo_until and a future ooo_until defers the touch (logged)", () => {
    const cold = coldSection();
    const leadSelect = cold.match(/from\("leads"\)\s*\.select\("([^"]+)"\)\s*\.eq\("id", touch\.lead_id\)/);
    expect(leadSelect).not.toBeNull();
    expect(leadSelect![1].split(",").map((c) => c.trim())).toContain("ooo_until");
    const ooo = cold.indexOf("if (lead.ooo_until && new Date(lead.ooo_until).getTime() > Date.now())");
    expect(ooo).toBeGreaterThan(-1);
    const branch = cold.slice(ooo, ooo + 400);
    expect(branch).toContain("logColdSkip(");
    expect(branch).toContain("continue;");
    // OOO check runs before any claim / provider call.
    expect(ooo).toBeLessThan(cold.indexOf('status: "claiming"'));
    expect(ooo).toBeLessThan(cold.indexOf("sendColdEmailTouch("));
  });
});

describe("skipLogging", () => {
  it("every `continue` in the cold pass is preceded by logColdSkip or an automation_log write", () => {
    const lines = coldSection().split("\n");
    const loopStart = lines.findIndex((l) => l.includes("for (const touch of (coldDue || []))"));
    expect(loopStart).toBeGreaterThan(-1);
    let branches = 0;
    let logged = 0;
    for (let i = loopStart; i < lines.length; i++) {
      if (!/\bcontinue;/.test(lines[i])) continue;
      branches++;
      const window = lines.slice(Math.max(loopStart, i - 8), i + 1).join("\n");
      const ok = window.includes("logColdSkip(") || window.includes('from("automation_log").update(');
      if (!ok) throw new Error(`Cold skip branch without a ledger write at cold-section line ${i + 1}:\n${lines[i]}`);
      logged++;
    }
    expect(branches).toBeGreaterThanOrEqual(24);
    expect(logged).toBe(branches);
  });

  it("a cold claim failure is only reported as a duplicate when the error code is 23505", () => {
    const cold = coldSection();
    const at = cold.indexOf("if (!coldTouchClaimAcquired(claimErr, claim)) {");
    expect(at).toBeGreaterThan(-1);
    const branch = cold.slice(at, at + 700);
    expect(branch).toContain('(claimErr as any)?.code === "23505"');
    expect(branch).toContain("Another executor run already claimed this touch");
    expect(branch).toContain("`claim failed: ${");
    expect(branch).toContain("continue;");
  });

  it("logColdSkip queues status 'skipped' rows for automation_log (singular) and the flush never throws", () => {
    const cold = coldSection();
    const helper = cold.slice(cold.indexOf("function logColdSkip("), cold.indexOf("for (const touch of (coldDue || []))"));
    expect(helper).toContain('status: "skipped"');
    expect(helper).not.toContain("automation_logs");
    const flush = cold.slice(cold.indexOf("async function flushColdSkips("), cold.indexOf("function logColdSkip("));
    expect(flush).toContain('from("automation_log").insert(rows)');
    expect(flush).toContain("try {");
    expect(flush).toContain("catch (logErr)");
    // Owner must come from the touch→lead join, since automation_log.owner_user_id is NOT NULL.
    expect(cold).toContain("leads!inner(owner_user_id)");
  });

  it("the volume tripwire default is REACHABLE given the run cap and the cron schedule (Codex P2)", () => {
    // The alarm fires on `count > threshold`. The most one mailbox can receive
    // in a trailing window is MAX_SENDS_PER_RUN x (batches the window straddles).
    // A threshold at or above that ceiling can never sound — which is what the
    // old hardcoded 15 was (ceiling 2 x 5 = 10).
    const interval = Number(src.match(/const EXECUTOR_CRON_INTERVAL_MIN = (\d+);/)![1]);
    const windowMin = Number(src.match(/const VOLUME_ALERT_WINDOW_MIN = (\d+);/)![1]);
    const cap = Number(src.match(/const maxSendsPerRun = maxSendsEnv \? parseInt\(maxSendsEnv, 10\) : (\d+);/)![1]);
    const batches = Math.floor(windowMin / interval) + 1;
    const ceiling = cap * batches;

    // Mirror of volumeAlertDefaultThreshold in the executor.
    const threshold = Math.max(1, Math.min(Math.max(1, cap), ceiling - 1));
    expect(threshold).toBeLessThan(ceiling);     // the alarm can sound
    expect(ceiling - threshold).toBeGreaterThan(0);
    // Defaults today: interval 15, window 15, cap 5 -> ceiling 10, threshold 5,
    // so 6 sends to one mailbox in 15 minutes trips it.
    expect({ interval, windowMin, cap, batches, ceiling, threshold })
      .toEqual({ interval: 15, windowMin: 15, cap: 5, batches: 2, ceiling: 10, threshold: 5 });

    // Still reachable for any cap the operator might set.
    for (const c of [1, 2, 3, 5, 10, 25, 40]) {
      const ceil = c * batches;
      const t = Math.max(1, Math.min(Math.max(1, c), ceil - 1));
      expect(t, `cap ${c}`).toBeLessThan(ceil);
    }

    // The derivation is wired in — no hardcoded default survives.
    expect(src).toContain("parsedThreshold > 0 ? parsedThreshold : volumeAlertDefaultThreshold(maxSendsPerRun)");
    expect(src).not.toContain("VOLUME_ALERT_DEFAULT_THRESHOLD");
    // Window is a single constant, not three copies of 15.
    expect(src).toContain("Date.now() - VOLUME_ALERT_WINDOW_MIN * 60 * 1000");
    expect(src).not.toContain("window_minutes: 15");
  });

  it("EXECUTOR_CRON_INTERVAL_MIN matches the codified production cron schedule", () => {
    const interval = Number(src.match(/const EXECUTOR_CRON_INTERVAL_MIN = (\d+);/)![1]);
    // CLAUDE.md: the most recent non-staging *_codify_cron_jobs.sql mirrors prod.
    const codified = readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith("_codify_cron_jobs.sql")).sort().pop();
    expect(codified, "no codified cron migration found").toBeDefined();
    const cronSql = readFileSync(path.join(ROOT, "supabase/migrations", codified!), "utf8");
    const job = cronSql.slice(cronSql.indexOf("'dispatch-automation-executor',", cronSql.indexOf("SELECT cron.schedule(")));
    const sched = job.match(/'(\*\/(\d+) [^']*)'/);
    expect(sched, "dispatch-automation-executor schedule not found").not.toBeNull();
    expect(Number(sched![2])).toBe(interval);
  });
});

// ── Codex P2 #2: the skip ledger must not starve the run ────────────────────
// cron-dispatcher aborts the forwarded request at FORWARD_TIMEOUT_MS (55s).
// Production logs ~8,200 cold skips per 14 days, so "most of the 200 scanned
// touches are blocked" is the normal case. A per-skip SELECT+INSERT (≈400 serial
// round trips) could therefore burn the whole run before the loop reached a
// touch that would actually have sent. These guards pin the batched shape.
describe("skipLedgerOffTheScanPath", () => {
  const DISPATCHER = readFileSync(path.join(ROOT, "supabase/functions/cron-dispatcher/index.ts"), "utf8");

  it("cron-dispatcher still aborts at 55s — the budget these guards protect", () => {
    const m = DISPATCHER.match(/const FORWARD_TIMEOUT_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThanOrEqual(55_000);
  });

  it("logColdSkip is synchronous: no await, no query builder, no network on the scan path", () => {
    const cold = coldSection();
    const start = cold.indexOf("function logColdSkip(");
    expect(start).toBeGreaterThan(-1);
    // Not `async function logColdSkip(`.
    expect(cold.slice(Math.max(0, start - 6), start)).not.toContain("async ");
    const helper = cold.slice(start, cold.indexOf("for (const touch of (coldDue || []))"));
    expect(helper).toContain("): void {");
    expect(helper).not.toMatch(/\bawait\b/);
    expect(helper).not.toContain("supabase.from(");
    // It only touches the in-memory dedupe set and the pending queue.
    expect(helper).toContain("coldSkipSeen.has(key)");
    expect(helper).toContain("coldSkipPending.push(");
  });

  it("not one skip call site is awaited (an awaited ledger write is the starvation bug)", () => {
    expect(src).not.toMatch(/await\s+logColdSkip\(/);
    // The ledger still covers every branch it used to.
    const calls = [...coldSection().matchAll(/\blogColdSkip\(/g)].length;
    expect(calls).toBeGreaterThanOrEqual(24);
  });

  it("the 6h dedupe set is prefetched ONCE for the batch, in chunks, before the loop", () => {
    const cold = coldSection();
    const prefetch = cold.indexOf('.in("action_key", allKeys.slice(i, i + COLD_SKIP_PREFETCH_CHUNK))');
    const loop = cold.indexOf("for (const touch of (coldDue || []))");
    expect(prefetch).toBeGreaterThan(-1);
    expect(prefetch).toBeLessThan(loop);
    const window = cold.slice(prefetch - 400, prefetch + 400);
    expect(window).toContain('.eq("status", "skipped")');
    expect(window).toContain('.gte("created_at", skipSince)');
    // Chunked so a 200-row scan can't blow the PostgREST URL length.
    const chunk = cold.match(/const COLD_SKIP_PREFETCH_CHUNK = (\d+);/);
    expect(chunk).not.toBeNull();
    expect(Number(chunk![1])).toBeGreaterThan(0);
    expect(Number(chunk![1])).toBeLessThanOrEqual(100);
  });

  it("rows are flushed in batches inside the loop AND once after it", () => {
    const cold = coldSection();
    const threshold = cold.match(/const COLD_SKIP_FLUSH_AT = (\d+);/);
    expect(threshold).not.toBeNull();
    const flushAt = Number(threshold![1]);
    expect(flushAt).toBeGreaterThan(1);   // 1 would be a per-skip insert again
    expect(flushAt).toBeLessThanOrEqual(50);
    const loop = cold.indexOf("for (const touch of (coldDue || []))");
    const inLoop = cold.indexOf("if (coldSkipPending.length >= COLD_SKIP_FLUSH_AT) await flushColdSkips();");
    expect(inLoop).toBeGreaterThan(loop);
    // Final flush lives after the loop body's catch, before the tripwire.
    const finalFlush = cold.lastIndexOf("await flushColdSkips();");
    expect(finalFlush).toBeGreaterThan(inLoop);
  });

  it("worst case for a 200-touch all-blocked scan is a dozen round trips, not hundreds", () => {
    const cold = coldSection();
    const scan = Number(src.match(/const COLD_DUE_SCAN_LIMIT = (\d+);/)![1]);
    const chunk = Number(cold.match(/const COLD_SKIP_PREFETCH_CHUNK = (\d+);/)![1]);
    const flushAt = Number(cold.match(/const COLD_SKIP_FLUSH_AT = (\d+);/)![1]);
    const roundTrips = Math.ceil(scan / chunk) + Math.ceil(scan / flushAt);
    expect(roundTrips).toBeLessThanOrEqual(20);
    // The old shape was one SELECT + one INSERT per skip.
    expect(roundTrips).toBeLessThan(scan * 2);
  });
});

// ── Codex P2 #1: the send-window timezone must follow the LEAD's workspace ──
// Before this, loadExecutionSettings read the timezone from an arbitrary
// workspace_members row, so an owner in two workspaces had "9–5" evaluated in
// whichever timezone came back first — a send could land at 5am for the
// recipient. The workspace id is now a required argument and part of the cache
// key, and every caller in supabase/functions must pass one.
describe("executionSettingsWorkspaceScope", () => {
  it("loadExecutionSettings takes a required workspaceId and keys its cache by it", () => {
    expect(settingsSrc).toMatch(/export async function loadExecutionSettings\(\s*ownerUserId: string,\s*serviceClient: ReturnType<typeof createClient>,\s*workspaceId: string,\s*\)/);
    expect(settingsSrc).toContain("const cacheKey = `${ownerUserId}");
    expect(settingsSrc).toContain("workspaceId ?? \"\"");
    expect(settingsSrc).toContain("cache.set(cacheKey, settings)");
  });

  it("the timezone is read from THIS workspace by id — the arbitrary workspace_members pick is gone", () => {
    // Comments are stripped: the doc block legitimately *describes* the old
    // workspace_members pick while the code must no longer do it.
    const code = settingsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    expect(code).toContain('.from("workspaces")');
    expect(code).toContain('.eq("id", workspaceId)');
    expect(code).not.toContain("workspace_members");
    expect(code).not.toContain("workspaces:workspace_id");
    // An unknown / empty workspace id yields no timezone → checkSendWindow
    // fails closed rather than guessing one.
    expect(settingsSrc).toContain("Promise.resolve({ data: null })");
    expect(settingsSrc).toContain('reason: "Workspace timezone not configured');
  });

  it("every caller under supabase/functions passes three arguments", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(path.join(ROOT, dir))) {
        const rel = path.posix.join(dir, name);
        if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
        else if (name.endsWith(".ts")) out.push(rel);
      }
      return out;
    };
    /** Top-level arguments of the call starting at `open` (a "(" index). */
    const topLevelArgs = (text: string, open: number): string[] => {
      let depth = 0;
      const args: string[] = [];
      let cur = "";
      for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === "(" || ch === "[" || ch === "{") { depth++; if (depth === 1) continue; }
        else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) { args.push(cur); return args; } }
        else if (ch === "," && depth === 1) { args.push(cur); cur = ""; continue; }
        cur += ch;
      }
      return args;
    };
    const calls: string[] = [];
    for (const rel of walk("supabase/functions")) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      for (const m of text.matchAll(/loadExecutionSettings\(/g)) {
        const args = topLevelArgs(text, m.index! + "loadExecutionSettings".length)
          .map((a) => a.trim()).filter((a) => a.length > 0);
        // Skip the declaration itself (its params carry type annotations).
        if (args.some((a) => /: (string|ReturnType)/.test(a))) continue;
        calls.push(`${rel}: ${args.join(" | ")}`);
        expect(args.length, `${rel} → loadExecutionSettings(${args.join(", ")})`).toBe(3);
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Codex round 3: safety code must fail CLOSED, and no blocked category may
// monopolise the 20-row candidate page ──────────────────────────────────────
describe("failClosedAndStarvation", () => {
  const legacy = legacySection();

  it("P1: paused owners are dropped from the candidate scan BEFORE the row limit", () => {
    const lookup = src.indexOf('.from("workspace_profiles")');
    const filter = src.indexOf('query.not("owner_user_id", "in", `(${pausedOwnerIds.join(",")})`)');
    const exec = src.indexOf("const { data: eligibleLeads, error: queryErr } = await query;");
    expect(lookup).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(lookup);
    // The filter must be attached to the builder before it is awaited — that is
    // what makes it apply before .limit(20) rather than after the page is cut.
    expect(filter).toBeLessThan(exec);
    // Same predicate as the loader: a literal boolean true, never the string.
    const block = src.slice(lookup - 200, filter);
    expect(block).toContain("cadence_settings as any)?.automation_paused === true");
  });

  it("P1: if the exclusion can't be built, the in-loop pause defers so the page still drains", () => {
    const pause = legacy.indexOf("if (execSettings.owner_automation_paused)");
    const branch = legacy.slice(pause, pause + 1800);
    expect(branch).toContain("if (!pausedOwnerFilterApplied)");
    expect(branch).toContain("EXECUTOR_CRON_INTERVAL_MIN * 60 * 1000");
    // And when the exclusion IS applied, the lead is untouched so un-pausing
    // resumes on the next tick (the behaviour the docs promise).
    expect(branch).toContain("un-pausing resumes instantly");
  });

  it("P1 defeat-resistance: the other refusals that need a human also defer instead of holding the page", () => {
    // Each of these clears only when someone changes a setting, so a bare
    // `continue` recreated the paused-owner starvation with a different cause.
    const sixHours = "new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()";
    for (const marker of [
      "WA auto-send blocked for lead",                       // WhatsApp not enabled / not opted in
      '"No mail connection (Gmail or Outlook)"',             // owner has no mailbox at all
      "Sender mismatch: no mail_accounts configured",        // no mail_accounts row
    ]) {
      const at = legacy.indexOf(marker);
      expect(at, `missing branch: ${marker}`).toBeGreaterThan(-1);
      const after = legacy.slice(at, at + 900);
      expect(after, `${marker} must defer, not just continue`).toContain(sixHours);
      expect(after).toContain("continue;");
    }
  });

  it("P2: the pause fails CLOSED on a profile read error, and a missing row still means 'not paused'", () => {
    expect(settingsSrc).toContain("const profileReadFailed = !!(profileRes as any).error;");
    expect(settingsSrc).toContain("owner_automation_paused: profileReadFailed || raw.automation_paused === true");
    expect(settingsSrc).toContain("settings_read_failed: profileReadFailed");
    // A failed read must not be cached, or one blip pauses the whole run.
    expect(settingsSrc).toContain("if (!profileReadFailed) cache.set(cacheKey, settings);");
    // maybeSingle() gives data=null with no error for "no row" — that path must
    // NOT set profileReadFailed, so a brand-new owner is not silently paused.
    expect(settingsSrc).toMatch(/maybeSingle\(\)/);
    expect(settingsSrc).not.toContain("!profileRes.data");
    // Both cold and legacy tell the rep which of the two happened.
    const reasons = [...src.matchAll(/"Could not read this account's automation settings[^"]*"/g)];
    expect(reasons.length).toBe(2);
  });

  it("P2: the email min-gap is anchored on the last EMAIL, not on any outbound", () => {
    // leads.last_outbound_at is stamped by sms-send too, so an SMS was deferring
    // the next email under a setting named min_gap_hours_between_emails.
    expect(settingsSrc).toContain("export async function checkEmailMinGap(");
    const fn = settingsSrc.slice(settingsSrc.indexOf("export async function checkEmailMinGap("));
    expect(fn).toContain('.eq("event_type", "email_outbound")');
    // Cheap path: if the cross-channel check already allows, no query at all.
    expect(fn).toContain("if (crossChannel.allowed) return { ...crossChannel, anchorAt: lastOutboundAt };");
    // Fail closed: a failed lookup keeps the conservative (blocked) answer.
    expect(fn).toMatch(/if \(error\) \{[\s\S]{0,400}return \{ \.\.\.crossChannel, anchorAt: lastOutboundAt \};/);
    // BOTH senders use it — the cold pass reads the same cross-channel field.
    expect([...src.matchAll(/checkEmailMinGap\(/g)].length).toBe(2);
    expect(src).not.toMatch(/[^l]checkMinGap\(/); // no raw cross-channel gap left in the executor
    // The deferral is anchored on the blocking email, not on last_outbound_at.
    expect(legacy).toContain("const gapAnchor = gapCheck.anchorAt ?? freshLead.last_outbound_at!;");
  });
});
