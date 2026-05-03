import { Redis } from "@upstash/redis";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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

// Use splits_standard from activity detail — always gives per-mile splits
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

async function fetchSplits(accessToken, activityId) {
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return [];
    const a = await r.json();
    return transformSplits(a.splits_standard || []);
  } catch { return []; }
}

function transform(activity, gearMap = new Map(), laps = []) {
  const shoeName = activity.gear?.name || gearMap.get(activity.gear_id) || "";
  return {
    stravaActivityId: activity.id,
    actualDate: activity.start_date_local.slice(0, 10),
    actualMiles: Math.round(activity.distance * 0.000621371 * 100) / 100,
    runTime: formatHMS(activity.moving_time),
    avgHr: activity.average_heartrate ? Math.round(activity.average_heartrate) : "",
    avgCadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : "",
    elevationGainFt: activity.total_elevation_gain
      ? Math.round(activity.total_elevation_gain * 3.28084) : "",
    shoe: shoeName,
    session: activity.name || "Strava run",
    category: categorize(activity),
    source: "Strava",
    notes: "",
    laps,
    cloudReceivedAt: new Date().toISOString(),
  };
}

async function getValidTokens(kv) {
  const tokens = await kv.get("runs:strava-tokens");
  if (!tokens) return null;
  if (Date.now() / 1000 < tokens.expires_at) return tokens;
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

async function fetchAllRunActivities(accessToken, afterTs) {
  const runs = [];
  let page = 1;
  while (true) {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) break;
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const a of batch) {
      if (a.type === "Run" || a.sport_type === "Run") runs.push(a);
    }
    if (batch.length < 100) break;
    page++;
  }
  return runs;
}

async function fetchGearNames(kv, accessToken, activities) {
  const gearIds = [...new Set(activities.map(a => a.gear_id).filter(Boolean))];
  if (!gearIds.length) return new Map();
  let cached = {};
  try { cached = (await kv.get("runs:gear-cache")) || {}; } catch {}
  const gearMap = new Map(Object.entries(cached));
  const uncached = gearIds.filter(id => !gearMap.has(id));
  if (uncached.length) {
    await Promise.all(uncached.map(async id => {
      try {
        const r = await fetch(`https://www.strava.com/api/v3/gear/${id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (r.ok) {
          const g = await r.json();
          if (g.name) { gearMap.set(id, g.name); cached[id] = g.name; }
        }
      } catch {}
    }));
    await kv.set("runs:gear-cache", cached);
  }
  return gearMap;
}

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

  const since = req.query.since ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const afterTs = Math.floor(new Date(since + "T00:00:00Z").getTime() / 1000);

  const tokens = await getValidTokens(kv);
  if (!tokens) {
    let runs = [];
    try { const r = await kv.get("runs:all"); if (Array.isArray(r)) runs = r; } catch {}
    res.status(200).json({ runs, added: 0, removed: 0 });
    return;
  }

  const stravaRuns = await fetchAllRunActivities(tokens.access_token, afterTs);
  const stravaIdSet = new Set(stravaRuns.map(a => a.id));
  const gearMap = await fetchGearNames(kv, tokens.access_token, stravaRuns);

  let blobRuns = [];
  try {
    const raw = await kv.get("runs:all");
    if (Array.isArray(raw)) blobRuns = raw;
  } catch {}

  const beforeCount = blobRuns.length;
  blobRuns = blobRuns.filter(r =>
    !r.stravaActivityId || stravaIdSet.has(r.stravaActivityId) || r.actualDate < since
  );
  const removed = beforeCount - blobRuns.length;

  const blobIdSet = new Set(blobRuns.filter(r => r.stravaActivityId).map(r => r.stravaActivityId));
  let added = 0, gearPatched = 0, lapsPatched = 0;

  const newActivities = stravaRuns.filter(a => !blobIdSet.has(a.id));

  // ── Step 1: fetch splits for new runs and add them ──
  // Done separately so new runs are always saved even if the backfill step below is slow.
  const newSplitsResults = await Promise.all(
    newActivities.map(a => fetchSplits(tokens.access_token, a.id))
  );
  newActivities.forEach((a, i) => {
    blobRuns.push(transform(a, gearMap, newSplitsResults[i] || []));
    added++;
  });

  // Patch existing runs (gear names)
  for (const a of stravaRuns) {
    const existing = blobRuns.find(r => r.stravaActivityId === a.id);
    if (!existing) continue;
    if (!existing.shoe) {
      const shoeName = a.gear?.name || gearMap.get(a.gear_id) || "";
      if (shoeName) { existing.shoe = shoeName; gearPatched++; }
    }
  }

  // Save new runs immediately — don't let backfill delay block them
  if (added > 0 || removed > 0 || gearPatched > 0) {
    await kv.set("runs:all", blobRuns);
  }

  // ── Step 2: backfill splits for existing runs missing them (small batch) ──
  // Keep at 5 to stay well within Vercel's 10s function timeout.
  const needsLapsBackfill = blobRuns
    .filter(r => r.stravaActivityId && stravaIdSet.has(r.stravaActivityId) &&
      (!r.laps?.length || (r.laps.length === 1 && (r.actualMiles || 0) >= 1.5)))
    .slice(0, 5);

  if (needsLapsBackfill.length) {
    const backfillResults = await Promise.all(
      needsLapsBackfill.map(r => fetchSplits(tokens.access_token, r.stravaActivityId))
    );
    needsLapsBackfill.forEach((r, i) => {
      const laps = backfillResults[i];
      if (laps?.length > 1) { r.laps = laps; lapsPatched++; }
    });
    if (lapsPatched > 0) await kv.set("runs:all", blobRuns);
  }

  res.status(200).json({ runs: blobRuns, added, removed });
}
