// ============================================================================
// Outreach unsubscribe token (Outreach Unit C, PR 2)
//
// The CAN-SPAM one-click unsubscribe link is PUBLIC and unauthenticated — email
// clients open it with no session. Its entire security rests on a SIGNED token,
// never a raw lead_id (which could be guessed/enumerated to unsubscribe arbitrary
// leads). The token is an HMAC-SHA256 over a small payload, keyed by a server-only
// secret (UNSUBSCRIBE_TOKEN_SECRET). Forging one requires the secret.
//
// CAN-SPAM requires the link to keep working for at least 30 days after send, so
// `iat` is carried for audit/rotation only — verification does NOT expire on it.
//
// The sign/verify functions take the secret as a parameter so they're pure and
// unit-testable (Web Crypto exists in both Deno and Node). getUnsubscribeSecret()
// reads the env. If the secret is unset, verify FAILS CLOSED (rejects every
// token) rather than accepting — a missing secret must never become an open door.
// ============================================================================

export interface UnsubscribePayload {
  lid: string; // lead_id
  wid: string; // workspace_id
  cid: string | null; // campaign_id (audit; not required to act)
  iat: number; // issued-at epoch seconds (audit/rotation only — NOT a TTL)
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a payload → `base64url(payloadJSON).base64url(hmac)`. Throws if secret is blank. */
export async function signUnsubscribeToken(payload: UnsubscribePayload, secret: string): Promise<string> {
  if (!secret) throw new Error("UNSUBSCRIBE_TOKEN_SECRET is not set");
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
  return `${b64urlFromBytes(payloadBytes)}.${b64urlFromBytes(sig)}`;
}

/**
 * Verify a token and return its payload, or null if invalid/forged/tampered.
 * Uses crypto.subtle.verify (constant-time). Fails closed when the secret is
 * unset — every token is rejected, never accepted.
 */
export async function verifyUnsubscribeToken(token: string, secret: string): Promise<UnsubscribePayload | null> {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  try {
    const payloadBytes = bytesFromB64url(token.slice(0, dot));
    const sigBytes = bytesFromB64url(token.slice(dot + 1));
    const key = await importHmacKey(secret);
    // Cast to BufferSource: these are freshly-built ArrayBuffer-backed byte
    // arrays; the assertion only resolves the Uint8Array<ArrayBufferLike> vs
    // BufferSource friction in newer TS/Deno libs — no runtime change.
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes as BufferSource, payloadBytes as BufferSource);
    if (!valid) return null;
    const obj = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!obj || typeof obj.lid !== "string" || typeof obj.wid !== "string") return null;
    return obj as UnsubscribePayload;
  } catch {
    return null;
  }
}

/** Read the server-only secret (Deno edge runtime). Empty string if unset. */
export function getUnsubscribeSecret(): string {
  try {
    // @ts-ignore Deno global is present in the edge runtime
    return (globalThis as any).Deno?.env?.get("UNSUBSCRIBE_TOKEN_SECRET") ?? "";
  } catch {
    return "";
  }
}
