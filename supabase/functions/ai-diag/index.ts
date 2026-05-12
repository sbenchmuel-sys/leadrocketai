Deno.serve(async () => {
  const key = Deno.env.get("LOVABLE_API_KEY") ?? "";
  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "say hi" }] }),
  });
  const text = await r.text();
  return new Response(JSON.stringify({ keyPrefix: key.slice(0, 10), keyLen: key.length, status: r.status, body: text.slice(0, 500) }), {
    headers: { "Content-Type": "application/json" },
  });
});
