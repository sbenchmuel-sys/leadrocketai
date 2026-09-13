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
import { checkEmailMinGap, checkMinGap, checkSendWindow, clearSettingsCache, loadExecutionSettings } from "../_shared/executionSettings.ts";

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

// ── Fail-closed behaviour (Codex round 3) ────────────────────────────────────

/** Profile read returns an ERROR (not "no row"); workspaces still succeeds. */
function stubClientProfileError() {
  return {
    from: (table: string) => {
      if (table === "workspace_profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) }) }) };
      }
      if (table === "workspaces") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { timezone: "UTC" }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

Deno.test("a workspace_profiles READ ERROR pauses the owner (fail closed), flagged as a read failure", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-err", stubClientProfileError(), "ws");
  assertEquals(s.owner_automation_paused, true);
  assertEquals(s.settings_read_failed, true);
  // The independent timezone read still succeeded — which is exactly how the
  // old code carried on through the send window and sent.
  assertEquals(s.timezone, "UTC");
  assertEquals(checkSendWindow(s).allowed, true);
});

Deno.test("a failed read is NOT cached — the next lead retries and a healthy read un-pauses", async () => {
  clearSettingsCache();
  const failed = await loadExecutionSettings("owner-retry", stubClientProfileError(), "ws");
  assertEquals(failed.owner_automation_paused, true);
  // Same owner + workspace, database recovered.
  const healthy = await loadExecutionSettings("owner-retry", stubClient({}), "ws");
  assertEquals(healthy.owner_automation_paused, false);
  assertEquals(healthy.settings_read_failed, false);
});

Deno.test("NO workspace_profiles row is 'never configured', not 'unreadable' — stays unpaused", async () => {
  clearSettingsCache();
  const s = await loadExecutionSettings("owner-new", stubClient(null), "ws");
  assertEquals(s.owner_automation_paused, false);
  assertEquals(s.settings_read_failed, false);
});

// ── checkEmailMinGap: the email gap must not count a text as an email ────────

/** `lastEmail` is the newest lead_timeline_items email_outbound, or null. */
function stubTimelineClient(lastEmail: string | null, opts: { error?: boolean; onQuery?: () => void } = {}) {
  return {
    from: (table: string) => {
      if (table !== "lead_timeline_items") throw new Error(`unexpected table ${table}`);
      opts.onQuery?.();
      return {
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({
          maybeSingle: async () => opts.error
            ? { data: null, error: { message: "boom" } }
            : { data: lastEmail ? { occurred_at: lastEmail } : null, error: null },
        }) }) }) }) }),
      };
    },
  } as any;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

Deno.test("no query at all when the cross-channel gap already allows the send", async () => {
  let queried = 0;
  const res = await checkEmailMinGap("lead-1", hoursAgo(20), 16, stubTimelineClient(null, { onQuery: () => queried++ }));
  assertEquals(res.allowed, true);
  assertEquals(queried, 0);
});

Deno.test("an SMS two hours ago no longer defers the next EMAIL", async () => {
  // last_outbound_at is 2h old (the SMS, which sms-send stamps), but the last
  // EMAIL was 40h ago — well outside the 16h email gap.
  const smsAt = hoursAgo(2);
  const lastEmail = hoursAgo(40);
  const res = await checkEmailMinGap("lead-2", smsAt, 16, stubTimelineClient(lastEmail));
  assertEquals(res.allowed, true);
  // Anchored on the email, never on the text.
  assertEquals(res.anchorAt, lastEmail);
  // Sanity: the old cross-channel behaviour would have blocked this send.
  assertEquals(checkMinGap(smsAt, 16).allowed, false);
});

Deno.test("a real EMAIL inside the gap still defers, anchored on that email", async () => {
  const lastEmail = hoursAgo(3);
  const res = await checkEmailMinGap("lead-3", hoursAgo(2), 16, stubTimelineClient(lastEmail));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, lastEmail);
});

Deno.test("a lead that has never been emailed is not held by someone else's channel", async () => {
  const res = await checkEmailMinGap("lead-4", hoursAgo(1), 16, stubTimelineClient(null));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, null);
});

Deno.test("a failed last-email lookup keeps the conservative block (fail closed)", async () => {
  const crossChannel = hoursAgo(1);
  const res = await checkEmailMinGap("lead-5", crossChannel, 16, stubTimelineClient(null, { error: true }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, crossChannel);
});
