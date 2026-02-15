/**
 * Notion Gantt Sync
 *
 * Provides bidirectional sync between Mermaid Gantt charts and Notion databases.
 *
 * Architecture:
 * - This module runs client-side but Notion API requires a server proxy
 *   (Notion API doesn't support CORS for browser-direct calls).
 * - For direct usage, use the Notion OAuth flow and a small proxy/serverless function.
 * - The exported functions can also be used from a Node.js backend.
 *
 * Notion Database Schema (expected):
 *   - Name (title) — task name
 *   - Status (select) — "Not Started" | "In Progress" | "Done"
 *   - Start Date (date) — start date
 *   - End Date (date) — end date
 *   - Assignee (rich_text or people) — assignee
 *   - Section (select) — Gantt section name
 */

import { parseGanttTasks } from "./ganttUtils";

// ── Gantt → Notion: Convert Mermaid code to Notion page payloads ──

export function ganttToNotionPages(mermaidCode, databaseId) {
  const tasks = parseGanttTasks(mermaidCode);

  return tasks.map((task) => {
    let computedEnd = task.endDate || "";
    if (!computedEnd && task.startDate && task.durationDays) {
      const d = new Date(task.startDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + task.durationDays);
      computedEnd = d.toISOString().slice(0, 10);
    }

    const statusMap = {
      done: "Done",
      active: "In Progress",
      crit: "In Progress",
    };
    const status = task.statusTokens?.find((t) => statusMap[t]);
    const notionStatus = status ? statusMap[status] : "Not Started";

    return {
      parent: { database_id: databaseId },
      properties: {
        Name: {
          title: [{ text: { content: task.label } }],
        },
        Status: {
          select: { name: notionStatus },
        },
        ...(task.startDate && {
          "Start Date": {
            date: {
              start: task.startDate,
              ...(computedEnd && { end: computedEnd }),
            },
          },
        }),
        ...(task.assignee && {
          Assignee: {
            rich_text: [{ text: { content: task.assignee } }],
          },
        }),
        ...(task.section && {
          Section: {
            select: { name: task.section },
          },
        }),
      },
    };
  });
}

// ── Notion → Gantt: Convert Notion pages to Mermaid code ──

export function notionPagesToGantt(pages, title = "Project Timeline") {
  // Group by section
  const sections = new Map();

  for (const page of pages) {
    const props = page.properties;

    const name = props.Name?.title?.[0]?.plain_text || "Untitled";
    const section = props.Section?.select?.name || "Tasks";
    const status = props.Status?.select?.name || "";
    const startDate = props["Start Date"]?.date?.start || "";
    const endDate = props["Start Date"]?.date?.end || "";
    const assignee = props.Assignee?.rich_text?.[0]?.plain_text || "";

    if (!sections.has(section)) sections.set(section, []);

    const statusTokens = [];
    if (status === "Done") statusTokens.push("done");
    else if (status === "In Progress") statusTokens.push("active");

    // Calculate duration
    let duration = "";
    if (startDate && endDate) {
      const days = Math.round(
        (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)
      );
      duration = `${Math.max(1, days)}d`;
    } else {
      duration = "3d"; // default
    }

    const taskId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20);

    sections.get(section).push({
      name,
      taskId,
      statusTokens,
      startDate,
      duration,
      assignee,
    });
  }

  // Build Mermaid code
  let code = `gantt\n    title ${title}\n    dateFormat  YYYY-MM-DD\n    axisFormat  %b %d\n`;

  for (const [section, tasks] of sections) {
    code += `\n    section ${section}\n`;
    for (const t of tasks) {
      const statusStr = t.statusTokens.length > 0
        ? t.statusTokens.join(", ") + ", "
        : "";
      const dateStr = t.startDate || "2026-03-01";
      code += `    ${t.name.padEnd(30)}:${statusStr}${t.taskId}, ${dateStr}, ${t.duration}\n`;

      if (t.assignee) {
        code += `    %% assignee: ${t.assignee}\n`;
      }
    }
  }

  return code;
}

// ── Notion API helpers (require server proxy) ──

const NOTION_PROXY_URL = "/api/notion"; // Your proxy endpoint

/**
 * Sync Gantt chart to Notion database.
 * Requires a server proxy at NOTION_PROXY_URL that forwards to Notion API.
 */
export async function syncGanttToNotion(mermaidCode, databaseId, accessToken) {
  const pages = ganttToNotionPages(mermaidCode, databaseId);
  const results = [];

  for (const page of pages) {
    const res = await fetch(`${NOTION_PROXY_URL}/pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(page),
    });
    if (!res.ok) {
      throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
    }
    results.push(await res.json());
  }

  return results;
}

/**
 * Import tasks from Notion database into Gantt chart.
 */
export async function importFromNotion(databaseId, accessToken, title) {
  const res = await fetch(`${NOTION_PROXY_URL}/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      sorts: [{ property: "Start Date", direction: "ascending" }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return notionPagesToGantt(data.results, title);
}

/**
 * Generate the Notion OAuth URL for user authorization.
 */
export function getNotionAuthUrl() {
  const clientId = import.meta.env.VITE_NOTION_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_NOTION_REDIRECT_URI;
  if (!clientId) return null;
  return `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}`;
}
