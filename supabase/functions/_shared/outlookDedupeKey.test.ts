// Run: deno test supabase/functions/_shared/outlookDedupeKey.test.ts
//
// BEHAVIOURAL (Unit G-B, finding 2). Both Outlook writers — outlook-sync and
// outlook-webhook/processor — call this function with the values their own API
// response gives them. This asserts they land on the SAME key for the same
// message, which is what stops the email being stored twice.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { outlookEmailDedupeKey } from "./timelineProjector.ts";

const MSG_ID = "<AAB1C2D3@acme.com>";
const GRAPH_ID = "AAMkADkzNzFlNzAzLTIzY2EtNGIwZi1iNDc3";

Deno.test("webhook and sync agree on the key for the same message", () => {
  // outlook-sync passes (internetMessageId, graph id, fallback interaction id).
  const fromSync = outlookEmailDedupeKey(MSG_ID, GRAPH_ID, "interaction-uuid");
  // outlook-webhook passes (internetMessageId, graph id, graph id).
  const fromWebhook = outlookEmailDedupeKey(MSG_ID, GRAPH_ID, GRAPH_ID);
  assertEquals(fromSync, fromWebhook);
  assertEquals(fromSync, `outlook:${MSG_ID}`);
});

Deno.test("they still agree when Graph gives no internetMessageId", () => {
  const fromSync = outlookEmailDedupeKey(null, GRAPH_ID, "interaction-uuid");
  const fromWebhook = outlookEmailDedupeKey(null, GRAPH_ID, GRAPH_ID);
  assertEquals(fromSync, fromWebhook);
  // Namespaced, so a graph id can never be confused with a Message-ID.
  assertEquals(fromSync, `outlook:graph:${GRAPH_ID}`);
});

Deno.test("the graph fallback is namespaced away from the Message-ID form", () => {
  assertEquals(
    outlookEmailDedupeKey(null, GRAPH_ID, "x") === outlookEmailDedupeKey(GRAPH_ID, null, "x"),
    false,
  );
});

Deno.test("no key is ever the legacy webhook shape", () => {
  for (
    const key of [
      outlookEmailDedupeKey(MSG_ID, GRAPH_ID, "x"),
      outlookEmailDedupeKey(null, GRAPH_ID, "x"),
      outlookEmailDedupeKey(null, null, "x"),
    ]
  ) {
    assertEquals(key.startsWith("outlook:webhook:"), false, key);
  }
});
