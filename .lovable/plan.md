

## Problem
After completing the Gmail OAuth flow, the browser lands on the `gmail-callback` edge function URL and displays a raw-looking success page. Since the flow uses a same-window redirect (not a popup), `window.close()` doesn't work, leaving you stranded on an unfamiliar page.

## Solution
Instead of rendering an HTML success page, the `gmail-callback` edge function will **redirect back to your app** with a `?gmail_connected=true` query parameter. Your app already handles this parameter and shows a toast notification -- so the experience becomes seamless: Google auth completes, and you're right back where you started.

## Changes

### 1. `supabase/functions/gmail-callback/index.ts`
Replace the success HTML response (the big block that renders "Gmail Connected!" with styles and scripts) with a simple **HTTP 302 redirect** back to the app:
- Build the redirect URL from `stateData.redirect_url` (the page the user was on)
- Append `?gmail_connected=true` to trigger the existing toast + refetch logic
- Keep all error pages as-is (they still need to display something)

### 2. `src/hooks/useGmailConnection.ts`
No changes needed -- it already detects `?gmail_connected=true`, cleans up the URL, shows a success toast, and refetches the connection.

## Technical Details

In the callback's success path (after upserting `gmail_connections`), replace the HTML response with:

```typescript
// Build redirect back to the app
const redirectUrl = new URL(stateData.redirect_url);
redirectUrl.searchParams.set("gmail_connected", "true");

return new Response(null, {
  status: 302,
  headers: {
    "Location": redirectUrl.toString(),
    ...getSecureHtmlHeaders(),
  },
});
```

This is a single-file change to the edge function. The integration logic stays intact -- only the final response changes from "render HTML" to "redirect."

