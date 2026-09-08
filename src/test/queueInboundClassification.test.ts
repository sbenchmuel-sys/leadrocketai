// ============================================================
// Unit G-A — inbound classification + Queue truth.
//
// Eight guards, one per finding. Mixed style, deliberately:
//   • behavioural, where the logic is a pure `_shared/` module a
//     vitest spec can import through the `@shared/*` alias;
//   • source-text, where the logic lives in a Deno edge function or in
//     SQL that this runner cannot execute (`npm run test:edge` and a
//     live Postgres are both out of reach in the build sandbox).
//
// Source-text guards are pinned to the exact strings the fix depends
// on, so a well-meaning refactor that reintroduces the bug fails here
// rather than in a rep's Queue.
// ============================================================
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  DETERMINISTIC_INTENTS,
  detectInboundIntent,
  senderIsLead,
} from "@shared/inboundIntentDetectors";
import { detectMeetingConfirmation } from "@shared/meetingConfirmation";
import { isOutOfOfficeReply } from "@shared/oooDetection";
import {
  INBOUND_EVENT_TYPES,
  QUEUE_INTENT_HIDE_SET,
  readInboundMetadata,
  shouldHideFromQueue,
} from "@/lib/queueQueries";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const CLASSIFY_INBOUND = "supabase/functions/classify-inbound/index.ts";
const OOO_PAUSE = "supabase/functions/_shared/oooPauseActions.ts";
const QUEUE_QUERIES = "src/lib/queueQueries.ts";
const MIGRATION = "supabase/migrations/20260908120000_queue_intent_rpc.sql";

// ── 1. detectorsRunBeforeAI ────────────────────────────────────────
// The whole P1: classify-inbound must consult the deterministic chain
// and write its verdict BEFORE it spends an AI call.
describe("detectorsRunBeforeAI", () => {
  const src = read(CLASSIFY_INBOUND);

  it("imports the shared deterministic detector chain", () => {
    expect(src).toContain('from "../_shared/inboundIntentDetectors.ts"');
    expect(src).toMatch(/import\s*\{[^}]*\bdetectInboundIntent\b[^}]*\}\s*from\s*"\.\.\/_shared\/inboundIntentDetectors\.ts"/);
    // Sender identity lives in the same pure module (testable from vitest),
    // not as a private copy inside the edge function.
    expect(src).toMatch(/import\s*\{[^}]*\bsenderIsLead\b[^}]*\}\s*from\s*"\.\.\/_shared\/inboundIntentDetectors\.ts"/);
    expect(src).not.toContain("function senderIsLead(");
  });

  it("calls detectInboundIntent strictly before the ai_task fetch", () => {
    const detectorAt = src.indexOf("detectInboundIntent({");
    const aiAt = src.indexOf("/functions/v1/ai_task");
    expect(detectorAt).toBeGreaterThan(-1);
    expect(aiAt).toBeGreaterThan(-1);
    expect(detectorAt).toBeLessThan(aiAt);
  });

  it("writes the detector verdict into `intent` and skips the AI call", () => {
    const branch = src.slice(
      src.indexOf("if (deterministic.intent) {"),
      src.indexOf("/functions/v1/ai_task"),
    );
    expect(branch).toContain("intent: deterministic.intent");
    // `continue` is what makes it a short-circuit rather than an extra write.
    expect(branch).toContain("continue;");
    // Concurrency guard must survive: the loser of a race no-ops.
    expect(branch).toContain('.is("intent", null)');
  });
});

// ── 2. hideVocabularyMatches ───────────────────────────────────────
// The dead-hide-list bug: the classifier could only emit intents the
// Queue never hides on. Pin the superset relation in BOTH directions
// that matter.
describe("hideVocabularyMatches", () => {
  it("every intent the Queue hides on is emittable by the detectors", () => {
    const emittable = new Set<string>(DETERMINISTIC_INTENTS);
    const unreachable = [...QUEUE_INTENT_HIDE_SET].filter((i) => !emittable.has(i));
    expect(unreachable).toEqual([]);
  });

  it("the detectors emit nothing the Queue would not hide (no surprise hides)", () => {
    const stray = DETERMINISTIC_INTENTS.filter((i) => !QUEUE_INTENT_HIDE_SET.has(i));
    expect(stray).toEqual([]);
  });

  it("actually classifies a real bounce, OOO and calendar accept", () => {
    expect(
      detectInboundIntent({
        fromEmail: "mailer-daemon@googlemail.com",
        subject: "Delivery Status Notification (Failure)",
        body: "",
      }).intent,
    ).toBe("bounce");

    expect(
      detectInboundIntent({
        fromEmail: "dana@acme.com",
        subject: "Automatic reply: Q3 rollout",
        body: "I am out of the office until March 5.",
      }).intent,
    ).toBe("ooo_reply");

    expect(
      detectInboundIntent({
        fromEmail: "dana@acme.com",
        subject: "Accepted: Intro call @ Tue Mar 3",
        body: "",
      }).intent,
    ).toBe("calendar_accept");
  });

  it("leaves a normal human reply for the AI (intent null)", () => {
    expect(
      detectInboundIntent({
        fromEmail: "dana@acme.com",
        subject: "Re: pilot",
        body: "Can you send the enterprise pricing for 50 seats?",
      }).intent,
    ).toBeNull();
  });
});

// ── 3. rpcNoIntentNotNull ──────────────────────────────────────────
// The stale-verdict bug: `intent IS NOT NULL` inside the DISTINCT ON
// made a fresh reply inherit an older bounce's hide verdict.
describe("rpcNoIntentNotNull", () => {
  const sql = read(MIGRATION);

  it("the new RPC body has no `intent IS NOT NULL` predicate", () => {
    const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("$$;"));
    expect(body).not.toMatch(/intent\s+IS\s+NOT\s+NULL/i);
  });

  it("still reduces to one row per lead by recency", () => {
    expect(sql).toMatch(/DISTINCT ON \(lti\.lead_id\)/);
    expect(sql).toMatch(/ORDER BY lti\.lead_id, lti\.occurred_at DESC/);
  });

  it("keeps the workspace authorization clause", () => {
    expect(sql).toContain("is_workspace_member(lti.workspace_id, auth.uid())");
  });

  it("is re-runnable (DROP IF EXISTS + CREATE OR REPLACE, one transaction)", () => {
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.get_latest_intents_for_leads(uuid[])");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.get_latest_intents_for_leads");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });
});

// ── 4. allChannelPreviews ──────────────────────────────────────────
// WhatsApp / SMS replies used to render blank cards because both the
// preview query and the RPC hard-filtered `email_inbound`.
describe("allChannelPreviews", () => {
  const src = read(QUEUE_QUERIES);
  const sql = read(MIGRATION);

  it("exports the canonical inbound event-type set", () => {
    expect([...INBOUND_EVENT_TYPES].sort()).toEqual(
      ["email_inbound", "sms_inbound", "whatsapp_inbound"],
    );
  });

  it("the preview query is not restricted to email_inbound", () => {
    expect(src).not.toMatch(/\.eq\(\s*["']event_type["']\s*,\s*["']email_inbound["']\s*\)/);
    expect(src).toContain('.in("event_type", INBOUND_EVENT_TYPES as string[])');
  });

  it("the RPC is not restricted to email_inbound", () => {
    const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("$$;"));
    expect(body).not.toMatch(/event_type\s*=\s*'email_inbound'/);
    for (const t of INBOUND_EVENT_TYPES) expect(body).toContain(`'${t}'`);
  });

  it("a WhatsApp-only lead yields a preview row shape, not a blank", () => {
    const preview = readInboundMetadata({ ai_summary: "Asks for a revised quote." });
    expect(preview.ai_summary).toBe("Asks for a revised quote.");
  });
});

// ── 5. oooKeepsNeedsActionOnQuestion ───────────────────────────────
// An OOO matched on the subject alone used to clear `needs_action`
// unconditionally, burying a live commercial question.
describe("oooKeepsNeedsActionOnQuestion", () => {
  it("flags an OOO whose body carries a question + commercial keyword", () => {
    const r = isOutOfOfficeReply(
      [],
      "Automatic reply: Re: pilot",
      "I'm out of the office until March 5. Before then, can you send the updated pricing?",
    );
    expect(r.isOOO).toBe(true);
    expect(r.hasSubstantiveQuestion).toBe(true);
    expect(r.matchedKeywords).toContain("pricing");
  });

  it("does NOT flag a plain OOO", () => {
    const r = isOutOfOfficeReply(
      [],
      "Automatic reply: Re: pilot",
      "I'm out of the office until March 5 with limited access to email.",
    );
    expect(r.isOOO).toBe(true);
    expect(r.hasSubstantiveQuestion).toBe(false);
    expect(r.matchedKeywords).toEqual([]);
  });

  it("does NOT flag a question with no commercial keyword", () => {
    const r = isOutOfOfficeReply(
      [],
      "Automatic reply",
      "I'm away until Monday. Who is covering for you?",
    );
    expect(r.hasSubstantiveQuestion).toBe(false);
  });

  it("an OOO carrying a question is NOT labelled ooo_reply (would re-hide it)", () => {
    // The whole point of keeping needs_action is lost if the classifier
    // then stamps `ooo_reply`, because that intent is in the Queue's hide
    // set — the lead would vanish within one classification cycle.
    const r = detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: "I'm out of the office until March 5. Before then, can you send the updated pricing?",
    });
    expect(r.intent).toBeNull();
    expect(r.ooo?.isOOO).toBe(true);
    expect(r.ooo?.hasSubstantiveQuestion).toBe(true);
  });

  it("…and is therefore not hidden from the Queue", () => {
    const r = detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: "I'm out of the office until March 5. Before then, can you send the updated pricing?",
    });
    expect(
      shouldHideFromQueue({
        intent: r.intent,
        reply_worthy: null,
        sender_is_lead: null,
      }),
    ).toBe(false);
  });

  it("a plain OOO IS still labelled ooo_reply and hidden", () => {
    const r = detectInboundIntent({
      fromEmail: "dana@acme.com",
      subject: "Automatic reply: Re: pilot",
      body: "I'm out of the office until March 5 with limited access to email.",
    });
    expect(r.intent).toBe("ooo_reply");
    expect(
      shouldHideFromQueue({ intent: r.intent, reply_worthy: null, sender_is_lead: null }),
    ).toBe(true);
  });

  it("applyOOOPause keeps the lead actionable when the flag is set", () => {
    const src = read(OOO_PAUSE);
    expect(src).toContain("const keepActionable = oooResult.hasSubstantiveQuestion === true;");
    // needs_action / next_action_key are conditional, never a bare false/null.
    expect(src).toContain("needs_action: keepActionable ? true : false,");
    expect(src).toContain('next_action_key: keepActionable ? "reply_now" : null,');
    expect(src).toContain('action_reason_code: keepActionable ? "REPLY_PENDING" : null,');
    // The send-side pause is NOT weakened — both fields still always written.
    expect(src).toContain("ooo_until:");
    expect(src).toContain("eligible_at: eligibleAt,");
  });
});

// ── 6. tentativeAcceptNotAccepted ──────────────────────────────────
describe("tentativeAcceptNotAccepted", () => {
  it('"Tentatively Accepted:" is not a confirmed meeting', () => {
    const r = detectMeetingConfirmation("Tentatively Accepted: Intro call @ Tue", "");
    expect(r.isConfirmed).toBe(false);
    expect(r.confidence).toBeNull();
  });

  it('"Tentatively Accepted:" is not classified calendar_accept', () => {
    expect(
      detectInboundIntent({
        fromEmail: "dana@acme.com",
        subject: "Tentatively Accepted: Intro call @ Tue",
        body: "",
      }).intent,
    ).toBeNull();
  });

  it("a firm accept still classifies", () => {
    expect(
      detectMeetingConfirmation("Accepted: Intro call @ Tue", "").confidence,
    ).toBe("subject");
  });

  it("a wavering accept is therefore not hidden from the Queue", () => {
    expect(shouldHideFromQueue({ intent: null, reply_worthy: null, sender_is_lead: null }))
      .toBe(false);
  });
});

// ── 7. aiSignalsPersisted ──────────────────────────────────────────
// Four signals were paid for on every call and thrown away.
describe("aiSignalsPersisted", () => {
  const src = read(CLASSIFY_INBOUND);

  it("the intent_router prompt actually asks for all five fields", () => {
    // Persisting a field the prompt never requests ships a dead column.
    const prompts = read("supabase/functions/_shared/prompts.ts");
    const schema = prompts.slice(
      prompts.indexOf("intent_router: `"),
      prompts.indexOf("email_intro_fast:"),
    );
    for (const field of [
      '"reply_worthy"',
      '"urgency"',
      '"tone"',
      '"questions_extracted"',
      '"language"',
    ]) {
      expect(schema).toContain(field);
    }
    // …and language must be specified as ISO 639-1, which is what
    // `extractSignals` validates (non-empty, <= 32 chars, lowercased).
    expect(schema).toMatch(/language=.*ISO 639-1/);
  });

  it("classify-inbound extracts all four signals plus language", () => {
    for (const field of [
      "reply_worthy",
      "urgency",
      "tone",
      "questions_extracted",
      "language",
    ]) {
      expect(src).toContain(field);
    }
    expect(src).toContain("function extractSignals(");
  });

  it("writes them into metadata_json on the classifying UPDATE", () => {
    expect(src).toContain("ai_signals: signals,");
    expect(src).toContain("metadata_json: nextMetadata,");
    // Existing metadata (from_email, to_emails, …) is preserved.
    expect(src).toContain("...(row.metadata_json ?? {}),");
  });

  it("the Queue reads them back off metadata_json", () => {
    const parsed = readInboundMetadata({
      ai_summary: "Asks for Q3 pricing on the 50-seat tier.",
      sender_is_lead: true,
      ai_signals: {
        reply_worthy: true,
        urgency: "high",
        tone: "positive",
        questions_extracted: ["What is the Q3 price?", "Do pilot terms still apply?"],
        language: "en",
      },
    });
    expect(parsed).toEqual({
      ai_summary: "Asks for Q3 pricing on the 50-seat tier.",
      reply_worthy: true,
      urgency: "high",
      tone: "positive",
      questions_extracted: ["What is the Q3 price?", "Do pilot terms still apply?"],
      language: "en",
      sender_is_lead: true,
    });
  });

  it("degrades to nulls on missing / malformed metadata (never throws)", () => {
    expect(readInboundMetadata(null).reply_worthy).toBeNull();
    expect(readInboundMetadata({}).questions_extracted).toEqual([]);
    expect(
      readInboundMetadata({ ai_signals: { reply_worthy: "yes", questions_extracted: 3 } })
        .reply_worthy,
    ).toBeNull();
  });

  it("hides the card when the model says no reply is needed", () => {
    expect(shouldHideFromQueue({ intent: null, reply_worthy: false, sender_is_lead: null }))
      .toBe(true);
    expect(shouldHideFromQueue({ intent: null, reply_worthy: true, sender_is_lead: null }))
      .toBe(false);
  });

  it("hides the card when a third party, not the lead, wrote it", () => {
    expect(shouldHideFromQueue({ intent: null, reply_worthy: true, sender_is_lead: false }))
      .toBe(true);
    // Unknown sender identity must fail OPEN.
    expect(shouldHideFromQueue({ intent: null, reply_worthy: true, sender_is_lead: null }))
      .toBe(false);
  });

  // `false` is the ONLY verdict here that can hide a real customer reply,
  // so it must require cross-organisation evidence. Anything less certain
  // stays `null` (unknown → visible).
  it("sender_is_lead is true on an exact match, alias or display name", () => {
    expect(senderIsLead("dana@acme.com", "dana@acme.com")).toBe(true);
    expect(senderIsLead('"Dana Ruiz" <Dana@Acme.com>', "dana@acme.com")).toBe(true);
    // Plus-aliasing is still Dana (normalizeEmail strips it).
    expect(senderIsLead("dana+drivepilot@acme.com", "dana@acme.com")).toBe(true);
  });

  it("sender_is_lead is NULL, not false, when only the local part differs", () => {
    // Shared inbox, second address, or an alias we can't normalize away.
    expect(senderIsLead("procurement@acme.com", "dana@acme.com")).toBeNull();
    expect(senderIsLead("d.ruiz@acme.com", "dana@acme.com")).toBeNull();
    // …and NULL never hides.
    expect(
      shouldHideFromQueue({ intent: null, reply_worthy: true, sender_is_lead: null }),
    ).toBe(false);
  });

  it("sender_is_lead is false only when the DOMAIN differs too", () => {
    expect(senderIsLead("vendor@other.com", "dana@acme.com")).toBe(false);
  });

  it("sender_is_lead is NULL when either side is missing or unparseable", () => {
    expect(senderIsLead("", "dana@acme.com")).toBeNull();
    expect(senderIsLead("dana@acme.com", null)).toBeNull();
    expect(senderIsLead("not-an-email", "dana@acme.com")).toBeNull();
  });
});

// ── 8. purgeGateSummary ────────────────────────────────────────────
// CLAUDE.md → "Public product commitments": an inbound row's raw body
// is held past 72h ONLY until the classifier has written a durable
// `ai_summary` (or 7 days elapse). Nothing in this unit may let a row
// reach `intent IS NOT NULL` + `ai_summary IS NOT NULL` without the
// summary actually having been produced, and nothing may cause a
// substantive inbound to be marked classified with no summary at all.
describe("purgeGateSummary", () => {
  const src = read(CLASSIFY_INBOUND);

  it("still refuses to write intent without ai_summary for substantive intents", () => {
    expect(src).toContain("if (!isSkipListIntent && ai_summary === null)");
    // …and that branch must bail out rather than write.
    const guard = src.slice(src.indexOf("if (!isSkipListIntent && ai_summary === null)"));
    expect(guard.slice(0, 600)).toContain("continue;");
  });

  it("ai_summary is only written together with intent, in one UPDATE", () => {
    expect(src).toContain("nextMetadata.ai_summary = ai_summary;");
    expect(src).toContain("intent: intentPrimary,");
    expect(src).toContain("metadata_json: nextMetadata,");
  });

  it("every deterministic short-circuit intent is one that never needs a summary", () => {
    // If a detector could emit an intent OUTSIDE SKIP_AI_SUMMARY_INTENTS, the
    // short-circuit would mark a substantive inbound classified with no
    // summary — the row would then never be re-polled (`intent IS NULL`) and
    // its body would sit until the 7-day hard cap.
    const skipBlock = src.slice(
      src.indexOf("const SKIP_AI_SUMMARY_INTENTS"),
      src.indexOf("interface TimelineRow"),
    );
    for (const intent of DETERMINISTIC_INTENTS) {
      expect(skipBlock).toContain(`"${intent}"`);
    }
  });

  it("defer_request is deliberately NOT short-circuited (it needs a summary)", () => {
    expect([...DETERMINISTIC_INTENTS]).not.toContain("defer_request");
    expect(
      detectInboundIntent({
        fromEmail: "dana@acme.com",
        subject: "Re: pilot",
        body: "Budget is not available until Q3 — let's reconnect after June.",
      }).intent,
    ).toBeNull();
  });

  it("this unit does not touch the purge function at all", () => {
    // The retention gate is not ours to move. Whatever the live
    // definition of expire_old_messages() says, our one migration must
    // not mention it — so the Queue fix can never widen or narrow the
    // purge window as a side effect.
    expect(read(MIGRATION)).not.toContain("expire_old_messages");
    expect(read(MIGRATION)).not.toMatch(/snippet_text|body_text|expires_at/);
  });

  it("the newest expire_old_messages() definition is the one QA verified", () => {
    // Pinned by discovery, not by hard-coded filename: an earlier draft of
    // this test asserted against 20260524090429, which had ALREADY been
    // superseded the same day — so it was asserting a gate that is not
    // live. Read whichever definition actually wins by migration order.
    const dir = "supabase/migrations";
    const defining = readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        /CREATE OR REPLACE FUNCTION public\.expire_old_messages/i.test(
          read(path.posix.join(dir, f)),
        ),
      );
    expect(defining.length).toBeGreaterThan(0);

    const newest = defining[defining.length - 1];
    const sql = read(path.posix.join(dir, newest));

    // Documented reality as of this unit (QA-confirmed, routed to the
    // founder as an out-of-unit discrepancy with CLAUDE.md): the winning
    // definition is a flat 30-day cap that does NOT consult `intent` or
    // `ai_summary` at all. This assertion is a TRIPWIRE, not an
    // endorsement — if someone restores the label-based gate, it fails
    // and whoever does that should re-read the comment above.
    const consultsClassifier = /intent IS NOT NULL/i.test(sql);
    expect({ newest, consultsClassifier }).toEqual({
      newest: "20260524133934_69822792-ceb0-4eee-b7b2-ea7d70def4b7.sql",
      consultsClassifier: false,
    });
  });
});
