import { describe, it, expect } from "vitest";
import { resolveLeadQuickActions } from "@/lib/leadQuickActions";

describe("resolveLeadQuickActions", () => {
  it("SMS shows when a phone exists and the lead isn't opted out", () => {
    expect(resolveLeadQuickActions({ phone: "+15551234567" }).sms).toEqual({ phone: "+15551234567" });
  });

  it("SMS hidden when there's no phone (or only whitespace)", () => {
    expect(resolveLeadQuickActions({ phone: null }).sms).toBeNull();
    expect(resolveLeadQuickActions({ phone: "   " }).sms).toBeNull();
  });

  it("WhatsApp shows with a whatsapp_number + opt-in", () => {
    expect(
      resolveLeadQuickActions({ phone: null, whatsapp_number: "+15559876543", wa_opted_in: true }).whatsapp,
    ).toEqual({ number: "+15559876543" });
  });

  it("WhatsApp falls back to the phone number when no whatsapp_number (opted in)", () => {
    expect(
      resolveLeadQuickActions({ phone: "+15551234567", wa_opted_in: true }).whatsapp,
    ).toEqual({ number: "+15551234567" });
  });

  it("WhatsApp hidden without opt-in, even with a number", () => {
    expect(
      resolveLeadQuickActions({ whatsapp_number: "+15559876543", wa_opted_in: false }).whatsapp,
    ).toBeNull();
    expect(
      resolveLeadQuickActions({ whatsapp_number: "+15559876543" }).whatsapp,
    ).toBeNull(); // wa_opted_in undefined → not opted in
  });

  it("OPT-OUT: unsubscribed hides BOTH SMS and WhatsApp regardless of details", () => {
    const out = resolveLeadQuickActions({
      phone: "+15551234567",
      whatsapp_number: "+15559876543",
      wa_opted_in: true,
      unsubscribed: true,
    });
    expect(out.sms).toBeNull();
    expect(out.whatsapp).toBeNull();
  });

  it("no contact details at all → both hidden", () => {
    expect(resolveLeadQuickActions({})).toEqual({ sms: null, whatsapp: null });
  });
});
