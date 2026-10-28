// Microsoft Graph subscription validation handshake.
//
// When a subscription is created (or its notificationUrl changes), Graph
// sends a POST to the notification URL with ?validationToken=<opaque> and
// an empty text/plain body, and expects the token echoed back as text/plain
// within 10 seconds. Some proxies / older docs use GET, so we accept both.
// Ref: https://learn.microsoft.com/graph/change-notifications-delivery-webhooks
//
// Pure + import-free so the entry module stays cold-start cheap and this can
// be tested without starting a server.
export function graphValidationResponse(req: Request): Response | null {
  const token = new URL(req.url).searchParams.get("validationToken");
  if (!token) return null;
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
