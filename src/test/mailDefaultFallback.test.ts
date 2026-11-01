// Oct 2026: a workspace with a dead default Gmail + a connected Outlook kept
// showing "Reconnect Gmail" after Disconnect, and the composer found no
// account to send from. Source guards for the three pieces of the fix.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");

describe("mail account default + disconnect", () => {
  it("default-account fallback accepts any connected provider, not just Gmail", () => {
    const src = read("src/lib/mailProviders/MailProviderRouter.ts");
    const fallback = src.slice(src.indexOf("// Fallback: first connected account"));
    expect(fallback.slice(0, 400)).not.toContain('.eq("provider", "gmail")');
  });

  it("Gmail disconnect also disconnects its mail_accounts row and drops default", () => {
    const src = read("src/hooks/useGmailConnection.ts");
    expect(src).toMatch(/from\("mail_accounts"\)\s*\.update\(\{ status: "disconnected", is_default: false/);
  });

  it("Outlook disconnect drops default too", () => {
    expect(read("src/components/settings/OutlookConnectionCard.tsx")).toContain(
      '.update({ status: "disconnected", is_default: false })',
    );
  });
});
