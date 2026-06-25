// Parsing parity for the "Log a meeting" flow. These helpers were moved VERBATIM
// out of MeetingsTab into src/lib/meetingRecap.ts so the dialog and the Meetings
// tab parse the AI recap/milestone JSON identically — this locks that behavior.
import { describe, it, expect } from "vitest";
import { extractJson, parseRecapJson } from "@/lib/meetingRecap";

describe("extractJson", () => {
  it("strips a ```json fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("strips a bare ``` fence", () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("returns trimmed content when there's no fence", () => {
    expect(extractJson('   {"a":1}   ')).toBe('{"a":1}');
  });
});

describe("parseRecapJson", () => {
  it("parses clean (fenced) JSON", () => {
    expect(parseRecapJson('```json\n{"a":1,"b":[1,2]}\n```')).toEqual({ a: 1, b: [1, 2] });
  });

  it("repairs trailing junk by trimming to the last balanced brace", () => {
    expect(parseRecapJson('{"a":1,"b":2} <-- model rambled after this')).toEqual({ a: 1, b: 2 });
  });

  it("repairs a second truncated object by trimming to the first close brace", () => {
    expect(parseRecapJson('{"a":1,"b":2}{"c"')).toEqual({ a: 1, b: 2 });
  });

  it("returns null on unrecoverable input (no closing brace)", () => {
    expect(parseRecapJson('{"a":1')).toBeNull();
  });

  it("returns null on plainly non-JSON", () => {
    expect(parseRecapJson("the model said hi")).toBeNull();
  });
});
