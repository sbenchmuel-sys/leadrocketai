// Oct 2026 bug: mail-only callers refreshed the shared Outlook token with
// mail scopes, so calendar-sync / teams-transcript-fetch reused a token that
// could no longer read calendars or transcripts (403 → "NOT_ORGANIZER" for
// the actual organizer). Refresh must ask for every granted scope, and must
// still succeed (narrow) if Microsoft refuses the wider set.
import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { outlookRefreshScope } from "./outlookScopes.ts";
import { OutlookGraphClient } from "./outlookGraphClient.ts";

const GRANTED = ["Calendars.Read", "Mail.Read", "OnlineMeetingTranscript.Read.All", "User.Read", "openid"];
const MAIL = "Mail.Read Mail.ReadWrite Mail.Send offline_access User.Read";

Deno.test("refresh scope = granted scopes + offline_access", () => {
  assertEquals(
    outlookRefreshScope(GRANTED, MAIL),
    "Calendars.Read Mail.Read OnlineMeetingTranscript.Read.All User.Read openid offline_access",
  );
});

Deno.test("refresh scope falls back when grants are unknown", () => {
  assertEquals(outlookRefreshScope(null, MAIL), MAIL);
  assertEquals(outlookRefreshScope([], MAIL), MAIL);
  assertEquals(outlookRefreshScope(["", "  "], MAIL), MAIL);
});

function stubTokenEndpoint(refuseIfScopeIncludes: string | null) {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    const scope = new URLSearchParams(String(init?.body)).get("scope") ?? "";
    sent.push(scope);
    if (refuseIfScopeIncludes === null || scope.includes(refuseIfScopeIncludes)) {
      return Promise.resolve(new Response('{"error":"invalid_grant","error_description":"AADSTS65001"}', { status: 400 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }), { status: 200 }));
  }) as typeof fetch;
  Deno.env.set("MICROSOFT_CLIENT_ID", "id");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret");
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}

Deno.test("refresh asks for all granted scopes first", async () => {
  const { sent, restore } = stubTokenEndpoint("NEVER");
  try {
    await OutlookGraphClient.refreshTokenWithGrantedScopes("rt", GRANTED, MAIL);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].includes("OnlineMeetingTranscript.Read.All"), true);
  } finally { restore(); }
});

Deno.test("refused wide scope retries once with the caller's scope", async () => {
  const { sent, restore } = stubTokenEndpoint("OnlineMeetingTranscript");
  try {
    const t = await OutlookGraphClient.refreshTokenWithGrantedScopes("rt", GRANTED, MAIL);
    assertEquals(t.access_token, "a");
    assertEquals(sent, [outlookRefreshScope(GRANTED, MAIL), MAIL]);
  } finally { restore(); }
});

Deno.test("a dead refresh token still throws", async () => {
  const { restore } = stubTokenEndpoint(null);
  try {
    await assertRejects(() => OutlookGraphClient.refreshTokenWithGrantedScopes("rt", GRANTED, MAIL));
  } finally { restore(); }
});
