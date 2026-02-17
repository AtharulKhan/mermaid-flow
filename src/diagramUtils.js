/* ── Multi-Diagram Parser & Mutator ────────────────────── */
/* Parsers and mutation functions for: class, ER, state,   */
/* sequence, mindmap, pie, timeline, C4, block, and others */

function getLineIndent(line) {
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  return line.slice(0, i);
}

function escapeDiagramString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
      const hasBlock = trimmed.includes("{");
      const classEntry = { id: classMatch[1], label: classMatch[2] || classMatch[1], members: [], lineIndex: i };
      classes.push(classEntry);
      currentClass = hasBlock ? classEntry : null;
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
  const parsed = parseClassDiagram(code);
  const targetClass = parsed.classes.find((cls) => cls.id === className);
  if (!targetClass) return code;

  const lines = code.split("\n");
  const toRemove = new Set();

  // Remove the class declaration (single-line or block form).
  toRemove.add(targetClass.lineIndex);
  if (lines[targetClass.lineIndex]?.includes("{")) {
    for (let i = targetClass.lineIndex + 1; i < lines.length; i++) {
      toRemove.add(i);
      if (lines[i].trim() === "}") break;
    }
  }

  // Remove relationships that reference this class.
  for (const rel of parsed.relationships) {
    if ((rel.source === className || rel.target === className) && rel.lineIndex >= 0) {
      toRemove.add(rel.lineIndex);
    }
  }

  // Remove annotations like <<interface>> ClassName.
  const annRe = new RegExp(`^\\s*<<\\w+>>\\s+${escapeRegExp(className)}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (annRe.test(lines[i])) toRemove.add(i);
  }

  return lines.filter((_, idx) => !toRemove.has(idx)).join("\n");
}

export function addClassDiagramRelationship(code, { source, target, type = "-->", label = "" }) {
  const labelPart = label ? ` : ${label}` : "";
  const line = `    ${source} ${type} ${target}${labelPart}`;
  return code + "\n" + line;
}

export function removeClassDiagramRelationship(code, source, target) {
  const parsed = parseClassDiagram(code);
  const toRemove = new Set(
    parsed.relationships
      .filter(
        (r) =>
          (r.source === source && r.target === target) ||
          (r.source === target && r.target === source)
      )
      .map((r) => r.lineIndex)
  );
  if (!toRemove.size) return code;
  return code
    .split("\n")
    .filter((_, idx) => !toRemove.has(idx))
    .join("\n");
}

export function updateClassDiagramClass(code, classId, { label }) {
  const nextLabel = (label || "").trim();
  if (!nextLabel) return code;
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("class ")) continue;
    const match = trimmed.match(/^class\s+(\w+)(?:\s*\["([^"]*)"\])?(\s*\{)?\s*$/);
    if (!match || match[1] !== classId) continue;
    const indent = getLineIndent(lines[i]);
    const hasBlock = Boolean(match[3]);
    const useAlias = nextLabel !== classId;
    const alias = useAlias ? `["${escapeDiagramString(nextLabel)}"]` : "";
    const block = hasBlock ? " {" : "";
    lines[i] = `${indent}class ${classId}${alias}${block}`;
    return lines.join("\n");
  }

  return code;
}

export function updateClassDiagramRelationship(code, source, target, { type, arrowType, label } = {}) {
  const parsed = parseClassDiagram(code);
  const rel = parsed.relationships.find((r) => r.source === source && r.target === target);
  if (!rel || rel.lineIndex < 0) return code;
  const lines = code.split("\n");
  const indent = getLineIndent(lines[rel.lineIndex]);
  const nextType = type || arrowType || rel.type || "-->";
  const nextLabel = label !== undefined ? label : rel.label;
  const labelPart = nextLabel ? ` : ${nextLabel}` : "";
  lines[rel.lineIndex] = `${indent}${source} ${nextType} ${target}${labelPart}`;
  return lines.join("\n");
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
    const relMatch = trimmed.match(/^(\w+)\s+([|o{}\s]+--[|o{}\s]+)\s+(\w+)(?:\s*:\s*(.+))?$/);
    if (relMatch) {
      relationships.push({
        source: relMatch[1],
        target: relMatch[3],
        cardinality: relMatch[2].trim(),
        label: (relMatch[4] || "").trim(),
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

  // Discover entities referenced only in relationships (no { } block)
  const entityIds = new Set(entities.map((e) => e.id));
  for (const rel of relationships) {
    if (!entityIds.has(rel.source)) {
      entities.push({ id: rel.source, attributes: [], lineIndex: rel.lineIndex });
      entityIds.add(rel.source);
    }
    if (!entityIds.has(rel.target)) {
      entities.push({ id: rel.target, attributes: [], lineIndex: rel.lineIndex });
      entityIds.add(rel.target);
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
  const parsed = parseErDiagram(code);
  const entity = parsed.entities.find((e) => e.id === entityName);
  if (!entity) return code;

  const lines = code.split("\n");
  const toRemove = new Set();

  // Remove entity block.
  toRemove.add(entity.lineIndex);
  for (let i = entity.lineIndex + 1; i < lines.length; i++) {
    toRemove.add(i);
    if (lines[i].trim() === "}") break;
  }

  // Remove relationships that reference this entity.
  for (const rel of parsed.relationships) {
    if ((rel.source === entityName || rel.target === entityName) && rel.lineIndex >= 0) {
      toRemove.add(rel.lineIndex);
    }
  }

  return lines.filter((_, idx) => !toRemove.has(idx)).join("\n");
}

export function updateErEntity(code, entityName, { newName, attributes }) {
  const parsed = parseErDiagram(code);
  const entity = parsed.entities.find((e) => e.id === entityName);
  if (!entity) return code;

  const lines = code.split("\n");
  const nextName = (newName || entityName).trim() || entityName;
  const nextAttributes = Array.isArray(attributes) && attributes.length ? attributes : entity.attributes;

  // Rename references in relationship lines (works even when relationships appear before entity blocks).
  if (nextName !== entityName) {
    const nameRe = new RegExp(`\\b${escapeRegExp(entityName)}\\b`, "g");
    for (const rel of parsed.relationships) {
      if (rel.lineIndex >= 0) {
        lines[rel.lineIndex] = lines[rel.lineIndex].replace(nameRe, nextName);
      }
    }
  }

  // Replace entity block while preserving existing indentation.
  let blockEnd = entity.lineIndex;
  for (let i = entity.lineIndex + 1; i < lines.length; i++) {
    if (lines[i].trim() === "}") {
      blockEnd = i;
      break;
    }
  }
  const baseIndent = getLineIndent(lines[entity.lineIndex] || "");
  const attrIndent =
    blockEnd > entity.lineIndex ? getLineIndent(lines[entity.lineIndex + 1] || `${baseIndent}  `) : `${baseIndent}  `;
  const block = [
    `${baseIndent}${nextName} {`,
    ...nextAttributes.map((attr) => `${attrIndent}${attr}`),
    `${baseIndent}}`,
  ];
  lines.splice(entity.lineIndex, blockEnd - entity.lineIndex + 1, ...block);
  return lines.join("\n");
}

/**
 * Parse a single ER attribute string like "int id PK" into structured parts.
 * Returns { type, name, constraint, raw }.
 */
export function parseErAttribute(attrStr) {
  const raw = (attrStr || "").trim();
  const parts = raw.split(/\s+/);
  const type = parts[0] || "";
  const name = parts[1] || "";
  const constraint = (parts[2] || "").toUpperCase();
  const validConstraints = ["PK", "FK", "UK"];
  return {
    type,
    name,
    constraint: validConstraints.includes(constraint) ? constraint : "",
    raw,
  };
}

/**
 * Parse a cardinality string like "||--o{" into source and target markers.
 */
export function parseCardinality(card) {
  const str = (card || "").trim();
  const idx = str.indexOf("--");
  if (idx < 0) return { source: "||", target: "o{" };
  return { source: str.slice(0, idx), target: str.slice(idx + 2) };
}

/**
 * Convert SQL CREATE TABLE statements into Mermaid ER diagram syntax.
 */
export function sqlToErDiagram(sql) {
  const tables = [];
  const relationships = [];

  // Match CREATE TABLE blocks
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(sql)) !== null) {
    const tableName = tableMatch[1].toUpperCase();
    const body = tableMatch[2];
    const attrs = [];
    const pkCols = new Set();
    const fkRefs = [];

    // Find inline PRIMARY KEY constraints
    const pkConstraintRe = /PRIMARY\s+KEY\s*\(([^)]+)\)/gi;
    let pkMatch;
    while ((pkMatch = pkConstraintRe.exec(body)) !== null) {
      pkMatch[1].split(",").forEach((c) => pkCols.add(c.trim().replace(/["`]/g, "").toLowerCase()));
    }

    // Find FOREIGN KEY constraints
    const fkRe = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["`]?(\w+)["`]?\s*\(([^)]+)\)/gi;
    let fkMatch;
    while ((fkMatch = fkRe.exec(body)) !== null) {
      const fkCol = fkMatch[1].trim().replace(/["`]/g, "").toLowerCase();
      const refTable = fkMatch[2].toUpperCase();
      fkRefs.push({ col: fkCol, refTable });
    }

    // Parse individual columns
    const colLines = body.split(",").map((l) => l.trim()).filter(Boolean);
    for (const line of colLines) {
      // Skip constraint-only lines
      if (/^\s*(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|INDEX)\b/i.test(line)) continue;

      const colMatch = line.match(/^["`]?(\w+)["`]?\s+(\w[\w()]*(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?)/i);
      if (!colMatch) continue;

      const colName = colMatch[1].toLowerCase();
      const colType = colMatch[2].toLowerCase().replace(/\s+/g, "");
      const isPk = pkCols.has(colName) || /\bPRIMARY\s+KEY\b/i.test(line);
      const isFk = fkRefs.some((f) => f.col === colName);
      const isUnique = /\bUNIQUE\b/i.test(line) && !isPk;

      // Map SQL types to simpler ER types
      let erType = colType;
      if (/^(varchar|char|text|clob|nvarchar|nchar|ntext)/i.test(colType)) erType = "string";
      else if (/^(int|integer|bigint|smallint|tinyint|serial|bigserial)/i.test(colType)) erType = "int";
      else if (/^(float|double|decimal|numeric|real)/i.test(colType)) erType = "float";
      else if (/^(bool|boolean)/i.test(colType)) erType = "boolean";
      else if (/^(date|timestamp|datetime|time)/i.test(colType)) erType = "datetime";
      else if (/^(uuid)/i.test(colType)) erType = "string";
      else if (/^(json|jsonb)/i.test(colType)) erType = "json";

      let constraint = "";
      if (isPk) { constraint = " PK"; pkCols.add(colName); }
      else if (isFk) constraint = " FK";
      else if (isUnique) constraint = " UK";

      attrs.push(`${erType} ${colName}${constraint}`);
    }

    tables.push({ name: tableName, attrs });

    // Create relationships from FK references
    for (const fk of fkRefs) {
      relationships.push({ source: tableName, target: fk.refTable, cardinality: "}o--||", label: "references" });
    }

    // Check for inline REFERENCES on columns
    const inlineRefRe = /["`]?(\w+)["`]?\s+\w[\w()]*\s+.*?\bREFERENCES\s+["`]?(\w+)["`]?/gi;
    let inlineMatch;
    const bodyForInline = body;
    while ((inlineMatch = inlineRefRe.exec(bodyForInline)) !== null) {
      const refTable = inlineMatch[2].toUpperCase();
      if (!fkRefs.some((f) => f.refTable === refTable)) {
        relationships.push({ source: tableName, target: refTable, cardinality: "}o--||", label: "references" });
      }
    }
  }

  if (!tables.length) return "";

  let out = "erDiagram\n";
  for (const t of tables) {
    out += `    ${t.name} {\n`;
    for (const a of t.attrs) {
      out += `        ${a}\n`;
    }
    out += `    }\n`;
  }
  // Deduplicate relationships
  const seen = new Set();
  for (const r of relationships) {
    const key = `${r.source}-${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out += `    ${r.source} ${r.cardinality} ${r.target} : ${r.label}\n`;
  }
  return out.trimEnd();
}

/**
 * Convert an ER diagram to SQL DDL (PostgreSQL dialect).
 */
export function erDiagramToSql(code) {
  const parsed = parseErDiagram(code);
  const stmts = [];

  // Type mapping: ER type → PostgreSQL type
  const typeMap = {
    string: "VARCHAR(255)", int: "INTEGER", float: "NUMERIC", boolean: "BOOLEAN",
    datetime: "TIMESTAMP", date: "DATE", json: "JSONB", text: "TEXT",
  };

  for (const entity of parsed.entities) {
    const colDefs = [];
    const pkCols = [];
    const fkCols = [];

    for (const attrRaw of entity.attributes) {
      const attr = parseErAttribute(attrRaw);
      const sqlType = typeMap[attr.type.toLowerCase()] || attr.type.toUpperCase();
      let colDef = `    ${attr.name} ${sqlType}`;
      if (attr.constraint === "PK") {
        colDef += " NOT NULL";
        pkCols.push(attr.name);
      }
      if (attr.constraint === "UK") {
        colDef += " UNIQUE";
      }
      if (attr.constraint === "FK") {
        fkCols.push(attr.name);
      }
      colDefs.push(colDef);
    }

    if (pkCols.length) {
      colDefs.push(`    PRIMARY KEY (${pkCols.join(", ")})`);
    }

    // Resolve FK targets from relationships
    for (const fkCol of fkCols) {
      const rel = parsed.relationships.find(
        (r) => r.source === entity.id || r.target === entity.id
      );
      if (rel) {
        const refTable = rel.source === entity.id ? rel.target : rel.source;
        colDefs.push(`    FOREIGN KEY (${fkCol}) REFERENCES ${refTable.toLowerCase()} (id)`);
      }
    }

    stmts.push(`CREATE TABLE ${entity.id.toLowerCase()} (\n${colDefs.join(",\n")}\n);`);
  }

  return stmts.join("\n\n");
}

export function addErRelationship(code, { source, target, cardinality = "||--o{", label = "relates" }) {
  return code + `\n    ${source} ${cardinality} ${target} : ${label}`;
}

export function removeErRelationship(code, source, target) {
  const parsed = parseErDiagram(code);
  const lineIndexes = new Set(
    parsed.relationships
      .filter((r) => r.source === source && r.target === target)
      .map((r) => r.lineIndex)
  );
  if (!lineIndexes.size) return code;
  return code
    .split("\n")
    .filter((_, idx) => !lineIndexes.has(idx))
    .join("\n");
}

export function updateErRelationship(code, source, target, { label, cardinality, arrowType } = {}) {
  const parsed = parseErDiagram(code);
  const rel = parsed.relationships.find((r) => r.source === source && r.target === target);
  if (!rel || rel.lineIndex < 0) return code;
  const lines = code.split("\n");
  const indent = getLineIndent(lines[rel.lineIndex]);
  const nextCardinality = (cardinality || arrowType || rel.cardinality || "||--o{").trim();
  const nextLabel = (label !== undefined ? label : rel.label || "").trim();
  const labelPart = nextLabel ? ` : ${nextLabel}` : "";
  lines[rel.lineIndex] = `${indent}${source} ${nextCardinality} ${target}${labelPart}`;
  return lines.join("\n");
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
  const escapedStateId = escapeRegExp(stateId);
  const lines = code.split("\n");
  const re = new RegExp(`\\b${escapedStateId}\\b`);
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (re.test(trimmed) && /-->/.test(trimmed)) return false;
    if (trimmed.match(new RegExp(`^state\\s+"[^"]*"\\s+as\\s+${escapedStateId}`))) return false;
    return true;
  }).join("\n");
}

export function addStateDiagramTransition(code, { source, target, label = "" }) {
  const labelPart = label ? ` : ${label}` : "";
  return code + `\n    ${source} --> ${target}${labelPart}`;
}

export function removeStateDiagramTransition(code, source, target) {
  const parsed = parseStateDiagram(code);
  const lineIndexes = new Set(
    parsed.transitions
      .filter((t) => t.source === source && t.target === target)
      .map((t) => t.lineIndex)
  );
  if (!lineIndexes.size) return code;
  return code
    .split("\n")
    .filter((_, idx) => !lineIndexes.has(idx))
    .join("\n");
}

export function updateStateDiagramState(code, stateId, { label }) {
  const nextLabel = (label || "").trim();
  if (!nextLabel) return code;
  const lines = code.split("\n");
  const declarationRe = new RegExp(`^\\s*state\\s+"[^"]*"\\s+as\\s+${escapeRegExp(stateId)}\\s*$`);

  for (let i = 0; i < lines.length; i++) {
    if (!declarationRe.test(lines[i])) continue;
    const indent = getLineIndent(lines[i]);
    lines[i] = `${indent}state "${escapeDiagramString(nextLabel)}" as ${stateId}`;
    return lines.join("\n");
  }

  const insertion = `    state "${escapeDiagramString(nextLabel)}" as ${stateId}`;
  let insertIdx = lines.findIndex((line) => /^\s*stateDiagram/.test(line));
  if (insertIdx >= 0) {
    insertIdx += 1;
  } else {
    insertIdx = 0;
  }
  lines.splice(insertIdx, 0, insertion);
  return lines.join("\n");
}

export function updateStateDiagramTransition(code, source, target, { label } = {}) {
  const parsed = parseStateDiagram(code);
  const transition = parsed.transitions.find((t) => t.source === source && t.target === target);
  if (!transition || transition.lineIndex < 0) return code;
  const lines = code.split("\n");
  const indent = getLineIndent(lines[transition.lineIndex]);
  const nextLabel = label !== undefined ? label : transition.label;
  const labelPart = nextLabel ? ` : ${nextLabel}` : "";
  lines[transition.lineIndex] = `${indent}${source} --> ${target}${labelPart}`;
  return lines.join("\n");
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
    const msgMatch = trimmed.match(/^(\w+)\s*(->>|-->>|->|-->|-x|--x|-\)|--)?\s*(\w+)(?:\s*:\s*(.+))?$/);
    if (msgMatch) {
      messages.push({
        source: msgMatch[1],
        target: msgMatch[3],
        arrowType: msgMatch[2] || "->>",
        text: (msgMatch[4] || "").trim(),
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
  const parsed = parseSequenceDiagram(code);
  const toRemove = new Set();
  for (const participant of parsed.participants) {
    if (participant.id === participantId && participant.lineIndex >= 0) {
      toRemove.add(participant.lineIndex);
    }
  }
  for (const message of parsed.messages) {
    if (
      (message.source === participantId || message.target === participantId) &&
      message.lineIndex >= 0
    ) {
      toRemove.add(message.lineIndex);
    }
  }
  if (!toRemove.size) return code;
  return code
    .split("\n")
    .filter((_, idx) => !toRemove.has(idx))
    .join("\n");
}

export function updateSequenceParticipant(code, participantId, { label }) {
  const parsed = parseSequenceDiagram(code);
  const participant = parsed.participants.find((p) => p.id === participantId);
  if (!participant) return code;
  const lines = code.split("\n");
  const nextLabel = (label || "").trim();
  if (!nextLabel) return code;
  if (participant.lineIndex >= 0) {
    const existingLine = lines[participant.lineIndex];
    const role = existingLine.trim().startsWith("actor ") ? "actor" : "participant";
    const indent = getLineIndent(existingLine);
    const aliasPart = nextLabel === participantId ? "" : ` as ${nextLabel}`;
    lines[participant.lineIndex] = `${indent}${role} ${participantId}${aliasPart}`;
    return lines.join("\n");
  }

  let insertIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^sequenceDiagram/.test(trimmed)) insertIdx = i + 1;
    if (/^(participant|actor)\s+/.test(trimmed)) insertIdx = i + 1;
  }
  const aliasPart = nextLabel === participantId ? "" : ` as ${nextLabel}`;
  lines.splice(insertIdx, 0, `    participant ${participantId}${aliasPart}`);
  return lines.join("\n");
}

export function addSequenceMessage(code, { source, target, text, arrowType = "->>" }) {
  const labelPart = text ? `: ${text}` : "";
  return code + `\n    ${source}${arrowType}${target}${labelPart}`;
}

export function removeSequenceMessage(code, source, target) {
  const parsed = parseSequenceDiagram(code);
  const lineIndexes = new Set(
    parsed.messages
      .filter((m) => m.source === source && m.target === target)
      .map((m) => m.lineIndex)
  );
  if (!lineIndexes.size) return code;
  return code
    .split("\n")
    .filter((_, idx) => !lineIndexes.has(idx))
    .join("\n");
}

export function updateSequenceMessage(code, source, target, { label, arrowType } = {}) {
  const parsed = parseSequenceDiagram(code);
  const message = parsed.messages.find((m) => m.source === source && m.target === target);
  if (!message || message.lineIndex < 0) return code;
  const lines = code.split("\n");
  const indent = getLineIndent(lines[message.lineIndex]);
  const nextArrow = arrowType || message.arrowType || "->>";
  const nextText = label !== undefined ? label : message.text;
  const labelPart = nextText ? `: ${nextText}` : "";
  lines[message.lineIndex] = `${indent}${source}${nextArrow}${target}${labelPart}`;
  return lines.join("\n");
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
        updateNode: updateClassDiagramClass,
        removeNode: removeClassDiagramClass,
        addEdge: addClassDiagramRelationship,
        updateEdge: updateClassDiagramRelationship,
        removeEdge: removeClassDiagramRelationship,
        nodeLabel: "class",
        edgeLabel: "relationship",
      };
    case "erDiagram":
      return {
        parse: parseErDiagram,
        addNode: addErEntity,
        updateNode: updateErEntity,
        removeNode: removeErEntity,
        addEdge: addErRelationship,
        updateEdge: updateErRelationship,
        removeEdge: removeErRelationship,
        nodeLabel: "entity",
        edgeLabel: "relationship",
      };
    case "stateDiagram":
      return {
        parse: parseStateDiagram,
        addNode: addStateDiagramState,
        updateNode: updateStateDiagramState,
        removeNode: removeStateDiagramState,
        addEdge: addStateDiagramTransition,
        updateEdge: updateStateDiagramTransition,
        removeEdge: removeStateDiagramTransition,
        nodeLabel: "state",
        edgeLabel: "transition",
      };
    case "sequenceDiagram":
      return {
        parse: parseSequenceDiagram,
        addNode: addSequenceParticipant,
        updateNode: updateSequenceParticipant,
        removeNode: removeSequenceParticipant,
        addEdge: addSequenceMessage,
        updateEdge: updateSequenceMessage,
        removeEdge: removeSequenceMessage,
        nodeLabel: "participant",
        edgeLabel: "message",
      };
    default:
      return null;
  }
}
