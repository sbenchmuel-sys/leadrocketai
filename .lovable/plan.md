
# Fix: Auto-Send Actually Calls WhatsApp Cloud API

## Root Cause

In `supabase/functions/whatsapp-webhook/index.ts`, lines 626–663 (the "Section 6: Auto Send Execution" block), when the decision engine approves an automated reply, the code:

1. Generates the AI reply text (correct)
2. Stores the message in the `messages` table with `status: "sent"` (incorrect assumption)
3. Logs `auto_sent` to `automation_logs`

But it **never makes an HTTP request to the WhatsApp Cloud API** (`https://graph.facebook.com/v21.0/{phoneNumberId}/messages`). The comment even acknowledges this: *"We store the automated outbound message directly here instead of calling whatsapp-send to avoid circular auth issues from webhook context."*

The fix is straightforward: decrypt the integration credentials (already done for Gmail in the codebase) and make the WhatsApp Cloud API call directly inside the webhook's auto-send block.

## Why This Hasn't Been Simple to Spot

The logs say `Auto-sent reply` and `automation_logs` shows `decision: "auto_sent"` — it looks like it worked from a database perspective. But the actual Meta Graph API call was never made, so the message never leaves the system.

## What the Fix Does

**File: `supabase/functions/whatsapp-webhook/index.ts`**

Inside the "Section 6: Auto Send Execution" block (around lines 617–665), after generating `replyText` and confirming credentials exist:

1. Import `safeDecryptToken` from `../_shared/encryption.ts` at the top of the file (already imported for `encryptToken`, just add `safeDecryptToken` to the same import).

2. Decrypt the access token from `integrationData.credentials_encrypted`:
```typescript
const credsJson = await safeDecryptToken(integrationData.credentials_encrypted);
const creds = JSON.parse(credsJson);
const accessToken = await safeDecryptToken(creds.access_token);
const phoneNumberId = integrationData.provider_account_id;
```

3. Normalize the recipient phone number (the sender's number from the inbound message):
```typescript
const recipientPhone = normalizedPhone; // already computed earlier in the loop
```

4. Make the actual WhatsApp Cloud API call:
```typescript
const waPayload = {
  messaging_product: "whatsapp",
  recipient_type: "individual",
  to: recipientPhone,
  type: "text",
  text: { body: replyText },
};

const waRes = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(waPayload),
});

const waData = await waRes.json();
if (!waRes.ok) {
  throw new Error(`WA API error: ${waData?.error?.message ?? JSON.stringify(waData)}`);
}
const providerAutoMsgId = waData?.messages?.[0]?.id ?? null;
```

5. Store the message in `messages` with the real `provider_message_id` from Meta (so delivery status webhooks can update it):
```typescript
// Store with the real provider_message_id (not null)
const { data: autoMsg } = await supabase.from("messages").insert({
  ...
  provider_message_id: providerAutoMsgId,
  status: "sent",
}).select("id").single();
```

6. If the WhatsApp API call fails, the error is caught by the existing `try/catch` block, which logs `Auto-send failed` — no change needed there.

## Scope

- Only `supabase/functions/whatsapp-webhook/index.ts` is modified
- Add `safeDecryptToken` to the existing encryption import on line 2
- Replace the fake "store-only" auto-send block with a real WA Cloud API call + then store
- No schema changes, no other files touched
- The function will be redeployed automatically after the change
