// ============================================================
// Twilio Signature Validation — X-Twilio-Signature HMAC-SHA1
// https://www.twilio.com/docs/usage/security#validating-requests
// ============================================================

/**
 * Validate a Twilio webhook signature.
 * @param authToken  Your Twilio Auth Token
 * @param signature  The X-Twilio-Signature header value
 * @param url        The full webhook URL Twilio called (including scheme, host, path)
 * @param params     The POST body parameters as key-value pairs
 */
export async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!authToken || !signature || !url) return false;

  // 1. Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  // 2. HMAC-SHA1 using the auth token
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(data));

  // 3. Base64 encode
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  // 4. Constant-time comparison
  return timingSafeEqual(computed, signature);
}

/** Constant-time string comparison to prevent timing attacks */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
