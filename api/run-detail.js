import { Redis } from "@upstash/redis";

function transformSplits(splits) {
  if (!Array.isArray(splits)) return [];
  return splits.map(s => {
    const mi = (s.distance || 0) * 0.000621371;
    const paceSecMi = mi > 0.05 ? Math.round(s.moving_time / mi) : null;
    return {
      n: s.split,
      mi: Math.round(mi * 100) / 100,
      sec: s.moving_time || 0,
      paceSecMi,
      hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
      cad: null,
      elev: s.elevation_difference != null ? Math.round(s.elevation_difference * 3.28084) : null,
    };
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const activityId = parseInt(req.query.id, 10);
  if (!activityId) { res.status(400).json({ error: "Missing ?id=" }); return; }

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  let blobRuns = [];
  try { const r = await kv.get("runs:all"); if (Array.isArray(r)) blobRuns = r; } catch {}
  const existing = blobRuns.find(r => r.stravaActivityId === activityId);

  // Use cached splits only if they look like real per-mile data (more than 1 split)
  const cachedOk = existing?.laps?.length > 1 ||
    (existing?.laps?.length === 1 && (existing.actualMiles || 0) < 1.5);
  if (cachedOk) {
    res.status(200).json({ laps: existing.laps, cached: true });
    return;
  }

  // Fetch activity detail from Strava (splits_standard = per-mile splits)
  const tokens = await kv.get("runs:strava-tokens");
  if (!tokens) { res.status(503).json({ error: "No Strava tokens" }); return; }

  let accessToken = tokens.access_token;
  if (Date.now() / 1000 >= tokens.expires_at) {
    const body = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    });
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await r.json();
    accessToken = data.access_token;
    await kv.set("runs:strava-tokens", { ...tokens, ...data });
  }

  const r = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) { res.status(r.status).json({ error: "Strava activity fetch failed" }); return; }

  const activity = await r.json();
  const laps = transformSplits(activity.splits_standard || []);

  if (existing && laps.length) {
    existing.laps = laps;
    await kv.set("runs:all", blobRuns);
  }

  res.status(200).json({ laps, cached: false });
}
