import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Accept token from Authorization header OR ?t= query param (for browser testing)
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "") || req.query.t || "";
  if (token !== process.env.SHARED_SECRET) {
    res.status(401).send("Unauthorized — add ?t=YOUR_SHARED_SECRET to the URL"); return;
  }

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  let activityId = parseInt(req.query.id, 10) || null;
  if (!activityId) {
    let runs = [];
    try { const r = await kv.get("runs:all"); if (Array.isArray(r)) runs = r; } catch {}
    const withStrava = runs.filter(r => r.stravaActivityId && r.actualMiles >= 2);
    if (!withStrava.length) { res.status(404).send("No Strava runs found in store"); return; }
    withStrava.sort((a, b) => (b.actualDate || "").localeCompare(a.actualDate || ""));
    activityId = withStrava[0].stravaActivityId;
  }

  let tokens = await kv.get("runs:strava-tokens");
  if (!tokens) { res.status(503).send("No Strava tokens in store"); return; }

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

  const result = {
    tested_activity_id: activityId,
    http_status: r.status,
    name: activity.name,
    type: activity.type,
    sport_type: activity.sport_type,
    distance_miles: activity.distance ? Math.round(activity.distance * 0.000621371 * 100) / 100 : null,
    splits_standard_count: Array.isArray(activity.splits_standard) ? activity.splits_standard.length : "MISSING",
    splits_metric_count: Array.isArray(activity.splits_metric) ? activity.splits_metric.length : "MISSING",
    splits_standard_all: activity.splits_standard ?? "NOT PRESENT",
    strava_error: activity.errors ?? undefined,
  };

  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify(result, null, 2));
}
