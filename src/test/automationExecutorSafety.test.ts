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
import { readFileSync } from "node:fs";
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

  it("workspace pause is a settings key (default false) and skips in BOTH the legacy loop and the cold pass", () => {
    expect(settingsSrc).toContain("automation_paused: boolean");
    expect(settingsSrc).toContain("automation_paused: false");
    expect(settingsSrc).toContain("automation_paused: raw.automation_paused === true");
    // Legacy loop: after loading execSettings, before the send-window check.
    const legacy = legacySection();
    const pause = legacy.indexOf("if (execSettings.automation_paused)");
    const window = legacy.indexOf("checkSendWindow(execSettings)");
    expect(pause).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(window);
    expect(legacy.slice(pause, pause + 500)).toContain('from("automation_log").insert(logEntry)');
    // Cold pass: after loading exec, before any claim.
    const cold = coldSection();
    const coldPause = cold.indexOf("if (exec.automation_paused)");
    const coldClaim = cold.indexOf('status: "claiming"');
    expect(coldPause).toBeGreaterThan(-1);
    expect(coldPause).toBeLessThan(coldClaim);
    expect(cold.slice(coldPause, coldPause + 200)).toContain("logColdSkip(");
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
    const floor = legacy.indexOf("coldSendFloor(supabase, lead.id, lead.workspace_id)");
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

  it("the unsubscribe-secret and postal-address refusals run BEFORE the draft lookup and the AI call", () => {
    const legacy = legacySection();
    const secretCheck = legacy.indexOf("if (!unsubSecret) {");
    const postalCheck = legacy.indexOf("if (!postalAddress && requirePostalAddress()) {");
    const draftLookup = legacy.indexOf('from("drafts")');
    const approvedConsumed = legacy.indexOf('from("drafts").update({ status: "sent" })');
    const aiCall = legacy.indexOf("functions/v1/ai_task");
    expect(secretCheck).toBeGreaterThan(-1);
    expect(postalCheck).toBeGreaterThan(-1);
    expect(secretCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(draftLookup);
    expect(postalCheck).toBeLessThan(approvedConsumed);
    expect(postalCheck).toBeLessThan(aiCall);
    // Each refusal writes the skip row and continues (no send, no claim).
    for (const at of [secretCheck, postalCheck]) {
      const branch = legacy.slice(at, at + 500);
      expect(branch).toContain('from("automation_log").insert(logEntry)');
      expect(branch).toContain("continue;");
    }
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

  it("logColdSkip writes status 'skipped' to automation_log (singular) and never throws", () => {
    const cold = coldSection();
    const helper = cold.slice(cold.indexOf("async function logColdSkip("), cold.indexOf("for (const touch of (coldDue || []))"));
    expect(helper).toContain('from("automation_log").insert(');
    expect(helper).not.toContain("automation_logs");
    expect(helper).toContain('status: "skipped"');
    expect(helper).toContain("try {");
    expect(helper).toContain("catch (logErr)");
    // Owner must come from the touch→lead join, since automation_log.owner_user_id is NOT NULL.
    expect(cold).toContain("leads!inner(owner_user_id)");
  });

  it("the volume tripwire default can actually fire (below the 40/day mailbox cap)", () => {
    const m = src.match(/const VOLUME_ALERT_DEFAULT_THRESHOLD = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(40);
    expect(src).toContain("parsedThreshold > 0 ? parsedThreshold : VOLUME_ALERT_DEFAULT_THRESHOLD");
  });
});
