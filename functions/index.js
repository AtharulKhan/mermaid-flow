const { onRequest } = require("firebase-functions/v2/https");

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";
const ROUTE_PREFIX = "/api/notion";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.notion.so",
  "https://notion.so",
  "https://www.notion.site",
  "https://notion.site",
];

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  const configured = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function getHost(urlString) {
  try {
    return new URL(urlString).host;
  } catch {
    return "";
  }
}

function setCors(req, res) {
  const origin = req.get("origin") || "";
  const allowedOrigins = getAllowedOrigins();
  const requestHost = req.get("x-forwarded-host") || req.get("host") || "";

  if (!origin) {
    res.set("Access-Control-Allow-Origin", "*");
    return true;
  }

  const originHost = getHost(origin);
  if (originHost && requestHost && originHost === requestHost) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    return true;
  }

  return false;
}

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

function getNotionPath(reqPath) {
  const cleaned = (reqPath || "/").replace(/\/+$/, "") || "/";
  if (cleaned === ROUTE_PREFIX) return "/";
  if (cleaned.startsWith(ROUTE_PREFIX + "/")) {
    return cleaned.slice(ROUTE_PREFIX.length);
  }
  return cleaned;
}

async function forwardToNotion(res, token, targetPath, body) {
  const notionRes = await fetch(`${NOTION_API_BASE}${targetPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  const text = await notionRes.text();
  const contentType = notionRes.headers.get("content-type") || "application/json";

  res.status(notionRes.status);
  res.set("Content-Type", contentType);
  res.set("Cache-Control", "no-store");
  res.send(text);
}

exports.notionProxy = onRequest(
  {
    region: "us-central1",
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async (req, res) => {
    if (!setCors(req, res)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing Authorization Bearer token." });
      return;
    }

    const notionPath = getNotionPath(req.path);

    try {
      if (notionPath === "/pages") {
        await forwardToNotion(res, token, "/pages", req.body);
        return;
      }

      const dbMatch = notionPath.match(/^\/databases\/([^/]+)\/query$/);
      if (dbMatch) {
        const databaseId = dbMatch[1];
        await forwardToNotion(res, token, `/databases/${databaseId}/query`, req.body);
        return;
      }

      res.status(404).json({
        error: "Unknown Notion proxy route.",
        supported: ["/api/notion/pages", "/api/notion/databases/:id/query"],
      });
    } catch (error) {
      res.status(502).json({
        error: "Proxy request to Notion failed.",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);
