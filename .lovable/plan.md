

## Fix: Gmail Connection Broken on Custom Domain (drivepilot.app)

### Root Cause

Four edge functions use a dynamic CORS check that only allows `localhost`, `*.lovableproject.com`, and `*.lovable.app` origins. When you access the app from `drivepilot.app`, the browser's preflight (OPTIONS) request gets an empty `Access-Control-Allow-Origin` header, blocking the entire request. This is why you see "Failed to send a request to the Edge Function."

### Affected Functions

| Function | Has restrictive CORS |
|----------|---------------------|
| `gmail-auth` | Yes -- blocks Gmail connect |
| `gmail-sync` | Yes -- blocks email sync |
| `gmail-send` | Yes -- blocks sending emails |
| `ai_task` | Yes -- blocks AI draft generation |

All other functions already use `"Access-Control-Allow-Origin": "*"` and work fine.

### Fix

Update the `getCorsHeaders` function in all four edge functions to also allow `drivepilot.app`:

```typescript
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];

  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isCustomDomain = origin === "https://drivepilot.app" || origin === "https://www.drivepilot.app";
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || isCustomDomain || allowedOrigins.includes("*");

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
```

The single-line addition (`isCustomDomain`) is applied to all four files.

### Google Cloud Console Update (Manual Step)

You also need to add `https://drivepilot.app` as an **Authorized JavaScript Origin** in your Google Cloud Console OAuth credentials. Without this, Google may reject the OAuth flow from the new domain.

1. Go to Google Cloud Console -> APIs & Credentials -> OAuth 2.0 Client IDs
2. Edit your Web Application client
3. Under "Authorized JavaScript origins", add `https://drivepilot.app`
4. Save

### Files Changed

| File | Change |
|------|--------|
| `supabase/functions/gmail-auth/index.ts` | Add `isCustomDomain` check |
| `supabase/functions/gmail-sync/index.ts` | Add `isCustomDomain` check |
| `supabase/functions/gmail-send/index.ts` | Add `isCustomDomain` check |
| `supabase/functions/ai_task/index.ts` | Add `isCustomDomain` check |

All four functions will be redeployed after the changes.

