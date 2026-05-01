import { kv } from "@vercel/kv";

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

function transform(activity, gearMap = new Map()) {
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
    cloudReceivedAt: new Date().toISOString(),
  };
}

async function getValidTokens() {
  const tokens = await kv.get("runs:strava-tokens");
  if (!tokens) return null;

  if (Date.now() / 1000 < tokens.expires_at) return tokens;

  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  const updated = { ...tokens, ...data };
  await kv.set("runs:strava-tokens", updated);
  return updated;
}

async function fetchAllRunActivities(accessToken, afterTs) {
  const runs = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const a of batch) {
      if (a.type === "Run" || a.sport_type === "Run") runs.push(a);
    }
    if (batch.length < 100) break;
    page++;
  }
  return runs;
}

async function fetchGearNames(accessToken, activities) {
  const gearIds = [...new Set(activities.map(a => a.gear_id).filter(Boolean))];
  if (!gearIds.length) return new Map();

  let cached = {};
  try { cached = (await kv.get("runs:gear-cache")) || {}; } catch {}

  const gearMap = new Map(Object.entries(cached));
  const uncached = gearIds.filter(id => !gearMap.has(id));

  if (uncached.length) {
    await Promise.all(uncached.map(async id => {
      try {
        const res = await fetch(`https://www.strava.com/api/v3/gear/${id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          const g = await res.json();
          if (g.name) { gearMap.set(id, g.name); cached[id] = g.name; }
        }
      } catch {}
    }));
    await kv.set("runs:gear-cache", cached);
  }

  return gearMap;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  const since = url.searchParams.get("since") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const afterTs = Math.floor(new Date(since + "T00:00:00Z").getTime() / 1000);

  const tokens = await getValidTokens();
  if (!tokens) {
    let runs = [];
    try { const r = await kv.get("runs:all"); if (Array.isArray(r)) runs = r; } catch {}
    return json({ runs, added: 0, removed: 0 });
  }

  const stravaRuns = await fetchAllRunActivities(tokens.access_token, afterTs);
  const stravaIdSet = new Set(stravaRuns.map(a => a.id));

  const gearMap = await fetchGearNames(tokens.access_token, stravaRuns);

  let blobRuns = [];
  try {
    const raw = await kv.get("runs:all");
    if (Array.isArray(raw)) blobRuns = raw;
  } catch {}

  const beforeCount = blobRuns.length;
  blobRuns = blobRuns.filter(r =>
    !r.stravaActivityId ||
    stravaIdSet.has(r.stravaActivityId) ||
    r.actualDate < since
  );
  const removed = beforeCount - blobRuns.length;

  const blobIdSet = new Set(blobRuns.filter(r => r.stravaActivityId).map(r => r.stravaActivityId));
  let added = 0;
  let gearPatched = 0;
  for (const a of stravaRuns) {
    if (!blobIdSet.has(a.id)) {
      blobRuns.push(transform(a, gearMap));
      added++;
    } else {
      const existing = blobRuns.find(r => r.stravaActivityId === a.id);
      if (existing && !existing.shoe) {
        const shoeName = a.gear?.name || gearMap.get(a.gear_id) || "";
        if (shoeName) { existing.shoe = shoeName; gearPatched++; }
      }
    }
  }

  if (added > 0 || removed > 0 || gearPatched > 0) {
    await kv.set("runs:all", blobRuns);
  }

  return json({ runs: blobRuns, added, removed });
}
