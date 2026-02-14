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
    const durationIndex =
      dateIndex >= 0 && DURATION.test(tokens[dateIndex + 1] || "") ? dateIndex + 1 : -1;
    const startDate = dateIndex >= 0 ? tokens[dateIndex] : "";
    const durationToken = durationIndex >= 0 ? tokens[durationIndex] : "";
    const durationDays = durationToken ? durationToDays(durationToken) : null;

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
