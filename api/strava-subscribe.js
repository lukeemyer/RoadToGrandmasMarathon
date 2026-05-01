export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const action = req.query.action;

  if (action === "list") {
    const r = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`
    );
    res.status(r.status).json(await r.json());
    return;
  }

  if (action === "create") {
    const callbackUrl = req.query.callback;
    if (!callbackUrl) { res.status(400).json({ error: "Missing callback param" }); return; }

    const body = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.STRAVA_VERIFY_TOKEN,
    });

    const r = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    res.status(r.status).json(await r.json());
    return;
  }

  if (action === "delete") {
    const id = req.query.id;
    if (!id) { res.status(400).json({ error: "Missing id param" }); return; }

    // Strava DELETE requires credentials as query params, not body
    const r = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions/${id}?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`,
      { method: "DELETE" }
    );

    if (r.status === 204) { res.status(200).json({ deleted: true }); return; }
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
    return;
  }

  res.status(400).json({ error: "Unknown action. Use ?action=list|create|delete" });
}
