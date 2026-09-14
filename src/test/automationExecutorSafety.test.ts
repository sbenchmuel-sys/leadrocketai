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
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    expect(channelResolved).toBeGreaterThan(-1);
    expect(secretCheck).toBeGreaterThan(channelResolved); // channel known before the checks
    expect(postalCheck).toBeGreaterThan(channelResolved);
    expect(secretCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(aiCall);
    // The old "...before the approved draft is consumed" clause is gone: the
    // draft is no longer consumed before the send at all (Codex P2). That
    // ordering is now asserted globally by draftConsumedOnlyAfterProviderSuccess.
    // Each refusal writes the skip row and continues (no send, no claim).
    // Window widened 800 -> 1400: both branches now also defer the lead (Codex
    // P1), which sits between the ledger insert and the `continue`.
    for (const at of [secretCheck, postalCheck]) {
      const branch = legacy.slice(at, at + 1400);
      expect(branch).toContain('from("automation_log").insert(logEntry)');
      expect(branch).toContain("continue;");
      // The rep still gets a findable explanation AND the row stops holding the page.
      expect(branch).toContain("blockedRowRetryAt()");
    }
    // The resolver itself (loadCampaignForLead) also precedes the draft lookup.
    expect(legacy.indexOf("loadCampaignForLead(lead.id, supabase)")).toBeLessThan(draftLookup);
  });

  it("the EARLY floor still runs before the draft lookup and the AI call", () => {
    // This used to also assert the LATE floor RESTORED a consumed approved draft.
    // That restore is deliberately gone — the draft is not consumed before the
    // send, so there is nothing to restore (Codex P2).
    const legacy = legacySection();
    const earlyFloor = legacy.indexOf("const earlyFloor = await coldSendFloor(supabase, lead.id, lead.workspace_id)");
    const draftLookup = legacy.indexOf('from("drafts")');
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    expect(earlyFloor).toBeGreaterThan(-1);
    expect(earlyFloor).toBeLessThan(draftLookup);
    expect(earlyFloor).toBeLessThan(aiCall);
    expect(earlyFloor).toBeGreaterThan(legacy.indexOf("const resolvedChannel: string")); // email-only gate is meaningful
    const lateFloor = legacy.indexOf("const legacyFloor = await coldSendFloor(supabase, lead.id, lead.workspace_id)");
    expect(lateFloor).toBeGreaterThan(-1);
  });
});

describe("smsPhoneSelected", () => {
  it("the legacy lead select includes `phone` so lead.phone is populated for the SMS branch", () => {
    const start = src.indexOf("// Find eligible leads (existing automation email flow)");
    const selectLine = src.slice(start).match(/\.select\("([^"]+)"\)/)![1];
    const cols = selectLine.split(",").map((c) => c.trim());
    expect(cols).toContain("phone");
    expect(cols).toContain("email");
    // Was `if (!lead.phone)` inside the SMS send branch. The precondition moved
    // ~400 lines earlier and is now channel-scoped (Codex P1) — see
    // smsPreconditionRunsBeforeAnySpending below.
    expect(src).toContain('if (resolvedChannel === "sms" && !lead.phone)');
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
    // Scope the check to the cap's OWN branch, not a byte window that can drift
    // into the neighbouring (legitimately channel-conditional) min-gap check.
    const capBranch = legacy.slice(cap, legacy.indexOf("// ── MIN GAP CHECK", cap));
    expect(capBranch).toContain("if (dailyCount >= dailyCap)");
    expect(capBranch).not.toContain('resolvedChannel === "sms"');
    expect(capBranch).not.toContain('resolvedChannel !== "sms"');
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

  it("the SMS send path is actually reachable: no mailbox needed", () => {
    const smsBranch = legacy.slice(legacy.indexOf('if (resolvedChannel === "sms") {'));
    const body = smsBranch.slice(0, smsBranch.indexOf("} else if (mailProvider"));
    // The phone precondition no longer lives here — it runs before anything is
    // spent (Codex P1). What must remain true is that the send path needs no
    // mailbox.
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
      // Lookback widened 8 -> 20 lines: the pause branch now also carries the
      // fallback deferral between its logColdSkip call and its `continue`, so a
      // short window reported a false negative on a branch that DOES log. The
      // guard's job is unchanged — a genuinely silent `continue` has no ledger
      // call anywhere near it — and the branches/logged equality below is what
      // actually pins "no cold skip path is silent".
      const window = lines.slice(Math.max(loopStart, i - 20), i + 1).join("\n");
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
    const cap = Number(src.match(/const MAX_SENDS_PER_RUN_DEFAULT = (\d+);/)![1]);
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

  it("WRAPPERS around the loader are audited too — a caller must not be able to omit the workspace", () => {
    // The direct-call audit above missed campaign-touch-scheduler's `getExec`
    // wrapper, so a #136 call site passed only the owner id and silently got
    // timezone:null. Nothing type-checks supabase/functions (tsconfig.app.json
    // includes only `src`, and `deno test` only checks modules a test imports),
    // so a required parameter is NOT enforced by the toolchain here — this audit
    // is the enforcement. Wrappers are found by their return type, so a new one
    // is picked up without editing this test.
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(path.join(ROOT, dir))) {
        const rel = path.posix.join(dir, name);
        if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
        else if (name.endsWith(".ts")) out.push(rel);
      }
      return out;
    };
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

    let wrappersFound = 0;
    let wrapperCalls = 0;
    for (const rel of walk("supabase/functions")) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      if (!text.includes("loadExecutionSettings(")) continue;
      // Any local helper that RETURNS ExecutionSettings is a wrapper for it.
      const names = new Set<string>();
      for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*async\s*\([^)]*\)\s*:\s*Promise<ExecutionSettings>/g)) names.add(m[1]);
      for (const m of text.matchAll(/async\s+function\s+(\w+)\s*\([^)]*\)\s*:\s*Promise<ExecutionSettings>/g)) names.add(m[1]);
      names.delete("loadExecutionSettings"); // the loader itself, audited above
      for (const name of names) {
        wrappersFound++;
        // The wrapper itself must require a workspace id.
        const declAt = text.search(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*async\\s*\\(|async\\s+function\\s+${name}\\s*\\(`));
        const declArgs = topLevelArgs(text, text.indexOf("(", declAt)).map((a) => a.trim());
        expect(declArgs.length, `${rel}: wrapper ${name} must take (ownerId, workspaceId)`).toBe(2);
        expect(declArgs[1], `${rel}: wrapper ${name}'s 2nd param must be the workspace id`).toMatch(/workspaceId/);
        // ...and every call must supply it.
        for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
          const at = m.index! + name.length;
          if (at === text.indexOf("(", declAt)) continue; // the declaration
          const args = topLevelArgs(text, at).map((a) => a.trim()).filter(Boolean);
          if (args.some((a) => /: (string|ReturnType)/.test(a))) continue; // declaration form
          wrapperCalls++;
          expect(args.length, `${rel} → ${name}(${args.join(", ")}) omits the workspace id`).toBe(2);
        }
      }
    }
    expect(wrappersFound, "guard went vacuous — no wrappers discovered").toBeGreaterThanOrEqual(1);
    expect(wrapperCalls, "guard went vacuous — no wrapper call sites discovered").toBeGreaterThanOrEqual(3);
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
    // Window widened to cover the documented two-case deferral condition.
    const branch = legacy.slice(pause, pause + 2600);
    // Was `if (!pausedOwnerFilterApplied)` alone. An owner paused because their
    // per-owner settings read FAILED was never in pausedOwnerIds, so a SUCCESSFUL
    // prefilter was exactly what stopped those rows being deferred (Codex P2).
    expect(branch).toContain("if (!pausedOwnerFilterApplied || execSettings.settings_read_failed)");
    // Was EXECUTOR_CRON_INTERVAL_MIN — deferring by exactly one tick put the row
    // straight back in the next scan, so the paused set rotated through the page
    // forever (Codex P1). The deferral must be materially longer than one tick.
    // Constant renamed PAUSED_FALLBACK_DEFER_MIN -> BLOCKED_ROW_DEFER_MIN: it is
    // now used by EVERY refusal that needs time or a human, not just the paused
    // fallback, so the name had to stop describing one caller.
    expect(branch).toContain("BLOCKED_ROW_DEFER_MIN * 60 * 1000");
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
    // An ABSENT mirror row is not evidence (Codex P2). lead_timeline_items is a
    // projection and a missing row is a supported failure mode, so "never
    // emailed" and "the mirror lost the row" look identical there. Only the
    // first may send. The authoritative record separates them — and is consulted
    // ONLY when the projection came back empty.
    const authAt = fn.indexOf('.from("interactions")');
    const mirrorShortCircuit = fn.indexOf("if (mirroredAt) return");
    expect(authAt).toBeGreaterThan(-1);
    expect(mirrorShortCircuit).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(mirrorShortCircuit);
    const authBlock = fn.slice(authAt, authAt + 500);
    // The predicate must NOT depend on `direction` for the modern spelling.
    // gmail-send inserts { type: "email_outbound" } with NO direction key, and
    // `direction` is bare nullable text (no default, no backfill) — so under SQL
    // three-valued logic `direction = 'outbound'` matched none of Gmail's rows
    // and this lookup silently answered "never emailed".
    expect(authBlock).toContain('.or("type.eq.email_outbound,and(type.eq.email,direction.eq.outbound)")');
    expect(authBlock, "a bare direction filter would exclude every gmail-send row")
      .not.toContain('.eq("direction"');
    // `email_outbound` alone must be sufficient — assert it is not ANDed with
    // anything about direction.
    expect(authBlock).not.toMatch(/and\(type\.eq\.email_outbound/);

    // The writers this predicate is derived from must still write what it expects.
    const gmailSend = readFileSync(path.join(ROOT, "supabase/functions/gmail-send/index.ts"), "utf8");
    const outlookSend = readFileSync(path.join(ROOT, "supabase/functions/outlook-send/index.ts"), "utf8");
    for (const [name, writer] of Object.entries({ gmailSend, outlookSend })) {
      const insertAt = writer.indexOf('from("interactions")\n            .insert({');
      const at = insertAt > -1 ? insertAt : writer.indexOf('from("interactions")');
      expect(at, `${name}: interactions insert not found`).toBeGreaterThan(-1);
      expect(writer.slice(at, at + 900), `${name} must still write type: "email_outbound"`)
        .toContain('type: "email_outbound"');
    }
    // Read-only: CLAUDE.md forbids reintroducing WRITES to the legacy table.
    expect(fn).not.toMatch(/from\("interactions"\)[\s\S]{0,200}\.(insert|update|upsert|delete)\(/);
    // The authoritative read fails closed too.
    expect(fn).toMatch(/if \(authError\) \{[\s\S]{0,400}return \{ \.\.\.crossChannel, anchorAt: lastOutboundAt \};/);
    // ...and the old conflation is gone.
    expect(fn).not.toContain("No email has ever gone out (or none on record)");

    // BOTH senders use it — the cold pass reads the same cross-channel field.
    expect([...src.matchAll(/checkEmailMinGap\(/g)].length).toBe(2);
    expect(src).not.toMatch(/[^l]checkMinGap\(/); // no raw cross-channel gap left in the executor
    // The deferral is anchored on the blocking email, not on last_outbound_at.
    expect(legacy).toContain("const gapAnchor = gapCheck.anchorAt ?? freshLead.last_outbound_at!;");
  });
});

// ── Codex round 4: the starvation shape, swept ──────────────────────────────
// Three capped scans in this function have a skip path that can leave rows in
// place. Each must be unable to monopolise its own page. (The other two capped
// scans — stale-claim recovery and OOO-return surfacing — mutate every row they
// fetch, so they always drain; nothing to pin there.)
describe("cappedScanStarvationSweep", () => {
  const legacy = legacySection();
  const cold = coldSection();

  it("cold scan: paused owners are excluded BEFORE the 200-row limit", () => {
    const filter = cold.indexOf('coldDueQuery.not("leads.owner_user_id", "in", `(${pausedOwnerIds.join(",")})`)');
    const limit = cold.indexOf("await coldDueQuery.limit(COLD_DUE_SCAN_LIMIT)");
    expect(filter).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(filter);
    // Same exclusion list the legacy query uses — one source of truth, built
    // once near the top of the run and reused by both scans.
    const lookupAt = src.indexOf('.from("workspace_profiles")');
    const coldFilterAt = src.indexOf('coldDueQuery.not("leads.owner_user_id"');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(lookupAt).toBeLessThan(coldFilterAt);
    expect([...src.matchAll(/pausedOwnerIds\.push\(/g)].length).toBe(1);
  });

  it("cold scan: if the exclusion can't be built, the paused branch defers the touch", () => {
    const pause = cold.indexOf("if (exec.owner_automation_paused)");
    const branch = cold.slice(pause, pause + 1400);
    expect(branch).toContain("if (!pausedOwnerFilterApplied || exec.settings_read_failed)");
    expect(branch).toContain('from("campaign_touch")');
    expect(branch).toContain("BLOCKED_ROW_DEFER_MIN * 60 * 1000");
  });

  it("WhatsApp no-reply scan: the lookback is bounded so answered threads age out", () => {
    // The loop skips `lastOut >= lastIn` without touching the row, and such a
    // row matches every other filter forever.
    expect(src).toContain("const WA_NO_REPLY_LOOKBACK_DAYS = 7;");
    expect(src).toContain('.gte("last_inbound_at", waLookbackStart)');
    const q = src.indexOf("let waCheckQuery = supabase");
    const bound = src.indexOf('.gte("last_inbound_at", waLookbackStart)', q);
    const limit = src.indexOf(".limit(30)", q);
    expect(bound).toBeGreaterThan(q);
    expect(bound).toBeLessThan(limit);
    // The un-modified skip is still there — this test is about the bound, not
    // about removing the skip.
    expect(src).toContain("if (lastOut >= lastIn) continue;");
  });

  it("legacy scan: the daily cap defers and explains itself instead of holding the page", () => {
    const cap = legacy.indexOf("if (dailyCount >= dailyCap)");
    expect(cap).toBeGreaterThan(-1);
    const branch = legacy.slice(cap, cap + 900);
    // Was `tomorrow.toISOString()` (tomorrow 09:30 local). The per-owner counter
    // resets at UTC midnight, so "tomorrow 09:30" woke the lead ~9.5h AFTER the
    // reset (Codex P2). It now wakes at the reset instant itself.
    expect(branch).toContain('from("leads").update({ eligible_at: capResetAt.toISOString() })');
    expect(branch).toContain('from("automation_log").insert(logEntry)');
    expect(branch).toContain("Daily send cap reached for this account");
  });

  it("the daily cap is evaluated with the channel known (Codex P2)", () => {
    const channel = legacy.indexOf('const resolvedChannel: string = resolvedInstruction?.channel || "email";');
    const cap = legacy.indexOf("const dailyCap = await getDailyCapForOwner(");
    expect(channel).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(channel);
    // ...and there is only ONE such check in the legacy loop.
    expect([...legacy.matchAll(/const dailyCap = await getDailyCapForOwner\(/g)].length).toBe(1);
  });
});

// ── Codex round 5 ───────────────────────────────────────────────────────────
describe("degradedPathCannotRotate", () => {
  const legacy = legacySection();

  it("the fallback deferral is many cron intervals, not one — with the margin computed", () => {
    const tick = Number(src.match(/const EXECUTOR_CRON_INTERVAL_MIN = (\d+);/)![1]);
    const deferExpr = src.match(/const BLOCKED_ROW_DEFER_MIN = ([^;]+);/)![1].trim();
    // Parse the literal product rather than eval'ing source text.
    const defer = deferExpr.split("*").reduce((acc, part) => {
      const n = Number(part.trim());
      expect(Number.isFinite(n), `BLOCKED_ROW_DEFER_MIN must stay a literal number or product, got "${deferExpr}"`).toBe(true);
      return acc * n;
    }, 1);

    const ticks = defer / tick;
    expect(ticks).toBeGreaterThan(1);          // one tick was the bug
    expect(ticks).toBeGreaterThanOrEqual(24);  // today: 6h / 15min

    // Sustained starvation needs P >= L x (D / T) paused rows simultaneously due.
    const legacyLimit = 20;
    const coldLimit = Number(src.match(/const COLD_DUE_SCAN_LIMIT = (\d+);/)![1]);
    expect(legacyLimit * ticks).toBeGreaterThanOrEqual(480);
    expect(coldLimit * ticks).toBeGreaterThanOrEqual(4800);
    // The legacy page size the arithmetic assumes is the real one.
    const scan = src.slice(src.indexOf("// Find eligible leads (existing automation email flow)"));
    expect(scan.slice(0, scan.indexOf("const { data: eligibleLeads"))).toContain(`.limit(${legacyLimit})`);

    // The arithmetic lives next to the constant so it can't rot silently.
    expect(src).toContain("P >= L x (D / T)");
    expect(src).toContain("P >= 480 legacy /  P >= 4,800 cold");
  });

  it("every time/config deferral uses the same constant — no second magic number", () => {
    // Was 2 (the two paused fallbacks); the constant is now shared by every
    // refusal that needs time or a human, via blockedRowRetryAt().
    expect([...src.matchAll(/BLOCKED_ROW_DEFER_MIN \* 60 \* 1000/g)].length).toBeGreaterThanOrEqual(2);
    expect([...src.matchAll(/blockedRowRetryAt\(\)/g)].length).toBeGreaterThanOrEqual(5);
    // The old one-interval deferral is gone from both.
    expect(src).not.toContain("EXECUTOR_CRON_INTERVAL_MIN * 60 * 1000");
  });
});

describe("draftConsumedOnlyAfterProviderSuccess", () => {
  const legacy = legacySection();

  it("a reused draft is marked sent in exactly ONE place, after the provider confirms", () => {
    // Replaces smsApprovedDraftSurvivesRetry (Codex P2, structural). The draft
    // used to be consumed at the reuse site BEFORE the send, so every refusal or
    // retryable failure in between destroyed rep-approved copy, and each path
    // needed its own restore. Three paths needed one; the likeliest — an ordinary
    // retryable Twilio error — never got it.
    const consumes = [...legacy.matchAll(/\.update\(\{ status: "sent" \}\)\.eq\("id", cachedDraft\.id\)/g)];
    expect(consumes.length, "exactly one consumption site").toBe(1);
    const consumeAt = consumes[0].index!;
    for (const call of ["functions/v1/sms-send", "functions/v1/outlook-send", "functions/v1/gmail-send"]) {
      const at = legacy.indexOf(call);
      expect(at, `${call} not found`).toBeGreaterThan(-1);
      expect(consumeAt, `consumption must follow ${call}`).toBeGreaterThan(at);
    }
    // Past the point of no return: after the response is parsed AND after the
    // !sendResult.ok bail-out.
    expect(consumeAt).toBeGreaterThan(legacy.indexOf("const sendResult = await sendResponse.json()"));
    expect(consumeAt).toBeGreaterThan(legacy.indexOf("if (!sendResult.ok)"));
  });

  it("nothing consumes a draft before the send, so no refusal path can destroy copy", () => {
    const firstProvider = Math.min(
      ...["functions/v1/sms-send", "functions/v1/outlook-send", "functions/v1/gmail-send"]
        .map((c) => legacy.indexOf(c)).filter((i) => i > -1));
    // The audit-trail drafts.insert is fine — it creates a row, consumes nothing.
    expect(legacy.slice(0, firstProvider)).not.toMatch(/\.update\(\{ status: "sent" \}\)/);
  });

  it("the restore calls are gone — there is nothing left to restore", () => {
    // This is what makes a missed restore impossible rather than rare: a fourth
    // refusal path added later inherits the correct behaviour for free.
    expect(legacy).not.toMatch(/\.update\(\{ status: "approved" \}\)/);
    expect(legacy).toContain("No draft restore needed");
  });

  it("consume-after-success cannot double-send: the claim precedes the provider call", () => {
    const claim = legacy.indexOf('logEntry.status = "claiming"');
    const firstProvider = Math.min(
      ...["functions/v1/sms-send", "functions/v1/outlook-send", "functions/v1/gmail-send"]
        .map((c) => legacy.indexOf(c)).filter((i) => i > -1));
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(firstProvider);
    // And the per-lead dedup guards still stand behind it.
    expect(legacy).toContain("Duplicate send guard: email sent/pending within last hour");
    expect(legacy).toContain("Daily send limit reached (1 per lead per day)");
    expect(legacy).toContain("Action already sent within 7 days");
  });
});

// ── STRUCTURAL GUARD: a refusal must MOVE the row, or justify not moving it ──
//
// This class of bug has now been found six times in this file — the legacy scan,
// the cold scan, the WhatsApp check, the degraded paused fallback, the CAN-SPAM
// preconditions and the cold caps. Every instance is the same sentence: a branch
// refuses a row and `continue`s WITHOUT changing anything the capped scan filters
// on, so the same rows refill the page every tick and everything behind them
// starves — silently, with the run still reporting success.
//
// Fixing instances has not ended the class, so this test ends it: every
// `continue` / `break` in either send loop must either move the row out of its
// scan, or appear below with a written reason why leaving it is safe. A new
// refusal branch that does neither fails CI. The allow-list is the audit — it is
// meant to be read, and to be argued with.
type Exempt = { match: string; why: string };

/** Branches that deliberately leave the row in place. Each needs a reason. */
const LEAVE_IN_PLACE_LEGACY: Exempt[] = [
  { match: "if (processed >= maxSendsPerRun)",
    why: "control flow, not a refusal — the per-run send cap ends the loop; it refuses nobody and moves nothing" },
  { match: "Could not re-fetch lead",
    why: "transient read error; if it persisted for a whole page the database is down and nothing sends anyway" },
  { match: "Consent withdrawn mid-flight",
    why: "the candidate query requires automation_mode IS NOT NULL, so these rows cannot be selected again" },
  { match: "Duplicate send guard: email sent/pending within last hour",
    why: "VERIFIED: the query matches automation_log status in (sent,pending) for this lead in the last hour, and logEntry is never inserted while still 'pending' (every insert site sets skipped/failed/claiming first), so only 'sent' rows can match and they age out in <=1h (4 ticks)" },
  { match: "if (claimError)",
    why: "VERIFIED with a bound: the winning run holds a claiming/sent row, and automation_log_claim_unique is PARTIAL (WHERE status IN ('claiming','sent')) so our retry keeps failing only while that row lives; a send clears needs_action, a failure/expiry drops the row out of the index, and stale-claim recovery expires abandoned ones every run" },
];

const LEAVE_IN_PLACE_COLD: Exempt[] = [
  { match: "if (processed >= maxSendsPerRun)",
    why: "control flow, not a refusal — the per-run send cap ends the cold loop, refusing nobody" },
  { match: "Touch is no longer scheduled",
    why: "the scan filters status='scheduled'; this row can no longer be selected" },
  { match: "Touch is not due yet",
    why: "the scan filters eligible_at <= now; an advanced touch is already out of the page" },
  { match: "Not the next step in line",
    why: "VERIFIED with a bound: steps are scheduled with increasing delays, so the earlier step has an older eligible_at and sorts ahead in this ASC scan; its send re-anchors this touch. Bound: both rows sit in the same 200-row page, so this only fails if one enrollment has >200 out-of-order touches" },
  { match: "Campaign is not active or not in automatic send mode",
    why: "the scan filters campaign_id IN (active + automatic); defense in depth only" },
  { match: "Workspace cold auto-send gate is off",
    why: "the scan already filters to gated workspaces; defense in depth only" },
  { match: "Lead no longer exists",
    why: "leads!inner join — a touch with no lead is not returned by the scan" },
  { match: "Another executor run already claimed this touch",
    why: "VERIFIED: the winner's claim is claiming/sent, and on success advanceColdEnrollment moves this touch out of the status='scheduled' scan; an abandoned claim is expired by stale-claim recovery at the top of every run, so the block cannot outlive one claim_expires_at window" },
  { match: "claim failed:",
    why: "RESIDUAL RISK, accepted and reported: a non-23505 insert failure is assumed transient. If one were persistent (e.g. a schema/constraint change), 200 such touches would hold this page. Not observed; flagged to the coordinator rather than fixed, since deferring here would also defer genuine transient claim races" },
  { match: "send failed",
    why: "RESIDUAL RISK, accepted and reported: the touch is left scheduled so a transient provider error retries promptly (documented at the branch). A provider down for one owner with >200 due touches would hold this page; a backoff is the right fix and is a follow-up, not a same-round change to the send-failure path" },
];

/** Writes that take a row out of its scan's filters. */
const MOVES_ROW = [
  "needs_action: false", "eligible_at:", "unsubscribed: true", "manual_mode: true",
  'status: "skipped"', "endColdEnrollment", "advanceColdEnrollment",
];

/** The `{`-delimited branch containing the statement at line index `i`. */
function branchBodyAt(lines: string[], i: number, floor: number): string {
  if (/\{[^{}]*\b(continue|break);/.test(lines[i])) return lines[i]; // single-line branch
  let depth = 0;
  for (let j = i; j >= floor; j--) {
    const line = lines[j];
    for (let k = line.length - 1; k >= 0; k--) {
      const ch = line[k];
      if (ch === "}") depth++;
      else if (ch === "{") {
        if (depth === 0) return lines.slice(j, i + 1).join("\n");
        depth--;
      }
    }
  }
  return lines.slice(Math.max(floor, i - 25), i + 1).join("\n");
}

function auditLoop(name: string, startPat: string, endPat: string, exempt: Exempt[]) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(startPat));
  const end = lines.findIndex((l, n) => n > start && l.includes(endPat));
  expect(start, `${name}: loop start not found`).toBeGreaterThan(-1);
  expect(end, `${name}: loop end not found`).toBeGreaterThan(start);

  const offenders: string[] = [];
  let audited = 0;
  for (let i = start; i < end; i++) {
    if (!/\b(continue|break);/.test(lines[i])) continue;
    audited++;
    const body = branchBodyAt(lines, i, start);
    if (MOVES_ROW.some((m) => body.includes(m))) continue;
    if (exempt.some((e) => body.includes(e.match))) continue;
    offenders.push(`line ${i + 1}: ${lines[i].trim().slice(0, 100)}`);
  }
  return { audited, offenders };
}

describe("everyRefusalMovesTheRowOrIsJustified", () => {
  it("legacy loop: no refusal leaves a lead where the 20-row scan will find it again", () => {
    const { audited, offenders } = auditLoop(
      "legacy", "for (const lead of legacyLeads)", "if (privileged) try {", LEAVE_IN_PLACE_LEGACY);
    expect(audited, "guard went vacuous — no branches found").toBeGreaterThanOrEqual(25);
    expect(offenders, `Refusal(s) that neither move the lead nor appear in LEAVE_IN_PLACE_LEGACY:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("cold loop: no refusal leaves a touch at the front of the eligible_at ASC page", () => {
    const { audited, offenders } = auditLoop(
      "cold", "for (const touch of (coldDue || []))", "VOLUME TRIPWIRE", LEAVE_IN_PLACE_COLD);
    expect(audited, "guard went vacuous — no branches found").toBeGreaterThanOrEqual(25);
    expect(offenders, `Refusal(s) that neither move the touch nor appear in LEAVE_IN_PLACE_COLD:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every exemption carries a written reason (the allow-list is an audit, not a mute button)", () => {
    for (const e of [...LEAVE_IN_PLACE_LEGACY, ...LEAVE_IN_PLACE_COLD]) {
      expect(e.why.length, `exemption "${e.match}" needs a real reason`).toBeGreaterThan(30);
    }
    // Keep the list small enough to stay reviewable.
    expect(LEAVE_IN_PLACE_LEGACY.length + LEAVE_IN_PLACE_COLD.length).toBeLessThanOrEqual(20);
  });
});

// ── Codex P1 (final): the no-phone refusal must cost nothing and move the lead
describe("smsPreconditionRunsBeforeAnySpending", () => {
  const legacy = legacySection();

  it("the phone check runs before the draft is consumed, the AI call and the claim", () => {
    const check = legacy.indexOf('if (resolvedChannel === "sms" && !lead.phone)');
    expect(check).toBeGreaterThan(-1);
    // Everything it used to run AFTER, destroying or spending something each tick.
    const auditDraftRow = legacy.indexOf('from("drafts").insert(');
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    const claim = legacy.indexOf('logEntry.status = "claiming"');
    for (const [name, at] of Object.entries({ auditDraftRow, aiCall, claim })) {
      expect(at, `${name} not found`).toBeGreaterThan(-1);
      expect(check, `phone check must precede ${name}`).toBeLessThan(at);
    }
    // ...and it is resolved AFTER the channel is known, or it would gate email too.
    expect(check).toBeGreaterThan(legacy.indexOf("const resolvedChannel: string"));
  });

  it("it writes a ledger row AND moves the lead — the claim row never parked it", () => {
    const check = legacy.indexOf('if (resolvedChannel === "sms" && !lead.phone)');
    const branch = legacy.slice(check, check + 1200);
    expect(branch).toContain('from("automation_log").insert(logEntry)');
    expect(branch).toContain("No phone number for SMS");
    expect(branch).toContain("blockedRowRetryAt()");
    expect(branch).toContain("continue;");
  });

  it("the old in-send-branch check is gone (one source of truth)", () => {
    expect([...legacy.matchAll(/!lead\.phone/g)].length).toBe(1);
    expect(legacy).not.toContain('error_message: "No phone number for SMS", completed_at');
  });

  it("no allow-list entry justifies itself with the partial claim index parking a lead", () => {
    // automation_log_claim_unique is WHERE status IN ('claiming','sent'), so a
    // claim flipped to 'skipped' leaves the index and frees the slot. Any
    // exemption resting on "the claim row parks it" is false by construction.
    for (const e of [...LEAVE_IN_PLACE_LEGACY, ...LEAVE_IN_PLACE_COLD]) {
      expect(e.why, `bad justification: ${e.match}`).not.toMatch(/parks the lead|claim row.*parks/i);
    }
    expect(LEAVE_IN_PLACE_LEGACY.some((e) => e.match.includes("No phone number for SMS"))).toBe(false);
  });
});

// ── Codex P1: a malformed send cap must not disable the cap AND its alarm ────
// `parseInt(" ", 10)` is NaN, and NaN loses every comparison: `processed >= NaN`
// is false so the per-run cap stops existing, and the tripwire threshold derived
// from the same value is NaN so `count > threshold` is false too. A one-character
// typo in a secret gave an uncapped sender with its own alarm silenced.
describe("sendCapNormalisation", () => {
  it("the cap is normalised at the PARSE, not at the comparison sites", () => {
    // The raw `env ? parseInt(env) : 5` form is the bug — it must be gone.
    expect(src).not.toMatch(/maxSendsEnv\s*\?\s*parseInt\(/);
    expect(src).toContain('const maxSendsPerRun = normalizeSendCap(parseInt(Deno.env.get("MAX_SENDS_PER_RUN") ?? "", 10));');
    // Exactly one place decides what a valid cap is.
    expect([...src.matchAll(/const maxSendsPerRun = /g)].length).toBe(1);
  });

  it("normalizeSendCap tests finiteness explicitly — a Math.max floor is not a guard", () => {
    const fn = src.slice(src.indexOf("function normalizeSendCap("));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).toContain("Number.isFinite(raw)");
    expect(body).toContain("raw >= 1");
    expect(body).toContain("MAX_SENDS_PER_RUN_DEFAULT");
    // Math.max(1, NaN) === NaN, so a floor would silently pass NaN through.
    expect(body).not.toMatch(/Math\.max\(1,/);
  });

  it("the tripwire's derived threshold goes through the same normaliser", () => {
    const fn = src.slice(src.indexOf("function volumeAlertDefaultThreshold("));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).toContain("normalizeSendCap(maxSendsPerRun)");
    // The old `Math.max(1, maxSendsPerRun)` was false comfort for exactly this.
    expect(body).not.toMatch(/Math\.max\(1, maxSendsPerRun\)/);
  });

  it("the documented default is a finite positive integer and is the single source", () => {
    const m = src.match(/const MAX_SENDS_PER_RUN_DEFAULT = (\d+);/);
    expect(m).not.toBeNull();
    const d = Number(m![1]);
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
    // No stray literal fallback left behind next to the env read.
    expect(src).not.toMatch(/Deno\.env\.get\("MAX_SENDS_PER_RUN"\)[^;]*:\s*\d+;/);
  });

  it("NaN really does defeat both guards — the arithmetic this test protects", () => {
    // Documents WHY the normaliser matters, using the same expressions the
    // executor uses. If either of these ever becomes true, the reasoning above
    // is wrong and the guards need revisiting.
    const nan = parseInt(" ", 10);
    expect(Number.isNaN(nan)).toBe(true);
    expect(7 >= nan).toBe(false);            // processed >= maxSendsPerRun
    expect(Number.isNaN(Math.max(1, nan))).toBe(true); // the false-comfort floor
    const ceiling = Math.max(1, nan) * 2;
    expect(999 > Math.max(1, Math.min(Math.max(1, nan), ceiling - 1))).toBe(false); // count > threshold
  });
});

// ── Guardrail coercion, source-text (behaviour is covered by the Deno suite) ─
describe("guardrailCoercion", () => {
  it("the JSON is coerced where it meets the defaults, not at the comparison sites", () => {
    expect(settingsSrc).toContain("guardrails: coerceGuardrails(raw.guardrails as Record<string, unknown> | undefined, ownerUserId),");
    // The raw spread was the bug — a non-numeric value landed straight on a limit.
    expect(settingsSrc).not.toMatch(/guardrails: \{\s*\.\.\.DEFAULT_EXECUTION_SETTINGS\.guardrails,\s*\.\.\.\(raw\.guardrails/);
  });

  it("every numeric guardrail is covered, and the test knows if one is added", () => {
    const listed = [...settingsSrc.matchAll(/^\s{2}"(\w+)",$/gm)].map((m) => m[1]);
    const declared = settingsSrc.slice(settingsSrc.indexOf("export interface Guardrails {"));
    const fields = [...declared.slice(0, declared.indexOf("}")).matchAll(/(\w+): number;/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(listed, `guardrail ${f} is numeric but not in NUMERIC_GUARDRAILS`).toContain(f);
    }
  });

  it("unreadable falls back to the default and is logged; zero is preserved", () => {
    const fn = settingsSrc.slice(settingsSrc.indexOf("function coerceGuardrails("));
    const body = fn.slice(0, fn.indexOf("\n}") + 2);
    expect(body).toContain("Number.isFinite(n) && n >= 0");   // 0 passes through
    expect(body).toContain("DEFAULT_EXECUTION_SETTINGS.guardrails[key]");
    expect(body).toContain("console.warn(");                  // operators can find it
    // null/""/booleans must not be read as 0 by Number() coercion.
    const reader = settingsSrc.slice(settingsSrc.indexOf("function readGuardrailNumber("));
    expect(reader.slice(0, reader.indexOf("\n}") + 2)).toContain('typeof value === "number"');
  });
});
