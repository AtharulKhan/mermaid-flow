const { onRequest } = require("firebase-functions/v2/https");
const fs = require("fs");
const path = require("path");

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
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

  // Allow Vercel preview deployments
  if (/^https:\/\/.*\.vercel\.app$/.test(origin)) {
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

/* ── AI Generate ─────────────────────────────────── */

function loadPromptTemplate(chartType) {
  const promptPath = path.join(__dirname, "prompts", `prompt-${chartType}.md`);
  try {
    return fs.readFileSync(promptPath, "utf-8");
  } catch {
    // Fallback to gantt prompt as generic template
    const fallback = path.join(__dirname, "prompts", "prompt-gantt.md");
    return fs.readFileSync(fallback, "utf-8");
  }
}

async function sleepWithBackoff(attempt) {
  const baseDelay = 1000;
  const maxDelay = 30000;
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = delay * 0.1 * Math.random();
  return new Promise((resolve) => setTimeout(resolve, delay + jitter));
}

exports.aiGenerate = onRequest(
  {
    region: "us-central1",
    memory: "512MiB",
    timeoutSeconds: 60,
  },
  async (req, res) => {
    if (!setCors(req, res)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }

    res.set("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed. Use POST." });
      return;
    }

    const { chartType, context } = req.body || {};
    if (!context || typeof context !== "string" || context.trim().length === 0) {
      res.status(400).json({ error: "Missing or empty context field." });
      return;
    }

    const normalizedChartType = (chartType || "gantt").toLowerCase();

    let promptTemplate;
    try {
      promptTemplate = loadPromptTemplate(normalizedChartType);
    } catch (err) {
      res.status(500).json({ error: "Failed to load prompt template." });
      return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || "minimax/minimax-m2.5";

    if (!apiKey) {
      res.status(500).json({ error: "OPENROUTER_API_KEY not configured." });
      return;
    }

    const systemMessage = promptTemplate;
    const userMessage =
      `Chart type requested: ${normalizedChartType}\n\n` +
      `Today's date: ${new Date().toISOString().split("T")[0]}\n\n` +
      `Project context:\n${context.trim()}`;

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 50000);

        const orRes = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://app.mermaidflow.co",
            "X-Title": "MermaidFlow",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemMessage },
              { role: "user", content: userMessage },
            ],
            temperature: 0.3,
            max_tokens: 8192,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!orRes.ok) {
          const errText = await orRes.text();
          const err = new Error(`OpenRouter ${orRes.status}: ${errText}`);
          // Don't retry on client errors (except rate limiting)
          if (orRes.status >= 400 && orRes.status < 500 && orRes.status !== 429) {
            res.status(502).json({
              error: "AI generation failed.",
              details: err.message,
            });
            return;
          }
          throw err;
        }

        const orData = await orRes.json();
        const rawContent = orData.choices?.[0]?.message?.content || "";

        // Parse JSON with recovery
        let parsed;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          // Try extracting JSON from markdown code blocks
          const match = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (match) {
            parsed = JSON.parse(match[1].trim());
          } else {
            // Try finding first { to last }
            const start = rawContent.indexOf("{");
            const end = rawContent.lastIndexOf("}");
            if (start !== -1 && end > start) {
              parsed = JSON.parse(rawContent.slice(start, end + 1));
            } else {
              throw new Error("Failed to parse AI response as JSON");
            }
          }
        }

        if (!parsed.code || typeof parsed.code !== "string") {
          throw new Error("AI response missing 'code' field");
        }

        res.status(200).json({
          code: parsed.code,
          title: parsed.title || "Untitled",
          summary: parsed.summary || "",
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          await sleepWithBackoff(attempt);
        }
      }
    }

    res.status(502).json({
      error: "AI generation failed after retries.",
      details: lastError?.message || "Unknown error",
    });
  }
);
