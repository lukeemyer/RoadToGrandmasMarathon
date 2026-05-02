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

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  // Auto-pick a Strava activity if no id provided
  let activityId = parseInt(req.query.id, 10) || null;
  if (!activityId) {
    let runs = [];
    try { const r = await kv.get("runs:all"); if (Array.isArray(r)) runs = r; } catch {}
    const withStrava = runs.filter(r => r.stravaActivityId && r.actualMiles >= 2);
    if (!withStrava.length) { res.status(404).json({ error: "No Strava runs found in store" }); return; }
    // Pick the most recent
    withStrava.sort((a, b) => (b.actualDate || "").localeCompare(a.actualDate || ""));
    activityId = withStrava[0].stravaActivityId;
  }

  const tokens = await kv.get("runs:strava-tokens");
  if (!tokens) { res.status(503).json({ error: "No Strava tokens in store" }); return; }

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
    tested_activity_id: activityId,
    http_status: r.status,
    name: activity.name,
    type: activity.type,
    sport_type: activity.sport_type,
    distance_miles: activity.distance ? Math.round(activity.distance * 0.000621371 * 100) / 100 : null,
    moving_time_sec: activity.moving_time,
    splits_standard_count: Array.isArray(activity.splits_standard) ? activity.splits_standard.length : "MISSING",
    splits_metric_count: Array.isArray(activity.splits_metric) ? activity.splits_metric.length : "MISSING",
    splits_standard_first: Array.isArray(activity.splits_standard) && activity.splits_standard.length
      ? activity.splits_standard[0] : null,
    splits_standard_all: activity.splits_standard ?? null,
    error: activity.errors ? activity.errors : undefined,
  });
}
