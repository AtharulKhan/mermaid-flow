/* ── Multi-Diagram Parser & Mutator ────────────────────── */
/* Parsers and mutation functions for: class, ER, state,   */
/* sequence, mindmap, pie, timeline, C4, block, and others */

/* ────────────────────────────────────────────────────────  */
/* ── Class Diagram ─────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseClassDiagram(code) {
  const lines = code.split("\n");
  const classes = [];
  const relationships = [];
  let currentClass = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "classDiagram") continue;

    // Class definition: class ClassName {
    const classMatch = trimmed.match(/^class\s+(\w+)\s*(?:\["([^"]+)"\])?\s*\{?\s*$/);
    if (classMatch) {
      currentClass = { id: classMatch[1], label: classMatch[2] || classMatch[1], members: [], lineIndex: i };
      classes.push(currentClass);
      continue;
    }

    // End of class block
    if (trimmed === "}" && currentClass) {
      currentClass = null;
      continue;
    }

    // Class members (inside { })
    if (currentClass && trimmed !== "{") {
      currentClass.members.push(trimmed);
      continue;
    }

    // Relationship: ClassA <|-- ClassB or ClassA --> ClassB : label
    const relMatch = trimmed.match(/^(\w+)\s+(<?(?:--|\.\.)>?|<\|--|\*--|o--|-->|--\*|--o|<\|\.\.|\.\.\|>|--)\s+(\w+)(?:\s*:\s*(.+))?$/);
    if (relMatch) {
      relationships.push({
        source: relMatch[1],
        target: relMatch[3],
        type: relMatch[2],
        label: relMatch[4] || "",
        lineIndex: i,
      });
      continue;
    }

    // Annotation: <<interface>> ClassName
    const annMatch = trimmed.match(/^<<(\w+)>>\s+(\w+)/);
    if (annMatch) continue;
  }

  return { classes, relationships };
}

export function addClassDiagramClass(code, { name, members = [] }) {
  const memberLines = members.map((m) => `    ${m}`).join("\n");
  const classBlock = memberLines
    ? `    class ${name} {\n${memberLines}\n    }`
    : `    class ${name}`;
  const lines = code.split("\n");
  lines.push(classBlock);
  return lines.join("\n");
}

export function removeClassDiagramClass(code, className) {
  const lines = code.split("\n");
  const result = [];
  let skipBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip class block
    if (trimmed.match(new RegExp(`^class\\s+${className}\\s`))) {
      skipBlock = trimmed.includes("{");
      if (!skipBlock) continue; // single-line class def
      continue;
    }
    if (skipBlock) {
      if (trimmed === "}") { skipBlock = false; }
      continue;
    }

    // Skip relationships involving this class
    if (new RegExp(`\\b${className}\\b`).test(trimmed) && /--|\.\./.test(trimmed)) continue;

    result.push(lines[i]);
  }

  return result.join("\n");
}

export function addClassDiagramRelationship(code, { source, target, type = "-->", label = "" }) {
  const labelPart = label ? ` : ${label}` : "";
  const line = `    ${source} ${type} ${target}${labelPart}`;
  return code + "\n" + line;
}

export function removeClassDiagramRelationship(code, source, target) {
  const lines = code.split("\n");
  return lines.filter((line) => {
    const trimmed = line.trim();
    const re = new RegExp(`^${source}\\s+(?:<[|*o])?(?:--|\\.\\.)(?:[|*o]>)?\\s+${target}`);
    const reReverse = new RegExp(`^${target}\\s+(?:<[|*o])?(?:--|\\.\\.)(?:[|*o]>)?\\s+${source}`);
    return !re.test(trimmed) && !reReverse.test(trimmed);
  }).join("\n");
}

/* ────────────────────────────────────────────────────────  */
/* ── ER Diagram ────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseErDiagram(code) {
  const lines = code.split("\n");
  const entities = [];
  const relationships = [];
  let currentEntity = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "erDiagram") continue;

    // Relationship: ENTITY1 ||--o{ ENTITY2 : label
    const relMatch = trimmed.match(/^(\w+)\s+([|o{}\s]+--[|o{}\s]+)\s+(\w+)\s*:\s*(.+)$/);
    if (relMatch) {
      relationships.push({
        source: relMatch[1],
        target: relMatch[3],
        cardinality: relMatch[2].trim(),
        label: relMatch[4].trim(),
        lineIndex: i,
      });
      continue;
    }

    // Entity with attributes: ENTITY {
    const entityMatch = trimmed.match(/^(\w+)\s*\{\s*$/);
    if (entityMatch) {
      currentEntity = { id: entityMatch[1], attributes: [], lineIndex: i };
      entities.push(currentEntity);
      continue;
    }

    // End of entity block
    if (trimmed === "}" && currentEntity) {
      currentEntity = null;
      continue;
    }

    // Attribute: type name
    if (currentEntity) {
      currentEntity.attributes.push(trimmed);
    }
  }

  return { entities, relationships };
}

export function addErEntity(code, { name, attributes = [] }) {
  const attrLines = attributes.map((a) => `      ${a}`).join("\n");
  const block = attrLines
    ? `    ${name} {\n${attrLines}\n    }`
    : `    ${name} {\n    }`;
  return code + "\n" + block;
}

export function removeErEntity(code, entityName) {
  const lines = code.split("\n");
  const result = [];
  let skipBlock = false;
  const re = new RegExp(`\\b${entityName}\\b`);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(new RegExp(`^${entityName}\\s*\\{`))) {
      skipBlock = true;
      continue;
    }
    if (skipBlock) {
      if (trimmed === "}") { skipBlock = false; }
      continue;
    }
    // Skip relationships involving this entity
    if (re.test(trimmed) && /--/.test(trimmed)) continue;
    result.push(lines[i]);
  }

  return result.join("\n");
}

export function updateErEntity(code, entityName, { newName, attributes }) {
  const lines = code.split("\n");
  const result = [];
  let inEntity = false;
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(new RegExp(`^${entityName}\\s*\\{`))) {
      inEntity = true;
      found = true;
      const name = newName || entityName;
      result.push(`    ${name} {`);
      for (const attr of attributes) {
        result.push(`        ${attr}`);
      }
      continue;
    }
    if (inEntity) {
      if (trimmed === "}") {
        inEntity = false;
        result.push(`    }`);
      }
      continue;
    }
    if (found && newName && newName !== entityName) {
      const re = new RegExp(`\\b${entityName}\\b`, 'g');
      result.push(lines[i].replace(re, newName));
    } else {
      result.push(lines[i]);
    }
  }
  return result.join("\n");
}

export function addErRelationship(code, { source, target, cardinality = "||--o{", label = "relates" }) {
  return code + `\n    ${source} ${cardinality} ${target} : ${label}`;
}

/* ────────────────────────────────────────────────────────  */
/* ── State Diagram ─────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseStateDiagram(code) {
  const lines = code.split("\n");
  const states = [];
  const transitions = [];
  const stateIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || /^stateDiagram/.test(trimmed) || trimmed === "direction LR" || trimmed === "direction TB") continue;

    // Transition: StateA --> StateB : event
    const transMatch = trimmed.match(/^(\[?\*?\]?[\w]+)\s+-->\s+(\[?\*?\]?[\w]+)(?:\s*:\s*(.+))?$/);
    if (transMatch) {
      const source = transMatch[1];
      const target = transMatch[2];
      transitions.push({
        source,
        target,
        label: transMatch[3] || "",
        lineIndex: i,
      });
      if (source !== "[*]") stateIds.add(source);
      if (target !== "[*]") stateIds.add(target);
      continue;
    }

    // State declaration: state "Label" as s1
    const stateMatch = trimmed.match(/^state\s+"([^"]+)"\s+as\s+(\w+)/);
    if (stateMatch) {
      states.push({ id: stateMatch[2], label: stateMatch[1], lineIndex: i });
      stateIds.add(stateMatch[2]);
      continue;
    }

    // Note
    if (trimmed.startsWith("note ")) continue;
  }

  // Add implicit states from transitions
  stateIds.forEach((id) => {
    if (!states.find((s) => s.id === id)) {
      states.push({ id, label: id, lineIndex: -1 });
    }
  });

  return { states, transitions };
}

export function addStateDiagramState(code, { id, label }) {
  const labelPart = label && label !== id ? `\n    state "${label}" as ${id}` : "";
  return code + labelPart + `\n    ${id}`;
}

export function removeStateDiagramState(code, stateId) {
  const lines = code.split("\n");
  const re = new RegExp(`\\b${stateId}\\b`);
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (re.test(trimmed) && /-->/.test(trimmed)) return false;
    if (trimmed.match(new RegExp(`^state\\s+"[^"]*"\\s+as\\s+${stateId}`))) return false;
    return true;
  }).join("\n");
}

export function addStateDiagramTransition(code, { source, target, label = "" }) {
  const labelPart = label ? ` : ${label}` : "";
  return code + `\n    ${source} --> ${target}${labelPart}`;
}

/* ────────────────────────────────────────────────────────  */
/* ── Sequence Diagram ──────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseSequenceDiagram(code) {
  const lines = code.split("\n");
  const participants = [];
  const messages = [];
  const participantIds = new Set();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "sequenceDiagram") continue;

    // Participant/actor
    const partMatch = trimmed.match(/^(participant|actor)\s+(\w+)(?:\s+as\s+(.+))?$/);
    if (partMatch) {
      const id = partMatch[2];
      participants.push({ id, label: partMatch[3] || id, type: partMatch[1], lineIndex: i });
      participantIds.add(id);
      continue;
    }

    // Message: A->>B: text or A-->>B: text
    const msgMatch = trimmed.match(/^(\w+)\s*(->>|-->>|->|-->|-x|--x|-\)|--)?\s*(\w+)\s*:\s*(.+)$/);
    if (msgMatch) {
      messages.push({
        source: msgMatch[1],
        target: msgMatch[3],
        arrowType: msgMatch[2] || "->>",
        text: msgMatch[4].trim(),
        lineIndex: i,
      });
      if (!participantIds.has(msgMatch[1])) participantIds.add(msgMatch[1]);
      if (!participantIds.has(msgMatch[3])) participantIds.add(msgMatch[3]);
      continue;
    }
  }

  // Add implicit participants
  participantIds.forEach((id) => {
    if (!participants.find((p) => p.id === id)) {
      participants.push({ id, label: id, type: "participant", lineIndex: -1 });
    }
  });

  return { participants, messages };
}

export function addSequenceParticipant(code, { id, label, type = "participant" }) {
  const labelPart = label && label !== id ? ` as ${label}` : "";
  const line = `    ${type} ${id}${labelPart}`;
  // Insert after last participant line or after sequenceDiagram line
  const lines = code.split("\n");
  let insertIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(participant|actor)\s/.test(lines[i])) insertIdx = i + 1;
    else if (/^\s*sequenceDiagram/.test(lines[i]) && insertIdx === 0) insertIdx = i + 1;
  }
  lines.splice(insertIdx, 0, line);
  return lines.join("\n");
}

export function removeSequenceParticipant(code, participantId) {
  const lines = code.split("\n");
  const re = new RegExp(`\\b${participantId}\\b`);
  return lines.filter((line) => {
    const trimmed = line.trim();
    // Remove participant declaration
    if (trimmed.match(new RegExp(`^(participant|actor)\\s+${participantId}(\\s|$)`))) return false;
    // Remove messages to/from this participant
    if (re.test(trimmed) && /(->|-->>|->>|-x|--x|-\))/.test(trimmed)) return false;
    return true;
  }).join("\n");
}

export function addSequenceMessage(code, { source, target, text, arrowType = "->>" }) {
  return code + `\n    ${source}${arrowType}${target}: ${text}`;
}

/* ────────────────────────────────────────────────────────  */
/* ── Pie Chart ─────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parsePieChart(code) {
  const lines = code.split("\n");
  const slices = [];
  let title = "";

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;

    const titleMatch = trimmed.match(/^pie\s+title\s+(.+)$/);
    if (titleMatch) { title = titleMatch[1]; continue; }
    if (trimmed === "pie") continue;

    // Slice: "Label" : value
    const sliceMatch = trimmed.match(/^"([^"]+)"\s*:\s*(\d+(?:\.\d+)?)$/);
    if (sliceMatch) {
      slices.push({ label: sliceMatch[1], value: parseFloat(sliceMatch[2]), lineIndex: i });
    }
  }

  return { title, slices };
}

export function addPieSlice(code, { label, value }) {
  return code + `\n    "${label}" : ${value}`;
}

export function removePieSlice(code, label) {
  const lines = code.split("\n");
  return lines.filter((line) => !line.trim().startsWith(`"${label}"`)).join("\n");
}

export function updatePieSlice(code, label, newValue) {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(`"${label}"`)) {
      lines[i] = lines[i].replace(/:\s*\d+(?:\.\d+)?/, `: ${newValue}`);
      break;
    }
  }
  return lines.join("\n");
}

/* ────────────────────────────────────────────────────────  */
/* ── Mindmap ───────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseMindmap(code) {
  const lines = code.split("\n");
  const nodes = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "mindmap") continue;

    // Detect indent level (2 spaces per level)
    const indent = lines[i].match(/^(\s*)/)[1].length;
    const level = Math.floor(indent / 2);

    // Root node with shape: root((text))
    const rootMatch = trimmed.match(/^root\(\((.+?)\)\)$/);
    if (rootMatch) {
      nodes.push({ label: rootMatch[1], level: 0, lineIndex: i });
      continue;
    }

    nodes.push({ label: trimmed, level, lineIndex: i });
  }

  return { nodes };
}

export function addMindmapNode(code, { label, level = 1 }) {
  const indent = "  ".repeat(level);
  return code + `\n${indent}${label}`;
}

/* ────────────────────────────────────────────────────────  */
/* ── Timeline ──────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseTimeline(code) {
  const lines = code.split("\n");
  const events = [];
  let title = "";

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "timeline") continue;

    const titleMatch = trimmed.match(/^title\s+(.+)$/);
    if (titleMatch) { title = titleMatch[1]; continue; }

    // Period : event
    const eventMatch = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
    if (eventMatch) {
      events.push({ period: eventMatch[1].trim(), text: eventMatch[2].trim(), lineIndex: i });
      continue;
    }

    // Continuation event (indented : event)
    if (trimmed.startsWith(":")) {
      events.push({ period: "", text: trimmed.slice(1).trim(), lineIndex: i });
    }
  }

  return { title, events };
}

export function addTimelineEvent(code, { period, text }) {
  return code + `\n    ${period} : ${text}`;
}

/* ────────────────────────────────────────────────────────  */
/* ── C4 Diagram ────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseC4Diagram(code) {
  const lines = code.split("\n");
  const elements = [];
  const relationships = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || /^C4/.test(trimmed) || trimmed.startsWith("title ")) continue;

    // Person/System/Container/Component
    const elemMatch = trimmed.match(/^(Person|System|Container|Component|System_Ext|Container_Ext)\((\w+),\s*"([^"]+)"(?:,\s*"([^"]+)")?\)/);
    if (elemMatch) {
      elements.push({
        type: elemMatch[1],
        id: elemMatch[2],
        label: elemMatch[3],
        description: elemMatch[4] || "",
        lineIndex: i,
      });
      continue;
    }

    // Relationship: Rel(from, to, "label")
    const relMatch = trimmed.match(/^Rel\((\w+),\s*(\w+),\s*"([^"]+)"\)/);
    if (relMatch) {
      relationships.push({
        source: relMatch[1],
        target: relMatch[2],
        label: relMatch[3],
        lineIndex: i,
      });
    }
  }

  return { elements, relationships };
}

export function addC4Element(code, { type = "System", id, label, description = "" }) {
  const descPart = description ? `, "${description}"` : "";
  return code + `\n    ${type}(${id}, "${label}"${descPart})`;
}

export function addC4Relationship(code, { source, target, label }) {
  return code + `\n    Rel(${source}, ${target}, "${label}")`;
}

/* ────────────────────────────────────────────────────────  */
/* ── Git Graph ─────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseGitGraph(code) {
  const lines = code.split("\n");
  const commits = [];
  const branches = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "gitGraph") continue;

    const commitMatch = trimmed.match(/^commit(?:\s+id:\s*"([^"]+)")?/);
    if (commitMatch) {
      commits.push({ id: commitMatch[1] || "", lineIndex: i });
      continue;
    }

    const branchMatch = trimmed.match(/^branch\s+(.+)/);
    if (branchMatch) {
      branches.push({ name: branchMatch[1].trim(), lineIndex: i });
    }
  }

  return { commits, branches };
}

/* ────────────────────────────────────────────────────────  */
/* ── Quadrant Chart ────────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

export function parseQuadrantChart(code) {
  const lines = code.split("\n");
  const points = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed === "quadrantChart") continue;

    // Point: "Label": [x, y]
    const pointMatch = trimmed.match(/^"([^"]+)"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
    if (pointMatch) {
      points.push({
        label: pointMatch[1],
        x: parseFloat(pointMatch[2]),
        y: parseFloat(pointMatch[3]),
        lineIndex: i,
      });
    }
  }

  return { points };
}

export function addQuadrantPoint(code, { label, x, y }) {
  return code + `\n    "${label}": [${x}, ${y}]`;
}

/* ────────────────────────────────────────────────────────  */
/* ── Adapter Registry ──────────────────────────────────── */
/* ────────────────────────────────────────────────────────  */

/**
 * Get the appropriate parser for a diagram type.
 * Returns { parse, addNode, removeNode, addEdge, removeEdge } or null.
 */
export function getDiagramAdapter(toolsetKey) {
  switch (toolsetKey) {
    case "classDiagram":
      return {
        parse: parseClassDiagram,
        addNode: addClassDiagramClass,
        removeNode: removeClassDiagramClass,
        addEdge: addClassDiagramRelationship,
        removeEdge: removeClassDiagramRelationship,
        nodeLabel: "class",
        edgeLabel: "relationship",
      };
    case "erDiagram":
      return {
        parse: parseErDiagram,
        addNode: addErEntity,
        removeNode: removeErEntity,
        addEdge: addErRelationship,
        removeEdge: null,
        nodeLabel: "entity",
        edgeLabel: "relationship",
      };
    case "stateDiagram":
      return {
        parse: parseStateDiagram,
        addNode: addStateDiagramState,
        removeNode: removeStateDiagramState,
        addEdge: addStateDiagramTransition,
        removeEdge: null,
        nodeLabel: "state",
        edgeLabel: "transition",
      };
    case "sequenceDiagram":
      return {
        parse: parseSequenceDiagram,
        addNode: addSequenceParticipant,
        removeNode: removeSequenceParticipant,
        addEdge: addSequenceMessage,
        removeEdge: null,
        nodeLabel: "participant",
        edgeLabel: "message",
      };
    default:
      return null;
  }
}
