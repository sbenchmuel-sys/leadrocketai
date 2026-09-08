// Regression pins for substitutePlaceholders (ai_task last-mile placeholder
// fill). Behaviour captured as-is before extraction to _shared/draftPostprocess.ts.
import { describe, expect, it } from "vitest";
import { substitutePlaceholders } from "../../../supabase/functions/_shared/draftPostprocess";

describe("substitutePlaceholders", () => {
  it("fills lead, rep and meeting-link placeholders in both bracket styles", () => {
    const out = substitutePlaceholders(
      "Hi [First Name], {Name} — I'm [Your Name]. Book here: [Meeting Link]. From {Rep Name}.",
      "Ana",
      "Mike",
      "https://cal.example/mike",
    );
    expect(out).toBe("Hi Ana, Ana — I'm Mike. Book here: https://cal.example/mike. From Mike.");
  });

  it("is case-insensitive and tolerates possessives/spacing", () => {
    expect(substitutePlaceholders("[lead's first name] / [PROSPECT NAME] / [Sales Rep]", "Ana", "Mike", null)).toBe(
      "Ana / Ana / Mike",
    );
  });

  it("leaves placeholders alone when the matching value is unknown", () => {
    expect(substitutePlaceholders("Hi [First Name], — [Your Name]", null, null, null)).toBe(
      "Hi [First Name], — [Your Name]",
    );
    expect(substitutePlaceholders("Book: [Meeting Link]", "Ana", "Mike", null)).toBe("Book: [Meeting Link]");
  });

  it("always rewrites [Your Company]-style placeholders to 'our team'", () => {
    expect(substitutePlaceholders("Greetings from [Your Company] and [Our Company]", null, null, null)).toBe(
      "Greetings from our team and our team",
    );
  });

  it("fills {FirstName} (the campaign template token) when a lead name is known, leaves [Company] alone", () => {
    expect(substitutePlaceholders("Hi {FirstName} at [Company],", "Ana", "Mike", null)).toBe("Hi Ana at [Company],");
  });
});
