/* ── Gantt Dependency Graph Utilities ────────────────── */

const DAY_MS = 86400000;

function taskKey(t) {
  return (t.idToken || t.label || "").toLowerCase();
}

function getStartMs(t) {
  const iso = t.resolvedStartDate || t.startDate || "";
  if (!iso) return null;
  const ms = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(ms) ? ms : null;
}

function getEndMs(t) {
  const end = t.resolvedEndDate || t.endDate || t.computedEnd || "";
  if (end) {
    const ms = Date.parse(end + "T00:00:00Z");
    if (Number.isFinite(ms)) return ms;
  }
  const startMs = getStartMs(t);
  if (startMs !== null && t.durationDays) {
    return startMs + t.durationDays * DAY_MS;
  }
  return startMs;
}

/* ── Build adjacency lists ───────────────────────────── */

export function buildDependencyGraph(tasks) {
  const taskById = new Map();
  const taskByLabel = new Map();
  const forward = new Map(); // key -> Set of downstream task keys
  const reverse = new Map(); // key -> Set of upstream task keys

  for (const t of tasks) {
    const key = taskKey(t);
    if (!key) continue;
    if (t.idToken) taskById.set(t.idToken.toLowerCase(), t);
    if (t.label && !taskByLabel.has(t.label.toLowerCase())) {
      taskByLabel.set(t.label.toLowerCase(), t);
    }
    if (!forward.has(key)) forward.set(key, new Set());
    if (!reverse.has(key)) reverse.set(key, new Set());
  }

  for (const t of tasks) {
    const tKey = taskKey(t);
    if (!tKey) continue;

    // afterDeps: t depends on each dep (dep must finish before t starts)
    for (const depId of t.afterDeps || []) {
      const depKey = depId.toLowerCase();
      const dep = taskById.get(depKey) || taskByLabel.get(depKey);
      if (!dep) continue;
      const dKey = taskKey(dep);
      if (!dKey || dKey === tKey) continue;

      if (!forward.has(dKey)) forward.set(dKey, new Set());
      forward.get(dKey).add(tKey);
      if (!reverse.has(tKey)) reverse.set(tKey, new Set());
      reverse.get(tKey).add(dKey);
    }

    // untilDep: t's end is bound by dep's start
    if (t.untilDep) {
      const depKey = t.untilDep.toLowerCase();
      const dep = taskById.get(depKey) || taskByLabel.get(depKey);
      if (dep) {
        const dKey = taskKey(dep);
        if (dKey && dKey !== tKey) {
          if (!forward.has(tKey)) forward.set(tKey, new Set());
          forward.get(tKey).add(dKey);
          if (!reverse.has(dKey)) reverse.set(dKey, new Set());
          reverse.get(dKey).add(tKey);
        }
      }
    }
  }

  return { forward, reverse, taskById, taskByLabel };
}

/* ── Cycle detection (DFS 3-color) ───────────────────── */

export function detectCycles(tasks) {
  const graph = buildDependencyGraph(tasks);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const cycles = [];

  for (const key of graph.forward.keys()) color.set(key, WHITE);

  function dfs(u, path) {
    color.set(u, GRAY);
    path.push(u);

    for (const v of graph.forward.get(u) || []) {
      if (color.get(v) === GRAY) {
        const cycleStart = path.indexOf(v);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart));
        }
      } else if (color.get(v) === WHITE || color.get(v) === undefined) {
        dfs(v, path);
      }
    }

    path.pop();
    color.set(u, BLACK);
  }

  for (const key of graph.forward.keys()) {
    if (color.get(key) === WHITE) dfs(key, []);
  }

  return cycles;
}

/* ── BFS traversal helpers ───────────────────────────── */

export function getUpstream(taskKeyStr, reverseAdj) {
  const visited = new Set();
  const queue = [...(reverseAdj[taskKeyStr] || reverseAdj.get?.(taskKeyStr) || [])];
  for (const k of queue) visited.add(k);

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    const deps = reverseAdj[current] || reverseAdj.get?.(current) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }
  return visited;
}

export function getDownstream(taskKeyStr, forwardAdj) {
  const visited = new Set();
  const queue = [...(forwardAdj[taskKeyStr] || forwardAdj.get?.(taskKeyStr) || [])];
  for (const k of queue) visited.add(k);

  let i = 0;
  while (i < queue.length) {
    const current = queue[i++];
    const deps = forwardAdj[current] || forwardAdj.get?.(current) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }
  return visited;
}

/* ── Conflict detection ──────────────────────────────── */

export function detectConflicts(tasks) {
  const byId = new Map();
  const byLabel = new Map();
  for (const t of tasks) {
    if (t.idToken) byId.set(t.idToken.toLowerCase(), t);
    if (t.label) byLabel.set(t.label.toLowerCase(), t);
  }

  const conflicts = [];
  for (const task of tasks) {
    if (!task.afterDeps || !task.afterDeps.length) continue;
    const taskStartMs = getStartMs(task);
    if (taskStartMs === null) continue;

    for (const depId of task.afterDeps) {
      const dep = byId.get(depId.toLowerCase()) || byLabel.get(depId.toLowerCase());
      if (!dep) continue;
      const depEndMs = getEndMs(dep);
      if (depEndMs === null) continue;

      if (taskStartMs < depEndMs) {
        const overlapDays = Math.ceil((depEndMs - taskStartMs) / DAY_MS);
        conflicts.push({
          taskLabel: task.label,
          depLabel: dep.label,
          overlapDays,
        });
      }
    }
  }
  return conflicts;
}

/* ── Slack calculation (forward/backward pass) ───────── */

export function calculateSlack(tasks) {
  const graph = buildDependencyGraph(tasks);
  const result = new Map();

  // Forward pass: earliest start/finish (already resolved by resolveDependencies)
  const earlyStart = new Map();
  const earlyFinish = new Map();
  for (const t of tasks) {
    const key = taskKey(t);
    if (!key) continue;
    earlyStart.set(key, getStartMs(t));
    earlyFinish.set(key, getEndMs(t));
  }

  // Find project end
  let projectEnd = 0;
  for (const ms of earlyFinish.values()) {
    if (ms !== null && ms > projectEnd) projectEnd = ms;
  }
  if (!projectEnd) return result;

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map();
  for (const key of graph.forward.keys()) inDegree.set(key, 0);
  for (const [, targets] of graph.forward) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) || 0) + 1);
    }
  }

  const topoOrder = [];
  const queue = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }
  while (queue.length) {
    const u = queue.shift();
    topoOrder.push(u);
    for (const v of graph.forward.get(u) || []) {
      const d = inDegree.get(v) - 1;
      inDegree.set(v, d);
      if (d === 0) queue.push(v);
    }
  }

  // Backward pass: latest finish/start
  const lateFinish = new Map();
  const lateStart = new Map();

  // Initialize all to projectEnd
  for (const key of topoOrder) {
    lateFinish.set(key, projectEnd);
  }

  // Process in reverse topological order
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const key = topoOrder[i];
    const successors = graph.forward.get(key) || new Set();

    // Latest finish = min(lateStart of successors), or projectEnd if no successors
    if (successors.size > 0) {
      let minLateStart = projectEnd;
      for (const s of successors) {
        const sLateStart = lateStart.get(s);
        if (sLateStart !== undefined && sLateStart < minLateStart) {
          minLateStart = sLateStart;
        }
      }
      lateFinish.set(key, minLateStart);
    }

    // Latest start = latest finish - duration
    const ef = earlyFinish.get(key);
    const es = earlyStart.get(key);
    const duration = ef !== null && es !== null ? ef - es : 0;
    lateStart.set(key, lateFinish.get(key) - duration);
  }

  // Compute slack
  for (const t of tasks) {
    const key = taskKey(t);
    if (!key) continue;
    const es = earlyStart.get(key);
    const ls = lateStart.get(key);
    if (es === null || ls === undefined) {
      result.set(t.label, { slack: 0, isCritical: false });
      continue;
    }
    const slackDays = Math.max(0, Math.round((ls - es) / DAY_MS));
    result.set(t.label, { slack: slackDays, isCritical: slackDays <= 0 });
  }

  return result;
}

/* ── Critical path ───────────────────────────────────── */

export function getCriticalPath(tasks) {
  const slackMap = calculateSlack(tasks);
  return tasks
    .filter((t) => {
      if (t.isVertMarker) return false;
      const info = slackMap.get(t.label);
      return info && info.isCritical;
    })
    .sort((a, b) => {
      const aMs = getStartMs(a) || 0;
      const bMs = getStartMs(b) || 0;
      return aMs - bMs;
    })
    .map((t) => t.label);
}

/* ── Serialize graph for iframe transport ────────────── */

export function serializeGraph(graph) {
  const forward = {};
  const reverse = {};
  for (const [key, set] of graph.forward) {
    if (set.size) forward[key] = [...set];
  }
  for (const [key, set] of graph.reverse) {
    if (set.size) reverse[key] = [...set];
  }
  return { forward, reverse };
}
