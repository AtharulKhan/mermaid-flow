const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/;
const DURATION_DAY = /^(\d+)([dwmy])$/i;
const DURATION_SUB = /^(?:\d+h)(?:\d+m(?:in)?)?$|^(?:\d+m(?:in)?)$|^(\d+)([dwy])$/i;
const STATUS_TOKENS = new Set(["done", "active", "crit"]);

/* ── Sub-day detection ───────────────────────────────── */

export function isSubDayFormat(dateFormat) {
  return /HH|mm|ss/.test(dateFormat || "");
}

/* ── Centralized date↔ms utilities ───────────────────── */

export function dateToMs(str) {
  if (!str) return null;
  const trimmed = str.trim();
  const dtMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?$/);
  if (!dtMatch) return null;
  const val = Date.parse(dtMatch[1] + "T" + (dtMatch[2] || "00:00:00") + "Z");
  return Number.isFinite(val) ? val : null;
}

export function msToDateStr(ms, includeTime = false) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const datePart = `${yyyy}-${mo}-${dd}`;
  if (!includeTime) return datePart;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (hh === "00" && mm === "00") return datePart;
  return datePart + " " + hh + ":" + mm;
}

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

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_MS = 60000;

function isDuration(token, subDay) {
  if (!token) return false;
  if (DURATION_DAY.test(token)) return true;
  if (subDay && DURATION_SUB.test(token)) return true;
  // Also accept compound like "1h30m" in sub-day mode
  if (subDay && /^\d+h\d+m(?:in)?$/i.test(token)) return true;
  // Accept standalone h durations even in day mode (converts to fractional days)
  if (/^\d+h$/i.test(token)) return true;
  if (/^\d+min$/i.test(token)) return true;
  return false;
}

function durationToMs(token, subDay = false) {
  if (!token) return null;
  const clean = token.trim().toLowerCase();
  let totalMs = 0;
  let matched = false;
  const re = /(\d+)(h|min|m|d|w|y)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    matched = true;
    if (unit === "h") totalMs += value * HOUR_MS;
    else if (unit === "min") totalMs += value * MIN_MS;
    else if (unit === "m" && subDay) totalMs += value * MIN_MS;
    else if (unit === "m" && !subDay) totalMs += value * 30 * DAY_MS;
    else if (unit === "d") totalMs += value * DAY_MS;
    else if (unit === "w") totalMs += value * 7 * DAY_MS;
    else if (unit === "y") totalMs += value * 365 * DAY_MS;
  }
  return matched ? totalMs : null;
}

function durationToDays(token, subDay = false) {
  const ms = durationToMs(token, subDay);
  return ms !== null ? ms / DAY_MS : null;
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

export function shiftDateTime(dateStr, deltaMs) {
  const ms = dateToMs(dateStr);
  if (ms === null) return dateStr;
  const includeTime = dateStr.includes(" ");
  return msToDateStr(ms + deltaMs, includeTime);
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
  const datePart = isoDate.includes(" ") ? isoDate.split(" ")[0] : isoDate;
  const d = new Date(datePart + "T00:00:00Z");
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
    } else if (excl === datePart.toLowerCase()) {
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

export function parseGanttTasks(code, dateFormat = "YYYY-MM-DD") {
  const subDay = isSubDayFormat(dateFormat);
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
      idIndex >= 0 && !ISO_DATE.test(tokens[idIndex]) && !isDuration(tokens[idIndex], subDay)
        ? tokens[idIndex]
        : "";

    // For tasks with "after" but no date, look for ID before the "after" token
    const effectiveIdToken =
      idToken ||
      (afterTokenIndex > 0 &&
        !ISO_DATE.test(tokens[afterTokenIndex - 1]) &&
        !isDuration(tokens[afterTokenIndex - 1], subDay) &&
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
      dateIndex >= 0 && endDateIndex !== dateIndex + 1 && isDuration(nextAfterDate, subDay)
        ? dateIndex + 1
        : -1;

    // If no date-based duration found, check token after "after" reference
    if (durationIndex < 0 && afterTokenIndex >= 0) {
      const afterNext = tokens[afterTokenIndex + 1] || "";
      if (isDuration(afterNext, subDay)) {
        durationIndex = afterTokenIndex + 1;
      }
    }

    // Fallback: last token is a duration (for tasks with only a duration)
    if (durationIndex < 0 && dateIndex < 0 && afterTokenIndex < 0) {
      const lastToken = tokens[tokens.length - 1] || "";
      if (isDuration(lastToken, subDay)) {
        durationIndex = tokens.length - 1;
      }
    }

    const durationToken = durationIndex >= 0 ? tokens[durationIndex] : "";
    let durationDays = durationToken ? durationToDays(durationToken, subDay) : null;
    let durationMs = durationToken ? durationToMs(durationToken, subDay) : null;

    // Compute durationDays/Ms from date difference when using end date syntax
    if (!durationDays && startDate && endDate) {
      const s = dateToMs(startDate);
      const e = dateToMs(endDate);
      if (s !== null && e !== null) {
        durationMs = e - s;
        durationDays = durationMs / DAY_MS;
      }
    }

    // Check subsequent lines for metadata comments (assignee, notes, link, progress)
    let assignee = "";
    let notes = "";
    let link = "";
    let progress = null;
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
      const pMatch = metaLine.match(/^%%\s*progress:\s*(\d+)$/i);
      if (pMatch) { const val = parseInt(pMatch[1], 10); if (val >= 0 && val <= 100) progress = val; }
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
      durationMs,
      endDateIndex,
      endDate,
      section: currentSection,
      hasExplicitDate: dateIndex >= 0,
      assignee,
      notes,
      link,
      progress,
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

export function resolveDependencies(tasks, subDay = false) {
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
    if (task.resolvedEndDate) return dateToMs(task.resolvedEndDate);
    if (task.endDate) return dateToMs(task.endDate);
    const start = task.resolvedStartDate || task.startDate;
    if (start && task.durationMs) {
      const sMs = dateToMs(start);
      return sMs !== null ? sMs + task.durationMs : null;
    }
    if (start && task.durationDays) {
      const sMs = dateToMs(start);
      return sMs !== null ? sMs + task.durationDays * DAY_MS : null;
    }
    if (start) return dateToMs(start);
    return null;
  };

  const getStartMs = (task) => {
    if (task.resolvedStartDate) return dateToMs(task.resolvedStartDate);
    if (task.startDate) return dateToMs(task.startDate);
    return null;
  };

  const toIso = (ms) => msToDateStr(ms, subDay);

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
        const resolvedStart = toIso(latestEndMs);
        if (task.resolvedStartDate !== resolvedStart) {
          task.resolvedStartDate = resolvedStart;
          if (task.durationMs) {
            task.resolvedEndDate = toIso(latestEndMs + task.durationMs);
          } else if (task.durationDays) {
            task.resolvedEndDate = toIso(latestEndMs + task.durationDays * DAY_MS);
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

    task.resolvedEndDate = toIso(depStartMs);
    const taskStartMs = getStartMs(task);
    if (taskStartMs !== null) {
      const diffMs = depStartMs - taskStartMs;
      task.durationMs = diffMs;
      task.durationDays = diffMs / DAY_MS;
    }
  }

  // Sequential default: tasks without dates or deps inherit end of previous task
  let prevEndMs = null;
  for (const task of tasks) {
    const hasStart = task.startDate || task.resolvedStartDate;
    if (!hasStart && task.afterDeps.length === 0 && prevEndMs !== null) {
      task.resolvedStartDate = toIso(prevEndMs);
      if (task.durationMs) {
        task.resolvedEndDate = toIso(prevEndMs + task.durationMs);
      } else if (task.durationDays) {
        task.resolvedEndDate = toIso(prevEndMs + task.durationDays * DAY_MS);
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
    return iso ? dateToMs(iso) : null;
  };
  const getEndMs = (t) => {
    const iso = t.resolvedEndDate || t.endDate;
    if (iso) return dateToMs(iso);
    const s = getStartMs(t);
    if (s !== null && t.durationMs) return s + t.durationMs;
    if (s !== null && t.durationDays) return s + t.durationDays * dayMs;
    return s;
  };
  const getDurationMs = (t) => {
    const s = getStartMs(t);
    const e = getEndMs(t);
    if (s !== null && e !== null) return Math.max(0, e - s);
    if (t.durationMs) return t.durationMs;
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

  // Project end — only consider tasks that participate in the dependency graph
  // (have at least one predecessor or successor). Disconnected tasks shouldn't
  // inflate projectEnd, which would give chained tasks false slack.
  let projectEnd = -Infinity;
  for (const k of topoOrder) {
    const hasPreds = (predecessors.get(k) || []).length > 0;
    const hasSuccs = (successors.get(k) || []).length > 0;
    if (hasPreds || hasSuccs) {
      const ef = EF.get(k);
      if (ef > projectEnd) projectEnd = ef;
    }
  }
  // Fallback: if no connected tasks, use global max
  if (projectEnd === -Infinity) {
    for (const ef of EF.values()) {
      if (ef > projectEnd) projectEnd = ef;
    }
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
  const connectedSet = new Set(); // tasks with at least one edge
  const slackByTask = new Map();
  const slackThreshold = dayMs * 0.5;

  for (const k of topoOrder) {
    const slack = LS.get(k) - ES.get(k);
    const slackDays = Math.round(slack / dayMs);
    const t = byKey.get(k);
    const origKey = t.idToken || t.label || "";
    slackByTask.set(origKey, slackDays);
    const hasPreds = (predecessors.get(k) || []).length > 0;
    const hasSuccs = (successors.get(k) || []).length > 0;
    if (hasPreds || hasSuccs) {
      connectedSet.add(origKey);
      if (Math.abs(slack) <= slackThreshold) {
        criticalSet.add(origKey);
      }
    }
  }

  return { criticalSet, connectedSet, slackByTask };
}

/* ── Cycle detection ─────────────────────────────────── */

export function detectCycles(tasks) {
  const graph = new Map();
  const byKey = new Map();
  const byLabel = new Map();

  for (const t of tasks) {
    if (t.isVertMarker) continue;
    const key = (t.idToken || t.label || "").toLowerCase();
    if (!key) continue;
    byKey.set(key, t);
    graph.set(key, []);
    if (t.label && !byLabel.has(t.label.toLowerCase())) {
      byLabel.set(t.label.toLowerCase(), key);
    }
  }

  for (const t of tasks) {
    if (t.isVertMarker) continue;
    const key = (t.idToken || t.label || "").toLowerCase();
    if (!key || !graph.has(key)) continue;
    for (const dep of t.afterDeps || []) {
      const depKey = byKey.has(dep.toLowerCase())
        ? dep.toLowerCase()
        : byLabel.get(dep.toLowerCase());
      if (depKey && graph.has(depKey)) {
        graph.get(depKey).push(key);
      }
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const node of graph.keys()) color.set(node, WHITE);
  const cycles = [];

  const dfs = (node, stack) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const neighbor of graph.get(node) || []) {
      if (color.get(neighbor) === GRAY) {
        const idx = stack.indexOf(neighbor);
        cycles.push(stack.slice(idx).map((k) => (byKey.get(k) || {}).label || k));
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor, stack);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) dfs(node, []);
  }
  return cycles;
}

/* ── Conflict detection ──────────────────────────────── */

export function detectConflicts(tasks) {
  const byId = new Map();
  const byLabel = new Map();
  for (const t of tasks) {
    if (t.idToken) byId.set(t.idToken.toLowerCase(), t);
    if (t.label && !byLabel.has(t.label.toLowerCase())) {
      byLabel.set(t.label.toLowerCase(), t);
    }
  }

  const toMs = (iso) => dateToMs(iso);
  const DAY = 86400000;
  const conflicts = [];

  for (const task of tasks) {
    if (task.isVertMarker) continue;
    const startMs = toMs(task.startDate || task.resolvedStartDate);
    if (startMs === null) continue;
    for (const depId of task.afterDeps || []) {
      const dep = byId.get(depId.toLowerCase()) || byLabel.get(depId.toLowerCase());
      if (!dep) continue;
      const depEndMs = toMs(dep.computedEnd || dep.endDate || dep.resolvedEndDate);
      if (depEndMs === null) continue;
      if (startMs < depEndMs) {
        conflicts.push({
          taskLabel: task.label,
          depLabel: dep.label,
          overlapDays: Math.ceil((depEndMs - startMs) / DAY),
        });
      }
    }
  }
  return conflicts;
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

  // If replacing an `after` dependency with an explicit start date,
  // swap the after token for the new date.
  if (updates.startDate && task.dateIndex < 0 && task.afterTokenIndex >= 0) {
    nextTokens[task.afterTokenIndex] = updates.startDate;
  } else if (updates.startDate && task.dateIndex >= 0) {
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

export function autoAdjustGanttDates(code, targetDate, dateFormat = "YYYY-MM-DD") {
  const subDay = isSubDayFormat(dateFormat);
  const tasks = parseGanttTasks(code, dateFormat);
  const explicit = tasks.filter((t) => t.hasExplicitDate);
  if (explicit.length === 0) return code;

  const targetMs = dateToMs(targetDate);
  if (targetMs === null) return code;

  let earliestMs = Infinity;
  for (const t of explicit) {
    const ms = dateToMs(t.startDate);
    if (ms !== null && ms < earliestMs) earliestMs = ms;
  }
  if (!Number.isFinite(earliestMs)) return code;

  if (subDay) {
    const deltaMs = targetMs - earliestMs;
    if (deltaMs === 0) return code;
    const sorted = explicit.slice().sort((a, b) => b.lineIndex - a.lineIndex);
    for (const task of sorted) {
      const updates = { startDate: shiftDateTime(task.startDate, deltaMs) };
      if (task.endDate && task.endDateIndex >= 0) {
        updates.endDate = shiftDateTime(task.endDate, deltaMs);
      }
      code = updateGanttTask(code, task, updates);
    }
  } else {
    const deltaDays = Math.round((targetMs - earliestMs) / DAY_MS);
    if (deltaDays === 0) return code;
    const sorted = explicit.slice().sort((a, b) => b.lineIndex - a.lineIndex);
    for (const task of sorted) {
      const updates = { startDate: shiftIsoDate(task.startDate, deltaDays) };
      if (task.endDate && task.endDateIndex >= 0) {
        updates.endDate = shiftIsoDate(task.endDate, deltaDays);
      }
      code = updateGanttTask(code, task, updates);
    }
  }

  return code;
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
    const durIdx = nextTokens.findIndex((t) => isDuration(t.trim(), true));
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

/**
 * Find all tasks that directly depend on the given task (via "after" references).
 * Matches by both idToken and label.
 */
export function findDependentTasks(tasks, task) {
  if (!task) return [];
  const keys = new Set();
  if (task.idToken) keys.add(task.idToken.toLowerCase());
  if (task.label) keys.add(task.label.toLowerCase());
  return tasks.filter((t) =>
    t !== task &&
    (t.afterDeps || []).some((dep) => keys.has(dep.toLowerCase()))
  );
}

/**
 * Find all tasks that depend on the given task, directly or transitively.
 * e.g. A → B → C: deleting A affects both B and C.
 */
export function findAllDependentTasks(tasks, task) {
  if (!task) return [];
  const result = [];
  const visited = new Set();
  const queue = [task];
  while (queue.length > 0) {
    const current = queue.shift();
    const deps = findDependentTasks(tasks, current);
    for (const dep of deps) {
      const key = dep.label.toLowerCase();
      if (!visited.has(key)) {
        visited.add(key);
        result.push(dep);
        queue.push(dep);
      }
    }
  }
  return result;
}

/**
 * Remove all "after" references to the given task from the code.
 * When a dependent loses all its "after" deps and has no explicit date,
 * replaces the "after" token with a resolved start date so downstream
 * chains keep working.
 */
export function removeDependencyReferences(code, allTasks, resolvedTasks, deletedTask) {
  if (!deletedTask) return code;
  const keys = new Set();
  if (deletedTask.idToken) keys.add(deletedTask.idToken.toLowerCase());
  if (deletedTask.label) keys.add(deletedTask.label.toLowerCase());

  const dependents = findDependentTasks(allTasks, deletedTask);
  if (dependents.length === 0) return code;

  // Build a lookup from resolved tasks so we can grab computed start dates
  const resolvedByLabel = new Map();
  for (const t of resolvedTasks) {
    resolvedByLabel.set(t.label.toLowerCase(), t);
  }

  let updated = code;
  // Process dependents in reverse line order so line indices stay valid
  const sorted = [...dependents].sort((a, b) => b.lineIndex - a.lineIndex);
  for (const dep of sorted) {
    const remaining = (dep.afterDeps || []).filter(
      (d) => !keys.has(d.toLowerCase())
    );
    if (remaining.length > 0) {
      // Still has other deps — just remove the deleted task's reference
      updated = updateGanttDependency(updated, dep, remaining);
    } else if (!dep.startDate) {
      // No remaining deps AND no explicit date — replace "after" with
      // the resolved start date so downstream tasks still resolve.
      const resolved = resolvedByLabel.get(dep.label.toLowerCase());
      const fallbackDate = resolved?.resolvedStartDate || resolved?.startDate;
      if (fallbackDate) {
        updated = updateGanttTask(updated, dep, { startDate: fallbackDate });
      } else {
        updated = updateGanttDependency(updated, dep, []);
      }
    } else {
      // Has an explicit date — just remove the after token
      updated = updateGanttDependency(updated, dep, []);
    }
  }
  return updated;
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

export function toggleGanttMilestone(code, task, shouldBeMilestone) {
  if (!task) return code;
  const lines = code.split("\n");
  const nextTokens = [...task.tokens];
  const milestoneIdx = nextTokens.findIndex((t) => t.toLowerCase() === "milestone");
  const hasMilestone = milestoneIdx >= 0;

  if (shouldBeMilestone && !hasMilestone) {
    // Insert "milestone" at the beginning of tokens (before status tokens)
    nextTokens.unshift("milestone");
  } else if (!shouldBeMilestone && hasMilestone) {
    nextTokens.splice(milestoneIdx, 1);
  } else {
    return code; // no change needed
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

export function updateGanttProgress(code, task, progress) {
  const value = progress !== null && progress !== undefined && progress !== ""
    ? String(Math.max(0, Math.min(100, Math.round(Number(progress)))))
    : "";
  return updateGanttMetadataComment(code, task, "progress", value);
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

/* ── Risk flag computation ──────────────────────────── */

export function computeRiskFlags(tasks) {
  const MANY_DEPS_THRESHOLD = 3;
  const result = {};

  const byId = new Map();
  const byLabel = new Map();
  for (const t of tasks) {
    if (t.idToken) byId.set(t.idToken.toLowerCase(), t);
    if (t.label && !byLabel.has(t.label.toLowerCase())) {
      byLabel.set(t.label.toLowerCase(), t);
    }
  }

  const isoToMs = (iso) => dateToMs(iso);

  const getEntry = (label) => {
    if (!result[label]) result[label] = { flags: [], reasons: [] };
    return result[label];
  };

  // Reverse dep map: depKey -> [tasks that depend on it]
  const reverseDeps = new Map();
  for (const t of tasks) {
    for (const depId of t.afterDeps || []) {
      const key = depId.toLowerCase();
      if (!reverseDeps.has(key)) reverseDeps.set(key, []);
      reverseDeps.get(key).push(t);
    }
  }

  for (const task of tasks) {
    if (task.isVertMarker) continue;

    const deps = task.afterDeps || [];

    // Condition 1: Many dependencies
    if (deps.length >= MANY_DEPS_THRESHOLD) {
      const entry = getEntry(task.label);
      entry.flags.push("many-deps");
      entry.reasons.push("Bottleneck: waiting on " + deps.length + " tasks to finish before this can start");
    }

    // Condition 2: Broken dependency (starts before dep ends)
    const taskStartMs = isoToMs(task.startDate);
    if (taskStartMs !== null) {
      for (const depId of deps) {
        const dep = byId.get(depId.toLowerCase()) || byLabel.get(depId.toLowerCase());
        if (!dep) continue;
        const depEndMs = isoToMs(dep.computedEnd);
        if (depEndMs !== null && taskStartMs < depEndMs) {
          const entry = getEntry(task.label);
          entry.flags.push("broken-dep");
          entry.reasons.push("Broken dependency: this task starts before '" + (dep.label || depId) + "' finishes");
        }
      }
    }

    // Zero-slack removed — same-day handoffs via `after` are normal workflow.
    // Critical path indicator already shows which tasks have no slack.
  }

  // Condition 4: Overloaded assignee (4+ concurrent active tasks on any day)
  // Uses sweep-line to find the actual peak concurrent count per person.
  // 2-3 concurrent tasks is normal work; only 4+ is a genuine overload.
  // Skip passive/background tasks (>14 days) — warm-ups, monitoring, etc.
  const PASSIVE_DAYS = 14;
  const OVERLOAD_THRESHOLD = 4;
  const splitAssignees = (raw) =>
    String(raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const taskDuration = (t) => {
    if (t.durationDays != null) return t.durationDays;
    const s = isoToMs(t.startDate);
    const e = isoToMs(t.computedEnd);
    if (s !== null && e !== null) return (e - s) / 86400000;
    return null;
  };

  const byAssignee = new Map();
  for (const t of tasks) {
    if (!t.assignee || t.isVertMarker || t.isMilestone) continue;
    const dur = taskDuration(t);
    if (dur !== null && dur > PASSIVE_DAYS) continue;
    for (const person of splitAssignees(t.assignee)) {
      if (!byAssignee.has(person)) byAssignee.set(person, []);
      byAssignee.get(person).push(t);
    }
  }
  for (const [person, group] of byAssignee) {
    if (group.length < OVERLOAD_THRESHOLD) continue;

    // Sweep-line: find peak concurrent tasks on any given day
    const events = [];
    for (const t of group) {
      const s = isoToMs(t.startDate);
      const e = isoToMs(t.computedEnd);
      if (s === null || e === null) continue;
      events.push({ ms: s, delta: 1, task: t });
      events.push({ ms: e, delta: -1, task: t });
    }
    // Sort by time; at same time, process ends before starts so
    // a task ending on day X and another starting on day X don't overlap
    events.sort((a, b) => a.ms - b.ms || a.delta - b.delta);

    let concurrent = 0;
    let peakConcurrent = 0;
    const active = new Set();
    const overloadedTasks = new Set();

    for (const ev of events) {
      if (ev.delta === 1) {
        concurrent++;
        active.add(ev.task);
      } else {
        concurrent--;
        active.delete(ev.task);
      }
      if (concurrent >= OVERLOAD_THRESHOLD) {
        for (const t of active) overloadedTasks.add(t);
        peakConcurrent = Math.max(peakConcurrent, concurrent);
      }
    }

    if (overloadedTasks.size > 0) {
      const displayName = person.charAt(0).toUpperCase() + person.slice(1);
      for (const task of overloadedTasks) {
        const entry = getEntry(task.label);
        if (!entry.flags.includes("overloaded-assignee")) {
          entry.flags.push("overloaded-assignee");
          entry.reasons.push("Overloaded: " + displayName + " has " + peakConcurrent + " tasks at the same time");
        }
      }
    }
  }

  return result;
}

/* ── Week key helper ─────────────────────────────────── */

export function getWeekKey(isoDate) {
  const datePart = isoDate.includes(" ") ? isoDate.split(" ")[0] : isoDate;
  const d = new Date(datePart + "T00:00:00Z");
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/* ── Resource load / overload detection ──────────────── */

export function computeResourceLoad(tasks) {
  const assigneeWeeks = new Map();

  for (const task of tasks) {
    if (!task.assignee || !task.startDate || !task.computedEnd) continue;

    const names = task.assignee
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);

    for (const name of names) {
      if (!assigneeWeeks.has(name)) assigneeWeeks.set(name, new Map());
      const weeks = assigneeWeeks.get(name);

      const datePart = task.startDate.includes(" ") ? task.startDate.split(" ")[0] : task.startDate;
      let current = datePart;
      const endDatePart = task.computedEnd.includes(" ") ? task.computedEnd.split(" ")[0] : task.computedEnd;
      const endMs = Date.parse(endDatePart + "T00:00:00Z");

      while (Date.parse(current + "T00:00:00Z") < endMs) {
        const wk = getWeekKey(current);
        if (!weeks.has(wk)) {
          const d = new Date(current + "T00:00:00Z");
          const day = d.getUTCDay() || 7;
          d.setUTCDate(d.getUTCDate() - day + 1);
          const weekStart = d.toISOString().slice(0, 10);
          weeks.set(wk, { weekStart, tasks: [] });
        }
        const entry = weeks.get(wk);
        if (!entry.tasks.includes(task.label)) {
          entry.tasks.push(task.label);
        }

        const next = new Date(Date.parse(current + "T00:00:00Z") + 86400000);
        current = next.toISOString().slice(0, 10);
      }
    }
  }

  const result = [];
  for (const [name, weeks] of assigneeWeeks) {
    const taskSet = new Set();
    const overloadedWeeks = [];

    for (const [weekKey, entry] of weeks) {
      for (const t of entry.tasks) taskSet.add(t);
      if (entry.tasks.length >= 2) {
        overloadedWeeks.push({
          weekKey,
          weekStart: entry.weekStart,
          tasks: [...entry.tasks],
        });
      }
    }

    overloadedWeeks.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
    result.push({ name, totalTasks: taskSet.size, overloadedWeeks });
  }

  result.sort((a, b) => {
    const diff = b.overloadedWeeks.length - a.overloadedWeeks.length;
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });

  return result;
}
