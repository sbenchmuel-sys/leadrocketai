// Run: deno test --allow-read --allow-env supabase/functions/_shared/encryption.test.ts
//
// Guards the "OAuth tokens encrypted at rest with AES-256-GCM" product
// commitment: encryptToken must never return plaintext, and must fail closed
// (throw) when TOKEN_ENCRYPTION_KEY is missing instead of passing the token
// through.
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  assertEncryptionConfigured,
  decryptToken,
  encryptToken,
  isEncrypted,
} from "./encryption.ts";

const TEST_KEY = "unit-test-token-encryption-secret";
const SAMPLE_TOKEN = "ya29.a0AfH6SMC-sample-oauth-access-token-value";

// Preserve whatever the outer environment had so other test files are unaffected.
const ORIGINAL_KEY = Deno.env.get("TOKEN_ENCRYPTION_KEY");
function restoreKey() {
  if (ORIGINAL_KEY === undefined) Deno.env.delete("TOKEN_ENCRYPTION_KEY");
  else Deno.env.set("TOKEN_ENCRYPTION_KEY", ORIGINAL_KEY);
}

Deno.test("encryptToken never emits plaintext and round-trips through decryptToken", async () => {
  Deno.env.set("TOKEN_ENCRYPTION_KEY", TEST_KEY);
  try {
    const stored = await encryptToken(SAMPLE_TOKEN);

    // The stored value must not be (or contain) the plaintext token.
    assertNotEquals(stored, SAMPLE_TOKEN);
    assert(!stored.includes(SAMPLE_TOKEN), "ciphertext must not embed the plaintext token");

    // It must satisfy the same check the read path uses to detect encrypted values.
    assert(isEncrypted(stored), "stored value must pass isEncrypted()");

    assertEquals(await decryptToken(stored), SAMPLE_TOKEN);
  } finally {
    restoreKey();
  }
});

Deno.test("encryptToken produces a fresh IV per call (no deterministic ciphertext)", async () => {
  Deno.env.set("TOKEN_ENCRYPTION_KEY", TEST_KEY);
  try {
    const a = await encryptToken(SAMPLE_TOKEN);
    const b = await encryptToken(SAMPLE_TOKEN);
    assertNotEquals(a, b, "same plaintext must not encrypt to the same ciphertext");
  } finally {
    restoreKey();
  }
});

Deno.test("encryptToken fails closed when TOKEN_ENCRYPTION_KEY is missing", async () => {
  Deno.env.delete("TOKEN_ENCRYPTION_KEY");
  try {
    // It must THROW — returning the plaintext here would silently store
    // unencrypted tokens, which is exactly the regression this test pins.
    await assertRejects(() => encryptToken(SAMPLE_TOKEN), Error, "TOKEN_ENCRYPTION_KEY");
    assertThrows(() => assertEncryptionConfigured(), Error, "TOKEN_ENCRYPTION_KEY");
  } finally {
    restoreKey();
  }
});
