import { Redis } from "@upstash/redis";

function transformLaps(laps) {
  if (!Array.isArray(laps)) return [];
  return laps.map(lap => {
    const mi = (lap.distance || 0) * 0.000621371;
    const paceSecMi = mi > 0.05 ? Math.round(lap.moving_time / mi) : null;
    return {
      n: lap.split || (lap.lap_index + 1),
      mi: Math.round(mi * 100) / 100,
      sec: lap.moving_time || 0,
      paceSecMi,
      hr: lap.average_heartrate ? Math.round(lap.average_heartrate) : null,
      cad: lap.average_cadence ? Math.round(lap.average_cadence * 2) : null,
      elev: lap.total_elevation_gain ? Math.round(lap.total_elevation_gain * 3.28084) : null,
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

  // Return cached laps if already stored
  let blobRuns = [];
  try { const r = await kv.get("runs:all"); if (Array.isArray(r)) blobRuns = r; } catch {}
  const existing = blobRuns.find(r => r.stravaActivityId === activityId);
  if (existing?.laps?.length) {
    res.status(200).json({ laps: existing.laps, cached: true });
    return;
  }

  // Fetch from Strava
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

  const r = await fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) { res.status(r.status).json({ error: "Strava laps fetch failed" }); return; }

  const laps = transformLaps(await r.json());

  // Cache in runs:all
  if (existing && laps.length) {
    existing.laps = laps;
    await kv.set("runs:all", blobRuns);
  }

  res.status(200).json({ laps, cached: false });
}
