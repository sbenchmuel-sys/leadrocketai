import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeLoginEmail } from "./loginCode.ts";

Deno.test("normalizeLoginEmail trims and lowercases a real address", () => {
  assertEquals(normalizeLoginEmail("  Cliff@PayThings.com "), "cliff@paythings.com");
});

Deno.test("normalizeLoginEmail rejects junk, lists and non-strings", () => {
  for (const bad of ["", "cliff", "cliff@", "@paythings.com", "a@b", "a@b.com, c@d.com", "a b@c.com", "<a@b.com>", null, 42]) {
    assertEquals(normalizeLoginEmail(bad), null, String(bad));
  }
  assertEquals(normalizeLoginEmail("a".repeat(250) + "@b.com"), null);
});
