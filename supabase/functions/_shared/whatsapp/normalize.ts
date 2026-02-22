// ============================================================
// normalize.ts — convert Meta webhook payload into channel_events rows
// ============================================================

interface NormalizedEvent {
  channel: "whatsapp";
  provider: "meta" | "twilio";
  event_type: "inbound_message" | "status_update";
  provider_event_id: string;
  payload_normalized: Record<string, unknown>;
  phone_number_id: string | null;
}

/**
 * Parse a full Meta webhook body into a flat list of NormalizedEvents.
 * Each message and each status update becomes its own event.
 */
export function normalizeMetaWebhookPayload(
  body: Record<string, unknown>,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const entries = (body?.entry as any[]) ?? [];

  for (const entry of entries) {
    const changes = (entry?.changes as any[]) ?? [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const value = change?.value;
      if (!value) continue;

      const phoneNumberId: string = value?.metadata?.phone_number_id ?? "";

      // ── Inbound messages ──────────────────────────────────
      const messages = (value?.messages as any[]) ?? [];
      for (const msg of messages) {
        const providerEventId = msg?.id;
        if (!providerEventId) continue;

        const senderPhone: string = msg?.from ?? "";
        const timestamp: string = msg?.timestamp
          ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
          : new Date().toISOString();

        let bodyText = "";
        const msgType: string = msg?.type ?? "unknown";

        switch (msgType) {
          case "text":
            bodyText = msg?.text?.body ?? "";
            break;
          case "image":
            bodyText = `[Image] ${msg?.image?.caption ?? ""}`;
            break;
          case "document":
            bodyText = `[Document] ${msg?.document?.filename ?? ""}`;
            break;
          case "audio":
            bodyText = "[Audio message]";
            break;
          case "video":
            bodyText = `[Video] ${msg?.video?.caption ?? ""}`;
            break;
          case "location":
            bodyText = `[Location] ${msg?.location?.latitude},${msg?.location?.longitude}`;
            break;
          case "contacts":
            bodyText = "[Contact card]";
            break;
          case "sticker":
            bodyText = "[Sticker]";
            break;
          case "reaction":
            bodyText = `[Reaction] ${msg?.reaction?.emoji ?? ""}`;
            break;
          default:
            bodyText = `[${msgType}]`;
        }

        events.push({
          channel: "whatsapp",
          provider: "meta",
          event_type: "inbound_message",
          provider_event_id: providerEventId,
          phone_number_id: phoneNumberId,
          payload_normalized: {
            from: senderPhone.replace(/\D/g, ""),
            timestamp,
            message_type: msgType,
            body_text: bodyText,
            context_message_id: msg?.context?.id ?? null,
          },
        });
      }

      // ── Status updates ────────────────────────────────────
      const statuses = (value?.statuses as any[]) ?? [];
      for (const statusEvent of statuses) {
        const providerMsgId: string = statusEvent?.id;
        const newStatus: string = statusEvent?.status;
        if (!providerMsgId || !newStatus) continue;
        if (!["sent", "delivered", "read", "failed"].includes(newStatus)) continue;

        events.push({
          channel: "whatsapp",
          provider: "meta",
          event_type: "status_update",
          // Use a composite key so different status updates for the same message don't collide
          provider_event_id: `${providerMsgId}:${newStatus}`,
          phone_number_id: phoneNumberId,
          payload_normalized: {
            provider_message_id: providerMsgId,
            status: newStatus,
            recipient_id: (statusEvent?.recipient_id ?? "").replace(/\D/g, ""),
            timestamp: statusEvent?.timestamp
              ? new Date(parseInt(statusEvent.timestamp) * 1000).toISOString()
              : new Date().toISOString(),
            error_code: statusEvent?.errors?.[0]?.code ?? null,
            error_title: statusEvent?.errors?.[0]?.title ?? null,
          },
        });
      }
    }
  }

  return events;
}
