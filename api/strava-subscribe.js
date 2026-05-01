const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

function requireAuth(req) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === process.env.SHARED_SECRET;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!requireAuth(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "list") {
    const res = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`
    );
    const data = await res.json();
    return json(data);
  }

  if (action === "create") {
    const callbackUrl = url.searchParams.get("callback");
    if (!callbackUrl) return json({ error: "Missing callback param" }, 400);

    const body = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      callback_url: callbackUrl,
      verify_token: process.env.STRAVA_VERIFY_TOKEN,
    });

    const res = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await res.json();
    return json(data, res.status);
  }

  if (action === "delete") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing id param" }, 400);

    const body = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
    });

    const res = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions/${id}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }
    );

    if (res.status === 204) return json({ deleted: true });
    const data = await res.json().catch(() => ({}));
    return json(data, res.status);
  }

  return json({ error: "Unknown action. Use ?action=list|create|delete" }, 400);
}
