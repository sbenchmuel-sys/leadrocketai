

## Problem Summary

Two wiring gaps prevent WhatsApp messages from appearing in the Inbox and Lead Card:

1. **Inbox shows "0 msgs"**: The `message_count` field on the conversation record is never incremented when outbound messages are sent via `whatsapp-send`. The conversation appears in the list but looks empty.

2. **Lead Card Timeline is blank for WhatsApp**: Outbound WhatsApp messages are NOT bridged to the `interactions` table. Only the inbound webhook bridges messages. Since no real inbound messages have arrived yet, the lead timeline shows nothing for WhatsApp.

---

## Fix 1: Update `whatsapp-send` Edge Function

After successfully sending a WhatsApp message and storing it in the `messages` table, the function must:

- **Increment `message_count`** on the conversation record
- **Bridge to the `interactions` table** with type `whatsapp_outbound`, matching the lead by phone number suffix (same pattern the inbound webhook uses)

## Fix 2: Update `whatsapp-webhook` Edge Function

The inbound webhook already bridges to interactions, but it should also **properly increment `message_count`** on the conversation. Currently it tries to increment but uses a stale value from a query that doesn't select `message_count`.

## Fix 3: Backfill existing data

Run a one-time SQL update to fix the `message_count` for the existing conversation and bridge the 7 existing outbound messages to the `interactions` table so they appear on the lead timeline immediately.

---

## Technical Details

### whatsapp-send changes
After the message insert into `messages`, add:

```text
1. UPDATE conversations SET message_count = message_count + 1, last_message_at = NOW() WHERE id = conversationId
2. Look up matching lead by phone suffix (same logic as webhook)
3. INSERT into interactions: type = 'whatsapp_outbound', source = 'whatsapp', direction = 'outbound'
```

### whatsapp-webhook changes
Fix the message_count increment to use SQL increment instead of reading a stale value:

```text
UPDATE conversations SET message_count = message_count + 1, last_message_at = timestamp WHERE id = conversationId
```

### Backfill SQL migration
- Update conversation `message_count` to match actual message count
- Insert interaction records for the 7 existing outbound messages so they appear on the lead timeline

