import { Redis } from "@upstash/redis";

function withTimeout(promise, ms, label) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`)), ms)
  );
  return Promise.race([promise, timer]);
}

export default async function handler(req, res) {
  console.log("strava-callback: handler start");

  if (!process.env.UPSTASH_REDIS_REST_URL) {
    console.error("strava-callback: UPSTASH_REDIS_REST_URL not set");
    res.status(500).send("Server misconfigured: UPSTASH_REDIS_REST_URL missing");
    return;
  }
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    console.error("strava-callback: Strava env vars not set");
    res.status(500).send("Server misconfigured: STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET missing");
    return;
  }

  const code = req.query?.code;
  const error = req.query?.error;

  console.log(`strava-callback: code present=${!!code}, error=${error || "none"}`);

  if (error) {
    res.status(400).send(`<pre>Strava authorization error: ${error}</pre>`);
    return;
  }
  if (!code) {
    res.status(400).send("<pre>Missing code parameter</pre>");
    return;
  }

  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
  });

  let data;
  try {
    console.log("strava-callback: starting Strava token exchange");
    const abort = new AbortController();
    const stravaRes = await withTimeout(
      fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: abort.signal,
      }),
      10000,
      "Strava token exchange fetch"
    );
    console.log(`strava-callback: Strava response status=${stravaRes.status}`);
    data = await withTimeout(stravaRes.json(), 5000, "Strava response JSON parse");
  } catch (e) {
    console.error("strava-callback: token exchange failed:", e.message);
    res.status(500).send(`<pre>Token exchange failed: ${e.message}</pre>`);
    return;
  }

  if (data.errors || !data.access_token) {
    console.error("strava-callback: bad token response (no secret logged)");
    res.status(400).send(`<pre>Strava returned an error. Check server logs.</pre>`);
    return;
  }

  try {
    console.log("strava-callback: saving tokens to Redis");
    const kv = Redis.fromEnv();
    await withTimeout(
      kv.set("runs:strava-tokens", {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        athlete: data.athlete,
      }),
      10000,
      "Redis save"
    );
    console.log("strava-callback: Redis save complete");
  } catch (e) {
    console.error("strava-callback: Redis save failed:", e.message);
    res.status(500).send(`<pre>Redis save failed: ${e.message}</pre>`);
    return;
  }

  console.log("strava-callback: sending success response");
  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Strava Connected</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.box{text-align:center;padding:2rem;border-radius:12px;background:#f0fdf4;border:1px solid #bbf7d0;}</style>
</head>
<body><div class="box">
<h2 style="color:#16a34a">&#10003; Strava connected</h2>
<p>Your tokens have been saved. You can close this tab.</p>
</div></body></html>`);
}
