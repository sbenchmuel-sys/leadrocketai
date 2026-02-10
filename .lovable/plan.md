

# Update Google OAuth and Encryption Secrets

## What We'll Do

Set the three secrets needed for Gmail integration:

1. **GOOGLE_CLIENT_ID** - Your Google OAuth client identifier
2. **GOOGLE_CLIENT_SECRET** - Your Google OAuth client secret
3. **TOKEN_ENCRYPTION_KEY** - Your self-generated encryption key for securing stored tokens

## Steps

1. Use the secret management tool to prompt you for each of the three values
2. You'll paste each value into the secure input field
3. Once all three are saved, the Gmail OAuth flow will be fully operational

No code changes are needed -- the edge functions (`gmail-auth`, `gmail-callback`, `gmail-sync`, `gmail-bulk-sync`) already reference these secrets.

