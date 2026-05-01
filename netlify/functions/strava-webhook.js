import { getStore } from "@netlify/blobs";

function pad2(n) {
  return String(n).padStart(2, "0");
}

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

function transformActivity(activity) {
  return {
    stravaActivityId: activity.id,
    actualDate: activity.start_date_local.slice(0, 10),
    actualMiles: Math.round(activity.distance * 0.000621371 * 100) / 100,
    runTime: formatHMS(activity.moving_time),
    avgHr: activity.average_heartrate ? Math.round(activity.average_heartrate) : "",
    avgCadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : "",
    elevationGainFt: activity.total_elevation_gain
      ? Math.round(activity.total_elevation_gain * 3.28084)
      : "",
    shoe: activity.gear?.name || "",
    session: activity.name || "Strava run",
    category: categorize(activity),
    source: "Strava",
    notes: "",
    cloudReceivedAt: new Date().toISOString(),
  };
}

async function refreshTokens(store, tokens) {
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

async function processEvent(event) {
  if (event.object_type !== "activity" || event.aspect_type !== "create") return;

  const store = getStore("runs");
  let tokens = await store.get("strava-tokens", { type: "json" });
  if (!tokens) {
    console.error("strava-webhook: no tokens in blob store");
    return;
  }

  if (Date.now() / 1000 >= tokens.expires_at) {
    tokens = await refreshTokens(store, tokens);
  }

  const actRes = await fetch(
    `https://www.strava.com/api/v3/activities/${event.object_id}?include_all_efforts=false`,
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );
  const activity = await actRes.json();

  if (activity.type !== "Run" && activity.sport_type !== "Run") return;

  const run = transformActivity(activity);

  let runs = [];
  try {
    const raw = await store.get("all", { type: "json" });
    if (Array.isArray(raw)) runs = raw;
  } catch {
    // blob doesn't exist yet
  }

  const alreadyExists = runs.some((r) => r.stravaActivityId === run.stravaActivityId);
  if (alreadyExists) {
    console.log(`strava-webhook: activity ${run.stravaActivityId} already stored, skipping`);
    return;
  }

  runs.push(run);
  await store.setJSON("all", runs);
  console.log(`strava-webhook: stored activity ${run.stravaActivityId} (${run.actualDate} ${run.actualMiles}mi)`);
}

export default async function handler(req, context) {
  // GET — Strava webhook verification handshake
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && verifyToken === process.env.STRAVA_VERIFY_TOKEN) {
      return new Response(JSON.stringify({ "hub.challenge": challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // POST — activity event
  if (req.method === "POST") {
    let event;
    try {
      event = await req.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    // context.waitUntil keeps the function alive after the response is sent,
    // preventing Lambda from freezing the process mid-fetch/mid-write.
    const work = processEvent(event).catch((e) =>
      console.error("strava-webhook processEvent error:", e)
    );
    if (context?.waitUntil) {
      context.waitUntil(work);
    } else {
      await work;
    }

    return new Response("OK", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
}
