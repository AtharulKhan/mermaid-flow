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
    trimmed.startsWith("weekend ") ||
    trimmed.startsWith("weekday ") ||
    trimmed.startsWith("displayMode ") ||
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

/* ── Directive parser ─────────────────────────────────── */

export function parseGanttDirectives(code) {
  const directives = {
    title: "",
    dateFormat: "YYYY-MM-DD",
    axisFormat: "",
    tickInterval: "",
    todayMarker: "on",
    excludes: [],
    displayMode: "",
    weekend: "",
  };

  const lines = code.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("title ")) directives.title = trimmed.slice(6).trim();
    if (trimmed.startsWith("dateFormat ")) directives.dateFormat = trimmed.slice(11).trim();
    if (trimmed.startsWith("axisFormat ")) directives.axisFormat = trimmed.slice(11).trim();
    if (trimmed.startsWith("tickInterval ")) directives.tickInterval = trimmed.slice(13).trim();
    if (trimmed.startsWith("todayMarker ")) directives.todayMarker = trimmed.slice(12).trim();
    if (trimmed.startsWith("displayMode ")) directives.displayMode = trimmed.slice(12).trim();
    if (trimmed.startsWith("weekend ")) directives.weekend = trimmed.slice(8).trim().toLowerCase();
    if (trimmed.startsWith("weekday ")) directives.weekend = trimmed.slice(8).trim().toLowerCase();
    if (trimmed.startsWith("excludes ")) {
      const values = trimmed
        .slice(9)
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      directives.excludes.push(...values);
    }
  }

  return directives;
}

/* ── Excludes helpers ─────────────────────────────────── */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function isExcludedDate(isoDate, excludes, weekend) {
  if (!excludes || !excludes.length) return false;
  const d = new Date(isoDate + "T00:00:00Z");
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 6=Sat

  for (const excl of excludes) {
    if (excl === "weekends") {
      if (weekend === "friday") {
        if (dayOfWeek === 5 || dayOfWeek === 6) return true;
      } else {
        if (dayOfWeek === 0 || dayOfWeek === 6) return true;
      }
    } else if (DAY_NAMES.indexOf(excl) === dayOfWeek) {
      return true;
    } else if (excl === isoDate.toLowerCase()) {
      return true;
    }
  }
  return false;
}

export function addWorkingDays(startIso, workingDays, excludes, weekend) {
  if (!excludes || !excludes.length) {
    return shiftIsoDate(startIso, workingDays);
  }
  let current = startIso;
  let remaining = workingDays;
  while (remaining > 0) {
    current = shiftIsoDate(current, 1);
    if (!isExcludedDate(current, excludes, weekend)) {
      remaining--;
    }
  }
  return current;
}

/* ── Task parser ──────────────────────────────────────── */

export function parseGanttTasks(code) {
  const lines = code.split("\n");
  const tasks = [];
  let currentSection = "";

  lines.forEach((rawLine, lineIndex) => {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("section ")) {
      currentSection = trimmed.slice("section ".length).trim();
      return;
    }
    if (isDirectiveLine(trimmed)) return;

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

    // Identify leading status/type tokens (done, active, crit, milestone, vert)
    const statusTokens = [];
    const statusIndices = [];
    let isMilestone = false;
    let isVertMarker = false;
    for (let i = 0; i < tokens.length; i++) {
      const lower = tokens[i].toLowerCase();
      if (STATUS_TOKENS.has(lower)) {
        statusTokens.push(lower);
        statusIndices.push(i);
      } else if (lower === "milestone") {
        isMilestone = true;
        continue;
      } else if (lower === "vert") {
        isVertMarker = true;
        continue;
      } else {
        break;
      }
    }

    // Detect "after <taskId>" token
    let afterDeps = [];
    let afterTokenIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase().startsWith("after ")) {
        afterTokenIndex = i;
        const rest = tokens[i].slice(6).trim();
        afterDeps = rest.split(/\s+/).filter(Boolean);
        break;
      }
    }

    // Detect "until <taskId>" token
    let untilDep = "";
    let untilTokenIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase().startsWith("until ")) {
        untilTokenIndex = i;
        untilDep = tokens[i].slice(6).trim();
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

    // For tasks with "after" but no date, look for ID before the "after" token
    const effectiveIdToken =
      idToken ||
      (afterTokenIndex > 0 &&
        !ISO_DATE.test(tokens[afterTokenIndex - 1]) &&
        !DURATION.test(tokens[afterTokenIndex - 1]) &&
        !STATUS_TOKENS.has(tokens[afterTokenIndex - 1].toLowerCase()) &&
        tokens[afterTokenIndex - 1].toLowerCase() !== "milestone" &&
        tokens[afterTokenIndex - 1].toLowerCase() !== "vert"
          ? tokens[afterTokenIndex - 1]
          : "");

    // Check for end date (second ISO date after start date)
    const endDateIndex =
      dateIndex >= 0
        ? tokens.findIndex((t, i) => i > dateIndex && ISO_DATE.test(t))
        : -1;
    const endDate = endDateIndex >= 0 ? tokens[endDateIndex] : "";

    // Duration token: look after start date, or after "after" token, or as last token
    const nextAfterDate = dateIndex >= 0 ? tokens[dateIndex + 1] || "" : "";
    let durationIndex =
      dateIndex >= 0 && endDateIndex !== dateIndex + 1 && DURATION.test(nextAfterDate)
        ? dateIndex + 1
        : -1;

    // If no date-based duration found, check token after "after" reference
    if (durationIndex < 0 && afterTokenIndex >= 0) {
      const afterNext = tokens[afterTokenIndex + 1] || "";
      if (DURATION.test(afterNext)) {
        durationIndex = afterTokenIndex + 1;
      }
    }

    // Fallback: last token is a duration (for tasks with only a duration)
    if (durationIndex < 0 && dateIndex < 0 && afterTokenIndex < 0) {
      const lastToken = tokens[tokens.length - 1] || "";
      if (DURATION.test(lastToken)) {
        durationIndex = tokens.length - 1;
      }
    }

    const durationToken = durationIndex >= 0 ? tokens[durationIndex] : "";
    let durationDays = durationToken ? durationToDays(durationToken) : null;

    // Compute durationDays from date difference when using end date syntax
    if (!durationDays && startDate && endDate) {
      const s = new Date(startDate + "T00:00:00Z");
      const e = new Date(endDate + "T00:00:00Z");
      durationDays = Math.round((e - s) / (1000 * 60 * 60 * 24));
    }

    // Check subsequent lines for metadata comments (assignee, notes, link)
    let assignee = "";
    let notes = "";
    let link = "";
    let metaIdx = lineIndex + 1;
    while (metaIdx < lines.length) {
      const metaLine = lines[metaIdx].trim();
      if (!metaLine.startsWith("%%")) break;
      const aMatch = metaLine.match(/^%%\s*assignee:\s*(.+)$/i);
      if (aMatch) assignee = aMatch[1].trim();
      const nMatch = metaLine.match(/^%%\s*notes:\s*(.+)$/i);
      if (nMatch) notes = nMatch[1].trim();
      const lMatch = metaLine.match(/^%%\s*link:\s*(.+)$/i);
      if (lMatch) link = lMatch[1].trim();
      metaIdx++;
    }

    tasks.push({
      lineIndex,
      rawLine,
      indent,
      label,
      tokens,
      idToken: effectiveIdToken || idToken,
      statusTokens,
      statusIndices,
      dateIndex,
      durationIndex,
      startDate,
      durationToken,
      durationDays,
      endDateIndex,
      endDate,
      section: currentSection,
      hasExplicitDate: dateIndex >= 0,
      assignee,
      notes,
      link,
      isMilestone,
      isVertMarker,
      afterDeps,
      afterTokenIndex,
      untilDep,
      untilTokenIndex,
    });
  });

  return tasks;
}

/* ── Dependency resolver ──────────────────────────────── */

export function resolveDependencies(tasks) {
  // Build lookup maps
  const byId = new Map();
  const byLabel = new Map();
  for (const t of tasks) {
    if (t.idToken) byId.set(t.idToken.toLowerCase(), t);
    if (t.label) {
      if (!byLabel.has(t.label.toLowerCase())) {
        byLabel.set(t.label.toLowerCase(), t);
      }
    }
  }

  const getEndMs = (task) => {
    if (task.resolvedEndDate) return Date.parse(task.resolvedEndDate + "T00:00:00Z");
    if (task.endDate) return Date.parse(task.endDate + "T00:00:00Z");
    const start = task.resolvedStartDate || task.startDate;
    if (start && task.durationDays) {
      const d = new Date(start + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + task.durationDays);
      return d.getTime();
    }
    if (start) return Date.parse(start + "T00:00:00Z");
    return null;
  };

  const getStartMs = (task) => {
    if (task.resolvedStartDate) return Date.parse(task.resolvedStartDate + "T00:00:00Z");
    if (task.startDate) return Date.parse(task.startDate + "T00:00:00Z");
    return null;
  };

  const msToIso = (ms) => new Date(ms).toISOString().slice(0, 10);

  // Iterative resolution for "after" dependencies (handles chains)
  let changed = true;
  let iterations = 0;
  const maxIterations = tasks.length + 1;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const task of tasks) {
      if (task.afterDeps.length === 0) continue;
      if (task.startDate && task.hasExplicitDate) continue;

      let latestEndMs = null;
      for (const depId of task.afterDeps) {
        const dep = byId.get(depId.toLowerCase()) || byLabel.get(depId.toLowerCase());
        if (!dep) continue;
        const endMs = getEndMs(dep);
        if (endMs === null) continue;
        if (latestEndMs === null || endMs > latestEndMs) latestEndMs = endMs;
      }

      if (latestEndMs !== null) {
        const resolvedStart = msToIso(latestEndMs);
        if (task.resolvedStartDate !== resolvedStart) {
          task.resolvedStartDate = resolvedStart;
          if (task.durationDays) {
            const d = new Date(latestEndMs);
            d.setUTCDate(d.getUTCDate() + task.durationDays);
            task.resolvedEndDate = msToIso(d.getTime());
          }
          changed = true;
        }
      }
    }
  }

  // Resolve "until" dependencies
  for (const task of tasks) {
    if (!task.untilDep) continue;
    const dep = byId.get(task.untilDep.toLowerCase()) || byLabel.get(task.untilDep.toLowerCase());
    if (!dep) continue;

    const depStartMs = getStartMs(dep);
    if (depStartMs === null) continue;

    task.resolvedEndDate = msToIso(depStartMs);
    const taskStartMs = getStartMs(task);
    if (taskStartMs !== null) {
      task.durationDays = Math.round((depStartMs - taskStartMs) / (1000 * 60 * 60 * 24));
    }
  }

  // Sequential default: tasks without dates or deps inherit end of previous task
  let prevEndMs = null;
  for (const task of tasks) {
    const hasStart = task.startDate || task.resolvedStartDate;
    if (!hasStart && task.afterDeps.length === 0 && prevEndMs !== null) {
      task.resolvedStartDate = msToIso(prevEndMs);
      if (task.durationDays) {
        const d = new Date(prevEndMs);
        d.setUTCDate(d.getUTCDate() + task.durationDays);
        task.resolvedEndDate = msToIso(d.getTime());
      }
    }
    // Update prevEndMs for sequential chaining
    const endMs = getEndMs(task);
    if (endMs !== null) prevEndMs = endMs;
  }

  return tasks;
}

/* ── Critical Path Method (CPM) ──────────────────────── */

export function computeCriticalPath(tasks) {
  const dayMs = 86400000;
  const taskKey = (t) => (t.idToken || t.label || "").toLowerCase();

  const getStartMs = (t) => {
    const iso = t.resolvedStartDate || t.startDate;
    return iso ? Date.parse(iso + "T00:00:00Z") : null;
  };
  const getEndMs = (t) => {
    const iso = t.resolvedEndDate || t.endDate;
    if (iso) return Date.parse(iso + "T00:00:00Z");
    const s = getStartMs(t);
    if (s !== null && t.durationDays) return s + t.durationDays * dayMs;
    return s;
  };
  const getDurationMs = (t) => {
    const s = getStartMs(t);
    const e = getEndMs(t);
    if (s !== null && e !== null) return Math.max(0, e - s);
    return (t.durationDays || 0) * dayMs;
  };

  // Build lookup and adjacency
  const byKey = new Map();
  const successors = new Map();
  const predecessors = new Map();

  for (const t of tasks) {
    if (t.isVertMarker) continue;
    const k = taskKey(t);
    if (!k) continue;
    byKey.set(k, t);
    if (!successors.has(k)) successors.set(k, []);
    if (!predecessors.has(k)) predecessors.set(k, []);
  }

  // Label-based lookup for resolving afterDeps by label
  const byLabel = new Map();
  for (const t of tasks) {
    const k = taskKey(t);
    if (t.label && !byLabel.has(t.label.toLowerCase())) {
      byLabel.set(t.label.toLowerCase(), k);
    }
  }

  // Add explicit "after" dependencies
  let hasExplicitDeps = false;
  for (const t of tasks) {
    const k = taskKey(t);
    if (!k || !byKey.has(k)) continue;
    for (const dep of t.afterDeps || []) {
      const depKey = byKey.has(dep.toLowerCase()) ? dep.toLowerCase() : byLabel.get(dep.toLowerCase());
      if (!depKey || !byKey.has(depKey)) continue;
      hasExplicitDeps = true;
      successors.get(depKey).push(k);
      predecessors.get(k).push(depKey);
    }
  }

  // When no explicit deps, infer sequential dependencies within each section.
  // If task B starts within 3 days of task A ending (same section, A listed before B),
  // treat A → B as an implicit dependency.
  if (!hasExplicitDeps) {
    const sectionTasks = new Map();
    for (const t of tasks) {
      if (t.isVertMarker) continue;
      const k = taskKey(t);
      if (!k || !byKey.has(k)) continue;
      const sec = t.section || "";
      if (!sectionTasks.has(sec)) sectionTasks.set(sec, []);
      sectionTasks.get(sec).push(t);
    }

    const gapTolerance = 3 * dayMs;
    for (const secList of sectionTasks.values()) {
      for (let i = 0; i < secList.length - 1; i++) {
        const a = secList[i];
        const b = secList[i + 1];
        const aEnd = getEndMs(a);
        const bStart = getStartMs(b);
        if (aEnd === null || bStart === null) continue;
        // B starts within gapTolerance after A ends (sequential or small gap)
        const gap = bStart - aEnd;
        if (gap >= 0 && gap <= gapTolerance) {
          const aKey = taskKey(a);
          const bKey = taskKey(b);
          successors.get(aKey).push(bKey);
          predecessors.get(bKey).push(aKey);
        }
      }
    }

    // Also infer cross-section dependencies: if the last task in section X ends
    // within tolerance of the first task in section Y, link them.
    const secEntries = [...sectionTasks.entries()];
    for (let i = 0; i < secEntries.length - 1; i++) {
      const prevList = secEntries[i][1];
      const nextList = secEntries[i + 1][1];
      if (!prevList.length || !nextList.length) continue;
      const lastOfPrev = prevList[prevList.length - 1];
      const firstOfNext = nextList[0];
      const prevEnd = getEndMs(lastOfPrev);
      const nextStart = getStartMs(firstOfNext);
      if (prevEnd === null || nextStart === null) continue;
      const gap = nextStart - prevEnd;
      if (gap >= 0 && gap <= gapTolerance) {
        const pKey = taskKey(lastOfPrev);
        const nKey = taskKey(firstOfNext);
        successors.get(pKey).push(nKey);
        predecessors.get(nKey).push(pKey);
      }
    }
  }

  // Check if we have any edges at all
  let hasEdges = false;
  for (const succs of successors.values()) {
    if (succs.length > 0) { hasEdges = true; break; }
  }
  if (!hasEdges) return { criticalSet: new Set(), slackByTask: new Map() };

  // Topological order via Kahn's algorithm
  const inDegree = new Map();
  for (const k of byKey.keys()) inDegree.set(k, 0);
  for (const k of byKey.keys()) {
    for (const succ of successors.get(k) || []) {
      inDegree.set(succ, (inDegree.get(succ) || 0) + 1);
    }
  }

  const queue = [];
  for (const [k, deg] of inDegree) {
    if (deg === 0) queue.push(k);
  }

  const topoOrder = [];
  while (queue.length) {
    const k = queue.shift();
    topoOrder.push(k);
    for (const succ of successors.get(k) || []) {
      const newDeg = inDegree.get(succ) - 1;
      inDegree.set(succ, newDeg);
      if (newDeg === 0) queue.push(succ);
    }
  }

  // Forward pass: Earliest Start (ES) and Earliest Finish (EF)
  const ES = new Map();
  const EF = new Map();

  for (const k of topoOrder) {
    const t = byKey.get(k);
    const preds = predecessors.get(k) || [];
    if (preds.length === 0) {
      ES.set(k, getStartMs(t) || 0);
    } else {
      let maxPredEF = -Infinity;
      for (const p of preds) {
        const pef = EF.get(p);
        if (pef !== undefined && pef > maxPredEF) maxPredEF = pef;
      }
      ES.set(k, maxPredEF === -Infinity ? (getStartMs(t) || 0) : maxPredEF);
    }
    EF.set(k, ES.get(k) + getDurationMs(t));
  }

  // Project end
  let projectEnd = -Infinity;
  for (const ef of EF.values()) {
    if (ef > projectEnd) projectEnd = ef;
  }

  // Backward pass: Latest Start (LS) and Latest Finish (LF)
  const LS = new Map();
  const LF = new Map();

  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const k = topoOrder[i];
    const t = byKey.get(k);
    const succs = successors.get(k) || [];
    if (succs.length === 0) {
      LF.set(k, projectEnd);
    } else {
      let minSuccLS = Infinity;
      for (const s of succs) {
        const sls = LS.get(s);
        if (sls !== undefined && sls < minSuccLS) minSuccLS = sls;
      }
      LF.set(k, minSuccLS === Infinity ? projectEnd : minSuccLS);
    }
    LS.set(k, LF.get(k) - getDurationMs(t));
  }

  // Compute slack and critical set
  const criticalSet = new Set();
  const slackByTask = new Map();
  const slackThreshold = dayMs * 0.5;

  for (const k of topoOrder) {
    const slack = LS.get(k) - ES.get(k);
    const slackDays = Math.round(slack / dayMs);
    const t = byKey.get(k);
    const origKey = t.idToken || t.label || "";
    slackByTask.set(origKey, slackDays);
    if (Math.abs(slack) <= slackThreshold) {
      criticalSet.add(origKey);
    }
  }

  return { criticalSet, slackByTask };
}

/* ── Existing utilities ───────────────────────────────── */

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

export function updateGanttDependency(code, task, depIds) {
  if (!task) return code;
  const lines = code.split("\n");
  const nextTokens = [...task.tokens];

  // Remove existing "after ..." token if present
  if (task.afterTokenIndex >= 0) {
    nextTokens.splice(task.afterTokenIndex, 1);
  }

  if (depIds.length > 0) {
    const afterToken = "after " + depIds.join(" ");
    // Insert before duration token if one exists, otherwise append
    // Recalculate duration index after possible splice
    const durIdx = nextTokens.findIndex((t) => /^\d+[dwmy]$/i.test(t.trim()));
    if (durIdx >= 0) {
      nextTokens.splice(durIdx, 0, afterToken);
    } else {
      nextTokens.push(afterToken);
    }
  }

  lines[task.lineIndex] = `${task.indent}${task.label} :${nextTokens.join(", ")}`;
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
  const link = (draft.link || "").trim();
  if (link) newLines.push(`${indent}%% link: ${link}`);

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

function updateGanttMetadataComment(code, task, key, value) {
  if (!task) return code;
  const lines = code.split("\n");
  const matcher = new RegExp(`^%%\\s*${key}:`, "i");

  // Find existing metadata line for this key among metadata comments after the task.
  let keyLineIdx = -1;
  let searchIdx = task.lineIndex + 1;
  while (searchIdx < lines.length && lines[searchIdx].trim().startsWith("%%")) {
    if (matcher.test(lines[searchIdx].trim())) {
      keyLineIdx = searchIdx;
      break;
    }
    searchIdx++;
  }

  const cleanValue = String(value || "").trim();
  if (cleanValue) {
    const commentLine = `${task.indent}%% ${key}: ${cleanValue}`;
    if (keyLineIdx >= 0) {
      lines[keyLineIdx] = commentLine;
    } else {
      // Insert after last metadata comment (or directly after task line).
      let insertIdx = task.lineIndex + 1;
      while (insertIdx < lines.length && lines[insertIdx].trim().startsWith("%%")) {
        insertIdx++;
      }
      lines.splice(insertIdx, 0, commentLine);
    }
  } else if (keyLineIdx >= 0) {
    lines.splice(keyLineIdx, 1);
  }

  return lines.join("\n");
}

export function updateGanttAssignee(code, task, assignee) {
  return updateGanttMetadataComment(code, task, "assignee", assignee);
}

export function updateGanttNotes(code, task, notes) {
  return updateGanttMetadataComment(code, task, "notes", notes);
}

export function updateGanttLink(code, task, link) {
  return updateGanttMetadataComment(code, task, "link", link);
}

function parseSectionHeader(line) {
  const match = String(line || "").match(/^(\s*)section\s+(.+?)\s*$/i);
  if (!match) return null;
  return {
    indent: match[1] || "",
    name: (match[2] || "").trim(),
  };
}

export function getGanttSections(code) {
  const lines = String(code || "").split("\n");
  const sections = [];
  lines.forEach((line, lineIndex) => {
    const parsed = parseSectionHeader(line);
    if (!parsed || !parsed.name) return;
    sections.push({
      ...parsed,
      lineIndex,
    });
  });
  return sections;
}

export function renameGanttSection(code, currentName, nextName) {
  const from = String(currentName || "").trim();
  const to = String(nextName || "").trim();
  if (!from || !to || from === to) return code;

  const lines = String(code || "").split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseSectionHeader(lines[i]);
    if (!parsed) continue;
    if (parsed.name.toLowerCase() !== from.toLowerCase()) continue;
    lines[i] = `${parsed.indent}section ${to}`;
    changed = true;
  }
  return changed ? lines.join("\n") : code;
}

export function addGanttSection(code, sectionName) {
  const name = String(sectionName || "").trim();
  if (!name) return code;
  const lines = String(code || "").split("\n");
  const hasSection = lines.some((line) => {
    const parsed = parseSectionHeader(line);
    return parsed && parsed.name.toLowerCase() === name.toLowerCase();
  });
  if (hasSection) return code;

  if (lines.length && lines[lines.length - 1].trim()) lines.push("");
  lines.push(`section ${name}`);
  return lines.join("\n");
}

export function moveGanttTaskToSection(code, task, targetSection) {
  if (!task) return code;
  const nextSection = String(targetSection || "").trim();
  const currentSection = String(task.section || "").trim();
  if (nextSection === currentSection) return code;

  const lines = String(code || "").split("\n");
  const taskEnd = findMetadataEndIndex(lines, task.lineIndex);
  const taskBlock = lines.slice(task.lineIndex, taskEnd + 1);
  lines.splice(task.lineIndex, taskEnd - task.lineIndex + 1);

  if (!nextSection) {
    const insertAt = lines.findIndex((line) => !!parseSectionHeader(line));
    if (insertAt < 0) {
      lines.push(...taskBlock);
      return lines.join("\n");
    }
    lines.splice(insertAt, 0, ...taskBlock);
    return lines.join("\n");
  }

  const sectionIndices = [];
  lines.forEach((line, index) => {
    const parsed = parseSectionHeader(line);
    if (!parsed) return;
    sectionIndices.push({ ...parsed, lineIndex: index });
  });

  const targetIdx = sectionIndices.findIndex((section) => section.name.toLowerCase() === nextSection.toLowerCase());
  if (targetIdx < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push("");
    lines.push(`section ${nextSection}`, ...taskBlock);
    return lines.join("\n");
  }

  const targetLine = sectionIndices[targetIdx].lineIndex;
  const nextSectionLine = targetIdx + 1 < sectionIndices.length ? sectionIndices[targetIdx + 1].lineIndex : lines.length;
  const insertAt = Math.max(targetLine + 1, nextSectionLine);
  lines.splice(insertAt, 0, ...taskBlock);
  return lines.join("\n");
}
