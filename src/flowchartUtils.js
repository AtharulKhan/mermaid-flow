/* ── Flowchart Mermaid Code Parser & Mutator ───────────── */

const DIRECTION_RE = /^\s*(?:flowchart|graph)\s+(LR|RL|TD|TB|BT)\s*$/;
const FRONT_MATTER_RE = /^---[\s\S]*?---\s*/;

/* Shape delimiters → shape name lookup */
const SHAPE_TABLE = [
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
  hexagon: ["{{", "}}"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
  parallelogram: ["[/", "/]"],
  "parallelogram-alt": ["[\\", "\\]"],
  trapezoid: ["[/", "\\]"],
  "trapezoid-alt": ["[\\", "/]"],
  asymmetric: [">", "]"],
};

/* Arrow types we recognise */
const ARROW_PATTERNS = [
  { pattern: "==>", type: "==>" },
  { pattern: "-.->", type: "-.->" },
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

    // Skip @{shape:} annotation lines
    if (/^\w+@\{/.test(trimmed)) continue;

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
    const inlineLabelMatch = trimmed.slice(pos).match(/^--\s+([^-][^>]*?)\s+(-->|---)/);
    if (inlineLabelMatch) {
      tokens.push({ type: "arrow", arrowType: inlineLabelMatch[2], label: inlineLabelMatch[1].trim() });
      pos += inlineLabelMatch[0].length;
      foundArrow = true;
    }

    if (!foundArrow) {
      for (const { pattern, type } of ARROW_PATTERNS) {
        if (trimmed.slice(pos).startsWith(pattern)) {
          let label = "";
          const afterArrow = pos + pattern.length;
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
          tokens.push({ type: "arrow", arrowType: type, label });
          foundArrow = true;
          break;
        }
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
          lineIndex,
          rawLine,
        });
      }
    }
  }
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
  const delimiters = SHAPE_TO_DELIMITERS[shape] || SHAPE_TO_DELIMITERS.rect;
  const nodeLine = `    ${id}${delimiters[0]}"${label}"${delimiters[1]}`;

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
  // Match nodeId as a word boundary - could be a node declaration or edge endpoint
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[\\s&])${escaped}(?:\\s*[\\[({<>]|\\s*-->|\\s*---|\\s*-\\.->|\\s*==>|\\s*$|\\s+)`, "");
  return re.test(line) || new RegExp(`-->\\s*${escaped}(?:\\s|$|[\\[({])`, "").test(line) ||
         new RegExp(`---\\s*${escaped}(?:\\s|$|[\\[({])`, "").test(line) ||
         new RegExp(`==>\\s*${escaped}(?:\\s|$|[\\[({])`, "").test(line) ||
         new RegExp(`-\\.->\\s*${escaped}(?:\\s|$|[\\[({])`, "").test(line);
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
  const delimiters = SHAPE_TO_DELIMITERS[newShape] || SHAPE_TO_DELIMITERS.rect;

  // Find and replace the node declaration in the code
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: nodeId followed by shape delimiters
  const nodePattern = new RegExp(
    `(${escaped})\\s*(?:\\([\\[({]|\\[[\\/\\[({]|\\{\\{|\\{|>|\\(\\(|\\()(?:["\\'](.*?)["\\']|[^\\]})\\)>]*)(?:\\]\\)|\\]\\]|\\)\\]|\\)\\)|\\}\\}|\\}|\\]|\\)|\\\\\\]|\\/\\])`,
    ""
  );

  for (let i = 0; i < lines.length; i++) {
    if (nodePattern.test(lines[i])) {
      lines[i] = lines[i].replace(nodePattern, `$1${delimiters[0]}"${newLabel}"${delimiters[1]}`);
      break;
    }
  }

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
  const escaped_src = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escaped_tgt = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (let i = 0; i < lines.length; i++) {
    // Check if this line contains the edge
    const nodesMap = new Map();
    const lineEdges = [];
    const trimmed = lines[i].trim();
    if (!trimmed || isDirectiveLine(trimmed)) continue;
    parseLineContent(trimmed, 0, lines[i], nodesMap, lineEdges);

    const edgeMatch = lineEdges.find((e) => e.source === source && e.target === target);
    if (!edgeMatch) continue;

    const newArrow = updates.arrowType || edgeMatch.arrowType;
    const newLabel = updates.label !== undefined ? updates.label : edgeMatch.label;
    const labelPart = newLabel ? `|${newLabel}|` : "";

    // Build a regex to find and replace this specific edge pattern
    const oldLabelPart = edgeMatch.label ? `\\|${edgeMatch.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|` : "";
    const edgeRe = new RegExp(
      `${escaped_src}(\\s*(?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\}|\\(\\([^)]*\\)\\))?)\\s*${edgeMatch.arrowType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${oldLabelPart}\\s*${escaped_tgt}`
    );

    if (edgeRe.test(lines[i])) {
      lines[i] = lines[i].replace(edgeRe, `${source}$1 ${newArrow}${labelPart} ${target}`);
      break;
    }
  }

  return lines.join("\n");
}
