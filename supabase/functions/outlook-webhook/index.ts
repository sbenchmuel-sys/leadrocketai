// ============================================================
// outlook-webhook — Graph change notification receiver (entry)
//
// This file is intentionally tiny.
//
// Microsoft Graph's subscription validation handshake is a POST
// (empty body) with ?validationToken=... and a strict ~10s timeout. If our
// Edge Function cold-starts beyond that, Graph returns a
// BadGateway error and the subscription create/update fails.
//
// To keep cold-start minimal, this entry module only imports
// `serve` at the top level. All POST-path dependencies
// (createClient, OOO/meeting/unsubscribe detection, token
// refresh, canonical interactions, etc.) live in ./processor.ts
// and are loaded via dynamic import() inside the POST handler.
// The validation path therefore never pays for them.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { graphValidationResponse } from "../_shared/graphValidation.ts";

serve(async (req) => {
  // ── 1. Validation handshake (POST or GET ?validationToken=...) ──
  // Must be checked before any body parsing: Graph's POST has an empty
  // body, so the notification path below would swallow it and reply "OK".
  const validation = graphValidationResponse(req);
  if (validation) return validation;
  if (req.method === "GET") return new Response("OK", { status: 200 });

  // ── 2. Notification POST — always returns 200 to Graph ──
  // Errors must never surface as HTTP failures, or Graph will
  // start deactivating the subscription after repeated failures.
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    const notifications = (body as { value?: unknown[] })?.value ?? [];
    if (notifications.length > 0) {
      // Lazy-load the heavy processor on first POST. Cached by the
      // Deno isolate after this, so subsequent POSTs are fast.
      const { handleNotifications } = await import("./processor.ts");
      // Fire-and-forget — we always 200 immediately so Graph never
      // sees a slow response. Processor handles its own errors.
      handleNotifications(notifications).catch((err) => {
        console.error("[outlook-webhook] handleNotifications threw:", err);
      });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[outlook-webhook] fatal:", err);
    return new Response("OK", { status: 200 });
  }
});
