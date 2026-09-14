// Run: deno test supabase/functions/_shared/outlookCandidates.test.ts
//
// BEHAVIOURAL. Deno mirror of src/test/outlookCandidateSelection.test.ts.
//
// THE BUG: outlook-sync sorted Graph's candidates newest-first and then
// `.slice(0, maxResults)` BEFORE any skip gate ran. Graph's candidate set is
// mostly ineligible — drafts, third-party mail, messages already stored,
// messages outside the sync window — so those messages spent the whole budget
// and a genuine direct reply ranked below them was never imported.
//
// Not imported LATE. Never: the candidate set is stable, so the same ineligible
// messages won the slice on every subsequent run too. The rep saw a customer
// who had not replied.
//
// Every test here drives the real `selectOutlookCandidates` and asserts on the
// messages it RETURNS. The `starves` test is the one that fails if the fix is
// reverted to a pre-filter slice.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

let currentSuite = "";
function describe(name: string, body: () => void) { currentSuite = name; body(); currentSuite = ""; }
function it(name: string, fn: () => void) { Deno.test(`${currentSuite} > ${name}`, fn); }
const expect = (actual: any) => ({
  toBe: (e: unknown) => assertEquals(actual, e),
  toEqual: (e: unknown) => assertEquals(actual, e),
  toHaveLength: (n: number) => assertEquals(actual.length, n),
});
import {
  type OutlookCandidate,
  selectOutlookCandidates,
} from "./outlookCandidates.ts";
import { outlookEmailDedupeKey } from "./dedupeKeys.ts";

const LEAD_ID = "11111111-1111-1111-1111-111111111111";
const LEAD = "manu@acme.com";
const REP = "rep@drivepilot.io";
const DAY = 86_400_000;

/** Builds a candidate; defaults to an eligible direct rep↔lead reply. */
function msg(over: Partial<OutlookCandidate> & { id: string; daysAgo: number }): OutlookCandidate {
  const { daysAgo, ...rest } = over;
  return {
    subject: "Re: Quick question",
    isDraft: false,
    receivedDateTime: new Date(Date.now() - daysAgo * DAY).toISOString(),
    from: { emailAddress: { address: LEAD } },
    toRecipients: [{ emailAddress: { address: REP } }],
    ...rest,
  };
}

function ctx(over: Partial<Parameters<typeof selectOutlookCandidates>[1]> = {}) {
  return {
    leadId: LEAD_ID,
    leadEmail: LEAD,
    repEmail: REP,
    alreadyStoredKeys: new Set<string>(),
    bodyByDedupeKey: new Map<string, string | null>(),
    syncStartMs: Date.now() - 365 * DAY,
    ...over,
  };
}

/** The dedupe key a stored row for this candidate carries. */
const keyOf = (m: OutlookCandidate) =>
  outlookEmailDedupeKey(LEAD_ID, m.internetMessageId ?? null, m.id ?? null, m.id);

const idsOf = (sel: ReturnType<typeof selectOutlookCandidates>) => sel.map((s) => s.messageId);

describe("selectOutlookCandidates: ineligible candidates never spend the budget", () => {
  it("THE REGRESSION — a real reply below 20 newer ineligible candidates is still imported", () => {
    // Exactly the shape Codex described: 20 newer candidates that the sync
    // deliberately drops, and one genuine reply underneath them. With a
    // pre-filter slice of 20, `reply` is never reached — on this run or any
    // later one.
    const noise: OutlookCandidate[] = [];
    for (let i = 0; i < 20; i++) {
      noise.push(msg({ id: `draft-${i}`, daysAgo: i, isDraft: true }));
    }
    const reply = msg({ id: "reply", daysAgo: 30 });

    const selected = selectOutlookCandidates([...noise, reply], ctx(), 20);

    expect(idsOf(selected)).toEqual(["reply"]);
  });

  it("the same holds for third-party noise", () => {
    const noise = Array.from({ length: 20 }, (_, i) =>
      msg({
        id: `news-${i}`,
        daysAgo: i,
        from: { emailAddress: { address: "news@substack.com" } },
        toRecipients: [{ emailAddress: { address: LEAD } }],
      }));
    const reply = msg({ id: "reply", daysAgo: 30 });

    expect(idsOf(selectOutlookCandidates([...noise, reply], ctx(), 20))).toEqual(["reply"]);
  });

  it("the same holds for already-synced noise", () => {
    const noise = Array.from({ length: 20 }, (_, i) => msg({ id: `old-${i}`, daysAgo: i }));
    const reply = msg({ id: "reply", daysAgo: 30 });
    const synced = new Set(noise.map(keyOf));
    const bodies = new Map(noise.map((m) => [keyOf(m), "already stored"]));

    expect(
      idsOf(selectOutlookCandidates(
        [...noise, reply],
        ctx({ alreadyStoredKeys: synced, bodyByDedupeKey: bodies }),
        20,
      )),
    ).toEqual(["reply"]);
  });

  it("the same holds for candidates older than the sync window", () => {
    const noise = Array.from({ length: 20 }, (_, i) => msg({ id: `ancient-${i}`, daysAgo: 400 + i }));
    const reply = msg({ id: "reply", daysAgo: 30 });
    // Sorted newest-first the reply leads here, so also check the budget is not
    // burned when the stale ones sort above a later eligible message.
    const selected = selectOutlookCandidates([...noise, reply], ctx({ syncStartMs: Date.now() - 90 * DAY }), 20);
    expect(idsOf(selected)).toEqual(["reply"]);
  });
});

describe("webhook-ingested messages do not consume selection slots", () => {
  it("THE REGRESSION — 20 messages the WEBHOOK already stored do not starve an older reply", () => {
    // The webhook writes a dedupe_key but never populates `gmail_message_id`.
    // The already-synced filter used to read that column, so every one of these
    // looked NEW, won a slot, and was only rejected at insert. Once a lead had
    // `maxResults` webhook deliveries newer than an unsynced message, that
    // message was never reached. The filter now asks with the dedupe key — the
    // same identity the insert uses.
    const viaWebhook = Array.from({ length: 20 }, (_, i) =>
      msg({ id: `wh-${i}`, internetMessageId: `<wh-${i}@acme.com>`, daysAgo: i }));
    const neverSynced = msg({ id: "unsynced", internetMessageId: "<unsynced@acme.com>", daysAgo: 30 });

    // Exactly what the webhook leaves behind: rows keyed by dedupe_key, with a
    // body, and NOTHING in gmail_message_id.
    const storedKeys = new Set(viaWebhook.map(keyOf));
    const storedBodies = new Map(viaWebhook.map((m) => [keyOf(m), "stored by the webhook"]));

    const selected = selectOutlookCandidates(
      [...viaWebhook, neverSynced],
      ctx({ alreadyStoredKeys: storedKeys, bodyByDedupeKey: storedBodies }),
      20,
    );

    expect(idsOf(selected)).toEqual(["<unsynced@acme.com>"]);
  });

  it("a webhook row whose body was purged is still re-selected to restore it", () => {
    const m = msg({ id: "wh", internetMessageId: "<wh@acme.com>", daysAgo: 2 });
    const selected = selectOutlookCandidates(
      [m],
      ctx({
        alreadyStoredKeys: new Set([keyOf(m)]),
        bodyByDedupeKey: new Map([[keyOf(m), null]]),
      }),
      10,
    );
    expect(idsOf(selected)).toEqual(["<wh@acme.com>"]);
    expect(selected[0].restoresPurgedBody).toBe(true);
  });

  it("the key it filters on is scoped to THIS lead", () => {
    // A row stored against a DIFFERENT lead must not make this one look synced.
    const m = msg({ id: "x", internetMessageId: "<x@acme.com>", daysAgo: 1 });
    const otherLeadKey = outlookEmailDedupeKey(
      "99999999-9999-9999-9999-999999999999",
      "<x@acme.com>",
      "x",
      "x",
    );
    expect(
      idsOf(selectOutlookCandidates([m], ctx({ alreadyStoredKeys: new Set([otherLeadKey]) }), 10)),
    ).toEqual(["<x@acme.com>"]);
  });
});

describe("selectOutlookCandidates: ordering and budget", () => {
  it("returns newest first", () => {
    const selected = selectOutlookCandidates(
      [msg({ id: "old", daysAgo: 9 }), msg({ id: "new", daysAgo: 1 }), msg({ id: "mid", daysAgo: 5 })],
      ctx(),
      10,
    );
    expect(idsOf(selected)).toEqual(["new", "mid", "old"]);
  });

  it("accepts at most `limit` ELIGIBLE messages", () => {
    const all = Array.from({ length: 10 }, (_, i) => msg({ id: `m-${i}`, daysAgo: i }));
    expect(selectOutlookCandidates(all, ctx(), 3)).toHaveLength(3);
    expect(idsOf(selectOutlookCandidates(all, ctx(), 3))).toEqual(["m-0", "m-1", "m-2"]);
  });

  it("a message with no usable timestamp sorts last, it does not jump the queue", () => {
    const selected = selectOutlookCandidates(
      [
        msg({ id: "undated", daysAgo: 0, receivedDateTime: null, sentDateTime: null }),
        msg({ id: "dated", daysAgo: 3 }),
      ],
      ctx(),
      10,
    );
    expect(idsOf(selected)).toEqual(["dated", "undated"]);
  });

  it("the same message twice in one batch is taken once and charged once", () => {
    const a = msg({ id: "graph-a", internetMessageId: "<same@acme.com>", daysAgo: 1 });
    const b = msg({ id: "graph-b", internetMessageId: "<same@acme.com>", daysAgo: 2 });
    const c = msg({ id: "graph-c", internetMessageId: "<other@acme.com>", daysAgo: 3 });
    expect(idsOf(selectOutlookCandidates([a, b, c], ctx(), 2)))
      .toEqual(["<same@acme.com>", "<other@acme.com>"]);
    // ...and the identity it deduped on is the dedupe key, not the Graph id.
    expect(selectOutlookCandidates([a, b, c], ctx(), 2).map((s) => s.dedupeKey))
      .toEqual([`outlook:${LEAD_ID}:<same@acme.com>`, `outlook:${LEAD_ID}:<other@acme.com>`]);
  });
});

describe("selectOutlookCandidates: what counts as eligible", () => {
  it("a DSN is let through even though it fails the rep↔lead gate", () => {
    // A bounce comes FROM postmaster and names the lead only in the body. It
    // must survive selection or the bounce-stop guardrail never fires.
    const dsn = msg({
      id: "dsn",
      daysAgo: 1,
      subject: "Undeliverable: Quick question",
      from: { emailAddress: { address: "postmaster@acme.com" } },
      toRecipients: [{ emailAddress: { address: REP } }],
    });
    const selected = selectOutlookCandidates([dsn], ctx(), 10);
    expect(idsOf(selected)).toEqual(["dsn"]);
    expect(selected[0].isDirect).toBe(false);
  });

  it("an already-synced message whose body was purged is re-selected to restore it", () => {
    const m = msg({ id: "purged", daysAgo: 2 });
    const selected = selectOutlookCandidates(
      [m],
      ctx({
        alreadyStoredKeys: new Set([keyOf(m)]),
        bodyByDedupeKey: new Map([[keyOf(m), ""]]),
      }),
      10,
    );
    expect(idsOf(selected)).toEqual(["purged"]);
    expect(selected[0].restoresPurgedBody).toBe(true);
  });

  it("carries isDirect / isFromLead so the caller does not recompute them", () => {
    const inbound = msg({ id: "in", daysAgo: 1 });
    const outbound = msg({
      id: "out",
      daysAgo: 2,
      from: { emailAddress: { address: REP } },
      toRecipients: [{ emailAddress: { address: LEAD } }],
    });
    const selected = selectOutlookCandidates([inbound, outbound], ctx(), 10);
    expect(selected.map((s) => [s.messageId, s.isDirect, s.isFromLead])).toEqual([
      ["in", true, true],
      ["out", true, false],
    ]);
  });

  it("a Cc-only rep↔lead message still counts as direct (the widened search)", () => {
    const m = msg({
      id: "cc",
      daysAgo: 1,
      toRecipients: [{ emailAddress: { address: "someone@else.com" } }],
      ccRecipients: [{ emailAddress: { address: REP } }],
    });
    expect(idsOf(selectOutlookCandidates([m], ctx(), 10))).toEqual(["cc"]);
  });

  it("nothing eligible returns nothing — it does not fall back to raw candidates", () => {
    const drafts = Array.from({ length: 5 }, (_, i) => msg({ id: `d-${i}`, daysAgo: i, isDraft: true }));
    expect(selectOutlookCandidates(drafts, ctx(), 20)).toEqual([]);
  });
});
