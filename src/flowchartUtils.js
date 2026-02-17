/* ── Flowchart Mermaid Code Parser & Mutator ───────────── */

const DIRECTION_RE = /^\s*(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\s*$/;
const FRONT_MATTER_RE = /^---[\s\S]*?---\s*/;

/* Shape delimiters → shape name lookup */
const SHAPE_TABLE = [
  { open: "(((", close: ")))", shape: "double-circle" },
  { open: "([", close: "])", shape: "stadium" },
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "((", close: "))", shape: "circle" },
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram-alt" },
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoid-alt" },
  { open: ">", close: "]", shape: "asymmetric" },
  { open: "{", close: "}", shape: "diamond" },
  { open: "(", close: ")", shape: "rounded" },
  { open: "[", close: "]", shape: "rect" },
];

const SHAPE_TO_DELIMITERS = {
  rect: ["[", "]"],
  rounded: ["(", ")"],
  stadium: ["([", "])"],
  diamond: ["{", "}"],
  circle: ["((", "))"],
  "double-circle": ["(((", ")))"],
  hexagon: ["{{", "}}"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
  parallelogram: ["[/", "/]"],
  "parallelogram-alt": ["[\\", "\\]"],
  trapezoid: ["[/", "\\]"],
  "trapezoid-alt": ["[\\", "/]"],
  asymmetric: [">", "]"],
};

/* v11.3.0+ shape name mappings: short name / alias → internal CSS shape name */
const V11_SHAPE_MAP = {
  // Direct mappings to existing classic shapes
  "rect": "rect", "proc": "rect", "process": "rect", "rectangle": "rect",
  "rounded": "rounded", "event": "rounded",
  "stadium": "stadium", "pill": "stadium", "terminal": "stadium",
  "diamond": "diamond", "diam": "diamond", "decision": "diamond", "question": "diamond",
  "circle": "circle", "circ": "circle",
  "dbl-circ": "double-circle", "double-circle": "double-circle",
  "hex": "hexagon", "hexagon": "hexagon", "prepare": "hexagon",
  "subproc": "subroutine", "subroutine": "subroutine", "subprocess": "subroutine",
  "fr-rect": "subroutine", "framed-rectangle": "subroutine",
  "cyl": "cylinder", "cylinder": "cylinder", "database": "cylinder", "db": "cylinder",
  "lean-r": "parallelogram", "lean-right": "parallelogram", "in-out": "parallelogram",
  "lean-l": "parallelogram-alt", "lean-left": "parallelogram-alt", "out-in": "parallelogram-alt",
  "trap-b": "trapezoid", "trapezoid": "trapezoid", "trapezoid-bottom": "trapezoid", "priority": "trapezoid",
  "trap-t": "trapezoid-alt", "trapezoid-top": "trapezoid-alt", "inv-trapezoid": "trapezoid-alt", "manual": "trapezoid-alt",
  "odd": "asymmetric",
  // New shapes requiring new CSS
  "doc": "document", "document": "document",
  "docs": "documents", "documents": "documents", "st-doc": "documents", "stacked-document": "documents",
  "notch-rect": "notched-rect", "card": "notched-rect", "notched-rectangle": "notched-rect",
  "cloud": "cloud",
  "bang": "bang",
  "bolt": "bolt", "com-link": "bolt", "lightning-bolt": "bolt",
  "brace-l": "brace-l", "comment": "brace-l", "brace": "brace-l",
  "brace-r": "brace-r",
  "braces": "braces",
  "tri": "triangle", "triangle": "triangle", "extract": "triangle",
  "flag": "flag", "paper-tape": "flag",
  "hourglass": "hourglass", "collate": "hourglass",
  "lin-rect": "lined-rect", "lin-proc": "lined-rect", "lined-rectangle": "lined-rect", "lined-process": "lined-rect", "shaded-process": "lined-rect",
  "sm-circ": "small-circle", "small-circle": "small-circle", "start": "small-circle",
  "fr-circ": "framed-circle", "framed-circle": "framed-circle", "stop": "framed-circle",
  "f-circ": "filled-circle", "filled-circle": "filled-circle", "junction": "filled-circle",
  "fork": "fork", "join": "fork",
  "text": "text-block",
  "delay": "delay", "half-rounded-rectangle": "delay",
  "h-cyl": "h-cylinder", "horizontal-cylinder": "h-cylinder", "das": "h-cylinder",
  "lin-cyl": "lined-cylinder", "lined-cylinder": "lined-cylinder", "disk": "lined-cylinder",
  "curv-trap": "curved-trapezoid", "curved-trapezoid": "curved-trapezoid", "display": "curved-trapezoid",
  "div-rect": "divided-rect", "divided-rectangle": "divided-rect", "div-proc": "divided-rect", "divided-process": "divided-rect",
  "flip-tri": "flipped-triangle", "flipped-triangle": "flipped-triangle", "manual-file": "flipped-triangle",
  "sl-rect": "sloped-rect", "sloped-rectangle": "sloped-rect", "manual-input": "sloped-rect",
  "win-pane": "window-pane", "window-pane": "window-pane", "internal-storage": "window-pane",
  "cross-circ": "crossed-circle", "crossed-circle": "crossed-circle", "summary": "crossed-circle",
  "lin-doc": "lined-document", "lined-document": "lined-document",
  "notch-pent": "notched-pentagon", "notched-pentagon": "notched-pentagon", "loop-limit": "notched-pentagon",
  "tag-doc": "tag-document", "tagged-document": "tag-document",
  "tag-rect": "tag-rect", "tag-proc": "tag-rect", "tagged-rectangle": "tag-rect", "tagged-process": "tag-rect",
  "bow-rect": "bow-rect", "bow-tie-rectangle": "bow-rect", "stored-data": "bow-rect",
  "st-rect": "stacked-rect", "stacked-rectangle": "stacked-rect", "processes": "stacked-rect", "procs": "stacked-rect",
};

/* Reverse mapping: internal CSS shape name → v11 short name (for code generation) */
const INTERNAL_TO_V11 = {};
for (const [k, v] of Object.entries(V11_SHAPE_MAP)) {
  if (!INTERNAL_TO_V11[v]) INTERNAL_TO_V11[v] = k;
}

function mapV11Shape(name) {
  return V11_SHAPE_MAP[name] || V11_SHAPE_MAP[name.toLowerCase()] || "rect";
}

/* Regex-based arrow matching (order matters: longer/more-specific first).
   Each entry has a regex to match, a canonical type, and a base length for minlen calculation. */
const ARROW_REGEX = /^(<={2,}>|<-\.{1,}->|<-{2,}>|o-{2,}o|x-{2,}x|={2,}>|-\.{1,}->|-{2,}o|-{2,}x|-{2,}>|-{3,}|-\.{1,}-|={3,}|~{3,})/;

function classifyArrow(raw) {
  if (raw.startsWith("<=") && raw.endsWith(">")) return { type: "<==>", minlen: raw.length - 3 };
  if (raw.startsWith("<-") && raw.endsWith(">") && raw.includes(".")) return { type: "<-.->", minlen: Math.max(1, raw.length - 4) };
  if (raw.startsWith("<-") && raw.endsWith(">")) return { type: "<-->", minlen: raw.length - 3 };
  if (raw.startsWith("o") && raw.endsWith("o")) return { type: "o--o", minlen: raw.length - 3 };
  if (raw.startsWith("x") && raw.endsWith("x")) return { type: "x--x", minlen: raw.length - 3 };
  if (raw.startsWith("=") && raw.endsWith(">")) return { type: "==>", minlen: raw.length - 2 };
  if (raw.startsWith("-") && raw.includes(".") && raw.endsWith(">")) return { type: "-.->", minlen: Math.max(1, raw.length - 3) };
  if (raw.startsWith("-") && raw.endsWith("o")) return { type: "--o", minlen: raw.length - 2 };
  if (raw.startsWith("-") && raw.endsWith("x")) return { type: "--x", minlen: raw.length - 2 };
  if (raw.startsWith("-") && raw.endsWith(">")) return { type: "-->", minlen: raw.length - 2 };
  if (raw.startsWith("-") && raw.includes(".")) return { type: "-.-", minlen: Math.max(1, raw.length - 2) };
  if (raw.startsWith("-")) return { type: "---", minlen: raw.length - 2 };
  if (raw.startsWith("=")) return { type: "===", minlen: raw.length - 2 };
  if (raw.startsWith("~")) return { type: "~~~", minlen: 1 };
  return { type: raw, minlen: 1 };
}

/* Legacy static list for backwards compat with simple startsWith checks */
const ARROW_PATTERNS = [
  { pattern: "<==>", type: "<==>" },
  { pattern: "<-.->", type: "<-.->" },
  { pattern: "<-->", type: "<-->" },
  { pattern: "o--o", type: "o--o" },
  { pattern: "x--x", type: "x--x" },
  { pattern: "==>", type: "==>" },
  { pattern: "-.->", type: "-.->" },
  { pattern: "--o", type: "--o" },
  { pattern: "--x", type: "--x" },
  { pattern: "--->", type: "--->" },
  { pattern: "-->", type: "-->" },
  { pattern: "---", type: "---" },
  { pattern: "-.-", type: "-.-" },
  { pattern: "===", type: "===" },
  { pattern: "~~~", type: "~~~" },
];

/* ── Helpers ─────────────────────────────────────────────── */

function isDirectiveLine(trimmed) {
  return (
    !trimmed ||
    /^\s*(?:flowchart|graph)\s/i.test(trimmed) ||
    trimmed.startsWith("%%") ||
    trimmed === "end" ||
    trimmed.startsWith("classDef ") ||
    trimmed.startsWith("class ") ||
    trimmed.startsWith("click ") ||
    trimmed.startsWith("style ") ||
    trimmed.startsWith("linkStyle ") ||
    trimmed.startsWith("direction ") ||
    /^---/.test(trimmed) ||
    /^\s*subgraph\s/.test(trimmed)
  );
}

/**
 * Extract the node shape from text following a node ID.
 * Returns { label, shape, shapeOpen, shapeClose, endIndex } or null.
 */
function extractNodeShape(text, startIndex) {
  const remaining = text.slice(startIndex);

  for (const { open, close, shape } of SHAPE_TABLE) {
    if (!remaining.startsWith(open)) continue;

    const inner = remaining.slice(open.length);
    // Handle quoted labels: ["label"] or ['label']
    let label = "";
    let closeIdx = -1;

    if (inner.startsWith('"') || inner.startsWith("'")) {
      const quote = inner[0];
      const endQuote = inner.indexOf(quote, 1);
      if (endQuote < 0) continue;
      label = inner.slice(1, endQuote);
      const afterQuote = inner.slice(endQuote + 1);
      if (!afterQuote.startsWith(close)) continue;
      closeIdx = startIndex + open.length + endQuote + 1 + close.length;
    } else {
      const idx = inner.indexOf(close);
      if (idx < 0) continue;
      label = inner.slice(0, idx);
      closeIdx = startIndex + open.length + idx + close.length;
    }

    return { label: label.trim(), shape, shapeOpen: open, shapeClose: close, endIndex: closeIdx };
  }
  return null;
}

/**
 * Extract the @{ shape: xxx } annotation from a line.
 */
function extractShapeAnnotation(line) {
  const match = line.match(/@\{\s*shape:\s*(\w+)\s*\}/);
  if (match) return match[1];
  return null;
}

/* ── Parsing ─────────────────────────────────────────────── */

/**
 * Parse Mermaid flowchart code into structured data.
 * @param {string} code - The Mermaid source code
 * @returns {{ direction: string, nodes: Array, edges: Array, subgraphs: Array }}
 */
export function parseFlowchart(code) {
  // Strip front matter
  const cleaned = code.replace(FRONT_MATTER_RE, "");
  const lines = cleaned.split("\n");

  let direction = "TD";
  const nodesMap = new Map(); // id → node object
  const edges = [];
  const subgraphs = [];
  const subgraphStack = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const trimmed = rawLine.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("%%")) continue;

    // Direction line
    const dirMatch = trimmed.match(DIRECTION_RE);
    if (dirMatch) {
      direction = dirMatch[1];
      continue;
    }

    // Front matter boundaries
    if (trimmed === "---") continue;
    if (/^config:/.test(trimmed) || /^layout:/.test(trimmed)) continue;

    // Subgraph open
    const subgraphMatch = trimmed.match(/^subgraph\s+(\S+)(?:\s*\[([^\]]*)\])?\s*$/);
    if (subgraphMatch) {
      const sg = {
        id: subgraphMatch[1],
        label: subgraphMatch[2] || subgraphMatch[1],
        lineIndex,
        endLineIndex: -1,
      };
      subgraphs.push(sg);
      subgraphStack.push(sg);
      continue;
    }

    // Subgraph close
    if (trimmed === "end") {
      const open = subgraphStack.pop();
      if (open) open.endLineIndex = lineIndex;
      continue;
    }

    // Skip directive lines
    if (
      trimmed.startsWith("classDef ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("click ") ||
      trimmed.startsWith("style ") ||
      trimmed.startsWith("linkStyle ") ||
      trimmed.startsWith("direction ")
    ) {
      continue;
    }

    // Handle @{shape:, label:} annotation lines (v11.3.0+ syntax)
    const annotationMatch = trimmed.match(/^(\w+)@\{\s*(.+?)\s*\}$/);
    if (annotationMatch) {
      const nodeId = annotationMatch[1];
      const body = annotationMatch[2];
      const shapeMatch = body.match(/shape:\s*([\w-]+)/);
      const labelMatch = body.match(/label:\s*"([^"]*)"/);
      const mappedShape = shapeMatch ? mapV11Shape(shapeMatch[1]) : null;
      if (nodesMap.has(nodeId)) {
        const existing = nodesMap.get(nodeId);
        if (mappedShape) existing.shape = mappedShape;
        if (labelMatch) existing.label = labelMatch[1];
      } else {
        nodesMap.set(nodeId, {
          id: nodeId,
          label: labelMatch ? labelMatch[1] : nodeId,
          shape: mappedShape || "rect",
          shapeOpen: "[", shapeClose: "]",
          lineIndex, rawLine,
        });
      }
      continue;
    }

    // Parse nodes and edges from this line
    parseLineContent(trimmed, lineIndex, rawLine, nodesMap, edges);
  }

  return {
    direction,
    nodes: Array.from(nodesMap.values()),
    edges,
    subgraphs,
  };
}

/**
 * Parse a single line for node declarations and edges.
 */
function parseLineContent(trimmed, lineIndex, rawLine, nodesMap, edges) {
  // Tokenise: split into node references and arrows
  // A node reference is: ID + optional shape (e.g., A["Label"])
  // An arrow is: -->, ---, -.->, ==>, etc., optionally with |label|

  let pos = 0;
  const tokens = []; // { type: "node", id, label?, shape? } or { type: "arrow", arrowType, label? }

  while (pos < trimmed.length) {
    // Skip whitespace
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos >= trimmed.length) break;

    // Check for arrows (must check before node IDs since arrows can start with -)
    let foundArrow = false;

    // Handle arrows with inline labels: -- text --> or -- text ---
    const inlineLabelMatch = trimmed.slice(pos).match(/^--\s+([^-][^>]*?)\s+(-{2,}>|-{3,})/);
    if (inlineLabelMatch) {
      const { type: ilType, minlen: ilMinlen } = classifyArrow(inlineLabelMatch[2]);
      tokens.push({ type: "arrow", arrowType: ilType, label: inlineLabelMatch[1].trim(), minlen: ilMinlen });
      pos += inlineLabelMatch[0].length;
      foundArrow = true;
    }

    if (!foundArrow) {
      const arrowMatch = trimmed.slice(pos).match(ARROW_REGEX);
      if (arrowMatch) {
        const raw = arrowMatch[1];
        const { type: arrowType, minlen } = classifyArrow(raw);
        let label = "";
        const afterArrow = pos + raw.length;
        // Check for |label| after arrow
        if (trimmed[afterArrow] === "|") {
          const labelEnd = trimmed.indexOf("|", afterArrow + 1);
          if (labelEnd > afterArrow) {
            label = trimmed.slice(afterArrow + 1, labelEnd).trim();
            pos = labelEnd + 1;
          } else {
            pos = afterArrow;
          }
        } else {
          pos = afterArrow;
        }
        tokens.push({ type: "arrow", arrowType, label, minlen });
        foundArrow = true;
      }
    }

    if (foundArrow) continue;

    // Check for & (parallel connections)
    if (trimmed[pos] === "&") {
      pos++;
      continue;
    }

    // Try to parse a node reference: ID with optional shape
    const idMatch = trimmed.slice(pos).match(/^([A-Za-z_\u00C0-\u024F][\w\u00C0-\u024F]*)/);
    if (idMatch) {
      const id = idMatch[1];
      pos += id.length;

      // Try to extract shape
      const shapeInfo = extractNodeShape(trimmed, pos);
      if (shapeInfo) {
        pos = shapeInfo.endIndex;
        const node = {
          id,
          label: shapeInfo.label,
          shape: shapeInfo.shape,
          shapeOpen: shapeInfo.shapeOpen,
          shapeClose: shapeInfo.shapeClose,
          lineIndex,
          rawLine,
        };
        if (!nodesMap.has(id)) nodesMap.set(id, node);
        tokens.push({ type: "node", id });
      } else {
        // Node reference without shape (just ID) - might be defined elsewhere
        if (!nodesMap.has(id)) {
          nodesMap.set(id, {
            id,
            label: id,
            shape: "rect",
            shapeOpen: "[",
            shapeClose: "]",
            lineIndex,
            rawLine,
          });
        }
        tokens.push({ type: "node", id });
      }
    } else {
      // Skip unrecognised character
      pos++;
    }
  }

  // Extract edges from token sequence: node arrow node
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === "arrow") {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      if (prev?.type === "node" && next?.type === "node") {
        edges.push({
          source: prev.id,
          target: next.id,
          label: tokens[i].label || "",
          arrowType: tokens[i].arrowType,
          minlen: tokens[i].minlen || 1,
          lineIndex,
          rawLine,
        });
      }
    }
  }
}

/**
 * Scan a line and return node token ranges with source offsets.
 * This lets us replace exact node references without fragile regexes.
 */
function findNodeTokenRanges(line) {
  let pos = 0;
  const ranges = [];

  while (pos < line.length) {
    while (pos < line.length && /\s/.test(line[pos])) pos++;
    if (pos >= line.length) break;

    // Handle arrows with inline labels: -- text --> or -- text ---
    const inlineLabelMatch = line.slice(pos).match(/^--\s+([^-][^>]*?)\s+(-->|---)/);
    if (inlineLabelMatch) {
      pos += inlineLabelMatch[0].length;
      continue;
    }

    // Handle plain arrow patterns
    let matchedArrow = false;
    for (const { pattern } of ARROW_PATTERNS) {
      if (line.slice(pos).startsWith(pattern)) {
        pos += pattern.length;
        // Optional |label|
        if (line[pos] === "|") {
          const labelEnd = line.indexOf("|", pos + 1);
          pos = labelEnd > pos ? labelEnd + 1 : pos + 1;
        }
        matchedArrow = true;
        break;
      }
    }
    if (matchedArrow) continue;

    if (line[pos] === "&") {
      pos++;
      continue;
    }

    const idMatch = line.slice(pos).match(/^([A-Za-z_\u00C0-\u024F][\w\u00C0-\u024F]*)/);
    if (!idMatch) {
      pos++;
      continue;
    }

    const id = idMatch[1];
    const start = pos;
    pos += id.length;
    const shapeInfo = extractNodeShape(line, pos);
    if (shapeInfo) {
      ranges.push({ id, start, end: shapeInfo.endIndex, hasShape: true });
      pos = shapeInfo.endIndex;
    } else {
      ranges.push({ id, start, end: pos, hasShape: false });
    }
  }

  return ranges;
}

/**
 * Scan a line and return node/arrow tokens with source offsets.
 * Used for robust edge updates without regex reconstruction.
 */
function findFlowTokensWithRanges(line) {
  let pos = 0;
  const tokens = [];

  while (pos < line.length) {
    while (pos < line.length && /\s/.test(line[pos])) pos++;
    if (pos >= line.length) break;

    const arrowStart = pos;
    const inlineLabelMatch = line.slice(pos).match(/^--\s+([^-][^>]*?)\s+(-->|---)/);
    if (inlineLabelMatch) {
      pos += inlineLabelMatch[0].length;
      tokens.push({
        type: "arrow",
        arrowType: inlineLabelMatch[2],
        label: inlineLabelMatch[1].trim(),
        start: arrowStart,
        end: pos,
      });
      continue;
    }

    let matchedArrow = false;
    for (const { pattern, type } of ARROW_PATTERNS) {
      if (!line.slice(pos).startsWith(pattern)) continue;
      pos += pattern.length;
      let label = "";
      if (line[pos] === "|") {
        const labelEnd = line.indexOf("|", pos + 1);
        if (labelEnd > pos) {
          label = line.slice(pos + 1, labelEnd).trim();
          pos = labelEnd + 1;
        } else {
          pos += 1;
        }
      }
      tokens.push({ type: "arrow", arrowType: type, label, start: arrowStart, end: pos });
      matchedArrow = true;
      break;
    }
    if (matchedArrow) continue;

    if (line[pos] === "&") {
      pos++;
      continue;
    }

    const idMatch = line.slice(pos).match(/^([A-Za-z_\u00C0-\u024F][\w\u00C0-\u024F]*)/);
    if (!idMatch) {
      pos++;
      continue;
    }

    const id = idMatch[1];
    const nodeStart = pos;
    pos += id.length;
    const shapeInfo = extractNodeShape(line, pos);
    if (shapeInfo) {
      pos = shapeInfo.endIndex;
      tokens.push({ type: "node", id, start: nodeStart, end: pos });
    } else {
      tokens.push({ type: "node", id, start: nodeStart, end: pos });
    }
  }

  return tokens;
}

function findEdgeTokenRanges(line) {
  const tokens = findFlowTokensWithRanges(line);
  const edges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "arrow") continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev?.type !== "node" || next?.type !== "node") continue;
    edges.push({
      source: prev.id,
      target: next.id,
      arrowType: tokens[i].arrowType,
      label: tokens[i].label || "",
      sourceRange: prev,
      targetRange: next,
      start: prev.start,
      end: next.end,
    });
  }
  return edges;
}

/* ── Find ────────────────────────────────────────────────── */

export function findNodeById(nodes, id) {
  return nodes.find((n) => n.id === id) || null;
}

export function findEdge(edges, source, target) {
  return edges.find((e) => e.source === source && e.target === target) || null;
}

/* ── Mutations ───────────────────────────────────────────── */

/**
 * Generate a unique node ID that doesn't conflict with existing ones.
 */
export function generateNodeId(existingNodes) {
  const existing = new Set(existingNodes.map((n) => n.id));
  // Try N1, N2, N3, ...
  for (let i = 1; i < 1000; i++) {
    const id = `N${i}`;
    if (!existing.has(id)) return id;
  }
  return `N${Date.now()}`;
}

/**
 * Add a new node to the flowchart code.
 */
export function addFlowchartNode(code, { id, label, shape = "rect" }) {
  const delimiters = SHAPE_TO_DELIMITERS[shape];
  let nodeLine;
  if (delimiters) {
    nodeLine = `    ${id}${delimiters[0]}"${label}"${delimiters[1]}`;
  } else {
    // v11 shape — use @{shape:} annotation syntax
    const v11Name = INTERNAL_TO_V11[shape] || shape;
    nodeLine = `    ${id}["${label}"]\n    ${id}@{ shape: ${v11Name}, label: "${label}" }`;
  }

  const lines = code.split("\n");
  // Find last non-empty, non-directive line to insert after
  let insertIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t && !t.startsWith("classDef ") && !t.startsWith("class ") && !t.startsWith("style ") && !t.startsWith("linkStyle ")) {
      insertIdx = i + 1;
      break;
    }
  }

  lines.splice(insertIdx, 0, nodeLine);
  return lines.join("\n");
}

/**
 * Remove a node and all its connected edges from the code.
 */
export function removeFlowchartNode(code, nodeId) {
  const lines = code.split("\n");
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip empty lines and directives - keep them
    if (!trimmed || trimmed.startsWith("%%") || /^\s*(?:flowchart|graph)\s/i.test(trimmed) ||
        trimmed === "end" || trimmed.startsWith("subgraph ") ||
        trimmed.startsWith("classDef ") || trimmed.startsWith("style ") ||
        trimmed.startsWith("linkStyle ") || trimmed === "---" ||
        /^config:/.test(trimmed) || /^layout:/.test(trimmed)) {
      result.push(lines[i]);
      continue;
    }

    // Check if this line contains the node or edges connected to it
    // Parse to see if the nodeId appears
    if (lineReferencesNode(trimmed, nodeId)) {
      // Try to remove just the parts that reference this node
      const cleaned = removeNodeFromLine(trimmed, nodeId);
      if (cleaned && cleaned.trim()) {
        // Preserve original indentation
        const indent = lines[i].match(/^(\s*)/)[1];
        result.push(indent + cleaned.trim());
      }
      // If cleaned is empty, skip the line entirely
    } else {
      result.push(lines[i]);
    }
  }

  return result.join("\n");
}

/**
 * Check if a line references a specific node ID.
 */
function lineReferencesNode(line, nodeId) {
  const trimmed = line.trim();
  if (!trimmed || isDirectiveLine(trimmed)) return false;
  const nodesMap = new Map();
  const edges = [];
  parseLineContent(trimmed, 0, line, nodesMap, edges);
  if (nodesMap.has(nodeId)) return true;
  return edges.some((edge) => edge.source === nodeId || edge.target === nodeId);
}

/**
 * Remove references to a node from a single line.
 * Returns empty string if the entire line should be removed.
 */
function removeNodeFromLine(line, nodeId) {
  const nodesMap = new Map();
  const edges = [];
  parseLineContent(line.trim(), 0, line, nodesMap, edges);

  // If this line is ONLY a node declaration (no edges), remove it
  if (edges.length === 0 && nodesMap.has(nodeId)) {
    // Check if there are other nodes on this line
    if (nodesMap.size === 1) return "";
    // Multiple nodes but no edges - just remove this node's declaration
    // This is unusual in practice
    return "";
  }

  // If there are edges, remove edges connected to nodeId
  const remainingEdges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  if (remainingEdges.length === 0) return "";

  // Reconstruct the line from remaining edges
  // This is a simplified reconstruction - preserves basic edge syntax
  const parts = [];
  for (const e of remainingEdges) {
    const srcNode = nodesMap.get(e.source);
    const tgtNode = nodesMap.get(e.target);
    const srcStr = srcNode && srcNode.shape !== "rect" ? `${e.source}${srcNode.shapeOpen}${JSON.stringify(srcNode.label).slice(1, -1)}${srcNode.shapeClose}` : e.source;
    const tgtStr = tgtNode && tgtNode.shape !== "rect" ? `${e.target}${tgtNode.shapeOpen}${JSON.stringify(tgtNode.label).slice(1, -1)}${tgtNode.shapeClose}` : e.target;
    const labelPart = e.label ? `|${e.label}|` : "";
    parts.push(`${srcStr} ${e.arrowType}${labelPart} ${tgtStr}`);
  }
  return parts.join("\n    ");
}

/**
 * Update a node's label or shape in the code.
 */
export function updateFlowchartNode(code, nodeId, updates) {
  const { nodes } = parseFlowchart(code);
  const node = findNodeById(nodes, nodeId);
  if (!node) return code;

  const lines = code.split("\n");
  const newLabel = updates.label !== undefined ? updates.label : node.label;
  const newShape = updates.shape !== undefined ? updates.shape : node.shape;
  const delimiters = SHAPE_TO_DELIMITERS[newShape];
  const escapedLabel = String(newLabel).replace(/"/g, '\\"');
  const isV11Shape = !delimiters;
  const replacement = delimiters
    ? `${nodeId}${delimiters[0]}"${escapedLabel}"${delimiters[1]}`
    : `${nodeId}["${escapedLabel}"]`;

  // Helper: manage @{shape:} annotation lines for v11 shapes
  const manageAnnotation = (linesArr) => {
    // Remove any existing annotation for this node
    for (let i = linesArr.length - 1; i >= 0; i--) {
      if (new RegExp(`^\\s*${nodeId}@\\{`).test(linesArr[i])) {
        linesArr.splice(i, 1);
      }
    }
    // Add annotation if this is a v11-only shape
    if (isV11Shape) {
      const v11Name = INTERNAL_TO_V11[newShape] || newShape;
      let insertAt = linesArr.length;
      for (let i = linesArr.length - 1; i >= 0; i--) {
        const t = linesArr[i].trim();
        if (t && !t.startsWith("classDef ") && !t.startsWith("class ") && !t.startsWith("style ") && !t.startsWith("linkStyle ")) {
          insertAt = i + 1;
          break;
        }
      }
      linesArr.splice(insertAt, 0, `    ${nodeId}@{ shape: ${v11Name}, label: "${escapedLabel}" }`);
    }
  };

  let fallbackBareRef = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (isDirectiveLine(trimmed)) continue;
    // Skip annotation lines during node search
    if (/^\w+@\{/.test(trimmed)) continue;

    const ranges = findNodeTokenRanges(lines[i]);
    const explicit = ranges.find((r) => r.id === nodeId && r.hasShape);
    if (explicit) {
      lines[i] = lines[i].slice(0, explicit.start) + replacement + lines[i].slice(explicit.end);
      manageAnnotation(lines);
      return lines.join("\n");
    }
    if (!fallbackBareRef) {
      const bare = ranges.find((r) => r.id === nodeId);
      if (bare) fallbackBareRef = { lineIndex: i, range: bare };
    }
  }

  if (fallbackBareRef) {
    const { lineIndex, range } = fallbackBareRef;
    lines[lineIndex] =
      lines[lineIndex].slice(0, range.start) + replacement + lines[lineIndex].slice(range.end);
    manageAnnotation(lines);
    return lines.join("\n");
  }

  // If the node isn't directly declared in a mutatable line, append a declaration.
  const nodeLine = `    ${replacement}`;
  let insertIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (
      t &&
      !t.startsWith("classDef ") &&
      !t.startsWith("class ") &&
      !t.startsWith("style ") &&
      !t.startsWith("linkStyle ")
    ) {
      insertIdx = i + 1;
      break;
    }
  }
  lines.splice(insertIdx, 0, nodeLine);
  manageAnnotation(lines);
  return lines.join("\n");
}

/**
 * Add an edge between two nodes.
 */
export function addFlowchartEdge(code, { source, target, label = "", arrowType = "-->" }) {
  const labelPart = label ? `|${label}|` : "";
  const edgeLine = `    ${source} ${arrowType}${labelPart} ${target}`;

  const lines = code.split("\n");
  // Insert before style/class definitions, or at end
  let insertIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t && !t.startsWith("classDef ") && !t.startsWith("class ") &&
        !t.startsWith("style ") && !t.startsWith("linkStyle ") &&
        !/^[\w]+@\{/.test(t)) {
      insertIdx = i + 1;
      break;
    }
  }

  lines.splice(insertIdx, 0, edgeLine);
  return lines.join("\n");
}

/**
 * Remove an edge from the code.
 */
export function removeFlowchartEdge(code, source, target) {
  const lines = code.split("\n");
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Parse line for edges
    const nodesMap = new Map();
    const lineEdges = [];
    if (trimmed && !isDirectiveLine(trimmed)) {
      parseLineContent(trimmed, 0, lines[i], nodesMap, lineEdges);
    }

    // Check if this line contains the target edge
    const hasTargetEdge = lineEdges.some((e) => e.source === source && e.target === target);
    if (!hasTargetEdge) {
      result.push(lines[i]);
      continue;
    }

    // Remove just this edge, keep others on the same line
    const remainingEdges = lineEdges.filter((e) => !(e.source === source && e.target === target));
    if (remainingEdges.length === 0) {
      // Check if there are standalone node declarations on this line
      const hasNodeDecl = Array.from(nodesMap.values()).some((n) =>
        !lineEdges.some((e) => e.source === n.id || e.target === n.id)
      );
      if (!hasNodeDecl) continue; // Drop the entire line
    }

    // Reconstruct from remaining edges
    const indent = lines[i].match(/^(\s*)/)[1];
    const parts = [];
    for (const e of remainingEdges) {
      const labelPart = e.label ? `|${e.label}|` : "";
      parts.push(`${e.source} ${e.arrowType}${labelPart} ${e.target}`);
    }
    if (parts.length) {
      result.push(indent + parts.join("\n" + indent));
    }
  }

  return result.join("\n");
}

/**
 * Update an edge's label or arrow type.
 */
export function updateFlowchartEdge(code, source, target, updates) {
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || isDirectiveLine(trimmed)) continue;
    const edgeRanges = findEdgeTokenRanges(lines[i]);
    const edgeMatch = edgeRanges.find((e) => e.source === source && e.target === target);
    if (!edgeMatch) continue;

    const newArrow = updates.arrowType || edgeMatch.arrowType;
    const newLabel = updates.label !== undefined ? updates.label : edgeMatch.label;
    const labelPart = newLabel ? `|${newLabel}|` : "";
    const sourceRef = lines[i].slice(edgeMatch.sourceRange.start, edgeMatch.sourceRange.end);
    const targetRef = lines[i].slice(edgeMatch.targetRange.start, edgeMatch.targetRange.end);
    const updatedSegment = `${sourceRef} ${newArrow}${labelPart} ${targetRef}`;
    lines[i] = lines[i].slice(0, edgeMatch.start) + updatedSegment + lines[i].slice(edgeMatch.end);
    return lines.join("\n");
  }

  return code;
}

/**
 * Parse classDef directives from flowchart code.
 * Returns array of { name, fill, stroke, color, strokeDasharray, raw, lineIndex }.
 */
export function parseClassDefs(code) {
  const result = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(/^classDef\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const name = m[1];
    const raw = m[2];
    const style = { name, raw, lineIndex: i };
    const fillMatch = raw.match(/fill:\s*([^,;]+)/);
    if (fillMatch) style.fill = fillMatch[1].trim();
    const strokeMatch = raw.match(/stroke:\s*([^,;]+)/);
    if (strokeMatch) style.stroke = strokeMatch[1].trim();
    const colorMatch = raw.match(/(?:^|,)\s*color:\s*([^,;]+)/);
    if (colorMatch) style.color = colorMatch[1].trim();
    const dashMatch = raw.match(/stroke-dasharray:\s*([^,;]+)/);
    if (dashMatch) style.strokeDasharray = dashMatch[1].trim();
    const widthMatch = raw.match(/stroke-width:\s*([^,;]+)/);
    if (widthMatch) style.strokeWidth = widthMatch[1].trim();
    result.push(style);
  }
  return result;
}

/**
 * Parse per-node style directives.
 * Lines: "style nodeId prop1:val1,prop2:val2,..."
 * Returns { nodeId: { fill, stroke, color, strokeWidth, strokeDasharray } }
 */
export function parseStyleDirectives(code) {
  const result = {};
  const lines = code.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^style\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const nodeId = m[1];
    const raw = m[2];
    const style = {};
    const fillMatch = raw.match(/fill:\s*([^,;]+)/);
    if (fillMatch) style.fill = fillMatch[1].trim();
    const strokeMatch = raw.match(/stroke:\s*([^,;]+)/);
    if (strokeMatch) style.stroke = strokeMatch[1].trim();
    const colorMatch = raw.match(/(?:^|,)\s*color:\s*([^,;]+)/);
    if (colorMatch) style.color = colorMatch[1].trim();
    const dashMatch = raw.match(/stroke-dasharray:\s*([^,;]+)/);
    if (dashMatch) style.strokeDasharray = dashMatch[1].trim();
    const widthMatch = raw.match(/stroke-width:\s*([^,;]+)/);
    if (widthMatch) style.strokeWidth = widthMatch[1].trim();
    result[nodeId] = style;
  }
  return result;
}

/**
 * Parse class assignments: "class A,B myClass" and inline :::className syntax.
 * Returns { nodeId: className } mapping.
 */
export function parseClassAssignments(code) {
  const result = {};
  const lines = code.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^class\s+(\S+)\s+(\S+)$/);
    if (m) {
      const nodeIds = m[1].split(",").map(s => s.trim());
      const className = m[2];
      for (const id of nodeIds) {
        if (id) result[id] = className;
      }
    }
    const inlineMatches = trimmed.matchAll(/(\w+)(?:\[.*?\]|\(.*?\)|\{.*?\})?\s*:::(\w+)/g);
    for (const im of inlineMatches) {
      result[im[1]] = im[2];
    }
  }
  return result;
}

/* ── Subgraph Mutation Functions ──────────────────────── */

/**
 * Find which subgraph a node belongs to (by line index range).
 * Returns the subgraph id, or null if the node is at the top level.
 */
export function findNodeSubgraph(code, nodeId) {
  const parsed = parseFlowchart(code);
  const node = parsed.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  for (const sg of parsed.subgraphs) {
    if (sg.endLineIndex < 0) continue;
    if (node.lineIndex > sg.lineIndex && node.lineIndex < sg.endLineIndex) {
      return sg.id;
    }
  }
  return null;
}

/**
 * Move a node's declaration line into a target subgraph (before its `end` line).
 */
export function moveNodeToSubgraph(code, nodeId, subgraphId) {
  const parsed = parseFlowchart(code);
  const node = parsed.nodes.find((n) => n.id === nodeId);
  const sg = parsed.subgraphs.find((s) => s.id === subgraphId);
  if (!node || !sg || sg.endLineIndex < 0) return code;

  const lines = code.split("\n");
  const nodeLine = lines[node.lineIndex];
  lines.splice(node.lineIndex, 1);
  const newEndIdx = node.lineIndex < sg.endLineIndex ? sg.endLineIndex - 1 : sg.endLineIndex;
  const indented = "    " + nodeLine.trim();
  lines.splice(newEndIdx, 0, indented);
  return lines.join("\n");
}

/**
 * Move a node's declaration line out of its parent subgraph to the top level.
 */
export function moveNodeOutOfSubgraph(code, nodeId) {
  const parsed = parseFlowchart(code);
  const node = parsed.nodes.find((n) => n.id === nodeId);
  if (!node) return code;
  const parentSg = parsed.subgraphs.find(
    (sg) => sg.endLineIndex >= 0 && node.lineIndex > sg.lineIndex && node.lineIndex < sg.endLineIndex
  );
  if (!parentSg) return code;

  const lines = code.split("\n");
  const nodeLine = lines[node.lineIndex];
  lines.splice(node.lineIndex, 1);
  const insertIdx = node.lineIndex < parentSg.endLineIndex ? parentSg.endLineIndex : parentSg.endLineIndex + 1;
  lines.splice(insertIdx, 0, "    " + nodeLine.trim());
  return lines.join("\n");
}

/**
 * Wrap selected nodes' declaration lines in a new subgraph block.
 */
export function createSubgraph(code, nodeIds, label) {
  const parsed = parseFlowchart(code);
  const lines = code.split("\n");
  const nodeLines = parsed.nodes
    .filter((n) => nodeIds.includes(n.id))
    .map((n) => n.lineIndex)
    .sort((a, b) => a - b);
  if (nodeLines.length === 0) return code;

  const existingIds = new Set(parsed.subgraphs.map((s) => s.id));
  let sgId = label.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "group";
  let counter = 2;
  while (existingIds.has(sgId)) {
    sgId = label.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() + counter;
    counter++;
  }

  const extractedLines = [];
  for (let i = nodeLines.length - 1; i >= 0; i--) {
    extractedLines.unshift("      " + lines[nodeLines[i]].trim());
    lines.splice(nodeLines[i], 1);
  }

  const insertIdx = Math.min(nodeLines[0], lines.length);
  const subgraphBlock = [
    `    subgraph ${sgId} [${label}]`,
    ...extractedLines,
    `    end`,
  ];
  lines.splice(insertIdx, 0, ...subgraphBlock);
  return lines.join("\n");
}

/**
 * Remove a subgraph wrapper (keep contents at top level).
 */
export function removeSubgraph(code, subgraphId) {
  const parsed = parseFlowchart(code);
  const sg = parsed.subgraphs.find((s) => s.id === subgraphId);
  if (!sg || sg.endLineIndex < 0) return code;

  const lines = code.split("\n");
  lines.splice(sg.endLineIndex, 1);
  lines.splice(sg.lineIndex, 1);
  for (let i = sg.lineIndex; i < sg.endLineIndex - 1 && i < lines.length; i++) {
    lines[i] = lines[i].replace(/^    /, "");
  }
  return lines.join("\n");
}

/**
 * Rename a subgraph's label.
 */
export function renameSubgraph(code, subgraphId, newLabel) {
  const parsed = parseFlowchart(code);
  const sg = parsed.subgraphs.find((s) => s.id === subgraphId);
  if (!sg) return code;

  const lines = code.split("\n");
  lines[sg.lineIndex] = lines[sg.lineIndex].replace(
    /^(\s*subgraph\s+\S+)(?:\s*\[.*?\])?\s*$/,
    `$1 [${newLabel}]`
  );
  return lines.join("\n");
}
