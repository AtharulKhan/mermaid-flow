const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DURATION = /^(\d+)([dwmy])$/i;
const STATUS_TOKENS = new Set(["done", "active", "crit"]);

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

function findMetadataEndIndex(lines, taskLineIndex) {
  let endIndex = taskLineIndex;
  for (let i = taskLineIndex + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("%%")) break;
    endIndex = i;
  }
  return endIndex;
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

    // Identify leading status tokens (done, active, crit)
    const statusTokens = [];
    const statusIndices = [];
    for (let i = 0; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase();
      if (STATUS_TOKENS.has(lower)) {
        statusTokens.push(lower);
        statusIndices.push(i);
      } else if (lower === "milestone") {
        continue;
      } else {
        break;
      }
    }

    const dateIndex = tokens.findIndex((token) => ISO_DATE.test(token));
    const startDate = dateIndex >= 0 ? tokens[dateIndex] : "";
    const idIndex = dateIndex > 0 ? dateIndex - 1 : -1;
    const idToken =
      idIndex >= 0 && !ISO_DATE.test(tokens[idIndex]) && !DURATION.test(tokens[idIndex])
        ? tokens[idIndex]
        : "";

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

    // Check subsequent lines for metadata comments (assignee, notes)
    let assignee = "";
    let notes = "";
    let metaIdx = lineIndex + 1;
    while (metaIdx < lines.length) {
      const metaLine = lines[metaIdx].trim();
      if (!metaLine.startsWith("%%")) break;
      const aMatch = metaLine.match(/^%%\s*assignee:\s*(.+)$/i);
      if (aMatch) assignee = aMatch[1].trim();
      const nMatch = metaLine.match(/^%%\s*notes:\s*(.+)$/i);
      if (nMatch) notes = nMatch[1].trim();
      metaIdx++;
    }

    tasks.push({
      lineIndex,
      rawLine,
      indent,
      label,
      tokens,
      idToken,
      statusTokens,
      statusIndices,
      dateIndex,
      durationIndex,
      startDate,
      durationToken,
      durationDays,
      endDateIndex,
      endDate,
      hasExplicitDate: dateIndex >= 0,
      assignee,
      notes,
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

  if (updates.endDate) {
    if (task.endDateIndex >= 0) {
      nextTokens[task.endDateIndex] = updates.endDate;
    } else if (task.durationIndex >= 0) {
      nextTokens[task.durationIndex] = updates.endDate;
    } else if (task.dateIndex >= 0) {
      nextTokens.splice(task.dateIndex + 1, 0, updates.endDate);
    }
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

export function deleteGanttTask(code, task) {
  if (!task) return code;
  const lines = code.split("\n");
  const endIndex = findMetadataEndIndex(lines, task.lineIndex);
  lines.splice(task.lineIndex, endIndex - task.lineIndex + 1);
  return lines.join("\n");
}

export function insertGanttTaskAfter(code, task, draft = {}) {
  if (!task) return code;
  const lines = code.split("\n");
  const insertAt = findMetadataEndIndex(lines, task.lineIndex) + 1;
  const indent = draft.indent ?? task.indent ?? "";
  const label = (draft.label || "New task").trim() || "New task";
  const status = Array.isArray(draft.status)
    ? draft.status.filter((token) => STATUS_TOKENS.has(String(token).toLowerCase()))
    : [];
  const idToken = (draft.idToken || "").trim();
  const startDate = (draft.startDate || "").trim();
  const endDate = (draft.endDate || "").trim();
  const duration = (draft.duration || "").trim();
  const tokens = [...status];

  if (idToken) tokens.push(idToken);
  if (startDate) tokens.push(startDate);
  if (endDate) {
    tokens.push(endDate);
  } else if (duration) {
    tokens.push(duration);
  }

  if (!tokens.length) tokens.push("task_new");

  const newLines = [`${indent}${label} :${tokens.join(", ")}`];
  const assignee = (draft.assignee || "").trim();
  if (assignee) newLines.push(`${indent}%% assignee: ${assignee}`);
  const notes = (draft.notes || "").trim();
  if (notes) newLines.push(`${indent}%% notes: ${notes}`);

  lines.splice(insertAt, 0, ...newLines);
  return lines.join("\n");
}

export function toggleGanttStatus(code, task, flag) {
  if (!task) return code;
  const lines = code.split("\n");
  const nextTokens = [...task.tokens];
  const hasFlag = task.statusTokens.includes(flag);

  if (hasFlag) {
    const idx = nextTokens.findIndex((t) => t.toLowerCase() === flag);
    if (idx >= 0) nextTokens.splice(idx, 1);
  } else {
    nextTokens.unshift(flag);
  }

  lines[task.lineIndex] = `${task.indent}${task.label} :${nextTokens.join(", ")}`;
  return lines.join("\n");
}

export function clearGanttStatus(code, task) {
  if (!task || !task.statusIndices.length) return code;
  const lines = code.split("\n");
  const nextTokens = [...task.tokens];

  for (let i = task.statusIndices.length - 1; i >= 0; i--) {
    nextTokens.splice(task.statusIndices[i], 1);
  }

  lines[task.lineIndex] = `${task.indent}${task.label} :${nextTokens.join(", ")}`;
  return lines.join("\n");
}

export function updateGanttAssignee(code, task, assignee) {
  if (!task) return code;
  const lines = code.split("\n");
  const nextLine = (lines[task.lineIndex + 1] || "").trim();
  const hasComment = /^%%\s*assignee:/i.test(nextLine);

  if (assignee) {
    const commentLine = `${task.indent}%% assignee: ${assignee}`;
    if (hasComment) {
      lines[task.lineIndex + 1] = commentLine;
    } else {
      lines.splice(task.lineIndex + 1, 0, commentLine);
    }
  } else if (hasComment) {
    lines.splice(task.lineIndex + 1, 1);
  }

  return lines.join("\n");
}

export function updateGanttNotes(code, task, notes) {
  if (!task) return code;
  const lines = code.split("\n");

  // Find existing notes comment line among metadata lines after task
  let notesLineIdx = -1;
  let searchIdx = task.lineIndex + 1;
  while (searchIdx < lines.length && lines[searchIdx].trim().startsWith("%%")) {
    if (/^%%\s*notes:/i.test(lines[searchIdx].trim())) {
      notesLineIdx = searchIdx;
    }
    searchIdx++;
  }

  if (notes) {
    const commentLine = `${task.indent}%% notes: ${notes}`;
    if (notesLineIdx >= 0) {
      lines[notesLineIdx] = commentLine;
    } else {
      // Insert after last metadata comment (or after task line)
      let insertIdx = task.lineIndex + 1;
      while (insertIdx < lines.length && lines[insertIdx].trim().startsWith("%%")) {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, commentLine);
    }
  } else if (notesLineIdx >= 0) {
    lines.splice(notesLineIdx, 1);
  }

  return lines.join("\n");
}
