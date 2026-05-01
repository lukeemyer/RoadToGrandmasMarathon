import { Redis } from "@upstash/redis";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  let runs = [];
  try {
    const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const raw = await kv.get("runs:all");
    if (Array.isArray(raw)) runs = raw;
  } catch (e) {
    console.error("get-runs: Redis error:", e.message);
    // return empty array rather than erroring — page still loads
  }

  res.status(200).setHeader("Content-Type", "application/json").json({ runs });
}
