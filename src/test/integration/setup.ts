// Integration-test setup: load the gitignored .env.staging into process.env and
// HARD-GUARD that we are pointed at the staging project, never production.
// No secrets live in this file — they are read from .env.staging at runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STAGING_REF = "jhipmqdpjenojfhfjgzq";

function loadDotenv(file: string) {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    throw new Error(
      `[integration setup] ${file} not found. Integration tests need the gitignored ` +
        `${file} with staging creds + TEST_USER_* values. See CLAUDE.md "Running tests".`,
    );
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue; // skip comments/blanks
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv(".env.staging");

// Safety: refuse to run if the target is not staging (protects production).
const url = process.env.SUPABASE_URL ?? "";
if (!url.includes(STAGING_REF)) {
  throw new Error(
    `[integration setup] SAFETY ABORT: SUPABASE_URL ("${url}") does not target the ` +
      `staging ref ${STAGING_REF}. Integration tests must never run against production.`,
  );
}
