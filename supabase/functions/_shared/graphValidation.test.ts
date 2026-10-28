import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { graphValidationResponse } from "./graphValidation.ts";

const URL_BASE = "https://x.supabase.co/functions/v1/outlook-webhook";

// The bug (Oct 2026): only GET echoed the token, but Graph validates with a
// POST, so every subscription CREATE failed and accounts were marked 'error'.
Deno.test("echoes validationToken on POST (how Graph actually validates)", async () => {
  const req = new Request(`${URL_BASE}?validationToken=abc%3D123`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "",
  });
  const resp = graphValidationResponse(req)!;
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "text/plain");
  assertEquals(await resp.text(), "abc=123");
});

Deno.test("echoes validationToken on GET too", async () => {
  const resp = graphValidationResponse(new Request(`${URL_BASE}?validationToken=t`))!;
  assertEquals(await resp.text(), "t");
});

Deno.test("returns null for a normal notification POST", () => {
  const req = new Request(URL_BASE, { method: "POST", body: '{"value":[]}' });
  assertEquals(graphValidationResponse(req), null);
});
