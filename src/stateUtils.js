import { parseStateDiagram } from "./diagramUtils";

/* ────────────────────────────────────────────────────────  */
/* ── Enhanced State Diagram Parsing ───────────────────── */
/* ────────────────────────────────────────────────────────  */

/**
 * Wraps parseStateDiagram with extra data needed by the custom renderer:
 *  - direction (LR / TB)
 *  - Splits [*] into __mf_initial__ / __mf_final__ pseudo-nodes
 */
export function parseStateDiagramEnhanced(code) {
  const { states, transitions } = parseStateDiagram(code);

  // Extract direction directive
  const dirMatch = code.match(/^\s*direction\s+(LR|TB|RL|BT)/m);
  const direction = dirMatch ? dirMatch[1] : "LR";

  // Determine [*] roles
  let hasInitial = false;
  let hasFinal = false;
  for (const t of transitions) {
    if (t.source === "[*]") hasInitial = true;
    if (t.target === "[*]") hasFinal = true;
  }

  // Build augmented state list: replace [*] with typed pseudo-nodes
  const augStates = states.filter((s) => s.id !== "[*]");
  if (hasInitial) {
    augStates.unshift({ id: "__mf_initial__", label: "", lineIndex: -1, pseudo: "initial" });
  }
  if (hasFinal) {
    augStates.push({ id: "__mf_final__", label: "", lineIndex: -1, pseudo: "final" });
  }

  // Rewrite transitions to use pseudo-node ids
  const augTransitions = transitions.map((t) => ({
    ...t,
    source: t.source === "[*]" ? "__mf_initial__" : t.source,
    target: t.target === "[*]" ? "__mf_final__" : t.target,
  }));

  return { states: augStates, transitions: augTransitions, direction, hasInitial, hasFinal };
}

/* ────────────────────────────────────────────────────────  */
/* ── XState JSON → Mermaid ────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

function sanitizeId(id) {
  return String(id || "")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "");
}

/**
 * Convert an XState v4/v5 machine config to stateDiagram-v2 Mermaid syntax.
 */
export function xstateToMermaid(config) {
  if (!config || typeof config !== "object") return "stateDiagram-v2\n    direction LR\n";

  const lines = ["stateDiagram-v2", "    direction LR"];

  // Initial state
  if (config.initial) {
    lines.push(`    [*] --> ${sanitizeId(config.initial)}`);
  }

  const stateEntries = Object.entries(config.states || {});
  for (const [stateId, stateDef] of stateEntries) {
    const safeId = sanitizeId(stateId);
    if (!safeId) continue;

    // State description / label
    if (stateDef && stateDef.description) {
      lines.push(`    state "${stateDef.description}" as ${safeId}`);
    }

    // Transitions from "on" events
    const events = (stateDef && stateDef.on) || {};
    for (const [eventName, target] of Object.entries(events)) {
      let targetId = "";
      if (typeof target === "string") {
        targetId = sanitizeId(target);
      } else if (Array.isArray(target) && target.length > 0) {
        targetId = sanitizeId(target[0].target || target[0]);
      } else if (target && typeof target === "object") {
        targetId = sanitizeId(target.target || "");
      }
      if (targetId) {
        lines.push(`    ${safeId} --> ${targetId} : ${eventName}`);
      }
    }

    // Final state
    if (stateDef && stateDef.type === "final") {
      lines.push(`    ${safeId} --> [*]`);
    }
  }

  return lines.join("\n") + "\n";
}

/* ────────────────────────────────────────────────────────  */
/* ── Mermaid → XState JSON ────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

/**
 * Convert current stateDiagram-v2 code to an XState machine config object.
 */
export function mermaidToXState(code) {
  const { states, transitions } = parseStateDiagram(code);

  const machine = {
    id: "machine",
    initial: "",
    states: {},
  };

  // Ensure all states exist in the output
  for (const state of states) {
    if (state.id === "[*]") continue;
    machine.states[state.id] = { on: {} };
  }

  // Process transitions
  for (const t of transitions) {
    if (t.source === "[*]") {
      machine.initial = t.target;
      if (!machine.states[t.target]) machine.states[t.target] = { on: {} };
      continue;
    }
    if (t.target === "[*]") {
      if (!machine.states[t.source]) machine.states[t.source] = { on: {} };
      machine.states[t.source].type = "final";
      continue;
    }

    if (!machine.states[t.source]) machine.states[t.source] = { on: {} };
    if (!machine.states[t.target]) machine.states[t.target] = { on: {} };

    const eventName = t.label || `TO_${t.target.toUpperCase()}`;
    machine.states[t.source].on[eventName] = t.target;
  }

  return machine;
}

/* ────────────────────────────────────────────────────────  */
/* ── Helpers ──────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

/**
 * Generate a unique state ID like S1, S2, ...
 */
export function generateStateId(existingStates) {
  const taken = new Set((existingStates || []).map((s) => s.id));
  for (let i = 1; i < 1000; i++) {
    const candidate = "S" + i;
    if (!taken.has(candidate)) return candidate;
  }
  return "S" + Date.now();
}

/**
 * Toggle or set the direction directive in a stateDiagram-v2 code block.
 */
export function toggleStateDiagramDirection(code, newDirection) {
  const dirRe = /^(\s*)direction\s+(LR|TB|RL|BT)\s*$/m;
  if (dirRe.test(code)) {
    return code.replace(dirRe, `$1direction ${newDirection}`);
  }
  // Insert after the stateDiagram-v2 header line
  const headerRe = /^(\s*stateDiagram(?:-v2)?)\s*$/m;
  const match = code.match(headerRe);
  if (match) {
    const idx = code.indexOf(match[0]) + match[0].length;
    return code.slice(0, idx) + `\n    direction ${newDirection}` + code.slice(idx);
  }
  return code;
}
