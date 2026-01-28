/**
 * Application-level encryption for sensitive data (OAuth tokens)
 * Uses AES-256-GCM for authenticated encryption
 */

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 128; // 128 bits auth tag

/**
 * Derives a CryptoKey from the encryption secret
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("TOKEN_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  }

  // Use SHA-256 to derive a 256-bit key from the secret
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(secret));

  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a plaintext string and returns base64-encoded ciphertext
 * Format: base64(iv + ciphertext + authTag)
 */
export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    encoder.encode(plaintext)
  );

  // Combine IV + ciphertext (includes auth tag) for storage
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // Return as base64 for safe storage
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a base64-encoded ciphertext and returns the plaintext
 */
export async function decryptToken(encryptedBase64: string): Promise<string> {
  const key = await getEncryptionKey();

  // Decode from base64
  const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

  // Extract IV and ciphertext
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Checks if a value appears to be encrypted (base64 with expected length)
 * Used to handle migration from plaintext to encrypted tokens
 */
export function isEncrypted(value: string): boolean {
  // Encrypted tokens are base64 and longer due to IV + auth tag overhead
  // A typical access token is ~150 chars, encrypted would be ~200+ chars base64
  // We check if it looks like base64 and has the right structure
  try {
    if (value.length < 50) return false;
    const decoded = atob(value);
    // IV (12 bytes) + at least some ciphertext + auth tag (16 bytes)
    return decoded.length >= IV_LENGTH + 16 + 10;
  } catch {
    // If atob fails, it's not valid base64 (probably a raw token)
    return false;
  }
}

/**
 * Safely decrypts a token, handling both encrypted and plaintext values
 * for backwards compatibility during migration
 */
export async function safeDecryptToken(value: string): Promise<string> {
  // Check if TOKEN_ENCRYPTION_KEY is configured
  const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
  
  if (!hasKey) {
    // No encryption configured, return as-is
    console.warn("[encryption] TOKEN_ENCRYPTION_KEY not configured, using plaintext tokens");
    return value;
  }

  if (!isEncrypted(value)) {
    // Value appears to be plaintext (legacy token), return as-is
    console.log("[encryption] Token appears to be plaintext (legacy), using as-is");
    return value;
  }

  try {
    return await decryptToken(value);
  } catch (err) {
    // Decryption failed - might be a plaintext token that looked like base64
    console.warn("[encryption] Decryption failed, treating as plaintext:", err);
    return value;
  }
}
