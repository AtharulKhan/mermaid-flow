/**
 * Notion Gantt Sync
 *
 * Provides bidirectional sync between Mermaid Gantt charts and Notion databases.
 *
 * Architecture:
 * - This module runs client-side but Notion API requires a server proxy
 *   (Notion API doesn't support CORS for browser-direct calls).
 * - API keys are stored per-user in Firestore, NOT in environment variables.
 * - Users configure their Notion integration token and database ID
 *   in the Settings page.
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

const FALLBACK_START_DATE = "2026-03-01";

function readPlainText(nodes = []) {
  return nodes
    .map((node) => node?.plain_text || node?.text?.content || "")
    .join("")
    .trim();
}

function findPropertyByName(properties, candidates) {
  if (!properties) return null;

  for (const name of candidates) {
    if (properties[name]) return properties[name];
  }

  const lowerMap = new Map(
    Object.entries(properties).map(([name, value]) => [name.toLowerCase(), value])
  );
  for (const name of candidates) {
    const hit = lowerMap.get(name.toLowerCase());
    if (hit) return hit;
  }

  return null;
}

function readDateProperty(prop) {
  if (!prop?.date) return { start: "", end: "" };
  return {
    start: prop.date.start || "",
    end: prop.date.end || "",
  };
}

function readAssigneeProperty(prop) {
  if (!prop) return "";

  if (Array.isArray(prop.people) && prop.people.length > 0) {
    return prop.people
      .map((person) => person?.name || person?.person?.email || "")
      .filter(Boolean)
      .join(", ");
  }

  if (Array.isArray(prop.rich_text)) {
    return readPlainText(prop.rich_text);
  }

  if (prop.select?.name) return prop.select.name;
  return "";
}

function readTitleProperty(properties) {
  const explicit = findPropertyByName(properties, ["Name", "Task Name", "Title"]);
  if (explicit?.title) return readPlainText(explicit.title) || "Untitled";

  const anyTitle = Object.values(properties || {}).find((prop) => Array.isArray(prop?.title));
  if (anyTitle?.title) return readPlainText(anyTitle.title) || "Untitled";

  return "Untitled";
}

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
    const props = page.properties || {};

    const name = readTitleProperty(props);
    const sectionProp = findPropertyByName(props, ["Section", "Group", "Phase"]);
    const statusProp = findPropertyByName(props, ["Status", "State"]);
    const startDateProp = findPropertyByName(props, [
      "Start Date",
      "Timeline",
      "Date",
      "Dates",
    ]);
    const endDateProp = findPropertyByName(props, [
      "End Date",
      "Due Date",
      "Finish Date",
      "End",
    ]);
    const assigneeProp = findPropertyByName(props, ["Assignee", "Owner", "Assignees"]);

    const section =
      sectionProp?.select?.name ||
      readPlainText(sectionProp?.rich_text || []) ||
      "Tasks";
    const status =
      statusProp?.select?.name ||
      readPlainText(statusProp?.rich_text || []) ||
      "";
    const startDateRange = readDateProperty(startDateProp);
    const endDateRange = readDateProperty(endDateProp);
    const startDate = startDateRange.start || "";
    const endDate = endDateRange.start || startDateRange.end || endDateRange.end || "";
    const assignee = readAssigneeProperty(assigneeProp);

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
    tasks.sort((a, b) => {
      if (!a.startDate && !b.startDate) return 0;
      if (!a.startDate) return 1;
      if (!b.startDate) return -1;
      return a.startDate.localeCompare(b.startDate);
    });

    code += `\n    section ${section}\n`;
    for (const t of tasks) {
      const statusStr = t.statusTokens.length > 0
        ? t.statusTokens.join(", ") + ", "
        : "";
      const dateStr = t.startDate || FALLBACK_START_DATE;
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
 * @param {string} mermaidCode - The Mermaid Gantt code
 * @param {string} databaseId - Notion database ID
 * @param {string} accessToken - User's Notion integration token
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
 * @param {string} databaseId - Notion database ID
 * @param {string} accessToken - User's Notion integration token
 * @param {string} title - Title for the generated Gantt chart
 */
export async function importFromNotion(databaseId, accessToken, title) {
  const res = await fetch(`${NOTION_PROXY_URL}/databases/${databaseId}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return notionPagesToGantt(data.results, title);
}
