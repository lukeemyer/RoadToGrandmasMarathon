import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }

  const envReady = !!(
    process.env.STRAVA_CLIENT_ID &&
    process.env.STRAVA_CLIENT_SECRET &&
    process.env.STRAVA_VERIFY_TOKEN &&
    process.env.SHARED_SECRET &&
    process.env.KV_REST_API_URL &&
    process.env.KV_REST_API_TOKEN
  );

  let dbReady = false;
  let stravaConnected = false;
  let webhookRegistered = false;

  if (envReady) {
    try {
      const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
      const tokens = await kv.get("runs:strava-tokens");
      dbReady = true;
      stravaConnected = !!(tokens && tokens.access_token);
    } catch {}

    if (stravaConnected) {
      try {
        const r = await fetch(
          `https://www.strava.com/api/v3/push_subscriptions?client_id=${process.env.STRAVA_CLIENT_ID}&client_secret=${process.env.STRAVA_CLIENT_SECRET}`
        );
        if (r.ok) {
          const subs = await r.json();
          webhookRegistered = Array.isArray(subs) && subs.length > 0;
        }
      } catch {}
    }
  }

  res.status(200).json({ envReady, dbReady, stravaConnected, webhookRegistered });
}
