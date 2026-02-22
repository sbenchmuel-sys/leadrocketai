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

// ── Credential decryption helper ────────────────────────────

interface DecryptedCreds {
  accessToken: string;
  phoneNumberId: string;
}

async function decryptIntegrationCreds(
  credentialsEncrypted: string,
  providerAccountId: string | null,
): Promise<DecryptedCreds> {
  const credsJson = await safeDecryptToken(credentialsEncrypted);
  const creds = JSON.parse(credsJson);
  const accessToken = await safeDecryptToken(creds.access_token);
  const phoneNumberId = creds.phone_number_id ?? providerAccountId ?? "";
  return { accessToken, phoneNumberId };
}

// ── Factory: build IWhatsAppProvider from integration row ───

function buildProvider(
  providerType: string,
  creds: DecryptedCreds,
): IWhatsAppProvider {
  switch (providerType) {
    case "meta":
      return new MetaWhatsAppProvider(creds.accessToken, creds.phoneNumberId);
    // case "twilio":
    //   return new TwilioWhatsAppProvider(creds.accountSid, creds.authToken, creds.fromNumber);
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

    const creds = await decryptIntegrationCreds(
      row.credentials_encrypted,
      row.provider_account_id,
    );

    const provider = buildProvider(row.provider ?? "meta", creds);

    return new WhatsAppService(provider, row.id, creds.phoneNumberId);
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

    const creds = await decryptIntegrationCreds(
      row.credentials_encrypted,
      row.provider_account_id,
    );

    const provider = buildProvider(row.provider ?? "meta", creds);

    return new WhatsAppService(provider, row.id, creds.phoneNumberId);
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

    const creds = await decryptIntegrationCreds(
      row.credentials_encrypted,
      row.provider_account_id,
    );

    const provider = buildProvider(row.provider ?? "meta", creds);

    return new WhatsAppService(provider, row.id, creds.phoneNumberId);
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
