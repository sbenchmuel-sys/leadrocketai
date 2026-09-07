// Run: deno test supabase/functions/_shared/linkedinLookup.test.ts
//
// Pins the fail-closed matcher behind enrich-lead-linkedin: a URL is saved to a
// lead only when exactly one profile carries the lead's name (company breaks a
// tie). Anything ambiguous must return null — a wrong profile means the rep
// messages a stranger.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { linkedinSearchQuery, normalizeProfileUrl, pickLinkedinProfile } from "./linkedinLookup.ts";

const r = (title: string, link: string, snippet = "") => ({ title, link, snippet });

Deno.test("linkedinSearchQuery quotes the name and the company when known", () => {
  assertEquals(linkedinSearchQuery(" Dana Cohen ", "Acme Motors"), 'site:linkedin.com/in "Dana Cohen" "Acme Motors"');
  assertEquals(linkedinSearchQuery("Dana Cohen", "  "), 'site:linkedin.com/in "Dana Cohen"');
});

Deno.test("normalizeProfileUrl accepts profile pages only, canonicalises host + slug", () => {
  assertEquals(normalizeProfileUrl("https://il.linkedin.com/in/Dana-Cohen-123?trk=x"), "https://www.linkedin.com/in/dana-cohen-123");
  assertEquals(normalizeProfileUrl("http://linkedin.com/in/dana/"), "https://www.linkedin.com/in/dana");
  assertEquals(normalizeProfileUrl("https://www.linkedin.com/company/acme"), null);
  assertEquals(normalizeProfileUrl("https://www.linkedin.com/posts/dana_x"), null);
  assertEquals(normalizeProfileUrl("https://notlinkedin.com/in/dana"), null);
});

Deno.test("one profile carrying the full name → that profile", () => {
  const url = pickLinkedinProfile([
    r("Dana Cohen - Sales Director - Acme Motors | LinkedIn", "https://il.linkedin.com/in/dana-cohen-1"),
    r("Acme Motors | LinkedIn", "https://www.linkedin.com/company/acme-motors"),
    r("Dana Levi - Engineer | LinkedIn", "https://www.linkedin.com/in/dana-levi"),
  ], "Dana Cohen", "Acme Motors");
  assertEquals(url, "https://www.linkedin.com/in/dana-cohen-1");
});

Deno.test("duplicate hits for the same profile still count as one", () => {
  const url = pickLinkedinProfile([
    r("Dana Cohen | LinkedIn", "https://www.linkedin.com/in/dana-cohen"),
    r("Dana Cohen - Acme | LinkedIn", "https://il.linkedin.com/in/Dana-Cohen?trk=public"),
  ], "Dana Cohen", null);
  assertEquals(url, "https://www.linkedin.com/in/dana-cohen");
});

Deno.test("two different people with the same name → company breaks the tie, else null", () => {
  const results = [
    r("Dana Cohen - Sales Director - Acme Motors | LinkedIn", "https://www.linkedin.com/in/dana-cohen-1", "Acme Motors · Tel Aviv"),
    r("Dana Cohen - Nurse | LinkedIn", "https://www.linkedin.com/in/dana-cohen-2", "Hadassah"),
  ];
  assertEquals(pickLinkedinProfile(results, "Dana Cohen", "Acme Motors"), "https://www.linkedin.com/in/dana-cohen-1");
  assertEquals(pickLinkedinProfile(results, "Dana Cohen", null), null);
  assertEquals(pickLinkedinProfile(results, "Dana Cohen", "Unknown Co"), null);
});

Deno.test("a partial name match is not a match", () => {
  assertEquals(pickLinkedinProfile([
    r("Dana Cohen-Levi - CEO | LinkedIn", "https://www.linkedin.com/in/dcl"),
  ], "Dana Cohen", null), "https://www.linkedin.com/in/dcl"); // hyphenated surname still carries both tokens
  assertEquals(pickLinkedinProfile([
    r("Dana Levi - CEO | LinkedIn", "https://www.linkedin.com/in/dl"),
  ], "Dana Cohen", null), null);
  assertEquals(pickLinkedinProfile([], "Dana Cohen", "Acme"), null);
});

Deno.test("name matching is accent- and case-insensitive", () => {
  assertEquals(pickLinkedinProfile([
    r("JOSÉ GARCÍA – Director | LinkedIn", "https://es.linkedin.com/in/jose-garcia"),
  ], "Jose Garcia", null), "https://www.linkedin.com/in/jose-garcia");
});
