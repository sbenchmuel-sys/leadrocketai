// ============================================================
// OutlookGraphClient — centralised Microsoft Graph API client
//
// All Graph calls go through this service.
// If MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET are missing,
// every call throws a controlled, non-crashing error.
// ============================================================

import { logger } from "./logger.ts";

export class MicrosoftCredentialsMissingError extends Error {
  constructor() {
    super("Microsoft credentials not configured");
    this.name = "MicrosoftCredentialsMissingError";
  }
}

/** Returns true when both MS env vars are present. */
export function hasMicrosoftCredentials(): boolean {
  return !!(
    Deno.env.get("MICROSOFT_CLIENT_ID") &&
    Deno.env.get("MICROSOFT_CLIENT_SECRET")
  );
}

/** Throws a controlled error if credentials are missing. */
export function requireMicrosoftCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    logger.warn("mail.outlook.credentials_missing", {});
    throw new MicrosoftCredentialsMissingError();
  }
  return { clientId, clientSecret };
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class OutlookGraphClient {
  constructor(private readonly accessToken: string) {}

  /** GET a message by its provider ID. */
  async getMessage(messageId: string, select?: string): Promise<Record<string, unknown>> {
    const url = select
      ? `${GRAPH_BASE}/me/messages/${messageId}?$select=${select}`
      : `${GRAPH_BASE}/me/messages/${messageId}`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph GET message ${messageId} failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }

  /** POST /me/sendMail */
  async sendMail(payload: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${GRAPH_BASE}/me/sendMail`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph sendMail failed (${resp.status}): ${body}`);
    }
  }

  /** POST /me/messages/{id}/reply */
  async replyToMessage(messageId: string, payload: Record<string, unknown>): Promise<void> {
    const resp = await fetch(`${GRAPH_BASE}/me/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph reply failed (${resp.status}): ${body}`);
    }
  }

  /** POST /subscriptions */
  async createSubscription(
    notificationUrl: string,
    clientState: string,
    resource: string,
    expirationDateTime: string
  ): Promise<{ id: string; expirationDateTime: string }> {
    const resp = await fetch(`${GRAPH_BASE}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource,
        expirationDateTime,
        clientState,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph createSubscription failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }

  /** PATCH /subscriptions/{id} — renew */
  async renewSubscription(
    subscriptionId: string,
    expirationDateTime: string
  ): Promise<{ id: string; expirationDateTime: string }> {
    const resp = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph renewSubscription failed (${resp.status}): ${body}`);
    }

    return resp.json();
  }

  /** Exchange refresh_token for new tokens. Requires credentials. */
  static async refreshToken(
    refreshToken: string,
    scope: string
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const { clientId, clientSecret } = requireMicrosoftCredentials();

    const resp = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          scope,
        }),
      }
    );

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Token refresh HTTP ${resp.status}: ${body}`);
    }

    return resp.json();
  }
}
