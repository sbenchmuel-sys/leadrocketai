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

/**
 * `lastEmail` is the newest lead_timeline_items email_outbound mirror row (null =
 * no mirror row). `authEmail` is the newest authoritative `interactions` outbound
 * email (undefined = same as the mirror, i.e. a consistent database).
 */
function stubTimelineClient(
  lastEmail: string | null,
  opts: {
    error?: boolean;            // mirror read fails
    authEmail?: string | null;  // authoritative answer when the mirror is empty
    authError?: boolean;        // authoritative read fails
    onQuery?: () => void;       // counts mirror reads
    onAuthQuery?: () => void;   // counts authoritative reads
  } = {},
) {
  const chain = (result: unknown, depth: number) => {
    // A tiny builder that swallows `depth` chained filter calls then resolves.
    let node: any = { maybeSingle: async () => result };
    node.limit = () => node;
    node.order = () => node;
    node.eq = () => node;
    node.in = () => node;
    node.select = () => node;
    void depth;
    return node;
  };
  return {
    from: (table: string) => {
      if (table === "lead_timeline_items") {
        opts.onQuery?.();
        return chain(opts.error
          ? { data: null, error: { message: "boom" } }
          : { data: lastEmail ? { occurred_at: lastEmail } : null, error: null }, 4);
      }
      if (table === "interactions") {
        opts.onAuthQuery?.();
        const auth = opts.authEmail === undefined ? lastEmail : opts.authEmail;
        return chain(opts.authError
          ? { data: null, error: { message: "authoritative boom" } }
          : { data: auth ? { occurred_at: auth } : null, error: null }, 5);
      }
      throw new Error(`unexpected table ${table}`);
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

// ── An ABSENT mirror row is not evidence (Codex P2) ─────────────────────────
// lead_timeline_items is a projection and a missing row is a supported failure
// mode. "Never emailed" and "the mirror lost the row" look identical there, and
// only the first may send inside the minimum gap. The authoritative record
// (`interactions`, written by gmail-send / outlook-send) separates them.

Deno.test("missing mirror row + an authoritative email inside the gap → BLOCKED", async () => {
  let mirrorReads = 0, authReads = 0;
  const emailAt = hoursAgo(3);
  const res = await checkEmailMinGap("lead-m1", hoursAgo(2), 16, stubTimelineClient(null, {
    authEmail: emailAt, onQuery: () => mirrorReads++, onAuthQuery: () => authReads++,
  }));
  assertEquals(res.allowed, false);          // previously: allowed → a second email inside the gap
  assertEquals(res.anchorAt, emailAt);       // anchored on the real email
  assertEquals(mirrorReads, 1);
  assertEquals(authReads, 1);                // consulted exactly once
});

Deno.test("missing mirror row + NO email anywhere in the authoritative record → ALLOWED", async () => {
  // The case this helper exists for: last touch was an SMS, never emailed.
  let authReads = 0;
  const res = await checkEmailMinGap("lead-m2", hoursAgo(2), 16, stubTimelineClient(null, {
    authEmail: null, onAuthQuery: () => authReads++,
  }));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, null);
  assertEquals(authReads, 1);
});

Deno.test("missing mirror row + the AUTHORITATIVE read errors → BLOCKED (fail closed)", async () => {
  const crossChannel = hoursAgo(2);
  const res = await checkEmailMinGap("lead-m3", crossChannel, 16, stubTimelineClient(null, {
    authError: true,
  }));
  assertEquals(res.allowed, false);
  assertEquals(res.anchorAt, crossChannel); // conservative block retained
});

Deno.test("a present mirror row answers on its own — no authoritative read", async () => {
  let authReads = 0;
  const emailAt = hoursAgo(40);
  const res = await checkEmailMinGap("lead-m4", hoursAgo(2), 16, stubTimelineClient(emailAt, {
    onAuthQuery: () => authReads++,
  }));
  assertEquals(res.allowed, true);
  assertEquals(res.anchorAt, emailAt);
  assertEquals(authReads, 0); // second read only when the first comes back empty
});

Deno.test("the cheap path still costs nothing: neither table is read when the gap already allows", async () => {
  let mirrorReads = 0, authReads = 0;
  const res = await checkEmailMinGap("lead-m5", hoursAgo(20), 16, stubTimelineClient(null, {
    onQuery: () => mirrorReads++, onAuthQuery: () => authReads++,
  }));
  assertEquals(res.allowed, true);
  assertEquals(mirrorReads, 0);
  assertEquals(authReads, 0);
});
