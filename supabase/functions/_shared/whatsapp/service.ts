// ============================================================
// WhatsAppService — provider-agnostic façade
//
// Usage:
//   const svc = await WhatsAppService.forIntegration(supabase, integrationId);
//   await svc.sendMessage({ to, body });
//   const health = await svc.healthCheck();
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeDecryptToken } from "../encryption.ts";
import type { IWhatsAppProvider } from "./provider.ts";
import type {
  SendWhatsAppParams,
  SendWhatsAppResult,
  WhatsAppHealthResult,
} from "./types.ts";
import { MetaWhatsAppProvider } from "./providers/meta.ts";
import { TwilioWhatsAppProvider } from "./providers/twilio.ts";

// ── Credential decryption helpers ───────────────────────────

interface MetaCreds {
  kind: "meta";
  accessToken: string;
  phoneNumberId: string;
}

interface TwilioCreds {
  kind: "twilio";
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

type DecryptedCreds = MetaCreds | TwilioCreds;

async function decryptMetaCreds(
  credentialsEncrypted: string,
  providerAccountId: string | null,
): Promise<MetaCreds> {
  const credsJson = await safeDecryptToken(credentialsEncrypted);
  const creds = JSON.parse(credsJson);
  const accessToken = await safeDecryptToken(creds.access_token);
  const phoneNumberId = creds.phone_number_id ?? providerAccountId ?? "";
  return { kind: "meta", accessToken, phoneNumberId };
}

async function decryptTwilioCreds(
  credentialsEncrypted: string,
  providerAccountId: string | null,
): Promise<TwilioCreds> {
  // Per-workspace creds contain twilio_phone_number etc.
  // Global TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN come from env secrets.
  const credsJson = await safeDecryptToken(credentialsEncrypted);
  const creds = JSON.parse(credsJson);

  const accountSid = creds.twilio_account_sid || Deno.env.get("TWILIO_ACCOUNT_SID") || "";
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
  const fromNumber = creds.twilio_phone_number ?? providerAccountId ?? "";

  if (!accountSid) throw new Error("TWILIO_ACCOUNT_SID not configured");
  if (!authToken) throw new Error("TWILIO_AUTH_TOKEN not configured");

  return { kind: "twilio", accountSid, authToken, fromNumber };
}

// ── Factory: build IWhatsAppProvider from integration row ───

async function decryptAndBuild(
  providerType: string,
  credentialsEncrypted: string,
  providerAccountId: string | null,
): Promise<{ provider: IWhatsAppProvider; identifier: string }> {
  switch (providerType) {
    case "meta": {
      const creds = await decryptMetaCreds(credentialsEncrypted, providerAccountId);
      return {
        provider: new MetaWhatsAppProvider(creds.accessToken, creds.phoneNumberId),
        identifier: creds.phoneNumberId,
      };
    }
    case "twilio": {
      const creds = await decryptTwilioCreds(credentialsEncrypted, providerAccountId);
      return {
        provider: new TwilioWhatsAppProvider(creds.accountSid, creds.authToken, creds.fromNumber),
        identifier: creds.fromNumber.replace(/\D/g, ""),
      };
    }
    default:
      throw new Error(`Unsupported WhatsApp provider: ${providerType}`);
  }
}

// ============================================================
// WhatsAppService
// ============================================================

export class WhatsAppService {
  private constructor(
    private readonly provider: IWhatsAppProvider,
    public readonly integrationId: string,
    public readonly phoneNumberId: string,
  ) {}

  // ── Static constructors ───────────────────────────────────

  /**
   * Build service from an integration row ID.
   */
  static async forIntegration(
    supabase: any,
    integrationId: string,
  ): Promise<WhatsAppService> {
    const { data: row, error } = await supabase
      .from("integrations")
      .select("id, provider, credentials_encrypted, provider_account_id, is_active")
      .eq("id", integrationId)
      .single();

    if (error || !row) throw new Error(`Integration not found: ${integrationId}`);
    if (!row.is_active) throw new Error(`Integration inactive: ${integrationId}`);
    if (!row.credentials_encrypted) throw new Error(`No credentials for integration: ${integrationId}`);

    const { provider, identifier } = await decryptAndBuild(
      row.provider ?? "meta",
      row.credentials_encrypted,
      row.provider_account_id,
    );

    return new WhatsAppService(provider, row.id, identifier);
  }

  /**
   * Build service for a given workspace + user (finds their active integration).
   */
  static async forWorkspaceUser(
    supabase: any,
    workspaceId: string,
    userId: string,
  ): Promise<WhatsAppService> {
    const { data: row, error } = await supabase
      .from("integrations")
      .select("id, provider, credentials_encrypted, provider_account_id, is_active")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("type", "whatsapp")
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw new Error(`DB error finding integration: ${error.message}`);
    if (!row) throw new Error(`No active WhatsApp integration for user in workspace`);
    if (!row.credentials_encrypted) throw new Error(`No credentials stored`);

    const { provider, identifier } = await decryptAndBuild(
      row.provider ?? "meta",
      row.credentials_encrypted,
      row.provider_account_id,
    );

    return new WhatsAppService(provider, row.id, identifier);
  }

  /**
   * Build service from a phone_number_id (used by processor).
   */
  static async forPhoneNumberId(
    supabase: any,
    phoneNumberId: string,
  ): Promise<WhatsAppService> {
    const { data: row, error } = await supabase
      .from("integrations")
      .select("id, provider, credentials_encrypted, provider_account_id, is_active")
      .eq("type", "whatsapp")
      .eq("is_active", true)
      .eq("provider_account_id", phoneNumberId)
      .maybeSingle();

    if (error) throw new Error(`DB error finding integration: ${error.message}`);
    if (!row) throw new Error(`No active integration for phone_number_id=${phoneNumberId}`);
    if (!row.credentials_encrypted) throw new Error(`No credentials for phone_number_id=${phoneNumberId}`);

    const { provider, identifier } = await decryptAndBuild(
      row.provider ?? "meta",
      row.credentials_encrypted,
      row.provider_account_id,
    );

    return new WhatsAppService(provider, row.id, identifier);
  }

  // ── Public methods (provider-agnostic) ────────────────────

  async sendMessage(params: SendWhatsAppParams): Promise<SendWhatsAppResult> {
    return this.provider.send(params);
  }

  async healthCheck(): Promise<WhatsAppHealthResult> {
    return this.provider.checkHealth();
  }

  get providerType(): string {
    return this.provider.providerType;
  }
}
