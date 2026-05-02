import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).send("Method not allowed"); return; }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader.replace(/^Bearer\s+/i, "") !== process.env.SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const appState = await kv.get("runs:app-state");
  res.status(200).json({ state: appState || null });
}
