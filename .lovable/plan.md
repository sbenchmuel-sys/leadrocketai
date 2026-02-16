

## Update WhatsApp Verify Token

**What we'll do:**
1. Update the `WHATSAPP_VERIFY_TOKEN` backend secret to a new value: `leadrocket-wa-verify-2026`
2. No code changes needed -- the webhook edge function already reads this secret at runtime

**After the update, here's what you do in Meta Developer Portal:**

1. Go to **WhatsApp** > **Configuration** (not the "Authorize callback URL" section)
2. Set **Callback URL** to:
   ```
   https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/whatsapp-webhook
   ```
3. Set **Verify token** to:
   ```
   leadrocket-wa-verify-2026
   ```
4. Click **Verify and save**
5. Subscribe to the **messages** webhook field

