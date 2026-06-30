import { describe, it, expect } from "vitest";
import { insertAtCursor, detectMergeTrigger, fieldsForChannel } from "../mergeFields";

function mkInput(value: string, start: number, end = start) {
  const el = document.createElement("textarea");
  el.value = value;
  el.selectionStart = start;
  el.selectionEnd = end;
  return el;
}

describe("mergeFields", () => {
  it("inserts at the caret in the middle", () => {
    const el = mkInput("Hi  there", 3);
    const { value, caret } = insertAtCursor(el, "{FirstName}");
    expect(value).toBe("Hi {FirstName} there");
    expect(caret).toBe(3 + "{FirstName}".length);
  });

  it("replaces a selection", () => {
    const el = mkInput("Hi NAME there", 3, 7);
    const { value } = insertAtCursor(el, "{FirstName}");
    expect(value).toBe("Hi {FirstName} there");
  });

  it("inserts at start and end", () => {
    expect(insertAtCursor(mkInput("body", 0), "X").value).toBe("Xbody");
    expect(insertAtCursor(mkInput("body", 4), "X").value).toBe("bodyX");
  });

  it("detects {{ trigger immediately after open braces", () => {
    expect(detectMergeTrigger("Hi {{", 5)).toEqual({ query: "", start: 3 });
    expect(detectMergeTrigger("Hi {{fir", 8)).toEqual({ query: "fir", start: 3 });
  });

  it("returns null when trigger is broken by whitespace or close", () => {
    expect(detectMergeTrigger("Hi {{ first", 11)).toBeNull();
    expect(detectMergeTrigger("Hi {{first}", 11)).toBeNull();
    expect(detectMergeTrigger("Hi there", 8)).toBeNull();
  });

  it("hides MeetingLink for non-email channels", () => {
    expect(fieldsForChannel("email").some((f) => f.token === "{MeetingLink}")).toBe(true);
    expect(fieldsForChannel("sms").some((f) => f.token === "{MeetingLink}")).toBe(false);
    expect(fieldsForChannel("voice").some((f) => f.token === "{MeetingLink}")).toBe(false);
  });
});
