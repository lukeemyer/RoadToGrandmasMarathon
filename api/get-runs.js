import { kv } from "@vercel/kv";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  let runs = [];
  try {
    const raw = await kv.get("runs:all");
    if (Array.isArray(raw)) runs = raw;
  } catch {
    // KV not configured yet — return empty array
  }

  return new Response(JSON.stringify({ runs }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
