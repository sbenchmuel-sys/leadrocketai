// Run: deno test supabase/functions/_shared/outreachUnsubscribeToken.test.ts
//
// The CAN-SPAM one-click unsubscribe link is PUBLIC and unauthenticated — its
// entire security is the signed token. These tests pin: a valid token verifies, a
// tampered/forged token is rejected, verification FAILS CLOSED when the secret is
// unset, and the token is never just a raw lead id.
import { assertEquals, assertNotEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribePayload,
} from "./outreachUnsubscribeToken.ts";

const SECRET = "test-unsubscribe-secret-aaaaaaaaaaaaaaaa";
const OTHER_SECRET = "different-secret-bbbbbbbbbbbbbbbbbbbbbbbb";
const payload: UnsubscribePayload = { lid: "lead-123", wid: "ws-9", cid: "camp-7", iat: 1_700_000_000 };

Deno.test("valid token round-trips back to its payload", async () => {
  const token = await signUnsubscribeToken(payload, SECRET);
  const out = await verifyUnsubscribeToken(token, SECRET);
  assertEquals(out, payload);
});

Deno.test("a tampered PAYLOAD is rejected", async () => {
  // Pair payload B's body with payload A's signature → the HMAC no longer matches.
  const tokenA = await signUnsubscribeToken(payload, SECRET);
  const tokenB = await signUnsubscribeToken({ ...payload, lid: "lead-999" }, SECRET);
  const forged = tokenB.split(".")[0] + "." + tokenA.split(".")[1];
  assertEquals(await verifyUnsubscribeToken(forged, SECRET), null);
});

Deno.test("a tampered SIGNATURE is rejected", async () => {
  const token = await signUnsubscribeToken(payload, SECRET);
  const [body, sig] = token.split(".");
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assertEquals(await verifyUnsubscribeToken(`${body}.${flipped}`, SECRET), null);
});

Deno.test("a token forged under a DIFFERENT secret is rejected", async () => {
  const token = await signUnsubscribeToken(payload, OTHER_SECRET);
  assertEquals(await verifyUnsubscribeToken(token, SECRET), null);
});

Deno.test("verify FAILS CLOSED when the secret is unset (never an open door)", async () => {
  const token = await signUnsubscribeToken(payload, SECRET);
  assertEquals(await verifyUnsubscribeToken(token, ""), null);
});

Deno.test("sign refuses to issue a token with no secret", async () => {
  await assertRejects(() => signUnsubscribeToken(payload, ""), Error, "UNSUBSCRIBE_TOKEN_SECRET");
});

Deno.test("a raw lead id is NOT a valid token", async () => {
  // The link must carry a signed token, never an enumerable raw lead id.
  const token = await signUnsubscribeToken(payload, SECRET);
  assertNotEquals(token, payload.lid);
  assertEquals(await verifyUnsubscribeToken(payload.lid, SECRET), null);
  // A bare body with no signature part is also rejected.
  assertEquals(await verifyUnsubscribeToken(token.split(".")[0], SECRET), null);
});

Deno.test("malformed tokens are rejected", async () => {
  for (const bad of ["", ".", "abc", "abc.", ".abc", "a.b.c.d"]) {
    assertEquals(await verifyUnsubscribeToken(bad, SECRET), null);
  }
});

Deno.test("a validly-signed but structurally-wrong payload is rejected", async () => {
  // Missing required lid/wid → even a correct signature must not verify.
  const bad = await signUnsubscribeToken({ foo: "bar" } as unknown as UnsubscribePayload, SECRET);
  assertEquals(await verifyUnsubscribeToken(bad, SECRET), null);
});
