import { getStore } from "@netlify/blobs";

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

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token !== process.env.SHARED_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const store = getStore("runs");
  let runs = [];
  try {
    const raw = await store.get("all", { type: "json" });
    if (Array.isArray(raw)) runs = raw;
  } catch {
    // blob doesn't exist yet — return empty array
  }

  return new Response(JSON.stringify({ runs }), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export const config = { path: "/api/get-runs" };
