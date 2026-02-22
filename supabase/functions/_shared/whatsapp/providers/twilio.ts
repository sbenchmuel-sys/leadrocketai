// ============================================================
// TwilioWhatsAppProvider — full implementation
//
// Uses Twilio REST API for WhatsApp messaging.
// Credentials: accountSid, authToken, fromNumber (whatsapp:+...)
// ============================================================

import type { IWhatsAppProvider } from "../provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
} from "../types.ts";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

// ── Signature verification ──────────────────────────────────

/**
 * Verify Twilio X-Twilio-Signature header using HMAC-SHA1.
 *
 * Algorithm:
 * 1. Take the full URL of the request
 * 2. If POST, sort all POST params alphabetically and append key+value
 * 3. Sign the resulting string with HMAC-SHA1 using AuthToken
 * 4. Base64 encode the result
 * 5. Compare to X-Twilio-Signature header
 */
export async function verifyTwilioSignature(
  request: Request,
  rawBody: string,
  authToken: string,
): Promise<boolean> {
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!signature) return false;

  const url = request.url;

  // Parse form-encoded body params and sort
  const params = new URLSearchParams(rawBody);
  const sortedKeys = [...params.keys()].sort();
  let dataString = url;
  for (const key of sortedKeys) {
    dataString += key + params.get(key);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(dataString));
  const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // Constant-time comparison
  if (signature.length !== expectedB64.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expectedB64.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Provider class ──────────────────────────────────────────

export class TwilioWhatsAppProvider implements IWhatsAppProvider {
  readonly providerType = "twilio" as const;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string, // e.g. "whatsapp:+14155238886" or just "+14155238886"
  ) {}

  private get authHeader(): string {
    return "Basic " + btoa(`${this.accountSid}:${this.authToken}`);
  }

  private get fromWhatsApp(): string {
    return this.fromNumber.startsWith("whatsapp:")
      ? this.fromNumber
      : `whatsapp:+${this.fromNumber.replace(/\D/g, "")}`;
  }

  async send(params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    const normalizedTo = params.to.replace(/\D/g, "");
    const toWhatsApp = `whatsapp:+${normalizedTo}`;

    const formData = new URLSearchParams();
    formData.set("From", this.fromWhatsApp);
    formData.set("To", toWhatsApp);
    formData.set("Body", params.body);

    if (params.mediaUrl) {
      formData.set("MediaUrl", params.mediaUrl);
    }

    const res = await fetch(
      `${TWILIO_API}/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
      },
    );

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data?.message ?? JSON.stringify(data);
      throw new Error(`Twilio API error (${res.status}): ${errMsg}`);
    }

    return {
      providerMessageId: data.sid ?? "",
    };
  }

  async checkHealth(): Promise<WhatsAppHealthResult> {
    try {
      // Check account status via Twilio API
      const res = await fetch(
        `${TWILIO_API}/Accounts/${this.accountSid}.json`,
        {
          headers: { Authorization: this.authHeader },
        },
      );

      if (!res.ok) {
        return {
          healthy: false,
          status: "token_invalid",
          phoneNumberId: this.fromNumber,
          errorMessage: `Twilio API returned ${res.status}`,
        };
      }

      const data = await res.json();
      const accountStatus = data.status; // active, suspended, closed

      if (accountStatus !== "active") {
        return {
          healthy: false,
          status: "error",
          phoneNumberId: this.fromNumber,
          verifiedName: data.friendly_name ?? undefined,
          errorMessage: `Account status: ${accountStatus}`,
        };
      }

      return {
        healthy: true,
        status: "active",
        phoneNumberId: this.fromNumber,
        verifiedName: data.friendly_name ?? undefined,
      };
    } catch (err: any) {
      return {
        healthy: false,
        status: "error",
        phoneNumberId: this.fromNumber,
        errorMessage: err.message,
      };
    }
  }
}
