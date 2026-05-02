import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" }); return;
  }

  const activityId = parseInt(req.query.id, 10);
  if (!activityId) { res.status(400).json({ error: "Missing ?id=" }); return; }

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const tokens = await kv.get("runs:strava-tokens");
  if (!tokens) { res.status(503).json({ error: "No tokens" }); return; }

  let accessToken = tokens.access_token;
  if (Date.now() / 1000 >= tokens.expires_at) {
    const body = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    });
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const data = await r.json();
    accessToken = data.access_token;
    await kv.set("runs:strava-tokens", { ...tokens, ...data });
  }

  const r = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const activity = await r.json();

  res.status(r.status).json({
    http_status: r.status,
    top_level_keys: Object.keys(activity),
    type: activity.type,
    sport_type: activity.sport_type,
    distance_meters: activity.distance,
    moving_time_sec: activity.moving_time,
    splits_standard: activity.splits_standard ?? "MISSING",
    splits_metric: activity.splits_metric ?? "MISSING",
    splits_standard_length: Array.isArray(activity.splits_standard) ? activity.splits_standard.length : null,
    splits_metric_length: Array.isArray(activity.splits_metric) ? activity.splits_metric.length : null,
  });
}
