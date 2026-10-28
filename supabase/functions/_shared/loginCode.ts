/**
 * Input check for "Email me a code" sign-in (request-login-code edge function).
 * Trims + lowercases (workspace_invitations.email is stored lowercase) and rejects
 * anything that isn't a plausible single address before it reaches Supabase Auth.
 */
export function normalizeLoginEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/.test(email) ? email : null;
}
