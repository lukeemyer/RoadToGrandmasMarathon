import { Redis } from "@upstash/redis";

const ok = (body) =>
  new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const err = (msg) =>
  new Response(
    `<!DOCTYPE html><html><body><h2>Error connecting Strava</h2><pre>${msg}</pre></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

export default async function handler(req) {
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    console.error("strava-callback: UPSTASH_REDIS_REST_URL not set");
    return err("Server misconfigured: Redis env vars missing");
  }
  if (!process.env.STRAVA_CLIENT_ID) {
    console.error("strava-callback: STRAVA_CLIENT_ID not set");
    return err("Server misconfigured: Strava env vars missing");
  }

  const kv = Redis.fromEnv();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return err(error);
  if (!code) return err("Missing code parameter");

  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
  });

  let data;
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: abort.signal,
    });
    clearTimeout(timer);
    data = await res.json();
  } catch (e) {
    console.error("strava-callback: token exchange failed:", e);
    return err(`Token exchange failed: ${e.message || String(e)}`);
  }

  if (data.errors || !data.access_token) {
    return err(JSON.stringify(data));
  }

  await kv.set("runs:strava-tokens", {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete: data.athlete,
  });

  return ok(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Strava Connected</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.box{text-align:center;padding:2rem;border-radius:12px;background:#f0fdf4;border:1px solid #bbf7d0;}</style>
</head>
<body><div class="box">
<h2 style="color:#16a34a">✓ Strava connected</h2>
<p>Your tokens have been saved. You can close this tab.</p>
</div></body></html>`);
}
