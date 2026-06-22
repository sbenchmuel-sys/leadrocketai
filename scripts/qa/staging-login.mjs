#!/usr/bin/env node
// QA helper: mint a real staging session for a test user so the unattended UI
// run can authenticate WITHOUT driving the login form (Google SSO 404s on the
// static Vercel deploy, and typing into the form is flaky headless).
//
// ZERO DEPENDENCIES: talks to the Supabase auth REST endpoint with Node's
// built-in fetch (Node 18+). It does NOT import @supabase/supabase-js, so it
// runs in any sandbox with only `node` present — independent of the
// node_modules / vitest install situation.
//
// It reconstructs the exact localStorage key+value the app's supabase-js client
// persists (`sb-<ref>-auth-token` → the session JSON), so injecting that pair
// into the browser and reloading lands a fully-authenticated session.
//
// Usage:
//   node scripts/qa/staging-login.mjs            # user A (default)
//   node scripts/qa/staging-login.mjs --user b   # user B
//   node scripts/qa/staging-login.mjs --json     # machine-readable: {key,value,access_token,...}
//
// Reads the gitignored .env.staging (same vars as `npm run test:isolation`):
//   SUPABASE_URL, SUPABASE_ANON_KEY,
//   TEST_USER_A_EMAIL / TEST_USER_B_EMAIL, TEST_USER_PASSWORD
//
// No secrets live in this file. Output contains live tokens — do not commit it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAGING_REF = "jhipmqdpjenojfhfjgzq";

function loadDotenv(file) {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    throw new Error(
      `[staging-login] ${file} not found. This helper needs the gitignored ${file} ` +
        `with staging creds + TEST_USER_* values. See CLAUDE.md "Running tests".`,
    );
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const userArg = (args[args.indexOf("--user") + 1] || "a").toLowerCase();
  const who = userArg === "b" ? "B" : "A";

  if (typeof fetch !== "function") {
    throw new Error("[staging-login] needs Node 18+ (global fetch is unavailable).");
  }

  loadDotenv(".env.staging");

  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anon = process.env.SUPABASE_ANON_KEY ?? "";
  const email = process.env[`TEST_USER_${who}_EMAIL`] ?? "";
  const password = process.env.TEST_USER_PASSWORD ?? "";

  // SAFETY: never authenticate against anything but staging.
  if (!url.includes(STAGING_REF)) {
    throw new Error(
      `[staging-login] SAFETY ABORT: SUPABASE_URL ("${url}") does not target the ` +
        `staging ref ${STAGING_REF}. This helper must never run against production.`,
    );
  }
  if (!anon || !email || !password) {
    throw new Error(
      `[staging-login] Missing creds. Need SUPABASE_ANON_KEY, TEST_USER_${who}_EMAIL, ` +
        `TEST_USER_PASSWORD in .env.staging.`,
    );
  }

  // Derive the project ref from the URL host (e.g. jhipmqdpjenojfhfjgzq.supabase.co).
  const ref = new URL(url).hostname.split(".")[0];

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` },
    body: JSON.stringify({ email, password }),
  });
  const tok = await res.json();
  if (!res.ok || !tok?.access_token) {
    const msg = tok?.error_description || tok?.msg || tok?.error || `HTTP ${res.status}`;
    throw new Error(`[staging-login] sign-in failed: ${msg}`);
  }

  // Reconstruct exactly what supabase-js persists: the session JSON under
  // sb-<ref>-auth-token. The token response already carries every field; we only
  // backfill expires_at if the gotrue version omitted it.
  const session = { ...tok };
  if (!session.expires_at) {
    session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);
  }
  const storageKey = `sb-${ref}-auth-token`;
  const storageValue = JSON.stringify(session);

  // A self-contained snippet to run in the browser console / agent eval ON THE
  // STAGING ORIGIN. It seeds the session and reloads into an authenticated app.
  const snippet =
    `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(storageValue)}); location.assign('/app');`;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          user: who,
          email,
          userId: tok.user?.id,
          storageKey,
          storageValue,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: session.expires_at,
          snippet,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n✅ Signed in as Test Dealership ${who} (${email})`);
  console.log(`   user id: ${tok.user?.id}\n`);
  console.log(`To log the UI run in, navigate to https://drivepilot-staging.vercel.app`);
  console.log(`then eval this snippet in the page (it seeds the session and opens /app):\n`);
  console.log(snippet + "\n");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
