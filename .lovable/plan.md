
## Goal

Stop swallowing edge-function error bodies in the Outreach queue so the next time Cliff (or anyone) sees a failure it says *why* — "This lead replied", "Only the lead owner can act on this outreach", "Outreach is not active", "session expired", CAN-SPAM address missing — instead of the useless "Edge Function returned a non-2xx status code". Also self-heal the card on terminal 409s so it doesn't snap back only to fail again.

Same fix covers every rep action on every channel (LinkedIn, call, SMS, WhatsApp, email review), because they all funnel through the same `invokeAction` wrapper.

## Root cause (recap)

`src/lib/outreachQueue.ts::invokeAction` does:

```ts
if (error) return { ok: false, error: error.message };
```

`supabase.functions.invoke` returns a `FunctionsHttpError` for any non-2xx and does not parse the body. The `outreach-touch-action` edge function deliberately returns rich JSON at 400/403/404/409 (`{ ok:false, error:"...", replied?/inactive?/optedOut? }`) — all of it is discarded today.

## Changes

### 1. `src/lib/outreachQueue.ts` — rewrite `invokeAction`

Parse the JSON body out of `FunctionsHttpError`, surface the real message, and flag terminal states so the UI can drop the card:

```ts
import { FunctionsHttpError } from "@supabase/supabase-js";

type ActionResult = {
  ok: boolean;
  error?: string;
  terminal?: boolean; // enrollment gone (replied / inactive / optedOut) — don't restore
};

async function invokeAction(body: Record<string, unknown>): Promise<ActionResult> {
  const { data, error } = await supabase.functions.invoke("outreach-touch-action", { body });
  if (error) {
    let msg = error.message;
    let terminal = false;
    if (error instanceof FunctionsHttpError) {
      try {
        const parsed = await error.context.clone().json();
        if (parsed?.error) msg = String(parsed.error);
        if (parsed?.replied || parsed?.inactive || parsed?.optedOut) terminal = true;
      } catch { /* keep generic message */ }
    }
    // Mobile app-switch can drop the Supabase session; make that legible.
    if (/JWT|token|Not authenticated|401|Unauthorized/i.test(msg)) {
      msg = "Your session expired — sign in again.";
    }
    return { ok: false, error: msg, terminal };
  }
  if (data && (data as any).ok === false) return { ok: false, error: (data as any).error };
  return { ok: true };
}
```

### 2. `src/components/queue/OutreachCard.tsx` — honor `terminal` in `run`

Small tweak (~4 lines) so a terminal 409 keeps the card dismissed instead of restoring it just to fail again on the next tap:

```ts
async function run(fn, successMsg) {
  setBusy(true);
  onDone(touch.id);
  const res = await fn();
  setBusy(false);
  if (!res.ok) {
    if (!res.terminal) onRestore(touch.id);
    (res.terminal ? toast.info : toast.error)(res.error || "Something went wrong");
    return;
  }
  toast.success(successMsg);
}
```

`handleReviewSend` already special-cases the CAN-SPAM string; no other change needed there — it'll just start showing the real server text for other 4xx too via the wrapper.

## Out of scope

- No changes to `outreach-touch-action` edge function (status codes and JSON shape unchanged).
- No changes to `openLinkedinTouch`, `openChannelApp`, or any deep-link builder — the LinkedIn flow stays exactly as it is.
- No changes to `campaign-touch-executor`, reply-bridge, scheduler, or send/queue business logic.
- No changes to `QueueCard.tsx` (Reply / Follow-up tabs); scoped strictly to the Outreach tab.
- No new UI beyond the toast text and the terminal-drop branch.

## Files touched

- `src/lib/outreachQueue.ts` — extend `ActionResult`, rewrite `invokeAction`.
- `src/components/queue/OutreachCard.tsx` — thread `terminal` through the shared `run` helper.

## How this confirms or falsifies the LinkedIn diagnosis

The next time Cliff (or anyone) triggers the toast on any Outreach action, the toast text will be the real server message. Three possibilities and what each means:

- "This lead replied — handle it in your Queue." / "This outreach is no longer active for this lead." → my diagnosis (reply-bridge moved the enrollment while he was in the LinkedIn app) is correct; card auto-dismisses now.
- "Your session expired — sign in again." → the iOS app-switch session drop is the cause; card restores and he re-auths.
- Anything else → we have a specific string to investigate instead of the generic wrapper. Strictly better than today.
