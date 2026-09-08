// Deno test (npm run test:edge): cadence_settings.automation_paused is read by the
// shared settings loader — only a literal boolean true pauses; anything else
// (missing, "true", 1) leaves automation running. Runs against a stub client.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { clearSettingsCache, loadExecutionSettings } from "../_shared/executionSettings.ts";

function stubClient(cadenceSettings: Record<string, unknown> | null) {
  const profileChain = {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cadenceSettings ? { cadence_settings: cadenceSettings } : null, error: null }) }) }),
  };
  const memberChain = {
    select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { workspace_id: "ws", workspaces: { timezone: "UTC" } }, error: null }) }) }) }),
  };
  return { from: (table: string) => (table === "workspace_profiles" ? profileChain : memberChain) } as any;
}

Deno.test("automation_paused defaults to false when the key is absent", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-a", stubClient({}));
  assertEquals(s.automation_paused, false);
});

Deno.test("automation_paused is true only for a literal boolean true", async () => {
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-b", stubClient({ automation_paused: true }))).automation_paused, true);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-c", stubClient({ automation_paused: "true" }))).automation_paused, false);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-d", stubClient({ automation_paused: 1 }))).automation_paused, false);
});
