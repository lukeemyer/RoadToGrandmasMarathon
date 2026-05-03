import { Redis } from "@upstash/redis";

function pad2(n) { return String(n).padStart(2, "0"); }

function formatHMS(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function categorize(activity) {
  if (activity.workout_type === 1) return "Race";
  if (activity.workout_type === 2) return "Long";
  if (activity.workout_type === 3) return "Quality";
  if (activity.distance >= 16093) return "Long";
  return "Easy";
}

// Use splits_standard from the activity detail for per-mile splits
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

function transformActivity(activity, laps = []) {
  return {
    stravaActivityId: activity.id,
    actualDate: activity.start_date_local.slice(0, 10),
    actualMiles: Math.round(activity.distance * 0.000621371 * 100) / 100,
    runTime: formatHMS(activity.moving_time),
    avgHr: activity.average_heartrate ? Math.round(activity.average_heartrate) : "",
    avgCadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : "",
    elevationGainFt: activity.total_elevation_gain
      ? Math.round(activity.total_elevation_gain * 3.28084) : "",
    shoe: activity.gear?.name || "",
    session: activity.name || "Strava run",
    category: categorize(activity),
    source: "Strava",
    notes: "",
    laps,
    cloudReceivedAt: new Date().toISOString(),
  };
}

async function refreshTokens(kv, tokens) {
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
  const updated = { ...tokens, ...data };
  await kv.set("runs:strava-tokens", updated);
  return updated;
}

async function processEvent(kv, event) {
  if (event.object_type !== "activity" || event.aspect_type !== "create") return;

  let tokens = await kv.get("runs:strava-tokens");
  if (!tokens) { console.error("strava-webhook: no tokens in KV store"); return; }

  if (Date.now() / 1000 >= tokens.expires_at) {
    tokens = await refreshTokens(kv, tokens);
  }

  // Fetch full activity detail — splits_standard is included here
  const actRes = await fetch(
    `https://www.strava.com/api/v3/activities/${event.object_id}?include_all_efforts=false`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const activity = await actRes.json();

  if (activity.type !== "Run" && activity.sport_type !== "Run") return;

  const laps = transformSplits(activity.splits_standard || []);
  const run = transformActivity(activity, laps);

  let runs = [];
  try {
    const raw = await kv.get("runs:all");
    if (Array.isArray(raw)) runs = raw;
  } catch {}

  if (runs.some(r => r.stravaActivityId === run.stravaActivityId)) {
    console.log(`strava-webhook: activity ${run.stravaActivityId} already stored, skipping`);
    return;
  }

  runs.push(run);
  await kv.set("runs:all", runs);
  console.log(`strava-webhook: stored ${run.stravaActivityId} (${run.actualDate} ${run.actualMiles}mi)`);
}

export default async function handler(req, res) {
  // GET — Strava webhook verification handshake
  if (req.method === "GET") {
    const { "hub.mode": mode, "hub.verify_token": verifyToken, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && verifyToken === process.env.STRAVA_VERIFY_TOKEN) {
      res.status(200).json({ "hub.challenge": challenge });
      return;
    }
    res.status(403).send("Forbidden");
    return;
  }

  // POST — process first, then respond.
  // Vercel does not guarantee execution continues after res.send(), so we must
  // complete the work before sending 200. Strava retries if we take >2s, but
  // the duplicate-check in processEvent handles that safely.
  if (req.method === "POST") {
    const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    await processEvent(kv, req.body || {}).catch(e =>
      console.error("strava-webhook processEvent error:", e)
    );
    res.status(200).send("OK");
    return;
  }

  res.status(405).send("Method not allowed");
}
