const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION = /^(\d+)([dwmy])$/i;

function isDirectiveLine(trimmed) {
  return (
    !trimmed ||
    trimmed.startsWith("gantt") ||
    trimmed.startsWith("title ") ||
    trimmed.startsWith("dateFormat ") ||
    trimmed.startsWith("axisFormat ") ||
    trimmed.startsWith("tickInterval ") ||
    trimmed.startsWith("todayMarker ") ||
    trimmed.startsWith("excludes ") ||
    trimmed.startsWith("%%")
  );
}

function durationToDays(token) {
  const match = token.match(DURATION);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "d") return value;
  if (unit === "w") return value * 7;
  if (unit === "m") return value * 30;
  if (unit === "y") return value * 365;
  return null;
}

export function shiftIsoDate(isoDate, dayDelta) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day + dayDelta);
  const shifted = new Date(utc);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function parseGanttTasks(code) {
  const lines = code.split("\n");
  const tasks = [];

  lines.forEach((rawLine, lineIndex) => {
    const trimmed = rawLine.trim();
    if (isDirectiveLine(trimmed) || trimmed.startsWith("section ")) return;

    const match = rawLine.match(/^(\s*)([^:\n][^:]*)\s*:\s*(.+?)\s*$/);
    if (!match) return;

    const indent = match[1] || "";
    const label = (match[2] || "").trim();
    const tokenPart = match[3] || "";
    const tokens = tokenPart
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (!tokens.length) return;

    const dateIndex = tokens.findIndex((token) => ISO_DATE.test(token));
    const startDate = dateIndex >= 0 ? tokens[dateIndex] : "";

    // Check for end date (second ISO date after start date)
    const endDateIndex =
      dateIndex >= 0
        ? tokens.findIndex((t, i) => i > dateIndex && ISO_DATE.test(t))
        : -1;
    const endDate = endDateIndex >= 0 ? tokens[endDateIndex] : "";

    // Duration token: only valid if it's right after start date AND there's no end date at that position
    const nextAfterDate = dateIndex >= 0 ? tokens[dateIndex + 1] || "" : "";
    const durationIndex =
      dateIndex >= 0 && endDateIndex !== dateIndex + 1 && DURATION.test(nextAfterDate)
        ? dateIndex + 1
        : -1;
    const durationToken = durationIndex >= 0 ? tokens[durationIndex] : "";
    let durationDays = durationToken ? durationToDays(durationToken) : null;

    // Compute durationDays from date difference when using end date syntax
    if (!durationDays && startDate && endDate) {
      const s = new Date(startDate + "T00:00:00Z");
      const e = new Date(endDate + "T00:00:00Z");
      durationDays = Math.round((e - s) / (1000 * 60 * 60 * 24));
    }

    tasks.push({
      lineIndex,
      rawLine,
      indent,
      label,
      tokens,
      dateIndex,
      durationIndex,
      startDate,
      durationToken,
      durationDays,
      endDateIndex,
      endDate,
      hasExplicitDate: dateIndex >= 0,
    });
  });

  return tasks;
}

export function findTaskByLabel(tasks, label) {
  if (!label) return null;
  const clean = label.trim();
  return (
    tasks.find((task) => task.label === clean) ||
    tasks.find((task) => task.label.toLowerCase() === clean.toLowerCase()) ||
    null
  );
}

export function updateGanttTask(code, task, updates) {
  if (!task) return code;

  const lines = code.split("\n");
  const nextTokens = [...task.tokens];
  const nextLabel = (updates.label || task.label).trim();

  if (updates.startDate && task.dateIndex >= 0) {
    nextTokens[task.dateIndex] = updates.startDate;
  }

  if (updates.endDate && task.endDateIndex >= 0) {
    nextTokens[task.endDateIndex] = updates.endDate;
  }

  if (updates.duration) {
    if (task.durationIndex >= 0) {
      nextTokens[task.durationIndex] = updates.duration;
    } else if (task.dateIndex >= 0) {
      nextTokens.splice(task.dateIndex + 1, 0, updates.duration);
    } else {
      nextTokens.push(updates.duration);
    }
  }

  lines[task.lineIndex] = `${task.indent}${nextLabel} :${nextTokens.join(", ")}`;
  return lines.join("\n");
}
