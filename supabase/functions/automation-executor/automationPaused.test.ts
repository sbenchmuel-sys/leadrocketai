// Deno test (npm run test:edge): the shared settings loader.
//
//  1. cadence_settings.automation_paused → ExecutionSettings.owner_automation_paused.
//     Only a literal boolean true pauses; anything else (missing, "true", 1)
//     leaves automation running. The field is named for its real blast radius:
//     workspace_profiles is UNIQUE(user_id), so the switch pauses the OWNER in
//     every workspace they belong to, not one workspace.
//  2. The timezone comes from THE workspace passed in, not an arbitrary
//     workspace_members row — an owner in two workspaces must get each
//     workspace's own send-window timezone, and an unknown id must yield null
//     (checkSendWindow then fails closed).
//
// Runs against a stub client.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { checkSendWindow, clearSettingsCache, loadExecutionSettings } from "../_shared/executionSettings.ts";

/** `timezones` maps workspace id → workspaces.timezone (missing id → no row). */
function stubClient(
  cadenceSettings: Record<string, unknown> | null,
  timezones: Record<string, string> = { ws: "UTC" },
) {
  const profileChain = {
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cadenceSettings ? { cadence_settings: cadenceSettings } : null, error: null }) }) }),
  };
  const wsChain = {
    select: () => ({
      eq: (_col: string, id: string) => ({
        maybeSingle: async () => ({ data: timezones[id] ? { timezone: timezones[id] } : null, error: null }),
      }),
    }),
  };
  return {
    from: (table: string) => {
      if (table === "workspace_profiles") return profileChain;
      if (table === "workspaces") return wsChain;
      throw new Error(`unexpected table ${table} — the loader must not read workspace_members any more`);
    },
  } as any;
}

Deno.test("owner_automation_paused defaults to false when the key is absent", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-a", stubClient({}), "ws");
  assertEquals(s.owner_automation_paused, false);
});

Deno.test("owner_automation_paused is true only for a literal boolean true", async () => {
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-b", stubClient({ automation_paused: true }), "ws")).owner_automation_paused, true);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-c", stubClient({ automation_paused: "true" }), "ws")).owner_automation_paused, false);
  clearSettingsCache();
  assertEquals((await loadExecutionSettings("owner-d", stubClient({ automation_paused: 1 }), "ws")).owner_automation_paused, false);
});

Deno.test("one owner in two workspaces gets each workspace's OWN timezone (not an arbitrary first pick)", async () => {
  clearSettingsCache();
  const client = stubClient({}, { "ws-ny": "America/New_York", "ws-syd": "Australia/Sydney" });
  const ny = await loadExecutionSettings("owner-multi", client, "ws-ny");
  const syd = await loadExecutionSettings("owner-multi", client, "ws-syd");
  assertEquals(ny.timezone, "America/New_York");
  assertEquals(syd.timezone, "Australia/Sydney");
});

Deno.test("an unknown workspace id yields no timezone and checkSendWindow fails closed", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-e", stubClient({}, { ws: "UTC" }), "ws-does-not-exist");
  assertEquals(s.timezone, null);
  assertEquals(checkSendWindow(s).allowed, false);
});

Deno.test("an empty workspace id never queries workspaces and fails closed", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-f", stubClient({}, {}), "");
  assertEquals(s.timezone, null);
  assertEquals(checkSendWindow(s).allowed, false);
});
