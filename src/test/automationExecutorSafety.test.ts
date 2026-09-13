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
    expect(settingsSrc).toContain("owner_automation_paused: raw.automation_paused === true");
    // Legacy loop: after loading execSettings, before the send-window check.
    const legacy = legacySection();
    const pause = legacy.indexOf("if (execSettings.owner_automation_paused)");
    const window = legacy.indexOf("checkSendWindow(execSettings)");
    expect(pause).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(window);
    expect(legacy.slice(pause, pause + 700)).toContain('from("automation_log").insert(logEntry)');
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

  it("the volume tripwire default can actually fire (below the 40/day mailbox cap)", () => {
    const m = src.match(/const VOLUME_ALERT_DEFAULT_THRESHOLD = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(40);
    expect(src).toContain("parsedThreshold > 0 ? parsedThreshold : VOLUME_ALERT_DEFAULT_THRESHOLD");
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
