import { getStore } from "@netlify/blobs";

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

function transform(activity) {
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
    cloudReceivedAt: new Date().toISOString(),
  };
}

async function getValidTokens(store) {
  const tokens = await store.get("strava-tokens", { type: "json" });
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
  await store.setJSON("strava-tokens", updated);
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

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  const url = new URL(req.url);
  // since defaults to 90 days ago if not specified
  const since = url.searchParams.get("since") ||
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const afterTs = Math.floor(new Date(since + "T00:00:00Z").getTime() / 1000);

  const store = getStore("runs");

  const tokens = await getValidTokens(store);
  if (!tokens) {
    // No tokens yet — return blob as-is with no changes
    let runs = [];
    try { const r = await store.get("all", { type: "json" }); if (Array.isArray(r)) runs = r; } catch {}
    return json({ runs, added: 0, removed: 0 });
  }

  // Fetch all Strava running activities in the window
  const stravaRuns = await fetchAllRunActivities(tokens.access_token, afterTs);
  const stravaIdSet = new Set(stravaRuns.map(a => a.id));

  // Read current blob
  let blobRuns = [];
  try {
    const raw = await store.get("all", { type: "json" });
    if (Array.isArray(raw)) blobRuns = raw;
  } catch {}

  // Remove entries deleted from Strava (only within the sync window to avoid
  // clobbering runs from before the plan start that we never fetched)
  const beforeCount = blobRuns.length;
  blobRuns = blobRuns.filter(r =>
    !r.stravaActivityId ||
    stravaIdSet.has(r.stravaActivityId) ||
    r.actualDate < since
  );
  const removed = beforeCount - blobRuns.length;

  // Add runs missing from blob
  const blobIdSet = new Set(blobRuns.filter(r => r.stravaActivityId).map(r => r.stravaActivityId));
  let added = 0;
  for (const a of stravaRuns) {
    if (!blobIdSet.has(a.id)) {
      blobRuns.push(transform(a));
      added++;
    }
  }

  if (added > 0 || removed > 0) {
    await store.setJSON("all", blobRuns);
  }

  return json({ runs: blobRuns, added, removed });
}
