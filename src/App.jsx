import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";
import { findTaskByLabel, parseGanttTasks, shiftIsoDate, updateGanttTask, toggleGanttStatus, clearGanttStatus, updateGanttAssignee, updateGanttNotes } from "./ganttUtils";
import { parseFlowchart, findNodeById, generateNodeId, addFlowchartNode, removeFlowchartNode, updateFlowchartNode, addFlowchartEdge, removeFlowchartEdge, updateFlowchartEdge, parseClassDefs, parseClassAssignments } from "./flowchartUtils";
import { getDiagramAdapter, parseErDiagram, updateErEntity, parseClassDiagram, parseStateDiagram } from "./diagramUtils";

const CHANNEL = "mermaid-flow";

const STYLE_PALETTE = [
  "#ffffff", "#f1f5f9", "#cbd5e1", "#94a3b8", "#64748b", "#334155",
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6",
  "#fee2e2", "#ffedd5", "#fef9c3", "#dcfce7", "#dbeafe", "#ede9fe",
];

function escapeHtml(raw) {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceFirstLabel(source, before, after) {
  if (!before || !after || before === after) return source;

  const escaped = escapeRegex(before);
  const quoted = new RegExp(`(["'])${escaped}(["'])`);
  if (quoted.test(source)) {
    return source.replace(quoted, (_, open, close) => `${open}${after}${close}`);
  }

  const inline = new RegExp(`\\b${escaped}\\b`);
  if (inline.test(source)) return source.replace(inline, after);

  return source;
}

function getMatchingLine(code, value) {
  if (!value) return null;
  const lines = code.split("\n");
  const index = lines.findIndex((line) => line.includes(value));
  return index === -1 ? null : index + 1;
}

function getIframeSrcDoc() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #f8f9fb;
        background-image: radial-gradient(circle, #d4d8e0 0.75px, transparent 0.75px);
        background-size: 20px 20px;
        font-family: "Manrope", system-ui, sans-serif;
      }
      #wrap {
        width: 100%;
        height: 100%;
        overflow: auto;
        padding: 16px;
        box-sizing: border-box;
      }
      #canvas {
        min-height: 100%;
        padding: 16px;
        box-sizing: border-box;
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      #canvas > svg {
        width: 100%;
        height: auto;
        max-width: 100%;
      }
      .mf-selected * {
        stroke: #2563eb !important;
        stroke-width: 2.5px !important;
        filter: drop-shadow(0 0 3px rgba(37, 99, 235, 0.35));
      }
      .mf-connect-source * {
        stroke: #16a34a !important;
        stroke-width: 3px !important;
        filter: drop-shadow(0 0 6px rgba(22, 163, 74, 0.4));
      }
      text.taskTextOutsideRight, text.taskTextOutsideLeft { pointer-events: all; cursor: pointer; }
      /* ── Gantt Bar Styling ── */
      .done0,.done1,.done2,.done3,.done4,.done5,.done6,.done7,.done8,.done9 { fill: #22c55e !important; rx: 6; }
      .active0,.active1,.active2,.active3,.active4,.active5,.active6,.active7,.active8,.active9 { fill: #3b82f6 !important; rx: 6; }
      .crit0,.crit1,.crit2,.crit3,.crit4,.crit5,.crit6,.crit7,.crit8,.crit9 { fill: #ef4444 !important; rx: 6; }
      .activeCrit0,.activeCrit1,.activeCrit2,.activeCrit3 { fill: #dc2626 !important; rx: 6; }
      .doneCrit0,.doneCrit1,.doneCrit2,.doneCrit3 { fill: #16a34a !important; rx: 6; }
      /* Default (untagged) Gantt bars */
      .task0,.task1,.task2,.task3,.task4,.task5,.task6,.task7,.task8,.task9 { rx: 6; }
      /* Gantt section labels */
      .sectionTitle { font-weight: 700 !important; fill: #1e293b !important; font-size: 14px !important; }
      .sectionTitle0,.sectionTitle1,.sectionTitle2,.sectionTitle3 { font-weight: 700 !important; fill: #1e293b !important; }
      /* Gantt section backgrounds - make them more visible */
      .section0,.section2 { fill: rgba(37, 99, 235, 0.04) !important; }
      .section1,.section3 { fill: rgba(37, 99, 235, 0.08) !important; }
      /* Gantt grid lines - hidden by default, shown via .mf-show-grid class */
      .grid .tick line { stroke: #e2e8f0 !important; stroke-dasharray: none; opacity: 0; transition: opacity 0.2s; }
      .mf-show-grid .grid .tick line { opacity: 0.6; stroke: #cbd5e1 !important; }
      .grid .tick text { fill: #6b7280 !important; font-size: 11px !important; }
      /* Gantt task text */
      .taskText { fill: #fff !important; font-weight: 500 !important; font-size: 12px !important; }
      .taskTextOutsideRight, .taskTextOutsideLeft { fill: #374151 !important; font-weight: 500 !important; font-size: 12px !important; }
      /* Milestone marker */
      .milestone { rx: 3; }
      /* ── General Diagram Styling ── */
      .node rect, .node circle, .node ellipse, .node polygon { rx: 8; ry: 8; }
      .node rect { stroke-width: 1.5px !important; }
      .edgePath path.path { stroke-width: 1.5px !important; }
      .cluster rect { rx: 10; ry: 10; stroke-width: 1px !important; stroke-dasharray: none !important; }
      /* ER diagram styling */
      .entity rect { rx: 8; ry: 8; stroke-width: 1.5px !important; }
      .er.attributeBoxOdd, .er.attributeBoxEven { rx: 4; }
      /* Draggable nodes cursor */
      g.node, g.entity, g.classGroup { cursor: grab; }
      g.node:active, g.entity:active, g.classGroup:active { cursor: grabbing; }
      #error {
        margin-top: 12px;
        font-size: 13px;
        color: #b91c1c;
        font-weight: 600;
      }
      #mf-tooltip {
        position: fixed;
        background: rgba(255, 255, 255, 0.97);
        color: #1a1d26;
        font-size: 12px;
        line-height: 1.5;
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid rgba(0,0,0,0.1);
        pointer-events: none;
        z-index: 1000;
        max-width: 280px;
        white-space: pre-line;
        display: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.1);
      }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="canvas"></div>
      <div id="error"></div>
    </div>
    <div id="mf-tooltip"></div>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

      let selected = null;
      let dragState = null;
      let suppressClick = false;
      let currentDiagramType = "";
      const canvas = document.getElementById("canvas");
      const error = document.getElementById("error");
      const tooltipEl = document.getElementById("mf-tooltip");
      const TASK_TEXT_SEL = "text.taskText, text.taskTextOutsideRight, text.taskTextOutsideLeft";

      const shiftIso = (iso, days) => {
        if (!iso || !days) return iso;
        const [y, m, d] = iso.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d + days));
        const yy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(dt.getUTCDate()).padStart(2, "0");
        return yy + "-" + mm + "-" + dd;
      };
      const fmtFullDate = (iso) => {
        if (!iso) return "";
        const parts = iso.split("-");
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10) + ", " + parts[0];
      };

      canvas.addEventListener("mouseover", (e) => {
        let tip = "";
        const tag = e.target.nodeName;
        if (tag === "rect" || tag === "text") {
          tip = e.target.getAttribute("data-mf-tip") || "";
        } else if (tag === "tspan") {
          const textEl = e.target.closest("text") || e.target.parentElement;
          if (textEl) tip = textEl.getAttribute("data-mf-tip") || "";
        }
        if (!tip) return;
        tooltipEl.textContent = tip;
        tooltipEl.style.display = "block";
        tooltipEl.style.left = (e.clientX + 12) + "px";
        tooltipEl.style.top = (e.clientY + 12) + "px";
      });
      canvas.addEventListener("mousemove", (e) => {
        if (tooltipEl.style.display === "block") {
          tooltipEl.style.left = (e.clientX + 12) + "px";
          tooltipEl.style.top = (e.clientY + 12) + "px";
        }
      });
      canvas.addEventListener("mouseout", (e) => {
        const tag = e.target.nodeName;
        if (tag === "rect" || tag === "text" || tag === "tspan") {
          tooltipEl.style.display = "none";
        }
      });

      const resetSelection = () => {
        if (selected) selected.classList.remove("mf-selected");
        selected = null;
      };

      const send = (type, payload) => {
        window.parent.postMessage({ channel: "${CHANNEL}", type, payload }, "*");
      };

      /* ── Diagram-aware node resolution ─────────────────── */
      const classifyForDrag = (dtype) => {
        const d = (dtype || "").toLowerCase();
        if (d.includes("flow") || d === "graph") return "flowchart";
        if (d.includes("class")) return "classDiagram";
        if (d.includes("state")) return "stateDiagram";
        if (d.includes("er")) return "erDiagram";
        if (d.includes("sequence")) return "sequenceDiagram";
        if (d.includes("mindmap")) return "mindmap";
        if (d.includes("c4")) return "c4";
        if (d.includes("block")) return "block";
        if (d.includes("architecture")) return "architecture";
        return "generic";
      };

      const findDragRoot = (target) => {
        const dtype = classifyForDrag(currentDiagramType);
        let node;
        switch (dtype) {
          case "flowchart":
            node = target.closest("g.node") || target.closest("g.cluster");
            break;
          case "classDiagram":
            node = target.closest("g.classGroup") || target.closest("g.node");
            break;
          case "stateDiagram":
            node = target.closest('g[id*="state-"]') || target.closest("g.node") || target.closest("g.stateGroup");
            break;
          case "erDiagram":
            node = target.closest("g.entity") || target.closest("g.node");
            break;
          case "mindmap":
            node = target.closest("g.mindmap-node") || target.closest("g.node");
            break;
          case "c4":
          case "block":
          case "architecture":
            node = target.closest("g.node") || target.closest("g[id]");
            break;
          default:
            node = target.closest("g.node");
            break;
        }
        if (node) return node;
        // Fallback: walk up g elements, prefer one with an id
        // Skip edge-related groups to avoid dragging edges
        let g = target.closest("g");
        while (g) {
          if (g.classList.contains("edgePath") || g.classList.contains("edgeLabel") || g.classList.contains("edgePaths") || g.classList.contains("edgeLabels")) {
            return null;
          }
          if (g.classList.contains("node") || g.classList.contains("cluster") || g.classList.contains("entity")) {
            return g;
          }
          if (g.id && !g.classList.contains("nodes") && !g.classList.contains("root") && !g.classList.contains("output")) {
            return g;
          }
          const parent = g.parentElement?.closest("g");
          if (!parent || parent === g || parent.classList.contains("nodes") || parent.classList.contains("root") || parent.classList.contains("edgePaths")) break;
          g = parent;
        }
        return null;
      };

      const getElementType = (target) => {
        if (target.closest("g.node") || target.closest("g.classGroup") || target.closest("g.entity") || target.closest("g.cluster") || target.closest("g.mindmap-node") || target.closest('g[id*="state-"]')) return "node";
        if (target.closest("g.edgePath") || target.closest("g.edgeLabel")) return "edge";
        if (target.classList?.contains("mf-edge") || target.classList?.contains("mf-edge-label")) return "edge";
        return "canvas";
      };

      const getNodeShortId = (svgId) => {
        if (!svgId) return "";
        // flowchart-A-0 → A, flowchart-NodeName-123 → NodeName
        const fm = svgId.match(/^flowchart-(.+?)-\\d+$/);
        if (fm) return fm[1];
        // entity-ORGANIZATIONS-0 → ORGANIZATIONS
        const em = svgId.match(/^entity-(.+?)-\\d+$/);
        if (em) return em[1];
        // state-StateName-0 → StateName
        const sm = svgId.match(/^state-(.+?)(?:-\\d+)?$/);
        if (sm) return sm[1];
        // classId0 → classId (strip trailing digit for class diagrams)
        const cm = svgId.match(/^(classId\\d+)$/);
        if (cm) return cm[1];
        return svgId;
      };

      const getEdgeEndpoints = (edgeId) => {
        if (!edgeId) return null;
        // Edge IDs: L-A-B or L_A_B or similar
        const m = edgeId.match(/^L[-_](.+?)[-_](.+?)(?:[-_]\\d+)?$/);
        return m ? { source: m[1], target: m[2] } : null;
      };

      /* ── Position persistence state ────────────────────── */
      let positionOverrides = {};  // nodeId → { dx, dy }

      const applyPositionOverrides = () => {
        const svg = canvas.querySelector("svg");
        if (!svg) return;
        for (const [nodeId, offset] of Object.entries(positionOverrides)) {
          const el = svg.querySelector("#" + CSS.escape(nodeId));
          if (!el) continue;
          const current = el.getAttribute("transform") || "";
          const m = current.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
          const cx = m ? parseFloat(m[1]) : 0;
          const cy = m ? parseFloat(m[2]) : 0;
          el.setAttribute("transform", "translate(" + (cx + offset.dx) + ", " + (cy + offset.dy) + ")");
        }
        // Also update edges connected to moved nodes
        updateEdgesForOverrides(svg);
      };

      const updateEdgesForOverrides = (svg) => {
        if (!svg || Object.keys(positionOverrides).length === 0) return;
        // Rebuild node positions from current SVG state (with overrides applied)
        cachedNodePositions = buildNodePositionMap(svg);
        // Redraw all custom edges with updated positions
        const edgeGroup = svg.querySelector(".mf-custom-edges");
        if (!edgeGroup) return;
        for (const edge of cachedEdgeData) {
          const srcPos = cachedNodePositions[edge.source];
          const tgtPos = cachedNodePositions[edge.target];
          if (!srcPos || !tgtPos) continue;
          const pathData = calcEdgePath(srcPos, tgtPos);
          const pathEl = edgeGroup.querySelector('.mf-edge[data-source="' + edge.source + '"][data-target="' + edge.target + '"]');
          if (pathEl) pathEl.setAttribute("d", pathData.d);
          // Update label position
          const labelEl = pathEl?.nextElementSibling;
          if (labelEl?.classList.contains("mf-edge-label")) {
            labelEl.setAttribute("x", (pathData.sx + pathData.tx) / 2);
            labelEl.setAttribute("y", (pathData.sy + pathData.ty) / 2 - 6);
          }
        }
      };

      /* ── Style overrides state ─────────────────────────── */
      let styleOverrides = {};  // nodeId → { fill, stroke, strokeStyle, textColor }

      const applyStyleOverrides = () => {
        const svg = canvas.querySelector("svg");
        if (!svg) return;
        for (const [nodeId, style] of Object.entries(styleOverrides)) {
          const svgId = findNodeSvgId(svg, nodeId);
          const el = svgId ? svg.querySelector("#" + CSS.escape(svgId)) : null;
          if (!el) continue;
          const shapes = el.querySelectorAll("rect, circle, polygon, ellipse, path");
          for (const shape of shapes) {
            if (style.fill) shape.style.fill = style.fill;
            if (style.stroke) shape.style.stroke = style.stroke;
            if (style.strokeStyle === "dashed") shape.style.strokeDasharray = "6,3";
            else if (style.strokeStyle === "none") shape.style.stroke = "transparent";
            else if (style.strokeStyle === "solid") shape.style.strokeDasharray = "none";
          }
          if (style.textColor) {
            el.querySelectorAll("text, tspan, .nodeLabel, span").forEach(t => {
              t.style.fill = style.textColor;
              t.style.color = style.textColor;
            });
          }
        }
      };

      const findNodeSvgId = (svg, shortId) => {
        const esc = CSS.escape(shortId);
        // flowchart-X-0
        const fc = svg.querySelector('[id^="flowchart-' + esc + '-"]');
        if (fc) return fc.id;
        // entity-X-0
        const er = svg.querySelector('[id^="entity-' + esc + '-"]');
        if (er) return er.id;
        // state-X (may or may not have trailing -0)
        const st = svg.querySelector('[id^="state-' + esc + '"]');
        if (st) return st.id;
        // direct ID match (classId, etc.)
        const direct = svg.querySelector("#" + esc);
        if (direct) return shortId;
        return null;
      };

      /* ── Custom Edge Rendering ──────────────────────────── */
      let cachedEdgeData = [];
      let cachedNodePositions = {};

      const buildNodePositionMap = (svg) => {
        const map = {};
        const nodeGroups = svg.querySelectorAll("g.node, g.entity, g.classGroup, g.stateGroup");
        for (const g of nodeGroups) {
          const shortId = getNodeShortId(g.id || "");
          if (!shortId) continue;
          try {
            const bbox = g.getBBox();
            const tr = g.getAttribute("transform") || "";
            const tm = tr.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
            const tx = tm ? parseFloat(tm[1]) : 0;
            const ty = tm ? parseFloat(tm[2]) : 0;
            map[shortId] = {
              cx: bbox.x + tx + bbox.width / 2,
              cy: bbox.y + ty + bbox.height / 2,
              left: bbox.x + tx,
              right: bbox.x + tx + bbox.width,
              top: bbox.y + ty,
              bottom: bbox.y + ty + bbox.height,
              width: bbox.width,
              height: bbox.height,
            };
          } catch (_) {}
        }
        return map;
      };

      const hideMermaidEdges = (svg) => {
        const skipSel = "g.node, g.entity, g.classGroup, g.cluster, g.mindmap-node, g.stateGroup, defs, marker";
        svg.querySelectorAll("path, line").forEach(el => {
          if (el.closest(skipSel)) return;
          el.style.display = "none";
        });
        svg.querySelectorAll(".edgeLabel").forEach(el => { el.style.display = "none"; });
        svg.querySelectorAll("g.relationshipLabel").forEach(el => { el.style.display = "none"; });
      };

      const calcEdgePath = (srcBox, tgtBox) => {
        const dx = tgtBox.cx - srcBox.cx;
        const dy = tgtBox.cy - srcBox.cy;
        let sx, sy, tx, ty;
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 0) { sx = srcBox.right; sy = srcBox.cy; tx = tgtBox.left; ty = tgtBox.cy; }
          else { sx = srcBox.left; sy = srcBox.cy; tx = tgtBox.right; ty = tgtBox.cy; }
        } else {
          if (dy > 0) { sx = srcBox.cx; sy = srcBox.bottom; tx = tgtBox.cx; ty = tgtBox.top; }
          else { sx = srcBox.cx; sy = srcBox.top; tx = tgtBox.cx; ty = tgtBox.bottom; }
        }
        const dist = Math.hypot(tx - sx, ty - sy);
        const offset = Math.max(dist * 0.4, 30);
        let c1x, c1y, c2x, c2y;
        if (Math.abs(dx) > Math.abs(dy)) {
          c1x = sx + (dx > 0 ? offset : -offset); c1y = sy;
          c2x = tx + (dx > 0 ? -offset : offset); c2y = ty;
        } else {
          c1x = sx; c1y = sy + (dy > 0 ? offset : -offset);
          c2x = tx; c2y = ty + (dy > 0 ? -offset : offset);
        }
        return { sx, sy, tx, ty, c1x, c1y, c2x, c2y,
          d: "M " + sx + "," + sy + " C " + c1x + "," + c1y + " " + c2x + "," + c2y + " " + tx + "," + ty };
      };

      const drawCustomEdges = (svg, edges, diagramType) => {
        svg.querySelectorAll(".mf-custom-edges").forEach(g => g.remove());
        const nodePositions = buildNodePositionMap(svg);
        cachedNodePositions = nodePositions;
        cachedEdgeData = edges;
        hideMermaidEdges(svg);

        let defs = svg.querySelector("defs");
        if (!defs) { defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); svg.prepend(defs); }
        if (!defs.querySelector("#mf-arrowhead")) {
          const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
          marker.setAttribute("id", "mf-arrowhead");
          marker.setAttribute("markerWidth", "10");
          marker.setAttribute("markerHeight", "7");
          marker.setAttribute("refX", "10");
          marker.setAttribute("refY", "3.5");
          marker.setAttribute("orient", "auto");
          const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
          poly.setAttribute("points", "0 0, 10 3.5, 0 7");
          poly.setAttribute("fill", "#475569");
          marker.appendChild(poly);
          defs.appendChild(marker);
        }

        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.classList.add("mf-custom-edges");
        const firstNode = svg.querySelector("g.node, g.entity, g.classGroup, g.stateGroup");
        if (firstNode && firstNode.parentNode) firstNode.parentNode.insertBefore(g, firstNode);
        else svg.appendChild(g);

        for (const edge of edges) {
          const srcPos = nodePositions[edge.source];
          const tgtPos = nodePositions[edge.target];
          if (!srcPos || !tgtPos) continue;
          const pathData = calcEdgePath(srcPos, tgtPos);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", pathData.d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#475569");
          path.setAttribute("stroke-width", "1.5");
          path.setAttribute("marker-end", "url(#mf-arrowhead)");
          path.setAttribute("data-source", edge.source);
          path.setAttribute("data-target", edge.target);
          path.classList.add("mf-edge");
          if (edge.arrowType === "==>" || edge.arrowType === "===") {
            path.setAttribute("stroke-width", "3");
          } else if (edge.arrowType === "-.->" || edge.arrowType === "-.-") {
            path.setAttribute("stroke-dasharray", "5,3");
          }
          g.appendChild(path);
          if (edge.label) {
            const midX = (pathData.sx + pathData.tx) / 2;
            const midY = (pathData.sy + pathData.ty) / 2;
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", midX);
            text.setAttribute("y", midY - 6);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("font-size", "12");
            text.setAttribute("fill", "#64748b");
            text.setAttribute("class", "mf-edge-label");
            text.textContent = edge.label;
            g.appendChild(text);
          }
        }
      };

      const updateCustomEdgesForNode = (svg, nodeId, dx, dy) => {
        const pos = cachedNodePositions[nodeId];
        if (pos) {
          cachedNodePositions[nodeId] = {
            cx: pos.cx + dx, cy: pos.cy + dy,
            left: pos.left + dx, right: pos.right + dx,
            top: pos.top + dy, bottom: pos.bottom + dy,
            width: pos.width, height: pos.height,
          };
        }
        const connectedEdges = cachedEdgeData.filter(e => e.source === nodeId || e.target === nodeId);
        for (const edge of connectedEdges) {
          const srcPos = cachedNodePositions[edge.source];
          const tgtPos = cachedNodePositions[edge.target];
          if (!srcPos || !tgtPos) continue;
          const pathData = calcEdgePath(srcPos, tgtPos);
          const pathEl = svg.querySelector('.mf-edge[data-source="' + edge.source + '"][data-target="' + edge.target + '"]');
          if (pathEl) pathEl.setAttribute("d", pathData.d);
          const labelEl = pathEl?.nextElementSibling;
          if (labelEl?.classList.contains("mf-edge-label")) {
            labelEl.setAttribute("x", (pathData.sx + pathData.tx) / 2);
            labelEl.setAttribute("y", (pathData.sy + pathData.ty) / 2 - 6);
          }
        }
      };

      /* ── SVG path parsing (kept for edge reconnection) ── */
      const parsePathD = (d) => {
        if (!d) return [];
        const tokens = [];
        const re = /([MLCQSTAZHVmlcqstahvz])|(-?\\d*\\.?\\d+(?:e[+-]?\\d+)?)/gi;
        let m;
        while ((m = re.exec(d)) !== null) {
          if (m[1]) tokens.push({ type: 'cmd', value: m[1] });
          else tokens.push({ type: 'num', value: parseFloat(m[2]) });
        }
        const commands = [];
        let i = 0;
        while (i < tokens.length) {
          if (tokens[i].type !== 'cmd') { i++; continue; }
          const cmd = tokens[i].value;
          i++;
          const nums = [];
          while (i < tokens.length && tokens[i].type === 'num') {
            nums.push(tokens[i].value);
            i++;
          }
          commands.push({ cmd, params: [...nums] });
        }
        return commands;
      };

      const serializePathD = (commands) => {
        return commands.map(c => c.cmd + ' ' + c.params.join(',')).join(' ');
      };

      // Collect all x,y coordinate pairs from path commands with their indices
      const getPathPoints = (commands) => {
        const points = [];
        commands.forEach((c, ci) => {
          const p = c.params;
          switch (c.cmd) {
            case 'M': case 'L': case 'T':
              for (let j = 0; j + 1 < p.length; j += 2) {
                points.push({ ci, pi: j });
              }
              break;
            case 'C':
              for (let j = 0; j + 5 < p.length; j += 6) {
                points.push({ ci, pi: j });     // cp1
                points.push({ ci, pi: j + 2 }); // cp2
                points.push({ ci, pi: j + 4 }); // end
              }
              break;
            case 'Q': case 'S':
              for (let j = 0; j + 3 < p.length; j += 4) {
                points.push({ ci, pi: j });
                points.push({ ci, pi: j + 2 });
              }
              break;
          }
        });
        return points;
      };

      /* ── Connect mode state ────────────────────────────── */
      let connectMode = null; // null or { sourceId }

      /* ── Zoom & Pan state ──────────────────────────────── */
      let zoomLevel = 1;
      let panX = 0, panY = 0;
      let isPanning = false, panStartX = 0, panStartY = 0, panOrigX = 0, panOrigY = 0;

      const applyCanvasTransform = () => {
        canvas.style.transformOrigin = "0 0";
        canvas.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + zoomLevel + ")";
        send("zoom:changed", { zoom: zoomLevel });
      };

      /* ── Reconnect state ────────────────────────────────── */
      let reconnectState = null;

      const findEdgeEndpointNear = (cx, cy) => {
        const svg = canvas.querySelector("svg");
        if (!svg) return null;
        const pt = svg.createSVGPoint();
        pt.x = cx; pt.y = cy;
        let svgPt;
        try {
          svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
        } catch (_) { return null; }
        const threshold = 14;
        // Check custom edges first (they have data-source/data-target attributes)
        const customEdges = svg.querySelectorAll(".mf-edge");
        for (const path of customEdges) {
          const d = path.getAttribute("d");
          if (!d) continue;
          const cmds = parsePathD(d);
          const points = getPathPoints(cmds);
          if (points.length < 2) continue;
          const fp = points[0];
          const fx = cmds[fp.ci].params[fp.pi], fy = cmds[fp.ci].params[fp.pi + 1];
          const lp = points[points.length - 1];
          const lx = cmds[lp.ci].params[lp.pi], ly = cmds[lp.ci].params[lp.pi + 1];
          const srcNodeId = path.getAttribute("data-source") || "";
          const tgtNodeId = path.getAttribute("data-target") || "";
          if (Math.hypot(svgPt.x - fx, svgPt.y - fy) < threshold) {
            return { pathEl: path, end: "source", origD: d, srcNodeId, tgtNodeId };
          }
          if (Math.hypot(svgPt.x - lx, svgPt.y - ly) < threshold) {
            return { pathEl: path, end: "target", origD: d, srcNodeId, tgtNodeId };
          }
        }
        return null;
      };

      /* ── Port indicators ────────────────────────────────── */
      let portTimeout = null;
      const showPorts = (nodeEl) => {
        clearPorts();
        const svg = canvas.querySelector("svg");
        if (!svg) return;
        try {
          const bbox = nodeEl.getBBox();
          const tr = nodeEl.getAttribute("transform") || "";
          const tm = tr.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
          const tx = tm ? parseFloat(tm[1]) : 0;
          const ty = tm ? parseFloat(tm[2]) : 0;
          const cx = bbox.x + tx + bbox.width / 2;
          const cy = bbox.y + ty + bbox.height / 2;
          const positions = [
            { name: "top",    px: cx, py: bbox.y + ty - 4 },
            { name: "bottom", px: cx, py: bbox.y + ty + bbox.height + 4 },
            { name: "left",   px: bbox.x + tx - 4, py: cy },
            { name: "right",  px: bbox.x + tx + bbox.width + 4, py: cy },
          ];
          const nid = getNodeShortId(nodeEl.id || "");
          positions.forEach(pos => {
            const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
            g.classList.add("mf-port");
            g.setAttribute("data-port", pos.name);
            g.setAttribute("data-node-id", nid);
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", pos.px);
            circle.setAttribute("cy", pos.py);
            circle.setAttribute("r", "9");
            circle.setAttribute("fill", "#2563eb");
            circle.setAttribute("stroke", "#ffffff");
            circle.setAttribute("stroke-width", "2");
            circle.setAttribute("cursor", "pointer");
            const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
            text.setAttribute("x", pos.px);
            text.setAttribute("y", pos.py);
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("dominant-baseline", "central");
            text.setAttribute("fill", "#ffffff");
            text.setAttribute("font-size", "13");
            text.setAttribute("font-weight", "bold");
            text.setAttribute("pointer-events", "none");
            text.textContent = "+";
            g.appendChild(circle);
            g.appendChild(text);
            svg.appendChild(g);
            g.addEventListener("pointerdown", (e) => {
              e.stopPropagation();
              e.preventDefault();
              send("port:clicked", { nodeId: nid, port: pos.name });
              clearPorts();
            });
          });
        } catch (_) {}
      };
      const clearPorts = () => {
        if (portTimeout) { clearTimeout(portTimeout); portTimeout = null; }
        document.querySelectorAll(".mf-port").forEach(p => p.remove());
      };

      const extractInfo = (target) => {
        const group = target.closest("g") || target;
        const svg = target.closest("svg");
        let textNode = null;

        // Gantt-specific: bars and labels are flat siblings in one <g>.
        // Mermaid sets rect id="X" and text id="X-text".
        if (currentDiagramType.toLowerCase().includes("gantt") && svg) {
          const targetId = target.getAttribute("id") || "";
          const cls = target.className?.baseVal || "";

          if (target.nodeName === "rect" && /\\btask\\b/.test(cls) && targetId) {
            // Primary: use Mermaid's id convention
            textNode = svg.querySelector("#" + CSS.escape(targetId + "-text"));
          }

          if (!textNode && target.nodeName === "rect" && /\\btask\\b/.test(cls)) {
            // Fallback: positional index matching among siblings
            const parent = target.parentElement;
            if (parent) {
              const rects = Array.from(parent.querySelectorAll("rect"));
              const texts = Array.from(parent.querySelectorAll(TASK_TEXT_SEL));
              const idx = rects.filter(r => /\\btask\\b/.test(r.className?.baseVal || "")).indexOf(target);
              if (idx >= 0 && idx < texts.length) {
                textNode = texts[idx];
              }
            }
          }

          if (!textNode && target.nodeName === "text" && /taskText/.test(cls)) {
            // User clicked the label text directly
            textNode = target;
          }
        }

        // Non-Gantt fallback
        if (!textNode) {
          textNode = group.querySelector("text") || target.closest("text");
        }

        let label = "";
        if (textNode) {
          const clone = textNode.cloneNode(true);
          clone.querySelectorAll(".mf-date-tspan").forEach(el => el.remove());
          label = clone.textContent?.trim() || "";
        }
        if (!label) label = target.getAttribute("id") || target.nodeName;

        // For Gantt text elements, get barWidth from the corresponding rect
        let barWidth = 0;
        if (currentDiagramType.toLowerCase().includes("gantt") && (target.nodeName === "text" || target.nodeName === "tspan")) {
          const tEl = target.nodeName === "tspan" ? (target.closest("text") || target.parentElement) : target;
          const tId = tEl?.getAttribute("id") || "";
          let taskRect = null;
          if (tId && tId.endsWith("-text")) {
            taskRect = svg?.querySelector("#" + CSS.escape(tId.slice(0, -5)));
          }
          if (!taskRect && svg) {
            const allTexts = Array.from(svg.querySelectorAll(TASK_TEXT_SEL));
            const allRects = Array.from(svg.querySelectorAll("rect")).filter(r => /\\btask\\b/.test(r.className?.baseVal || ""));
            const tIdx = allTexts.indexOf(tEl);
            if (tIdx >= 0 && tIdx < allRects.length) taskRect = allRects[tIdx];
          }
          if (taskRect) barWidth = taskRect.getBBox?.()?.width || 0;
        }
        if (!barWidth) {
          const bbox = target.getBBox ? target.getBBox() : null;
          barWidth = bbox?.width || 0;
        }

        return {
          id: target.id || group.id || "",
          className: group.className?.baseVal || target.className?.baseVal || "",
          label,
          nodeName: target.nodeName,
          barWidth,
        };
      };

      const isGanttTaskTarget = (target) => {
        if (!target) return false;
        if (!currentDiagramType.toLowerCase().includes("gantt")) return false;
        const cls = target.className?.baseVal || "";
        if (target.nodeName === "tspan") {
          const parentCls = target.parentElement?.className?.baseVal || "";
          return /task/i.test(parentCls);
        }
        if (!/task/i.test(cls)) return false;
        return target.nodeName === "rect" || target.nodeName === "text" || target.nodeName === "g";
      };

      const findGanttTaskRect = (target) => {
        if (target.nodeName === "rect") return target;
        const textEl = target.nodeName === "tspan" ? (target.closest("text") || target.parentElement) : target;
        if (!textEl || textEl.nodeName !== "text") return null;
        const cls = textEl.className?.baseVal || "";
        if (!/taskText/.test(cls)) return null;
        const tId = textEl.getAttribute("id") || "";
        if (tId && tId.endsWith("-text")) {
          const r = canvas.querySelector("svg #" + CSS.escape(tId.slice(0, -5)));
          if (r) return r;
        }
        const svgEl = canvas.querySelector("svg");
        if (!svgEl) return null;
        const allTexts = Array.from(svgEl.querySelectorAll(TASK_TEXT_SEL));
        const allRects = Array.from(svgEl.querySelectorAll("rect")).filter(r => /\\btask\\b/.test(r.className?.baseVal || ""));
        const idx = allTexts.indexOf(textEl);
        return (idx >= 0 && idx < allRects.length) ? allRects[idx] : null;
      };

      const wireSelection = (svg) => {
        const clearDrag = () => {
          if (!dragState) return;
          if (dragState.node) {
            if (dragState.ganttTask) {
              // Gantt: restore original rect geometry (code update handles the change)
              dragState.node.removeAttribute("transform");
              if (dragState.origX != null) {
                dragState.node.setAttribute("x", String(dragState.origX));
              }
              if (dragState.origWidth != null) {
                dragState.node.setAttribute("width", String(dragState.origWidth));
              }
            } else {
              // Non-Gantt: restore to original transform (NOT removeAttribute,
              // which would snap the node to 0,0 since Mermaid positions via translate)
              if (dragState.committed) {
                // Position was committed - keep new position
              } else {
                dragState.node.setAttribute("transform", dragState.origTransform || "");
                // Restore custom edges to original positions since drag was cancelled
                const shortId = getNodeShortId(dragState.node?.id || "");
                if (shortId && (dragState._prevDx || dragState._prevDy)) {
                  updateCustomEdgesForNode(svg, shortId, -(dragState._prevDx || 0), -(dragState._prevDy || 0));
                }
              }
            }
            dragState.node.style.cursor = "";
          }
          if (dragState.textNode) {
            dragState.textNode.removeAttribute("transform");
          }
          tooltipEl.style.display = "none";
          dragState = null;
          suppressClick = false;
        };

        // Edge-resize cursor hint on hover
        svg.addEventListener("mousemove", (event) => {
          if (dragState) return;
          const target = event.target;
          if (!target || target.nodeName !== "rect") {
            svg.style.cursor = "";
            return;
          }
          if (!isGanttTaskTarget(target)) {
            svg.style.cursor = "";
            return;
          }
          try {
            const pt = svg.createSVGPoint();
            pt.x = event.clientX; pt.y = event.clientY;
            const ctm = svg.getScreenCTM();
            if (ctm) {
              const svgPt = pt.matrixTransform(ctm.inverse());
              const bbox = target.getBBox();
              const relX = svgPt.x - bbox.x;
              const edgeZone = Math.max(bbox.width * 0.15, 8);
              if (relX > bbox.width - edgeZone || relX < edgeZone) {
                svg.style.cursor = "ew-resize";
              } else {
                svg.style.cursor = "grab";
              }
            }
          } catch (_) {
            svg.style.cursor = "";
          }
        });

        svg.addEventListener("click", (event) => {
          const target = event.target;
          if (!target || target.nodeName === "svg" || suppressClick) {
            suppressClick = false;
            send("element:selected", null);
            return;
          }

          const group = target.closest("g");
          if (selected) selected.classList.remove("mf-selected");
          if (group) {
            group.classList.add("mf-selected");
            selected = group;
          }

          const info = extractInfo(target);
          const nodeGroup = findDragRoot(target);
          if (nodeGroup) {
            try {
              const bbox = nodeGroup.getBBox();
              const tr = nodeGroup.getAttribute("transform") || "";
              const tm = tr.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
              const tx = tm ? parseFloat(tm[1]) : 0;
              const ty = tm ? parseFloat(tm[2]) : 0;
              const ctm = svg.getScreenCTM();
              if (ctm) {
                const p = svg.createSVGPoint();
                p.x = bbox.x + tx; p.y = bbox.y + ty;
                const tl = p.matrixTransform(ctm);
                p.x = bbox.x + tx + bbox.width; p.y = bbox.y + ty + bbox.height;
                const br = p.matrixTransform(ctm);
                info.screenBox = { left: tl.x, top: tl.y, right: br.x, bottom: br.y };
              }
            } catch (_) {}
            info.nodeId = getNodeShortId(nodeGroup.id || "");
            info.elementType = "node";
          } else {
            info.elementType = getElementType(target);
          }
          send("element:selected", info);
        });

        svg.addEventListener("contextmenu", (event) => {
          const target = event.target;
          event.preventDefault();
          const elementType = (!target || target.nodeName === "svg") ? "canvas" : getElementType(target);
          const nodeGroup = elementType === "node" ? findDragRoot(target) : null;
          const edgeGroup = elementType === "edge" ? (target.closest("g.edgePath") || target.closest("g.edgeLabel")) : null;
          // Check for custom edge (mf-edge) first, fallback to Mermaid edge IDs
          const customEdge = elementType === "edge" ? (target.classList?.contains("mf-edge") ? target : target.classList?.contains("mf-edge-label") ? target.previousElementSibling : null) : null;
          const edgeEndpoints = customEdge
            ? { source: customEdge.getAttribute("data-source") || "", target: customEdge.getAttribute("data-target") || "" }
            : (edgeGroup ? getEdgeEndpoints(edgeGroup.id || edgeGroup.closest?.("g.edgePath")?.id || "") : null);

          // For nodes, extract label from the outermost node group (not inner sub-groups)
          let nodeLabel = "";
          if (nodeGroup) {
            // Try to get the primary/first text child of the node group
            const allTexts = Array.from(nodeGroup.querySelectorAll("text"));
            if (allTexts.length > 0) {
              // For ER entities: first text is the entity name
              // For flowchart nodes: first text is the node label
              // For class diagrams: first text is the class name
              nodeLabel = allTexts[0].textContent?.trim() || "";
              // If multiple texts and first is very short (like a type), use the group id
              if (!nodeLabel || nodeLabel.length < 2) {
                // Collect all text content
                nodeLabel = allTexts.map(t => t.textContent?.trim()).filter(Boolean).join(" ") || "";
              }
            }
            if (!nodeLabel) nodeLabel = getNodeShortId(nodeGroup.id || "") || target.textContent?.trim() || "";
          }

          const info = extractInfo(target);
          // Override label with better extraction for nodes
          if (nodeGroup && nodeLabel) info.label = nodeLabel;

          send("element:context", {
            ...info,
            elementType,
            nodeId: nodeGroup ? getNodeShortId(nodeGroup.id || "") : "",
            edgeSource: edgeEndpoints?.source || "",
            edgeTarget: edgeEndpoints?.target || "",
            pointerX: event.clientX,
            pointerY: event.clientY,
          });
        });

        svg.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          const target = event.target;
          if (!target || target.nodeName === "svg") return;

          clearPorts(); // Hide port indicators during interaction

          // Edge reconnection: detect click near edge endpoint
          if (!connectMode) {
            const nearEdge = findEdgeEndpointNear(event.clientX, event.clientY);
            if (nearEdge) {
              reconnectState = nearEdge;
              document.body.style.cursor = "crosshair";
              event.preventDefault();
              return;
            }
          }

          // In connect mode, clicking a node completes the connection
          if (connectMode) {
            const nodeGroup = findDragRoot(target);
            const nodeId = getNodeShortId(nodeGroup?.id || "");
            if (nodeId && nodeId !== connectMode.sourceId) {
              send("connect:complete", { sourceId: connectMode.sourceId, targetId: nodeId });
              connectMode = null;
              svg.style.cursor = "";
              svg.querySelectorAll(".mf-connect-source").forEach(el => el.classList.remove("mf-connect-source"));
            }
            event.preventDefault();
            return;
          }

          const isGantt = isGanttTaskTarget(target);
          let dragNode, textNode = null, dragMode = "move";

          if (isGantt) {
            dragNode = target.closest("g") || target;
            const taskRect = findGanttTaskRect(target);
            if (taskRect) {
              dragNode = taskRect;
              const rId = taskRect.getAttribute("id") || "";
              if (rId) {
                textNode = svg.querySelector("#" + CSS.escape(rId + "-text"));
              }
              try {
                const pt = svg.createSVGPoint();
                pt.x = event.clientX;
                pt.y = event.clientY;
                const ctm = svg.getScreenCTM();
                if (ctm) {
                  const svgPt = pt.matrixTransform(ctm.inverse());
                  const bbox = taskRect.getBBox();
                  const relX = svgPt.x - bbox.x;
                  const edgeZone = Math.max(bbox.width * 0.15, 8);
                  if (relX > bbox.width - edgeZone) {
                    dragMode = "resize-end";
                  } else if (relX < edgeZone) {
                    dragMode = "resize-start";
                  } else {
                    dragMode = "shift";
                  }
                }
              } catch (_) {
                dragMode = "shift";
              }
              dragNode.style.cursor = dragMode.startsWith("resize") ? "ew-resize" : "grabbing";
            }
          } else {
            // Non-Gantt: only allow dragging actual nodes, not edges or background
            const elemType = getElementType(target);
            if (elemType !== "node") return;
            dragNode = findDragRoot(target);
            if (!dragNode || dragNode === svg || dragNode.nodeName === "svg") return;
            dragNode.style.cursor = "grabbing";
            dragMode = "move";
          }

          // Store original transform for non-Gantt nodes
          let origTransform = "", origTx = 0, origTy = 0;
          if (!isGantt) {
            origTransform = dragNode.getAttribute("transform") || "";
            const tm = origTransform.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
            if (tm) { origTx = parseFloat(tm[1]); origTy = parseFloat(tm[2]); }
          }

          // Store original rect geometry for edge-resize restoration (Gantt)
          let origX = null, origWidth = null, svgScale = 1;
          if (isGantt && dragNode.nodeName === "rect") {
            origX = parseFloat(dragNode.getAttribute("x")) || 0;
            origWidth = parseFloat(dragNode.getAttribute("width")) || 0;
          }
          try {
            const ctm = svg.getScreenCTM();
            if (ctm) svgScale = ctm.a;
          } catch (_) {}

          dragState = {
            target,
            node: dragNode,
            textNode,
            startX: event.clientX,
            startY: event.clientY,
            deltaX: 0,
            deltaY: 0,
            ganttTask: isGantt,
            dragMode,
            origX,
            origWidth,
            svgScale,
            origTransform,
            origTx,
            origTy,
            committed: false,
          };

          // Initialize delta tracking for custom edge updates
          if (!isGantt) {
            dragState._prevDx = 0;
            dragState._prevDy = 0;
          }
        });

        svg.addEventListener("pointermove", (event) => {
          // Edge reconnect: drag endpoint to follow cursor
          if (reconnectState) {
            const svg = canvas.querySelector("svg");
            if (svg) {
              try {
                const pt = svg.createSVGPoint();
                pt.x = event.clientX; pt.y = event.clientY;
                const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
                const cmds = parsePathD(reconnectState.origD);
                const points = getPathPoints(cmds);
                if (points.length >= 2) {
                  const idx = reconnectState.end === "source" ? points[0] : points[points.length - 1];
                  cmds[idx.ci].params[idx.pi] = svgPt.x;
                  cmds[idx.ci].params[idx.pi + 1] = svgPt.y;
                  reconnectState.pathEl.setAttribute("d", serializePathD(cmds));
                }
              } catch (_) {}
            }
            return;
          }
          if (!dragState) return;
          dragState.deltaX = event.clientX - dragState.startX;
          dragState.deltaY = event.clientY - dragState.startY;
          if (Math.abs(dragState.deltaX) > 3 || Math.abs(dragState.deltaY) > 3) {
            suppressClick = true;
          }
          if (dragState.ganttTask) {
            // Gantt: horizontal only
            const dx = dragState.deltaX;
            const svgDx = dx / (dragState.svgScale || 1);
            const mode = dragState.dragMode;

            if (mode === "resize-end" && dragState.origWidth != null) {
              const newW = Math.max(4, dragState.origWidth + svgDx);
              dragState.node.setAttribute("width", String(newW));
            } else if (mode === "resize-start" && dragState.origX != null && dragState.origWidth != null) {
              const newX = dragState.origX + svgDx;
              const newW = Math.max(4, dragState.origWidth - svgDx);
              dragState.node.setAttribute("x", String(newX));
              dragState.node.setAttribute("width", String(newW));
              if (dragState.textNode) {
                dragState.textNode.setAttribute("transform", "translate(" + dx + " 0)");
              }
            } else {
              dragState.node.setAttribute("transform", "translate(" + dx + " 0)");
              if (dragState.textNode) {
                dragState.textNode.setAttribute("transform", "translate(" + dx + " 0)");
              }
            }

            // Live tooltip with projected dates
            const rect = dragState.node;
            const origStart = rect.getAttribute("data-mf-start") || "";
            const origEnd = rect.getAttribute("data-mf-end") || "";
            const days = parseInt(rect.getAttribute("data-mf-days") || "0", 10);
            const bw = dragState.origWidth || 1;
            const pxPerDay = days ? bw / days : 0;
            const dayShift = pxPerDay ? Math.round(svgDx / pxPerDay) : 0;

            let projStart = origStart;
            let projEnd = origEnd;
            if (mode === "resize-end") {
              projEnd = shiftIso(origEnd, dayShift);
            } else if (mode === "resize-start") {
              projStart = shiftIso(origStart, dayShift);
            } else {
              projStart = shiftIso(origStart, dayShift);
              projEnd = shiftIso(origEnd, dayShift);
            }

            const label = dragState.textNode
              ? (() => { const c = dragState.textNode.cloneNode(true); c.querySelectorAll(".mf-date-tspan").forEach(el => el.remove()); return c.textContent?.trim() || ""; })()
              : "";
            let tipText = label || "Dragging...";
            tipText += "\\nStart: " + fmtFullDate(projStart);
            tipText += "\\nEnd: " + fmtFullDate(projEnd);
            const shift = mode === "resize-end" || mode === "resize-start" ? dayShift : dayShift;
            if (dayShift !== 0) {
              tipText += "\\n" + (dayShift > 0 ? "+" : "") + dayShift + " day" + (Math.abs(dayShift) !== 1 ? "s" : "");
            }
            tooltipEl.textContent = tipText;
            tooltipEl.style.display = "block";
            tooltipEl.style.left = (event.clientX + 14) + "px";
            tooltipEl.style.top = (event.clientY + 14) + "px";
          } else {
            // Non-Gantt: move node in SVG coordinate space
            const scale = dragState.svgScale || 1;
            const svgDx = dragState.deltaX / scale;
            const svgDy = dragState.deltaY / scale;
            const newTx = dragState.origTx + svgDx;
            const newTy = dragState.origTy + svgDy;
            dragState.node.setAttribute("transform", "translate(" + newTx + ", " + newTy + ")");

            // Move connected edges using deterministic ID-based lookup
            const shortId = getNodeShortId(dragState.node?.id || "");
            if (shortId && cachedEdgeData.length > 0) {
              const ddx = svgDx - (dragState._prevDx || 0);
              const ddy = svgDy - (dragState._prevDy || 0);
              updateCustomEdgesForNode(svg, shortId, ddx, ddy);
              dragState._prevDx = svgDx;
              dragState._prevDy = svgDy;
            }
          }
        });

        svg.addEventListener("pointerup", (event) => {
          // Edge reconnect: complete or cancel
          if (reconnectState) {
            const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
            const nodeGroup = dropTarget ? findDragRoot(dropTarget) : null;
            if (nodeGroup) {
              const newNodeId = getNodeShortId(nodeGroup.id || "");
              if (newNodeId) {
                send("edge:reconnect", {
                  end: reconnectState.end,
                  srcNodeId: reconnectState.srcNodeId,
                  tgtNodeId: reconnectState.tgtNodeId,
                  newNodeId,
                });
              }
            } else {
              // Restore original path
              reconnectState.pathEl.setAttribute("d", reconnectState.origD);
            }
            reconnectState = null;
            document.body.style.cursor = "";
            return;
          }
          if (!dragState) return;
          const threshold = Math.abs(dragState.deltaX) + Math.abs(dragState.deltaY);

          // Compute accumulated position BEFORE building payload
          let accDx = 0, accDy = 0;
          if (!dragState.ganttTask && threshold > 4) {
            const nodeId = dragState.node?.id || "";
            if (nodeId) {
              const scale = dragState.svgScale || 1;
              const svgDx = dragState.deltaX / scale;
              const svgDy = dragState.deltaY / scale;
              positionOverrides[nodeId] = positionOverrides[nodeId] || { dx: 0, dy: 0 };
              positionOverrides[nodeId].dx += svgDx;
              positionOverrides[nodeId].dy += svgDy;
              accDx = positionOverrides[nodeId].dx;
              accDy = positionOverrides[nodeId].dy;
              dragState.committed = true;
            }
          }

          const payload = {
            ...extractInfo(dragState.target),
            deltaX: dragState.deltaX,
            deltaY: dragState.deltaY,
            isGanttTask: dragState.ganttTask,
            dragMode: dragState.dragMode || "shift",
            nodeId: dragState.node?.id || "",
            accumulatedDx: accDx,
            accumulatedDy: accDy,
          };
          if (threshold > 4) {
            send("element:dragged", payload);
            if (dragState.ganttTask) {
              send("gantt:dragged", payload);
            }
          }
          clearDrag();
        });

        svg.addEventListener("pointerleave", clearDrag);

        // Port indicators: show on mouseenter, hide on mouseleave with delay
        const nodeGroups = svg.querySelectorAll("g.node, g.entity, g.classGroup");
        nodeGroups.forEach(nodeEl => {
          nodeEl.addEventListener("mouseenter", () => {
            if (dragState || isPanning || reconnectState) return;
            // Only show ports for flowcharts (other diagram types generate invalid syntax)
            const dtype = classifyForDrag(currentDiagramType);
            if (dtype !== "flowchart") return;
            showPorts(nodeEl);
          });
          nodeEl.addEventListener("mouseleave", () => {
            portTimeout = setTimeout(() => {
              if (!document.querySelector(".mf-port:hover")) clearPorts();
            }, 300);
          });
        });
      };

      /* ── Zoom/Pan handlers on #wrap ────────────────────── */
      const wrap = document.getElementById("wrap");
      wrap.addEventListener("wheel", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const oldZoom = zoomLevel;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        zoomLevel = Math.min(3, Math.max(0.1, zoomLevel + delta));
        // Zoom toward cursor position
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const ratio = zoomLevel / oldZoom;
        panX = cx - (cx - panX) * ratio;
        panY = cy - (cy - panY) * ratio;
        applyCanvasTransform();
      }, { passive: false });

      wrap.addEventListener("pointerdown", (e) => {
        if (e.button === 1) {
          // Middle mouse: pan
          e.preventDefault();
          isPanning = true;
          panStartX = e.clientX;
          panStartY = e.clientY;
          panOrigX = panX;
          panOrigY = panY;
          wrap.style.cursor = "grabbing";
          wrap.setPointerCapture(e.pointerId);
        }
      });
      wrap.addEventListener("pointermove", (e) => {
        if (!isPanning) return;
        panX = panOrigX + (e.clientX - panStartX);
        panY = panOrigY + (e.clientY - panStartY);
        applyCanvasTransform();
      });
      wrap.addEventListener("pointerup", (e) => {
        if (isPanning) {
          isPanning = false;
          wrap.style.cursor = "";
          wrap.releasePointerCapture(e.pointerId);
        }
      });

      wrap.addEventListener("dblclick", (e) => {
        // Only reset if double-clicking on background, not on SVG elements
        if (e.target === wrap || e.target === canvas) {
          zoomLevel = 1; panX = 0; panY = 0;
          applyCanvasTransform();
        }
      });

      const annotateGanttBars = (tasks, showDates) => {
        const svg = canvas.querySelector("svg");
        if (!svg) return;
        svg.querySelectorAll(".mf-date-tspan").forEach(el => el.remove());
        svg.querySelectorAll(".mf-overdue-dot").forEach(el => el.remove());
        svg.querySelectorAll(".mf-tooltip").forEach(el => el.remove());

        const texts = Array.from(svg.querySelectorAll(TASK_TEXT_SEL));
        const rects = Array.from(svg.querySelectorAll("rect")).filter(r => /\\btask\\b/.test(r.className?.baseVal || ""));
        const today = new Date().toISOString().slice(0, 10);

        const fmt = (iso) => {
          if (!iso) return "";
          const parts = iso.split("-");
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
        };
        const fmtFull = (iso) => {
          if (!iso) return "";
          const parts = iso.split("-");
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10) + ", " + parts[0];
        };

        tasks.forEach((t) => {
          const endDate = t.endDate || t.computedEnd || "";
          const isDone = (t.statusTokens || []).includes("done");
          const isOverdue = endDate && !isDone && endDate < today;

          const textEl = texts.find(el => el.textContent?.trim() === t.label);
          let rectEl = null;
          if (textEl) {
            const textId = textEl.getAttribute("id");
            if (textId && textId.endsWith("-text")) {
              rectEl = svg.querySelector("#" + CSS.escape(textId.slice(0, -5)));
            }
            if (!rectEl) {
              const idx = texts.indexOf(textEl);
              if (idx >= 0 && idx < rects.length) rectEl = rects[idx];
            }
          }

          if (rectEl) {
            let tip = t.label;
            if (t.statusTokens?.length) {
              const sMap = { done: "Done", active: "Active", crit: "Critical" };
              tip += "\\nStatus: " + t.statusTokens.map(s => sMap[s] || s).join(", ");
            }
            if (t.startDate) tip += "\\nStart: " + fmtFull(t.startDate);
            if (endDate) tip += "\\nEnd: " + fmtFull(endDate);
            if (isOverdue) tip += "\\nOVERDUE";
            if (t.assignee) tip += "\\nAssignee: " + t.assignee;
            if (t.notes) tip += "\\nNotes: " + t.notes;
            rectEl.setAttribute("data-mf-tip", tip);
            // Store task metadata for live drag tooltip
            if (t.startDate) rectEl.setAttribute("data-mf-start", t.startDate);
            if (endDate) rectEl.setAttribute("data-mf-end", endDate);
            if (t.durationDays) rectEl.setAttribute("data-mf-days", String(t.durationDays));
            // Also set on text element so tooltip works when hovering labels
            if (textEl) textEl.setAttribute("data-mf-tip", tip);

            // White text on dark status bars (done=green, crit=maroon)
            if (textEl && (t.statusTokens || []).some(s => s === "done" || s === "crit")) {
              textEl.setAttribute("fill", "#ffffff");
            }

            if (isOverdue) {
              const bbox = rectEl.getBBox();
              const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
              dot.setAttribute("class", "mf-overdue-dot");
              dot.setAttribute("cx", String(bbox.x - 8));
              dot.setAttribute("cy", String(bbox.y + bbox.height / 2));
              dot.setAttribute("r", "4");
              dot.setAttribute("fill", "#dc2626");
              rectEl.parentElement.appendChild(dot);
            }
          }

          if (!showDates || !textEl) return;
          if (!t.startDate && !endDate && !t.assignee) return;

          const startStr = fmt(t.startDate);
          const endStr = endDate ? fmt(endDate) : "";
          let dateStr = endStr ? startStr + " – " + endStr : startStr;
          if (t.assignee) dateStr = (dateStr ? dateStr + " · " : "") + t.assignee;
          if (!dateStr) return;

          const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
          tspan.setAttribute("class", "mf-date-tspan");
          const isDarkBar = (t.statusTokens || []).some(s => s === "done" || s === "crit");
          tspan.setAttribute("fill", isDarkBar ? "rgba(255,255,255,0.65)" : "#9ca3af");
          tspan.setAttribute("font-size", "0.78em");
          tspan.setAttribute("font-weight", "400");
          tspan.textContent = " (" + dateStr + ")";
          textEl.appendChild(tspan);
        });
      };

      window.addEventListener("message", async (event) => {
        const data = event.data;
        if (!data || data.channel !== "${CHANNEL}") return;

        if (data.type === "gantt:annotate") {
          annotateGanttBars(data.payload?.tasks || [], data.payload?.showDates !== false);
          return;
        }

        if (data.type === "apply:positions") {
          // Merge parent overrides with any existing iframe-side overrides
          const incoming = data.payload?.overrides || {};
          for (const [key, val] of Object.entries(incoming)) {
            positionOverrides[key] = val;
          }
          applyPositionOverrides();
          applyStyleOverrides();
          return;
        }

        if (data.type === "apply:styles") {
          const incoming = data.payload?.overrides || {};
          for (const [key, val] of Object.entries(incoming)) {
            styleOverrides[key] = val;
          }
          applyStyleOverrides();
          return;
        }

        if (data.type === "edges:draw") {
          const svg = canvas.querySelector("svg");
          if (svg) {
            drawCustomEdges(svg, data.payload?.edges || [], data.payload?.diagramType || "");
            setTimeout(() => applyStyleOverrides(), 10);
          }
          return;
        }

        if (data.type === "gantt:grid") {
          const svg = canvas.querySelector("svg");
          if (svg) {
            if (data.payload?.show) {
              svg.classList.add("mf-show-grid");
            } else {
              svg.classList.remove("mf-show-grid");
            }
          }
          return;
        }

        if (data.type === "mode:connect") {
          const sourceId = data.payload?.sourceId || "";
          connectMode = { sourceId };
          const svgEl = canvas.querySelector("svg");
          if (svgEl) {
            svgEl.style.cursor = "crosshair";
            // Highlight source node
            const srcEl = svgEl.querySelector('[id*="' + CSS.escape(sourceId) + '"]');
            if (srcEl) srcEl.classList.add("mf-connect-source");
          }
          return;
        }

        if (data.type === "mode:normal") {
          connectMode = null;
          const svgEl = canvas.querySelector("svg");
          if (svgEl) {
            svgEl.style.cursor = "";
            svgEl.querySelectorAll(".mf-connect-source").forEach(el => el.classList.remove("mf-connect-source"));
          }
          return;
        }

        if (data.type === "clear:positions") {
          positionOverrides = {};
          return;
        }

        if (data.type === "zoom:set") {
          const oldZoom = zoomLevel;
          const delta = data.payload?.delta || 0;
          zoomLevel = Math.min(3, Math.max(0.1, zoomLevel + delta));
          const rect = wrap.getBoundingClientRect();
          const cx = rect.width / 2;
          const cy = rect.height / 2;
          const ratio = zoomLevel / oldZoom;
          panX = cx - (cx - panX) * ratio;
          panY = cy - (cy - panY) * ratio;
          applyCanvasTransform();
          return;
        }

        if (data.type === "zoom:reset") {
          zoomLevel = 1; panX = 0; panY = 0;
          applyCanvasTransform();
          return;
        }

        if (data.type !== "render") return;

        const { code, config } = data.payload || {};
        if (!code) return;

        try {
          resetSelection();
          error.textContent = "";
          mermaid.initialize({ ...config, startOnLoad: false });
          const parseResult = await mermaid.parse(code);
          currentDiagramType = parseResult?.diagramType || "";
          const token = "diagram_" + Date.now();
          const { svg } = await mermaid.render(token, code);
          canvas.innerHTML = svg;

          const svgNode = canvas.querySelector("svg");
          if (svgNode) {
            // Make Gantt charts fill the container width
            const dtype = (parseResult?.diagramType || "").toLowerCase();
            if (dtype.includes("gantt")) {
              svgNode.removeAttribute("width");
              svgNode.style.width = "100%";
              svgNode.style.minWidth = "100%";
              svgNode.style.height = "auto";
              // Ensure the viewBox covers the content
              try {
                const bbox = svgNode.getBBox();
                if (bbox.width > 0) {
                  svgNode.setAttribute("viewBox", bbox.x + " " + bbox.y + " " + bbox.width + " " + bbox.height);
                  svgNode.setAttribute("preserveAspectRatio", "xMidYMid meet");
                }
              } catch (_) {}
            }
            wireSelection(svgNode);
          }
          send("render:success", { diagramType: parseResult?.diagramType || "", svg });
        } catch (err) {
          const message = (err && err.message) ? err.message : String(err);
          error.textContent = message;
          send("render:error", { message });
        }
      });
    </script>
  </body>
</html>`;
}

/* ── SVG Icon Components ──────────────────────────────── */
const IconSidebar = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="16" height="14" rx="2" />
    <line x1="7" y1="3" x2="7" y2="17" />
  </svg>
);

const IconExport = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 10l4-4 4 4" />
    <line x1="10" y1="6" x2="10" y2="16" />
    <path d="M3 14v2a2 2 0 002 2h10a2 2 0 002-2v-2" />
  </svg>
);

const IconTools = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="11" y="3" width="6" height="6" rx="1" />
    <rect x="3" y="11" width="6" height="6" rx="1" />
    <rect x="11" y="11" width="6" height="6" rx="1" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="3" />
    <path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.93 4.93l1.41 1.41m7.32 7.32l1.41 1.41M15.07 4.93l-1.41 1.41m-7.32 7.32l-1.41 1.41" />
  </svg>
);

const IconPresent = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="16" height="12" rx="2" />
    <path d="M7 9l3 2 3-2" />
  </svg>
);

/* ── Main App ─────────────────────────────────────────── */
function App() {
  const iframeRef = useRef(null);
  const editorRef = useRef(null);
  const exportMenuRef = useRef(null);

  // Core state
  const [code, setCode] = useState(DEFAULT_CODE);
  const [theme, setTheme] = useState("neo");
  const [securityLevel, setSecurityLevel] = useState("strict");
  const [renderer, setRenderer] = useState("dagre");
  const [autoRender, setAutoRender] = useState(true);
  const [diagramType, setDiagramType] = useState("flowchart");
  const [renderSvg, setRenderSvg] = useState("");
  const [renderStatus, setRenderStatus] = useState("idle");
  const [renderMessage, setRenderMessage] = useState("");
  const [selectedElement, setSelectedElement] = useState(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [highlightLine, setHighlightLine] = useState(null);
  const [templateId, setTemplateId] = useState("flowchart");
  const [dragFeedback, setDragFeedback] = useState("");
  const [ganttDraft, setGanttDraft] = useState({ label: "", startDate: "", endDate: "", status: [], assignee: "", notes: "" });

  // UI state
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentMode, setPresentMode] = useState(false);
  const [editorWidth, setEditorWidth] = useState(30);
  const [showDates, setShowDates] = useState(true);
  const [showGrid, setShowGrid] = useState(false);

  // Interactive diagram state
  const [positionOverrides, setPositionOverrides] = useState({});
  const [styleOverrides, setStyleOverrides] = useState({}); // { [nodeId]: { fill?, stroke?, strokeStyle?, textColor? } }
  const [connectMode, setConnectMode] = useState(null);
  const [shapePickerNode, setShapePickerNode] = useState(null);
  const [edgeLabelEdit, setEdgeLabelEdit] = useState(null);
  const [nodeEditModal, setNodeEditModal] = useState(null); // { type: "node"|"edge", nodeId?, label, shape?, edgeSource?, edgeTarget?, arrowType? }
  const [nodeCreationForm, setNodeCreationForm] = useState(null); // { sourceNodeId, port, label, description }
  const [zoomLevel, setZoomLevel] = useState(1);
  const [styleToolbar, setStyleToolbar] = useState(null); // { nodeId, x, y, yBottom, activeDropdown }
  const contextMenuRef = useRef(null);

  // Derived
  const srcDoc = useMemo(() => getIframeSrcDoc(), []);
  const lineCount = code.split("\n").length;
  const toolsetKey = classifyDiagramType(diagramType);
  const activeTemplate = DIAGRAM_LIBRARY.find((entry) => entry.id === templateId);
  const ganttTasks = useMemo(() => parseGanttTasks(code), [code]);
  const flowchartData = useMemo(() => {
    if (toolsetKey === "flowchart") return parseFlowchart(code);
    return { direction: "TD", nodes: [], edges: [], subgraphs: [] };
  }, [code, toolsetKey]);
  const selectedGanttTask = useMemo(
    () => findTaskByLabel(ganttTasks, selectedElement?.label || ""),
    [ganttTasks, selectedElement]
  );
  const quickTools =
    DIAGRAM_LIBRARY.find((entry) => entry.id === toolsetKey)?.quickTools ||
    DIAGRAM_LIBRARY.find((entry) => entry.id === "flowchart")?.quickTools ||
    [];

  // Get connected nodes for any diagram type (for edit modal navigation)
  const getNodeConnections = (nodeId) => {
    const inputs = [];
    const outputs = [];
    if (toolsetKey === "flowchart") {
      for (const edge of flowchartData.edges) {
        if (edge.target === nodeId) {
          const node = flowchartData.nodes.find(n => n.id === edge.source);
          const rawLabel = node?.label || edge.source;
          inputs.push({ id: edge.source, label: rawLabel.split(/<br\s*\/?>/i)[0].trim() });
        }
        if (edge.source === nodeId) {
          const node = flowchartData.nodes.find(n => n.id === edge.target);
          const rawLabel = node?.label || edge.target;
          outputs.push({ id: edge.target, label: rawLabel.split(/<br\s*\/?>/i)[0].trim() });
        }
      }
    } else if (toolsetKey === "erDiagram") {
      const erData = parseErDiagram(code);
      for (const rel of erData.relationships) {
        if (rel.target === nodeId) inputs.push({ id: rel.source, label: rel.source });
        if (rel.source === nodeId) outputs.push({ id: rel.target, label: rel.target });
      }
    } else if (toolsetKey === "stateDiagram") {
      const adapter = getDiagramAdapter(toolsetKey);
      if (adapter?.parse) {
        const data = adapter.parse(code);
        for (const t of (data.transitions || [])) {
          if (t.target === nodeId) {
            const state = (data.states || []).find(s => s.id === t.source);
            inputs.push({ id: t.source, label: state?.label || t.source });
          }
          if (t.source === nodeId) {
            const state = (data.states || []).find(s => s.id === t.target);
            outputs.push({ id: t.target, label: state?.label || t.target });
          }
        }
      }
    } else if (toolsetKey === "classDiagram") {
      const adapter = getDiagramAdapter(toolsetKey);
      if (adapter?.parse) {
        const data = adapter.parse(code);
        for (const r of (data.relationships || [])) {
          if (r.target === nodeId) inputs.push({ id: r.source, label: r.source });
          if (r.source === nodeId) outputs.push({ id: r.target, label: r.target });
        }
      }
    } else if (toolsetKey === "sequenceDiagram") {
      const adapter = getDiagramAdapter(toolsetKey);
      if (adapter?.parse) {
        const data = adapter.parse(code);
        for (const m of (data.messages || [])) {
          if (m.target === nodeId) {
            const part = (data.participants || []).find(p => p.id === m.source);
            inputs.push({ id: m.source, label: part?.label || m.source });
          }
          if (m.source === nodeId) {
            const part = (data.participants || []).find(p => p.id === m.target);
            outputs.push({ id: m.target, label: part?.label || m.target });
          }
        }
      }
    }
    // Deduplicate by id
    const dedup = (arr) => [...new Map(arr.map(x => [x.id, x])).values()];
    return { inputs: dedup(inputs), outputs: dedup(outputs) };
  };

  // Build node edit modal data for a given nodeId (used for navigation)
  const buildNodeEditData = (nodeId) => {
    const connections = getNodeConnections(nodeId);
    if (toolsetKey === "flowchart") {
      const node = flowchartData.nodes.find(n => n.id === nodeId);
      const shape = node?.shape || "rect";
      const fullLabel = node?.label || nodeId;
      const parts = fullLabel.split(/<br\s*\/?>/i);
      const label = parts[0].trim();
      const description = parts.slice(1).map(p => p.trim()).join("\n");
      const existingStyle = styleOverrides[nodeId] || {};
      const classDefs = parseClassDefs(code);
      const classAssignments = parseClassAssignments(code);
      const assignedClass = classAssignments[nodeId] || null;
      return { type: "node", nodeId, label, description, shape, connections, style: { ...existingStyle }, classDefs, assignedClass };
    }
    if (toolsetKey === "erDiagram") {
      const erData = parseErDiagram(code);
      const entity = erData.entities.find(e => e.id === nodeId);
      if (entity) {
        return { type: "node", nodeId, label: entity.id, shape: "rect", attributes: [...entity.attributes], connections };
      }
    }
    // State/class/sequence: try to get label from adapter
    const adapter = getDiagramAdapter(toolsetKey);
    if (adapter?.parse) {
      const data = adapter.parse(code);
      const items = data.states || data.classes || data.participants || [];
      const item = items.find(i => i.id === nodeId);
      if (item) {
        return { type: "node", nodeId, label: item.label || item.id || nodeId, shape: "rect", connections };
      }
    }
    return { type: "node", nodeId, label: nodeId, shape: "rect", connections };
  };

  /* ── Render ──────────────────────────────────────────── */
  const postRender = () => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;

    setRenderStatus("rendering");
    frame.contentWindow.postMessage(
      {
        channel: CHANNEL,
        type: "render",
        payload: {
          code,
          config: {
            theme,
            securityLevel,
            flowchart: { defaultRenderer: renderer },
          },
        },
      },
      "*"
    );
  };

  /* ── Auto-render ─────────────────────────────────────── */
  useEffect(() => {
    if (!autoRender) return;
    const handle = window.setTimeout(postRender, 360);
    return () => window.clearTimeout(handle);
  }, [code, autoRender, theme, securityLevel, renderer]);

  /* ── Gantt draft sync ────────────────────────────────── */
  useEffect(() => {
    if (!selectedGanttTask) {
      setGanttDraft({ label: "", startDate: "", endDate: "", status: [], assignee: "", notes: "" });
      return;
    }
    let computedEnd = selectedGanttTask.endDate || "";
    if (!computedEnd && selectedGanttTask.startDate && selectedGanttTask.durationDays) {
      const d = new Date(selectedGanttTask.startDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + selectedGanttTask.durationDays);
      computedEnd = d.toISOString().slice(0, 10);
    }
    setGanttDraft({
      label: selectedGanttTask.label || "",
      startDate: selectedGanttTask.startDate || "",
      endDate: computedEnd,
      status: selectedGanttTask.statusTokens || [],
      assignee: selectedGanttTask.assignee || "",
      notes: selectedGanttTask.notes || "",
    });
  }, [selectedGanttTask]);

  /* ── PostMessage listener ────────────────────────────── */
  useEffect(() => {
    const listener = (event) => {
      const data = event.data;
      if (!data || data.channel !== CHANNEL) return;

      if (data.type === "render:success") {
        const payload = data.payload || {};
        setRenderStatus("ok");
        setRenderMessage("Rendered successfully");
        setDiagramType(payload.diagramType || "unknown");
        setRenderSvg(payload.svg || "");

        // Send date annotations for Gantt charts
        if ((payload.diagramType || "").toLowerCase().includes("gantt")) {
          const tasks = parseGanttTasks(code);
          const annotationData = tasks.map((t) => {
            let computedEnd = t.endDate || "";
            if (!computedEnd && t.startDate && t.durationDays) {
              const d = new Date(t.startDate + "T00:00:00Z");
              d.setUTCDate(d.getUTCDate() + t.durationDays);
              computedEnd = d.toISOString().slice(0, 10);
            }
            return { label: t.label, startDate: t.startDate, endDate: t.endDate, durationDays: t.durationDays, computedEnd, assignee: t.assignee || "", statusTokens: t.statusTokens || [], notes: t.notes || "" };
          });
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage(
              { channel: CHANNEL, type: "gantt:annotate", payload: { tasks: annotationData, showDates } },
              "*"
            );
            // Apply grid lines state
            if (showGrid) {
              frame.contentWindow.postMessage(
                { channel: CHANNEL, type: "gantt:grid", payload: { show: true } },
                "*"
              );
            }
          }
        }

        // Apply position overrides after re-render (non-Gantt)
        if (Object.keys(positionOverrides).length > 0) {
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage(
              { channel: CHANNEL, type: "apply:positions", payload: { overrides: positionOverrides } },
              "*"
            );
          }
        }

        // Send parsed edge data for custom edge rendering
        const tk = classifyDiagramType(payload.diagramType || "");
        const edgeTypes = ["flowchart", "erDiagram", "stateDiagram", "classDiagram"];
        if (edgeTypes.includes(tk)) {
          let edges = [];
          if (tk === "flowchart") {
            const fd = parseFlowchart(code);
            edges = fd.edges.map(e => ({ source: e.source, target: e.target, label: e.label || "", arrowType: e.arrowType || "-->" }));
          } else if (tk === "erDiagram") {
            const ed = parseErDiagram(code);
            edges = ed.relationships.map(r => ({ source: r.source, target: r.target, label: r.label || "", arrowType: r.cardinality || "||--o{" }));
          } else if (tk === "stateDiagram") {
            const sd = parseStateDiagram(code);
            edges = sd.transitions.map(t => ({ source: t.source, target: t.target, label: t.label || "", arrowType: "-->" }));
          } else if (tk === "classDiagram") {
            const cd = parseClassDiagram(code);
            edges = (cd.relationships || []).map(r => ({ source: r.source, target: r.target, label: r.label || "", arrowType: r.type || "--" }));
          }
          const frame = iframeRef.current;
          if (frame?.contentWindow && edges.length > 0) {
            // Use setTimeout to ensure positions are applied first
            setTimeout(() => {
              frame.contentWindow.postMessage(
                { channel: CHANNEL, type: "edges:draw", payload: { edges, diagramType: tk } },
                "*"
              );
            }, 50);
          }
        }

        // Apply style overrides after render (with delay for edges to draw first)
        if (Object.keys(styleOverrides).length > 0) {
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            setTimeout(() => {
              frame.contentWindow.postMessage(
                { channel: CHANNEL, type: "apply:styles", payload: { overrides: styleOverrides } },
                "*"
              );
            }, 100);
          }
        }
      }

      if (data.type === "render:error") {
        setRenderStatus("error");
        setRenderMessage(data.payload?.message || "Render failed");
      }

      if (data.type === "element:selected") {
        const selected = data.payload || null;
        setSelectedElement(selected);
        setLabelDraft(selected?.label || "");
        setHighlightLine(getMatchingLine(code, selected?.label || selected?.id || ""));

        if (selected?.elementType === "node" && selected?.screenBox && selected?.nodeId) {
          const ir = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
          setStyleToolbar({
            nodeId: selected.nodeId,
            x: ir.left + (selected.screenBox.left + selected.screenBox.right) / 2,
            y: ir.top + selected.screenBox.top,
            yBottom: ir.top + selected.screenBox.bottom,
            activeDropdown: null,
          });
        } else {
          setStyleToolbar(null);
        }
      }

      if (data.type === "element:context") {
        const selected = data.payload || null;
        setSelectedElement(selected);
        setLabelDraft(selected?.label || "");
        setHighlightLine(getMatchingLine(code, selected?.label || selected?.id || ""));

        if (toolsetKey === "gantt" && selected) {
          setContextMenu({ type: "gantt", label: selected.label });
        } else {
          const elementType = selected?.elementType || "canvas";

          if (elementType === "node") {
            const nodeId = selected?.nodeId || "";
            setStyleToolbar(null);
            setNodeEditModal(buildNodeEditData(nodeId));
          } else if (elementType === "edge") {
            // Open full modal for edge editing
            const src = selected?.edgeSource || "";
            const tgt = selected?.edgeTarget || "";
            let arrowType = "-->";
            if (toolsetKey === "flowchart") {
              const edge = flowchartData.edges.find(e => e.source === src && e.target === tgt);
              if (edge) arrowType = edge.arrowType || "-->";
            }
            setNodeEditModal({
              type: "edge",
              edgeSource: src,
              edgeTarget: tgt,
              label: selected?.label || "",
              arrowType,
            });
          } else if (elementType === "canvas") {
            // Canvas right-click: keep as small context menu
            const iframeRect = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
            const menuX = iframeRect.left + (selected?.pointerX || 0);
            const menuY = iframeRect.top + (selected?.pointerY || 0);
            setContextMenu({
              type: "canvas",
              label: selected?.label || "",
              x: menuX,
              y: menuY,
            });
          } else {
            setDrawerOpen(true);
          }
        }
      }

      if (data.type === "element:dragged") {
        setStyleToolbar(null);
        const payload = data.payload || {};
        if (!payload.isGanttTask && payload.nodeId) {
          // Store accumulated position override from iframe (SVG-space values)
          setPositionOverrides((prev) => ({
            ...prev,
            [payload.nodeId]: {
              dx: payload.accumulatedDx || 0,
              dy: payload.accumulatedDy || 0,
            },
          }));
        }
        setDragFeedback(
          `Dragged ${payload.label || payload.id || "element"} by ${Math.round(payload.deltaX || 0)}px x ${Math.round(
            payload.deltaY || 0
          )}px`
        );
      }

      if (data.type === "zoom:changed") {
        setZoomLevel(data.payload?.zoom || 1);
        setStyleToolbar(null);
      }

      if (data.type === "port:clicked") {
        const payload = data.payload || {};
        const { nodeId, port } = payload;
        if (!nodeId) return;
        setNodeCreationForm({ sourceNodeId: nodeId, port, label: "", description: "" });
      }

      if (data.type === "edge:reconnect") {
        const payload = data.payload || {};
        const { end, srcNodeId, tgtNodeId, newNodeId } = payload;
        if (!srcNodeId || !tgtNodeId || !newNodeId) return;
        if (newNodeId === srcNodeId || newNodeId === tgtNodeId) return;
        if (toolsetKey === "flowchart") {
          let updated = removeFlowchartEdge(code, srcNodeId, tgtNodeId);
          if (end === "source") {
            updated = addFlowchartEdge(updated, { source: newNodeId, target: tgtNodeId });
            setRenderMessage("Reconnected edge: " + newNodeId + " --> " + tgtNodeId);
          } else {
            updated = addFlowchartEdge(updated, { source: srcNodeId, target: newNodeId });
            setRenderMessage("Reconnected edge: " + srcNodeId + " --> " + newNodeId);
          }
          setCode(updated);
          setPositionOverrides({});
        }
      }

      if (data.type === "connect:complete") {
        const payload = data.payload || {};
        if (payload.sourceId && payload.targetId) {
          setCode((prev) => addFlowchartEdge(prev, { source: payload.sourceId, target: payload.targetId }));
          setRenderMessage(`Added edge ${payload.sourceId} --> ${payload.targetId}`);
        }
        setConnectMode(null);
        // Tell iframe to exit connect mode
        const frame = iframeRef.current;
        if (frame?.contentWindow) {
          frame.contentWindow.postMessage({ channel: CHANNEL, type: "mode:normal" }, "*");
        }
      }

      if (data.type === "gantt:dragged") {
        const payload = data.payload || {};
        const task = findTaskByLabel(ganttTasks, payload.label || "");
        if (!task) {
          setRenderMessage("Drag captured, but no matching Gantt task found");
          return;
        }
        if (!task.hasExplicitDate || !task.durationDays || !payload.barWidth) {
          setRenderMessage("Task uses dependency-based dates; use right-click edit to set date manually");
          return;
        }

        const pixelsPerDay = payload.barWidth / task.durationDays;
        const dayShift = Math.round((payload.deltaX || 0) / pixelsPerDay);
        if (!dayShift) return;

        const dragMode = payload.dragMode || "shift";
        if (dragMode === "resize-end") {
          const currentEnd = task.endDate || shiftIsoDate(task.startDate, task.durationDays);
          const nextEnd = shiftIsoDate(currentEnd, dayShift);
          setCode((prev) => updateGanttTask(prev, task, { endDate: nextEnd }));
          setRenderMessage(`Updated "${task.label}" end date to ${nextEnd}`);
        } else if (dragMode === "resize-start") {
          const nextStart = shiftIsoDate(task.startDate, dayShift);
          setCode((prev) => updateGanttTask(prev, task, { startDate: nextStart }));
          setRenderMessage(`Updated "${task.label}" start date to ${nextStart}`);
        } else {
          const nextStart = shiftIsoDate(task.startDate, dayShift);
          const updates = { startDate: nextStart };
          if (task.endDate) {
            updates.endDate = shiftIsoDate(task.endDate, dayShift);
          }
          setCode((prev) => updateGanttTask(prev, task, updates));
          setRenderMessage(`Updated "${task.label}" to ${nextStart}`);
        }
        setHighlightLine(task.lineIndex + 1);
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [code, ganttTasks, toolsetKey, showDates, positionOverrides, flowchartData]);

  /* ── Re-annotate on showDates toggle ─────────────────── */
  useEffect(() => {
    if (toolsetKey !== "gantt") return;
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const tasks = parseGanttTasks(code);
    const annotationData = tasks.map((t) => {
      let computedEnd = t.endDate || "";
      if (!computedEnd && t.startDate && t.durationDays) {
        const d = new Date(t.startDate + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() + t.durationDays);
        computedEnd = d.toISOString().slice(0, 10);
      }
      return { label: t.label, startDate: t.startDate, endDate: t.endDate, durationDays: t.durationDays, computedEnd, assignee: t.assignee || "", statusTokens: t.statusTokens || [] };
    });
    frame.contentWindow.postMessage(
      { channel: CHANNEL, type: "gantt:annotate", payload: { tasks: annotationData, showDates } },
      "*"
    );
  }, [showDates, toolsetKey]);

  /* ── Re-apply grid toggle on change ─────────────────── */
  useEffect(() => {
    if (toolsetKey !== "gantt") return;
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      { channel: CHANNEL, type: "gantt:grid", payload: { show: showGrid } },
      "*"
    );
  }, [showGrid, toolsetKey]);

  /* ── Resizable divider ───────────────────────────────── */
  const onDividerPointerDown = (e) => {
    e.preventDefault();
    const workspace = document.querySelector(".workspace");
    if (!workspace) return;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEvent) => {
      const rect = workspace.getBoundingClientRect();
      const pct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(Math.max(pct, 15), 55);
      setEditorWidth(clamped);
    };

    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  /* ── Outside click for export dropdown ───────────────── */
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [exportMenuOpen]);

  /* ── Escape key handler ──────────────────────────────── */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        if (connectMode) {
          setConnectMode(null);
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage({ channel: CHANNEL, type: "mode:normal" }, "*");
          }
          return;
        }
        if (styleToolbar) { setStyleToolbar(null); return; }
        if (nodeEditModal) { setNodeEditModal(null); return; }
        if (nodeCreationForm) { setNodeCreationForm(null); return; }
        if (contextMenu) { setContextMenu(null); return; }
        if (shapePickerNode) { setShapePickerNode(null); return; }
        if (edgeLabelEdit) { setEdgeLabelEdit(null); return; }
        if (presentMode) { setPresentMode(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (drawerOpen) { setDrawerOpen(false); return; }
        if (exportMenuOpen) { setExportMenuOpen(false); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenu, presentMode, settingsOpen, drawerOpen, exportMenuOpen, connectMode, shapePickerNode, edgeLabelEdit, nodeEditModal, nodeCreationForm, styleToolbar]);

  /* ── Style Toolbar ──────────────────────────────────── */
  const applyToolbarStyle = (nodeId, stylePatch) => {
    setStyleOverrides((prev) => {
      const current = { ...(prev[nodeId] || {}) };
      for (const [k, v] of Object.entries(stylePatch)) {
        if (v === null) delete current[k];
        else current[k] = v;
      }
      const next = { ...prev };
      if (Object.keys(current).length > 0) next[nodeId] = current;
      else delete next[nodeId];
      const frame = iframeRef.current;
      if (frame?.contentWindow) {
        frame.contentWindow.postMessage(
          { channel: CHANNEL, type: "apply:styles", payload: { overrides: { [nodeId]: current } } },
          "*"
        );
      }
      return next;
    });
  };

  /* ── Actions ─────────────────────────────────────────── */
  const insertSnippet = (snippet) => {
    const editor = editorRef.current;
    if (!editor) {
      setCode((prev) => `${prev}\n${snippet}`);
      return;
    }

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const next = `${code.slice(0, start)}${snippet}${code.slice(end)}`;
    setCode(next);
    window.requestAnimationFrame(() => {
      editor.focus();
      editor.selectionStart = start + snippet.length;
      editor.selectionEnd = start + snippet.length;
    });
  };

  const applyLabelPatch = () => {
    if (!selectedElement?.label || !labelDraft.trim()) return;
    const updated = replaceFirstLabel(code, selectedElement.label, labelDraft.trim());
    setCode(updated);
  };

  const applyGanttTaskPatch = () => {
    if (!selectedGanttTask) return;
    const nextLabel = ganttDraft.label.trim();
    if (!nextLabel) return;

    const nextStartDate = ganttDraft.startDate.trim();
    const nextEndDate = ganttDraft.endDate.trim();
    let updated = updateGanttTask(code, selectedGanttTask, {
      label: nextLabel,
      startDate: nextStartDate || selectedGanttTask.startDate,
      endDate: nextEndDate,
    });

    // Apply status changes: clear existing, then add desired flags
    const freshTasks = parseGanttTasks(updated);
    const freshTask = findTaskByLabel(freshTasks, nextLabel);
    if (freshTask) {
      updated = clearGanttStatus(updated, freshTask);
      for (const flag of ganttDraft.status) {
        const currentTasks = parseGanttTasks(updated);
        const currentTask = findTaskByLabel(currentTasks, nextLabel);
        if (currentTask) updated = toggleGanttStatus(updated, currentTask, flag);
      }
    }

    // Apply assignee
    const assigneeTasks = parseGanttTasks(updated);
    const assigneeTask = findTaskByLabel(assigneeTasks, nextLabel);
    if (assigneeTask) {
      updated = updateGanttAssignee(updated, assigneeTask, ganttDraft.assignee.trim());
    }

    // Apply notes
    const notesTasks = parseGanttTasks(updated);
    const notesTask = findTaskByLabel(notesTasks, nextLabel);
    if (notesTask) {
      updated = updateGanttNotes(updated, notesTask, ganttDraft.notes.trim());
    }

    setCode(updated);
    setRenderMessage(`Updated "${nextLabel}"`);
    setHighlightLine(selectedGanttTask.lineIndex + 1);
  };

  const handleStatusToggle = (flag) => {
    const label = contextMenu?.label || selectedElement?.label;
    const task = findTaskByLabel(ganttTasks, label);
    if (!task) return;
    const updated = toggleGanttStatus(code, task, flag);
    setCode(updated);
    setRenderMessage(`Toggled "${flag}" on "${task.label}"`);
    setHighlightLine(task.lineIndex + 1);
  };

  const handleStatusClear = () => {
    const label = contextMenu?.label || selectedElement?.label;
    const task = findTaskByLabel(ganttTasks, label);
    if (!task) return;
    const updated = clearGanttStatus(code, task);
    setCode(updated);
    setRenderMessage(`Cleared status on "${task.label}"`);
    setHighlightLine(task.lineIndex + 1);
  };

  const replaceWithTemplate = () => {
    if (!activeTemplate?.starter) return;
    setCode(activeTemplate.starter);
    setSelectedElement(null);
    setHighlightLine(null);
    setDragFeedback("");
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(code);
    setRenderMessage("Mermaid code copied");
  };

  const copyEmbed = async () => {
    const embedDoc = `<!doctype html><html><body><div id="root"></div><script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";const code=${JSON.stringify(
      code
    )};mermaid.initialize({startOnLoad:false});const {svg}=await mermaid.render("embed",code);document.getElementById("root").innerHTML=svg;<\\/script></body></html>`;
    const embed = `<iframe title="Mermaid Flow Embed" style="width:100%;height:500px;border:0;" sandbox="allow-scripts" srcdoc="${escapeHtml(embedDoc)}"></iframe>`;
    await navigator.clipboard.writeText(embed);
    setRenderMessage("Iframe embed snippet copied");
  };

  const downloadSvg = () => {
    if (!renderSvg) return;
    const blob = new Blob([renderSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "diagram.svg";
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadPng = () => {
    if (!renderSvg) return;
    const blob = new Blob([renderSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width || 1600;
      canvas.height = img.height || 900;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return;
        const pngUrl = URL.createObjectURL(pngBlob);
        const link = document.createElement("a");
        link.href = pngUrl;
        link.download = "diagram.png";
        link.click();
        URL.revokeObjectURL(pngUrl);
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  /* ── Render ──────────────────────────────────────────── */
  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────────── */}
      <header className="top-strip">
        <div className="brand">
          <div className="brand-mark">MF</div>
          <h1>Mermaid Flow</h1>
        </div>

        <div className="toolbar">
          {/* Editor toggle */}
          <button
            className="icon-btn"
            title={editorCollapsed ? "Show editor" : "Hide editor"}
            onClick={() => setEditorCollapsed(!editorCollapsed)}
          >
            <IconSidebar />
          </button>

          <div className="toolbar-sep" />

          {/* Render (only when auto-render is off) */}
          {!autoRender && (
            <button className="soft-btn primary" onClick={postRender}>
              Render
            </button>
          )}

          {/* Export dropdown */}
          <div className="dropdown-wrap" ref={exportMenuRef}>
            <button
              className="soft-btn"
              onClick={() => setExportMenuOpen(!exportMenuOpen)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <IconExport />
                Export
              </span>
            </button>
            <div className={`dropdown-menu ${exportMenuOpen ? "open" : ""}`}>
              <button className="dropdown-item" onClick={() => { copyCode(); setExportMenuOpen(false); }}>
                Copy Mermaid code
              </button>
              <button className="dropdown-item" onClick={() => { copyEmbed(); setExportMenuOpen(false); }}>
                Copy iframe embed
              </button>
              <button className="dropdown-item" onClick={() => { downloadSvg(); setExportMenuOpen(false); }}>
                Download SVG
              </button>
              <button className="dropdown-item" onClick={() => { downloadPng(); setExportMenuOpen(false); }}>
                Download PNG
              </button>
            </div>
          </div>

          <div className="toolbar-sep" />

          {/* Quick Tools drawer */}
          <button
            className="icon-btn"
            title="Quick tools"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            <IconTools />
          </button>

          {/* Settings */}
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings />
          </button>

          {/* Present mode */}
          <button
            className="icon-btn"
            title="Present mode"
            onClick={() => setPresentMode(true)}
          >
            <IconPresent />
          </button>
        </div>
      </header>

      {/* ── Workspace ───────────────────────────────────── */}
      <section className="workspace">
        {/* Editor Panel */}
        <article
          className={`editor-panel ${editorCollapsed ? "collapsed" : ""}`}
          style={editorCollapsed ? undefined : { width: `${editorWidth}%` }}
        >
          <div className="panel-header">
            <h2>Code</h2>
            <span>{lineCount} lines &middot; {diagramType || "unknown"}</span>
          </div>
          <div className="editor-wrap">
            <pre className="line-gutter" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, idx) => {
                const line = idx + 1;
                return (
                  <span key={line} className={line === highlightLine ? "focus-line" : ""}>
                    {line}
                  </span>
                );
              })}
            </pre>
            <textarea
              ref={editorRef}
              value={code}
              onChange={(e) => { setCode(e.target.value); setPositionOverrides({}); }}
              spellCheck={false}
              className="code-area"
            />
          </div>
          <div className="panel-footer">
            <p className={`status-${renderStatus}`}>{renderMessage}</p>
            {dragFeedback && <p className="drag-note">{dragFeedback}</p>}
          </div>
        </article>

        {/* Resizable Divider */}
        {!editorCollapsed && (
          <div className="resize-divider" onPointerDown={onDividerPointerDown} />
        )}

        {/* Preview Panel */}
        <article className="preview-panel">
          <div className="panel-header">
            <h2>Preview</h2>
            <span className="preview-hint">
              {toolsetKey === "gantt" && (
                <>
                  <button
                    className="date-toggle-btn"
                    onClick={() => setShowGrid((prev) => !prev)}
                  >
                    {showGrid ? "Hide grid" : "Show grid"}
                  </button>
                  <button
                    className="date-toggle-btn"
                    onClick={() => setShowDates((prev) => !prev)}
                  >
                    {showDates ? "Hide dates" : "Show dates"}
                  </button>
                </>
              )}
              Click, right-click, and drag to edit
            </span>
          </div>
          <iframe
            ref={iframeRef}
            title="Mermaid preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            className="preview-frame"
          />
          <div className="zoom-controls">
            <button title="Zoom out" onClick={() => {
              const frame = iframeRef.current;
              if (frame?.contentWindow) {
                frame.contentWindow.postMessage({ channel: CHANNEL, type: "zoom:set", payload: { delta: -0.1 } }, "*");
              }
            }}>-</button>
            <span className="zoom-pct">{Math.round(zoomLevel * 100)}%</span>
            <button title="Zoom in" onClick={() => {
              const frame = iframeRef.current;
              if (frame?.contentWindow) {
                frame.contentWindow.postMessage({ channel: CHANNEL, type: "zoom:set", payload: { delta: 0.1 } }, "*");
              }
            }}>+</button>
            <button title="Reset zoom" onClick={() => {
              const frame = iframeRef.current;
              if (frame?.contentWindow) {
                frame.contentWindow.postMessage({ channel: CHANNEL, type: "zoom:reset" }, "*");
              }
            }} style={{ fontSize: 12 }}>Fit</button>
          </div>
        </article>
      </section>

      {/* ── Tools Drawer (Right Overlay) ────────────────── */}
      <div
        className={`tools-drawer-backdrop ${drawerOpen ? "open" : ""}`}
        onClick={() => setDrawerOpen(false)}
      />
      <aside className={`tools-drawer ${drawerOpen ? "open" : ""}`}>
        <div className="drawer-header">
          <h2>{toolsetKey === "gantt" ? "Gantt Editor" : "Quick Tools"}</h2>
          <button className="drawer-close-btn" onClick={() => setDrawerOpen(false)}>
            &times;
          </button>
        </div>

        {/* Snippet buttons */}
        <div className="tool-grid">
          {quickTools.map((tool) => (
            <button key={tool.label} className="tool-btn" onClick={() => insertSnippet(tool.snippet)}>
              {tool.label}
            </button>
          ))}
        </div>

        {/* Gantt Task Editor (replaces Selection card for Gantt) */}
        {toolsetKey === "gantt" ? (
          <div className="property-card">
            <h3>Task Editor</h3>
            {/* Task selector dropdown */}
            <label>
              Select task
              <select
                value={selectedGanttTask?.label || ""}
                onChange={(e) => {
                  const task = ganttTasks.find((t) => t.label === e.target.value);
                  if (task) {
                    setSelectedElement({ label: task.label, id: "" });
                  }
                }}
              >
                <option value="">-- pick a task --</option>
                {ganttTasks.map((t) => (
                  <option key={t.lineIndex} value={t.label}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            {selectedGanttTask ? (
              <>
                <label>
                  Task label
                  <input
                    value={ganttDraft.label}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, label: e.target.value }))}
                  />
                </label>
                <label>
                  Start date
                  <input
                    type="date"
                    value={ganttDraft.startDate}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                </label>
                <label>
                  End date
                  <input
                    type="date"
                    value={ganttDraft.endDate}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                </label>
                <label>
                  Assignee
                  <input
                    value={ganttDraft.assignee}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, assignee: e.target.value }))}
                    placeholder="e.g. Mohammed"
                  />
                </label>
                <label>Status</label>
                <div className="status-toggle-group">
                  {["done", "active", "crit"].map((flag) => {
                    const isOn = ganttDraft.status.includes(flag);
                    return (
                      <button
                        key={flag}
                        className={`status-toggle-btn ${isOn ? "on" : ""} status-${flag}`}
                        onClick={() => {
                          setGanttDraft((prev) => ({
                            ...prev,
                            status: prev.status.includes(flag) ? [] : [flag],
                          }));
                        }}
                      >
                        <span className={`status-check ${isOn ? "checked" : ""}`}>{isOn ? "\u2713" : ""}</span>
                        {flag === "crit" ? "Critical" : flag.charAt(0).toUpperCase() + flag.slice(1)}
                      </button>
                    );
                  })}
                </div>
                <button className="soft-btn primary full" onClick={applyGanttTaskPatch}>
                  Apply update
                </button>
              </>
            ) : (
              <p className="muted">Pick a task above or right-click one in the preview.</p>
            )}
          </div>
        ) : (
          /* Selection Inspector (non-Gantt diagrams) */
          <div className="property-card">
            <h3>Selection</h3>
            {selectedElement ? (
              <>
                <p><strong>Label:</strong> {selectedElement.label}</p>
                <p><strong>ID:</strong> {selectedElement.id || "n/a"}</p>
                <label>
                  New label
                  <input value={labelDraft} onChange={(e) => setLabelDraft(e.target.value)} />
                </label>
                <button className="soft-btn full" onClick={applyLabelPatch}>
                  Apply patch
                </button>
              </>
            ) : (
              <p className="muted">Pick an element in preview to edit properties.</p>
            )}
          </div>
        )}
      </aside>

      {/* ── Settings Modal ──────────────────────────────── */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <div className="settings-group">
              <label>
                Theme
                <select value={theme} onChange={(e) => setTheme(e.target.value)}>
                  <option value="default">Default</option>
                  <option value="neutral">Neutral</option>
                  <option value="base">Base</option>
                  <option value="dark">Dark</option>
                  <option value="forest">Forest</option>
                  <option value="neo">Neo</option>
                </select>
              </label>
              <label>
                Security Level
                <select value={securityLevel} onChange={(e) => setSecurityLevel(e.target.value)}>
                  <option value="strict">strict</option>
                  <option value="sandbox">sandbox</option>
                  <option value="loose">loose (for click callbacks)</option>
                </select>
              </label>
              <label>
                Layout Engine
                <select value={renderer} onChange={(e) => setRenderer(e.target.value)}>
                  <option value="dagre">dagre</option>
                  <option value="elk">elk</option>
                </select>
              </label>
              <label className="auto-toggle">
                <input
                  type="checkbox"
                  checked={autoRender}
                  onChange={(e) => setAutoRender(e.target.checked)}
                />
                Auto-render on code change
              </label>
            </div>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Gantt Task Edit Modal (right-click) ────────── */}
      {contextMenu?.type === "gantt" && (() => {
        const task = findTaskByLabel(ganttTasks, contextMenu.label);
        return (
          <div className="modal-backdrop" onClick={() => setContextMenu(null)}>
            <div className="task-modal" onClick={(e) => e.stopPropagation()}>
              <div className="task-modal-header">
                <h2>{ganttDraft.label || contextMenu.label}</h2>
                <button className="drawer-close-btn" onClick={() => setContextMenu(null)}>
                  &times;
                </button>
              </div>

              <div className="task-modal-body">
                <label>Status</label>
                <div className="status-toggle-group">
                  {["done", "active", "crit"].map((flag) => {
                    const isOn = ganttDraft.status.includes(flag);
                    return (
                      <button
                        key={flag}
                        className={`status-toggle-btn ${isOn ? "on" : ""} status-${flag}`}
                        onClick={() => {
                          setGanttDraft((prev) => ({
                            ...prev,
                            status: prev.status.includes(flag) ? [] : [flag],
                          }));
                        }}
                      >
                        <span className={`status-check ${isOn ? "checked" : ""}`}>{isOn ? "\u2713" : ""}</span>
                        <span className={`status-dot status-${flag}`} />
                        {flag === "crit" ? "Critical" : flag.charAt(0).toUpperCase() + flag.slice(1)}
                      </button>
                    );
                  })}
                </div>

                <label>
                  Assignee
                  <input
                    value={ganttDraft.assignee}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, assignee: e.target.value }))}
                    placeholder="e.g. Mohammed"
                  />
                </label>

                <label>
                  Task name
                  <input
                    value={ganttDraft.label}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, label: e.target.value }))}
                  />
                </label>

                <div className="task-modal-dates">
                  <label>
                    Start date
                    <input
                      type="date"
                      value={ganttDraft.startDate}
                      onChange={(e) => setGanttDraft((prev) => ({ ...prev, startDate: e.target.value }))}
                    />
                  </label>
                  <label>
                    End date
                    <input
                      type="date"
                      value={ganttDraft.endDate}
                      onChange={(e) => setGanttDraft((prev) => ({ ...prev, endDate: e.target.value }))}
                    />
                  </label>
                </div>

                <label>
                  Notes
                  <textarea
                    className="task-notes-input"
                    value={ganttDraft.notes}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Add notes about this task..."
                    rows={3}
                  />
                </label>
              </div>

              <div className="task-modal-actions">
                <button className="soft-btn" onClick={() => setContextMenu(null)}>
                  Cancel
                </button>
                <button
                  className="soft-btn primary"
                  onClick={() => { applyGanttTaskPatch(); setContextMenu(null); }}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Node Edit Modal (right-click on node) ──────── */}
      {nodeEditModal?.type === "node" && (() => {
        const adapter = getDiagramAdapter(toolsetKey);
        const isFlowchart = toolsetKey === "flowchart";
        const nodeLabel = adapter?.nodeLabel || "node";
        const conn = nodeEditModal.connections || { inputs: [], outputs: [] };
        const hasConnections = conn.inputs.length > 0 || conn.outputs.length > 0;
        return (
          <div className="modal-backdrop" onClick={() => setNodeEditModal(null)}>
            <div className="node-edit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="task-modal-header">
                <h2>Edit {nodeLabel} <span style={{ fontWeight: 400, color: "var(--ink-soft)", fontSize: "0.8em" }}>{nodeEditModal.nodeId}</span></h2>
                <button className="drawer-close-btn" onClick={() => setNodeEditModal(null)}>&times;</button>
              </div>
              <div className="task-modal-body">
                {/* Connected nodes navigation */}
                {hasConnections && (
                  <div className="node-nav-bar">
                    {conn.inputs.length > 0 && (
                      <div className="node-nav-section">
                        <span className="node-nav-label">&larr; From</span>
                        <div className="node-nav-group">
                          {conn.inputs.map((inp) => (
                            <button
                              key={inp.id}
                              className="node-nav-btn"
                              title={inp.label}
                              onClick={() => setNodeEditModal(buildNodeEditData(inp.id))}
                            >
                              {inp.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {conn.outputs.length > 0 && (
                      <div className="node-nav-section">
                        <span className="node-nav-label">To &rarr;</span>
                        <div className="node-nav-group">
                          {conn.outputs.map((out) => (
                            <button
                              key={out.id}
                              className="node-nav-btn"
                              title={out.label}
                              onClick={() => setNodeEditModal(buildNodeEditData(out.id))}
                            >
                              {out.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <label>
                  Label
                  <input
                    value={nodeEditModal.label}
                    onChange={(e) => setNodeEditModal((prev) => ({ ...prev, label: e.target.value }))}
                    autoFocus
                  />
                </label>
                {/* Flowchart description (body text after title) */}
                {nodeEditModal.description !== undefined && (
                  <label>
                    Description
                    <textarea
                      className="task-notes-input"
                      value={nodeEditModal.description}
                      onChange={(e) => setNodeEditModal((prev) => ({ ...prev, description: e.target.value }))}
                      placeholder="Additional content (each line becomes a new line in the node)..."
                      rows={5}
                    />
                  </label>
                )}
                {nodeEditModal.attributes && (
                  <>
                    <label>Attributes</label>
                    <div className="er-attr-list">
                      {nodeEditModal.attributes.map((attr, idx) => (
                        <div key={idx} className="er-attr-row">
                          <input
                            value={attr}
                            onChange={(e) => {
                              setNodeEditModal((prev) => {
                                const attrs = [...prev.attributes];
                                attrs[idx] = e.target.value;
                                return { ...prev, attributes: attrs };
                              });
                            }}
                          />
                          <button className="er-attr-remove" onClick={() => {
                            setNodeEditModal((prev) => ({
                              ...prev,
                              attributes: prev.attributes.filter((_, i) => i !== idx),
                            }));
                          }}>&times;</button>
                        </div>
                      ))}
                      <button className="soft-btn" style={{ marginTop: 4 }} onClick={() => {
                        setNodeEditModal((prev) => ({
                          ...prev,
                          attributes: [...prev.attributes, "string new_field"],
                        }));
                      }}>+ Add attribute</button>
                    </div>
                  </>
                )}
              </div>
              <div className="task-modal-actions">
                <button className="soft-btn" onClick={() => setNodeEditModal(null)}>Cancel</button>
                <button className="soft-btn" onClick={() => {
                  setConnectMode({ sourceId: nodeEditModal.nodeId });
                  const frame = iframeRef.current;
                  if (frame?.contentWindow) {
                    frame.contentWindow.postMessage(
                      { channel: CHANNEL, type: "mode:connect", payload: { sourceId: nodeEditModal.nodeId } },
                      "*"
                    );
                  }
                  setNodeEditModal(null);
                  setRenderMessage(`Connect mode: click target node for edge from "${nodeEditModal.nodeId}"`);
                }}>
                  Connect to...
                </button>
                <button className="soft-btn danger" onClick={() => {
                  if (isFlowchart) {
                    setCode((prev) => removeFlowchartNode(prev, nodeEditModal.nodeId));
                  } else if (adapter?.removeNode) {
                    setCode((prev) => adapter.removeNode(prev, nodeEditModal.nodeId));
                  }
                  setPositionOverrides({});
                  setRenderMessage(`Deleted ${nodeLabel} "${nodeEditModal.nodeId}"`);
                  setNodeEditModal(null);
                }}>
                  Delete
                </button>
                <button className="soft-btn primary" onClick={() => {
                  if (toolsetKey === "erDiagram" && nodeEditModal.attributes) {
                    setCode((prev) => updateErEntity(prev, nodeEditModal.nodeId, {
                      newName: nodeEditModal.label,
                      attributes: nodeEditModal.attributes,
                    }));
                  } else if (isFlowchart) {
                    // Recombine label + description with <br> tags
                    let combinedLabel = nodeEditModal.label || "";
                    if (nodeEditModal.description) {
                      combinedLabel += "<br>" + nodeEditModal.description.split("\n").join("<br>");
                    }
                    const updates = { label: combinedLabel };
                    setCode((prev) => updateFlowchartNode(prev, nodeEditModal.nodeId, updates));
                  } else {
                    setCode((prev) => replaceFirstLabel(prev, selectedElement?.label || "", nodeEditModal.label));
                  }
                  setPositionOverrides({});
                  setRenderMessage(`Updated ${nodeLabel} "${nodeEditModal.nodeId}"`);
                  setNodeEditModal(null);
                }}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Node Creation Form (from + port click) ──── */}
      {nodeCreationForm && (
        <div className="modal-backdrop" onClick={() => setNodeCreationForm(null)}>
          <div className="node-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-header">
              <h2>Create Node</h2>
              <button className="drawer-close-btn" onClick={() => setNodeCreationForm(null)}>&times;</button>
            </div>
            <div className="task-modal-body">
              <label>
                Label
                <input
                  value={nodeCreationForm.label}
                  onChange={(e) => setNodeCreationForm((prev) => ({ ...prev, label: e.target.value }))}
                  autoFocus
                  placeholder="Node name..."
                />
              </label>
              <label>
                Description
                <textarea
                  className="task-notes-input"
                  value={nodeCreationForm.description}
                  onChange={(e) => setNodeCreationForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Optional description..."
                  rows={3}
                />
              </label>
            </div>
            <div className="task-modal-actions">
              <button className="soft-btn" onClick={() => setNodeCreationForm(null)}>Cancel</button>
              <button className="soft-btn primary" onClick={() => {
                if (toolsetKey === "flowchart") {
                  const parsed = parseFlowchart(code);
                  const newId = generateNodeId(parsed.nodes);
                  let combinedLabel = nodeCreationForm.label || "New Node";
                  if (nodeCreationForm.description) {
                    combinedLabel += "<br>" + nodeCreationForm.description.split("\n").join("<br>");
                  }
                  let newCode = addFlowchartNode(code, { id: newId, label: combinedLabel, shape: "rect" });
                  const { sourceNodeId, port } = nodeCreationForm;
                  if (port === "left" || port === "top") {
                    newCode = addFlowchartEdge(newCode, { source: newId, target: sourceNodeId });
                  } else {
                    newCode = addFlowchartEdge(newCode, { source: sourceNodeId, target: newId });
                  }
                  setCode(newCode);
                  setPositionOverrides({});
                  setRenderMessage("Added node " + newId + " connected to " + sourceNodeId);
                } else {
                  const adapter = getDiagramAdapter(toolsetKey);
                  if (adapter?.addNode && adapter?.addEdge) {
                    const newId = "New" + Date.now().toString(36).slice(-4);
                    let combinedLabel = nodeCreationForm.label || "New " + (adapter.nodeLabel || "node");
                    let newCode = adapter.addNode(code, { id: newId, name: newId, label: combinedLabel, type: "participant" });
                    newCode = adapter.addEdge(newCode, { source: nodeCreationForm.sourceNodeId, target: newId, label: "" });
                    setCode(newCode);
                    setPositionOverrides({});
                    setRenderMessage("Added " + (adapter.nodeLabel || "node") + " " + newId);
                  }
                }
                setNodeCreationForm(null);
              }}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edge Edit Modal (right-click on edge) ────── */}
      {nodeEditModal?.type === "edge" && (() => {
        const arrowTypes = ["-->", "--->", "-.->", "==>", "---", "-.-", "==="];
        return (
          <div className="modal-backdrop" onClick={() => setNodeEditModal(null)}>
            <div className="node-edit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="task-modal-header">
                <h2>Edit Edge</h2>
                <button className="drawer-close-btn" onClick={() => setNodeEditModal(null)}>&times;</button>
              </div>
              <div className="task-modal-body">
                <label>
                  Label
                  <input
                    value={nodeEditModal.label}
                    onChange={(e) => setNodeEditModal((prev) => ({ ...prev, label: e.target.value }))}
                    placeholder="e.g. Yes, No..."
                    autoFocus
                  />
                </label>
                {toolsetKey === "flowchart" && (
                  <>
                    <label>Arrow Style</label>
                    <div className="arrow-type-grid">
                      {arrowTypes.map((arrow) => (
                        <button
                          key={arrow}
                          className={`arrow-type-btn ${nodeEditModal.arrowType === arrow ? "active" : ""}`}
                          onClick={() => setNodeEditModal((prev) => ({ ...prev, arrowType: arrow }))}
                        >
                          {arrow}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <p style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  {nodeEditModal.edgeSource} {nodeEditModal.arrowType || "-->"} {nodeEditModal.edgeTarget}
                </p>
              </div>
              <div className="task-modal-actions">
                <button className="soft-btn" onClick={() => setNodeEditModal(null)}>Cancel</button>
                <button className="soft-btn danger" onClick={() => {
                  setCode((prev) => removeFlowchartEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget));
                  setPositionOverrides({});
                  setRenderMessage(`Deleted edge ${nodeEditModal.edgeSource} --> ${nodeEditModal.edgeTarget}`);
                  setNodeEditModal(null);
                }}>
                  Delete
                </button>
                <button className="soft-btn primary" onClick={() => {
                  const updates = {};
                  if (nodeEditModal.label !== undefined) updates.label = nodeEditModal.label;
                  if (nodeEditModal.arrowType) updates.arrowType = nodeEditModal.arrowType;
                  setCode((prev) => updateFlowchartEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget, updates));
                  setRenderMessage("Updated edge");
                  setNodeEditModal(null);
                }}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Floating Style Toolbar ─────────────────────── */}
      {styleToolbar && (() => {
        const existingStyle = styleOverrides[styleToolbar.nodeId] || {};
        const isFlowchart = toolsetKey === "flowchart";
        const toolbarHeight = 40;
        const gap = 8;
        let top = styleToolbar.y - toolbarHeight - gap;
        if (top < 8) top = styleToolbar.yBottom + gap;
        const left = styleToolbar.x;
        const classDefs = isFlowchart ? parseClassDefs(code) : [];

        return (
          <div
            className="style-toolbar"
            style={{ top, left, transform: "translateX(-50%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Edit */}
            <button
              className="style-toolbar-btn"
              title="Edit label & description"
              onClick={() => {
                const data = buildNodeEditData(styleToolbar.nodeId);
                setStyleToolbar(null);
                setNodeEditModal(data);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>

            <div className="style-toolbar-sep" />

            {/* Fill Color */}
            <button
              className={`style-toolbar-btn${styleToolbar.activeDropdown === "fill" ? " active" : ""}`}
              title="Fill color"
              onClick={() => setStyleToolbar((prev) => prev ? { ...prev, activeDropdown: prev.activeDropdown === "fill" ? null : "fill" } : null)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
              </svg>
              {existingStyle.fill && <span className="style-toolbar-indicator" style={{ backgroundColor: existingStyle.fill }} />}
            </button>

            {/* Border Color */}
            <button
              className={`style-toolbar-btn${styleToolbar.activeDropdown === "stroke" ? " active" : ""}`}
              title="Border color"
              onClick={() => setStyleToolbar((prev) => prev ? { ...prev, activeDropdown: prev.activeDropdown === "stroke" ? null : "stroke" } : null)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
              {existingStyle.stroke && <span className="style-toolbar-indicator" style={{ backgroundColor: existingStyle.stroke }} />}
            </button>

            {/* Border Style */}
            <button
              className={`style-toolbar-btn${styleToolbar.activeDropdown === "borderStyle" ? " active" : ""}`}
              title="Border style"
              onClick={() => setStyleToolbar((prev) => prev ? { ...prev, activeDropdown: prev.activeDropdown === "borderStyle" ? null : "borderStyle" } : null)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 3">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </button>

            {/* Text Color */}
            <button
              className={`style-toolbar-btn${styleToolbar.activeDropdown === "textColor" ? " active" : ""}`}
              title="Text color"
              onClick={() => setStyleToolbar((prev) => prev ? { ...prev, activeDropdown: prev.activeDropdown === "textColor" ? null : "textColor" } : null)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 7 4 4 20 4 20 7" />
                <line x1="9.5" y1="20" x2="14.5" y2="20" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
              {existingStyle.textColor && <span className="style-toolbar-indicator" style={{ backgroundColor: existingStyle.textColor }} />}
            </button>

            <div className="style-toolbar-sep" />

            {/* Duplicate (flowchart only) */}
            {isFlowchart && (
              <button
                className="style-toolbar-btn"
                title="Duplicate node"
                onClick={() => {
                  const node = flowchartData.nodes.find((n) => n.id === styleToolbar.nodeId);
                  if (node) {
                    const newId = generateNodeId(flowchartData.nodes);
                    setCode((prev) => addFlowchartNode(prev, { id: newId, label: node.label || styleToolbar.nodeId, shape: node.shape || "rect" }));
                    setPositionOverrides({});
                    setRenderMessage(`Duplicated "${styleToolbar.nodeId}" as "${newId}"`);
                  }
                  setStyleToolbar(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            )}

            {/* Delete */}
            <button
              className="style-toolbar-btn danger"
              title="Delete node"
              onClick={() => {
                const adapter = getDiagramAdapter(toolsetKey);
                if (isFlowchart) {
                  setCode((prev) => removeFlowchartNode(prev, styleToolbar.nodeId));
                } else if (adapter?.removeNode) {
                  setCode((prev) => adapter.removeNode(prev, styleToolbar.nodeId));
                }
                setPositionOverrides({});
                setRenderMessage(`Deleted "${styleToolbar.nodeId}"`);
                setStyleToolbar(null);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>

            {/* ── Dropdown Panels ────────────────────── */}
            {styleToolbar.activeDropdown === "fill" && (
              <div className="style-toolbar-dropdown">
                <div className="color-palette">
                  {STYLE_PALETTE.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch${existingStyle.fill === color ? " active" : ""}`}
                      style={{ backgroundColor: color }}
                      title={color}
                      onClick={() => applyToolbarStyle(styleToolbar.nodeId, { fill: color })}
                    />
                  ))}
                </div>
                {existingStyle.fill && (
                  <button className="style-toolbar-clear" onClick={() => applyToolbarStyle(styleToolbar.nodeId, { fill: null })}>
                    Clear fill
                  </button>
                )}
                {classDefs.length > 0 && (
                  <div className="classdef-section">
                    <span className="style-toolbar-section-label">Your Styles</span>
                    <div className="classdef-list">
                      {classDefs.map((cd) => (
                        <button
                          key={cd.name}
                          className="classdef-btn"
                          title={cd.name}
                          onClick={() => {
                            const patch = {};
                            if (cd.fill) patch.fill = cd.fill;
                            if (cd.stroke) patch.stroke = cd.stroke;
                            if (cd.color) patch.textColor = cd.color;
                            applyToolbarStyle(styleToolbar.nodeId, patch);
                          }}
                        >
                          <span className="classdef-preview" style={{ backgroundColor: cd.fill || "#e2e8f0", borderColor: cd.stroke || "#94a3b8" }} />
                          <span className="classdef-name">{cd.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {styleToolbar.activeDropdown === "stroke" && (
              <div className="style-toolbar-dropdown">
                <div className="color-palette">
                  {STYLE_PALETTE.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch${existingStyle.stroke === color ? " active" : ""}`}
                      style={{ backgroundColor: color }}
                      title={color}
                      onClick={() => applyToolbarStyle(styleToolbar.nodeId, { stroke: color })}
                    />
                  ))}
                </div>
                {existingStyle.stroke && (
                  <button className="style-toolbar-clear" onClick={() => applyToolbarStyle(styleToolbar.nodeId, { stroke: null })}>
                    Clear border color
                  </button>
                )}
              </div>
            )}

            {styleToolbar.activeDropdown === "borderStyle" && (
              <div className="style-toolbar-dropdown">
                <div className="border-style-grid">
                  {[
                    { value: "solid", label: "Solid", icon: "\u2500\u2500\u2500" },
                    { value: "dashed", label: "Dashed", icon: "- - -" },
                    { value: "none", label: "None", icon: "\u00a0" },
                  ].map(({ value, label, icon }) => (
                    <button
                      key={value}
                      className={`border-style-btn${(existingStyle.strokeStyle || "solid") === value ? " active" : ""}`}
                      onClick={() => applyToolbarStyle(styleToolbar.nodeId, { strokeStyle: value })}
                    >
                      <span className="border-style-icon">{icon}</span>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {styleToolbar.activeDropdown === "textColor" && (
              <div className="style-toolbar-dropdown">
                <div className="color-palette">
                  {STYLE_PALETTE.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch${existingStyle.textColor === color ? " active" : ""}`}
                      style={{ backgroundColor: color }}
                      title={color}
                      onClick={() => applyToolbarStyle(styleToolbar.nodeId, { textColor: color })}
                    />
                  ))}
                </div>
                {existingStyle.textColor && (
                  <button className="style-toolbar-clear" onClick={() => applyToolbarStyle(styleToolbar.nodeId, { textColor: null })}>
                    Clear text color
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Canvas Context Menu (right-click on empty area) */}
      {contextMenu?.type === "canvas" && (() => {
        const adapter = getDiagramAdapter(toolsetKey);
        const isFlowchart = toolsetKey === "flowchart";
        return (
          <div className="context-menu-backdrop" onClick={() => setContextMenu(null)}>
            <div
              className="context-menu"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e) => e.stopPropagation()}
            >
              {isFlowchart && (
                <>
                  <button className="context-menu-item" onClick={() => {
                    const newId = generateNodeId(flowchartData.nodes);
                    setCode((prev) => addFlowchartNode(prev, { id: newId, label: "New Node", shape: "rect" }));
                    setPositionOverrides({});
                    setRenderMessage(`Added node "${newId}"`);
                    setContextMenu(null);
                  }}>
                    Add node
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    const newId = generateNodeId(flowchartData.nodes);
                    setCode((prev) => addFlowchartNode(prev, { id: newId, label: "Decision?", shape: "diamond" }));
                    setPositionOverrides({});
                    setRenderMessage(`Added decision "${newId}"`);
                    setContextMenu(null);
                  }}>
                    Add decision
                  </button>
                </>
              )}
              {adapter && !isFlowchart && (
                <button className="context-menu-item" onClick={() => {
                  const newId = `New${Date.now().toString(36).slice(-4)}`;
                  if (adapter.addNode) {
                    setCode((prev) => adapter.addNode(prev, { id: newId, name: newId, label: `New ${adapter.nodeLabel}`, type: "participant" }));
                  }
                  setPositionOverrides({});
                  setRenderMessage(`Added ${adapter.nodeLabel}`);
                  setContextMenu(null);
                }}>
                  Add {adapter.nodeLabel}
                </button>
              )}
              {!isFlowchart && !adapter && (
                <button className="context-menu-item" onClick={() => {
                  setDrawerOpen(true);
                  setContextMenu(null);
                }}>
                  Open quick tools
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Shape Picker Modal ──────────────────────────── */}
      {shapePickerNode && (
        <div className="modal-backdrop" onClick={() => setShapePickerNode(null)}>
          <div className="modal-card shape-picker" onClick={(e) => e.stopPropagation()}>
            <h2>Change Shape</h2>
            <div className="shape-grid">
              {[
                { shape: "rect", label: "Rectangle", icon: "[ ]" },
                { shape: "rounded", label: "Rounded", icon: "( )" },
                { shape: "stadium", label: "Stadium", icon: "([ ])" },
                { shape: "diamond", label: "Diamond", icon: "{ }" },
                { shape: "circle", label: "Circle", icon: "(( ))" },
                { shape: "hexagon", label: "Hexagon", icon: "{{ }}" },
                { shape: "subroutine", label: "Subroutine", icon: "[[ ]]" },
                { shape: "cylinder", label: "Cylinder", icon: "[( )]" },
                { shape: "parallelogram", label: "Parallelogram", icon: "[/ /]" },
              ].map(({ shape, label, icon }) => (
                <button
                  key={shape}
                  className="shape-btn"
                  onClick={() => {
                    setCode((prev) => updateFlowchartNode(prev, shapePickerNode, { shape }));
                    setPositionOverrides({});
                    setRenderMessage(`Changed "${shapePickerNode}" to ${label}`);
                    setShapePickerNode(null);
                  }}
                >
                  <span className="shape-icon">{icon}</span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setShapePickerNode(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edge Label Editor ───────────────────────────── */}
      {edgeLabelEdit && (
        <div className="modal-backdrop" onClick={() => setEdgeLabelEdit(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>Edge Label</h2>
            <label>
              Label
              <input
                value={edgeLabelEdit.label}
                onChange={(e) => setEdgeLabelEdit((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="e.g. Yes, No, label..."
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setEdgeLabelEdit(null)}>Cancel</button>
              <button className="soft-btn primary" onClick={() => {
                setCode((prev) => updateFlowchartEdge(prev, edgeLabelEdit.source, edgeLabelEdit.target, { label: edgeLabelEdit.label }));
                setRenderMessage(`Updated edge label`);
                setEdgeLabelEdit(null);
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Connect Mode Banner ─────────────────────────── */}
      {connectMode && (
        <div className="connect-mode-banner">
          <span>Connect mode: click a target node to create edge from <strong>{connectMode.sourceId}</strong></span>
          <button className="soft-btn" onClick={() => {
            setConnectMode(null);
            const frame = iframeRef.current;
            if (frame?.contentWindow) {
              frame.contentWindow.postMessage({ channel: CHANNEL, type: "mode:normal" }, "*");
            }
          }}>Cancel</button>
        </div>
      )}

      {/* ── Present Mode ────────────────────────────────── */}
      {presentMode && (
        <div className="present-mode">
          <div className="present-toolbar">
            <button className="soft-btn" onClick={() => setPresentMode(false)}>
              Exit
            </button>
            <button className="soft-btn" onClick={downloadSvg}>
              SVG
            </button>
            <button className="soft-btn" onClick={downloadPng}>
              PNG
            </button>
          </div>
          <iframe
            title="Mermaid present"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            ref={(el) => {
              if (!el) return;
              const onLoad = () => {
                el.contentWindow?.postMessage(
                  {
                    channel: CHANNEL,
                    type: "render",
                    payload: {
                      code,
                      config: {
                        theme,
                        securityLevel,
                        flowchart: { defaultRenderer: renderer },
                      },
                    },
                  },
                  "*"
                );
              };
              el.addEventListener("load", onLoad, { once: true });
            }}
          />
        </div>
      )}
    </main>
  );
}

export default App;
