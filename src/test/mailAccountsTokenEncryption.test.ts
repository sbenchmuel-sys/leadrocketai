// Static guard for the "OAuth tokens encrypted at rest with AES-256-GCM"
// product commitment (see CLAUDE.md). It scans every edge-function write to
// the OAuth-token tables (mail_accounts, gmail_connections) and fails if a
// token column is ever assigned a value that does not provably come from the
// shared encryptToken() helper (supabase/functions/_shared/encryption.ts).
//
// What it catches:
//   - a new write path that stores a raw OAuth token
//   - reintroducing the fail-open pattern `hasKey ? encryptToken(x) : x`
//     (any ternary / Promise.resolve / safeDecryptToken in the value's
//     declaration fails the guard)
//
// Runs in the default unit suite (`npm test`) so a regression is caught
// before merge, not at deploy time.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FUNCTIONS_ROOT = path.resolve(__dirname, "../../supabase/functions");
// Token-bearing tables and their token column names.
const TOKEN_TABLES: Record<string, string[]> = {
  mail_accounts: ["access_token", "refresh_token"],
  gmail_connections: ["access_token_encrypted", "refresh_token_encrypted"],
};
// TS type annotations (interface members) and token-clearing writes are fine.
const ALLOWED_NON_ENCRYPTED_VALUES = new Set(["null", "undefined"]);
const TYPE_KEYWORDS = new Set(["string", "number", "boolean", "any", "unknown", "never"]);

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Extracts the argument text of every .insert/.update/.upsert chained onto
 *  .from("<table>"). Select-only usage is ignored. */
function extractWritePayloads(source: string, table: string): string[] {
  const payloads: string[] = [];
  const fromRe = new RegExp(String.raw`\.from\(\s*["'\`]${table}["'\`]\s*\)`, "g");
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source))) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i])) i++;
    const writeMatch = source.slice(i).match(/^\.(insert|update|upsert)\s*\(/);
    if (!writeMatch) continue;
    // Balance parentheses to capture the full argument list.
    let j = i + writeMatch[0].length;
    let depth = 1;
    const start = j;
    while (j < source.length && depth > 0) {
      if (source[j] === "(") depth++;
      else if (source[j] === ")") depth--;
      j++;
    }
    payloads.push(source.slice(start, j - 1));
  }
  return payloads;
}

/** Finds EVERY declaration of `identifier` in the file and returns the start
 *  of each right-hand side (300 chars), handling array destructuring like
 *  `const [encAccess, encRefresh] = await Promise.all([...])`. The guard has
 *  no scope analysis, so a name declared in several functions is checked
 *  conservatively: all declarations must be safe. */
function declarationRhs(source: string, identifier: string): string[] {
  const declRe = new RegExp(
    String.raw`(?:const|let|var)\s+(?:\[[^\]]*\b${identifier}\b[^\]]*\]|${identifier}\b)\s*(?::[^=\n]+)?=\s*`,
    "g",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source))) {
    out.push(source.slice(m.index + m[0].length, m.index + m[0].length + 300));
  }
  return out;
}

interface TokenWrite {
  file: string;
  table: string;
  column: string;
  value: string;
}

function findTokenWrites(): { writes: TokenWrite[]; violations: string[] } {
  const writes: TokenWrite[] = [];
  const violations: string[] = [];

  for (const file of collectSourceFiles(FUNCTIONS_ROOT)) {
    const source = readFileSync(file, "utf8");
    const rel = path.relative(FUNCTIONS_ROOT, file).replace(/\\/g, "/");

    for (const [table, columns] of Object.entries(TOKEN_TABLES)) {
      for (const payload of extractWritePayloads(source, table)) {
        for (const column of columns) {
          const assignRe = new RegExp(String.raw`\b${column}\s*:\s*([^,}\n]+)`, "g");
          let a: RegExpExecArray | null;
          while ((a = assignRe.exec(payload))) {
            const value = a[1].trim();
            if (TYPE_KEYWORDS.has(value.split(/\s|\|/)[0])) continue; // type annotation, not a value
            writes.push({ file: rel, table, column, value });

            if (ALLOWED_NON_ENCRYPTED_VALUES.has(value)) continue;

            // Inline call is fine — access_token: await encryptToken(x) — but
            // only when unconditional: an inline ternary / Promise.resolve /
            // safeDecryptToken is the fail-open pattern in expression form
            // (e.g. `hasKey ? await encryptToken(x) : x`).
            if (value.includes("encryptToken(")) {
              if (/[?]/.test(value) || value.includes("Promise.resolve") || value.includes("safeDecryptToken")) {
                violations.push(
                  `${rel}: ${table}.${column} inline expression "${value}" is only conditionally encrypted (fail-open pattern) — encryption must be unconditional`,
                );
              }
              continue;
            }

            // Otherwise the value must be an identifier whose declaration is an
            // unconditional encryptToken() result.
            const identMatch = value.match(/^[A-Za-z_$][\w$]*$/);
            if (!identMatch) {
              violations.push(
                `${rel}: ${table}.${column} is assigned expression "${value}" — route it through encryptToken() from _shared/encryption.ts`,
              );
              continue;
            }
            const rhsList = declarationRhs(source, value);
            if (rhsList.length === 0) {
              violations.push(
                `${rel}: cannot find the declaration of "${value}" assigned to ${table}.${column} — the guard cannot prove it is encrypted`,
              );
              continue;
            }
            for (const rhs of rhsList) {
              if (!rhs.includes("encryptToken(")) {
                violations.push(
                  `${rel}: ${table}.${column} is assigned "${value}" with a declaration not derived from encryptToken() — plaintext token write`,
                );
              } else if (/[?]/.test(rhs) || rhs.includes("Promise.resolve") || rhs.includes("safeDecryptToken")) {
                violations.push(
                  `${rel}: ${table}.${column} value "${value}" is only conditionally encrypted (fail-open pattern) — encryption must be unconditional`,
                );
              }
            }
          }
        }
      }
    }
  }
  return { writes, violations };
}

describe("OAuth token writes are always encrypted (mail_accounts + gmail_connections)", () => {
  const { writes, violations } = findTokenWrites();

  it("scanner sanity: token-writing paths exist and were found", () => {
    // mail_accounts: gmail-callback, outlook-callback, gmail-sync,
    // calendar-sync and _shared/outlookTokens.ts write both token columns.
    // gmail_connections: gmail-callback, gmail-sync, gmail-send,
    // gmail-bulk-sync, calendar-sync, backfill-inbound-summaries,
    // detect-lead-candidates, lookback-seed-candidates, meet-transcript-fetch
    // write at least the access-token column. If this count collapses the
    // scanner broke (or the writes moved) — fix the scan, don't delete the
    // guard.
    const byTable = (t: string) => writes.filter((w) => w.table === t).length;
    expect(byTable("mail_accounts")).toBeGreaterThanOrEqual(8);
    expect(byTable("gmail_connections")).toBeGreaterThanOrEqual(8);
  });

  it("no write path stores a plaintext or conditionally-encrypted token", () => {
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
