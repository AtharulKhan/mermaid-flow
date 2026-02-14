import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";
import { findTaskByLabel, parseGanttTasks, shiftIsoDate, updateGanttTask, toggleGanttStatus, clearGanttStatus, updateGanttAssignee, updateGanttNotes } from "./ganttUtils";
import { parseFlowchart, findNodeById, generateNodeId, addFlowchartNode, removeFlowchartNode, updateFlowchartNode, addFlowchartEdge, removeFlowchartEdge, updateFlowchartEdge } from "./flowchartUtils";
import { getDiagramAdapter } from "./diagramUtils";

const CHANNEL = "mermaid-flow";

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
      }
      #canvas > svg {
        width: 100%;
        height: auto;
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
      .sectionTitle { font-weight: 600 !important; fill: #374151 !important; font-size: 13px !important; }
      .sectionTitle0,.sectionTitle1,.sectionTitle2,.sectionTitle3 { font-weight: 600 !important; }
      /* Gantt grid lines */
      .grid .tick line { stroke: #e5e7eb !important; stroke-dasharray: 4 2; opacity: 0.5; }
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
        return "canvas";
      };

      const getNodeShortId = (svgId) => {
        if (!svgId) return "";
        // flowchart-A-0 → A, flowchart-NodeName-123 → NodeName
        const m = svgId.match(/^flowchart-(.+?)-\\d+$/);
        return m ? m[1] : svgId;
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
        // Build list of moved nodes with their ORIGINAL bounding boxes
        const movedNodes = [];
        const skipSel = "g.node, g.entity, g.classGroup, g.cluster, g.mindmap-node, g.stateGroup, defs, marker";
        for (const [nodeId, offset] of Object.entries(positionOverrides)) {
          const el = svg.querySelector("#" + CSS.escape(nodeId));
          if (!el) continue;
          try {
            const bbox = el.getBBox();
            const tr = el.getAttribute("transform") || "";
            const m = tr.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
            const tx = m ? parseFloat(m[1]) : 0;
            const ty = m ? parseFloat(m[2]) : 0;
            // Subtract offset to get original position (before applyPositionOverrides moved it)
            movedNodes.push({ offset, origBox: {
              left: bbox.x + tx - offset.dx, right: bbox.x + bbox.width + tx - offset.dx,
              top: bbox.y + ty - offset.dy, bottom: bbox.y + bbox.height + ty - offset.dy,
            }});
          } catch (e) {}
        }
        if (movedNodes.length === 0) return;
        const margin = 30;
        // Update all edge paths/lines using geometric proximity
        svg.querySelectorAll("path, line").forEach(el => {
          if (el.closest(skipSel)) return;
          if (el.tagName === "path") {
            const d = el.getAttribute("d");
            if (!d) return;
            const cmds = parsePathD(d);
            const points = getPathPoints(cmds);
            if (points.length < 2) return;
            const fp = points[0];
            const firstX = cmds[fp.ci].params[fp.pi], firstY = cmds[fp.ci].params[fp.pi + 1];
            const lp = points[points.length - 1];
            const lastX = cmds[lp.ci].params[lp.pi], lastY = cmds[lp.ci].params[lp.pi + 1];
            let srcDx = 0, srcDy = 0, tgtDx = 0, tgtDy = 0;
            for (const mn of movedNodes) {
              const b = mn.origBox;
              if (firstX >= b.left - margin && firstX <= b.right + margin && firstY >= b.top - margin && firstY <= b.bottom + margin) {
                srcDx += mn.offset.dx; srcDy += mn.offset.dy;
              }
              if (lastX >= b.left - margin && lastX <= b.right + margin && lastY >= b.top - margin && lastY <= b.bottom + margin) {
                tgtDx += mn.offset.dx; tgtDy += mn.offset.dy;
              }
            }
            if (srcDx === 0 && srcDy === 0 && tgtDx === 0 && tgtDy === 0) return;
            const origCmds = parsePathD(d);
            const newCmds = parsePathD(d);
            applyRubberBand(newCmds, origCmds, srcDx, srcDy, tgtDx, tgtDy);
            el.setAttribute("d", serializePathD(newCmds));
          } else if (el.tagName === "line") {
            const x1 = parseFloat(el.getAttribute("x1")) || 0, y1 = parseFloat(el.getAttribute("y1")) || 0;
            const x2 = parseFloat(el.getAttribute("x2")) || 0, y2 = parseFloat(el.getAttribute("y2")) || 0;
            let srcDx = 0, srcDy = 0, tgtDx = 0, tgtDy = 0;
            for (const mn of movedNodes) {
              const b = mn.origBox;
              if (x1 >= b.left - margin && x1 <= b.right + margin && y1 >= b.top - margin && y1 <= b.bottom + margin) {
                srcDx += mn.offset.dx; srcDy += mn.offset.dy;
              }
              if (x2 >= b.left - margin && x2 <= b.right + margin && y2 >= b.top - margin && y2 <= b.bottom + margin) {
                tgtDx += mn.offset.dx; tgtDy += mn.offset.dy;
              }
            }
            if (srcDx === 0 && srcDy === 0 && tgtDx === 0 && tgtDy === 0) return;
            el.setAttribute("x1", x1 + srcDx); el.setAttribute("y1", y1 + srcDy);
            el.setAttribute("x2", x2 + tgtDx); el.setAttribute("y2", y2 + tgtDy);
          }
        });
        // Move edge labels (flowchart-specific, best-effort for other types)
        svg.querySelectorAll(".edgeLabel").forEach(el => {
          const id = el.id || "";
          const endpoints = getEdgeEndpoints(id.replace(/^label-/, "L-"));
          if (!endpoints) return;
          const srcId = findNodeSvgId(svg, endpoints.source);
          const tgtId = findNodeSvgId(svg, endpoints.target);
          const srcOff = srcId ? positionOverrides[srcId] : null;
          const tgtOff = tgtId ? positionOverrides[tgtId] : null;
          if (!srcOff && !tgtOff) return;
          const curTransform = el.getAttribute("transform") || "";
          const m = curTransform.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
          const cx = m ? parseFloat(m[1]) : 0;
          const cy = m ? parseFloat(m[2]) : 0;
          const dx = ((srcOff?.dx || 0) + (tgtOff?.dx || 0)) / 2;
          const dy = ((srcOff?.dy || 0) + (tgtOff?.dy || 0)) / 2;
          el.setAttribute("transform", "translate(" + (cx + dx) + ", " + (cy + dy) + ")");
        });
      };

      const findNodeSvgId = (svg, shortId) => {
        // Try flowchart convention first
        const el = svg.querySelector('[id^="flowchart-' + CSS.escape(shortId) + '-"]');
        if (el) return el.id;
        // Try direct id
        const direct = svg.querySelector("#" + CSS.escape(shortId));
        if (direct) return shortId;
        return null;
      };

      /* ── SVG path parsing for rubber-band edge following ── */
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

      // Apply weighted interpolation: source-end points follow source, target-end follow target
      const applyRubberBand = (commands, origCommands, srcDx, srcDy, tgtDx, tgtDy) => {
        const points = getPathPoints(origCommands);
        if (points.length < 2) return;
        const total = points.length - 1;
        points.forEach((pt, idx) => {
          const t = idx / total; // 0 = source end, 1 = target end
          const dx = srcDx * (1 - t) + tgtDx * t;
          const dy = srcDy * (1 - t) + tgtDy * t;
          commands[pt.ci].params[pt.pi] = origCommands[pt.ci].params[pt.pi] + dx;
          commands[pt.ci].params[pt.pi + 1] = origCommands[pt.ci].params[pt.pi + 1] + dy;
        });
      };

      // Universal: find all edge paths/lines connected to a node using geometric proximity
      const findConnectedEdges = (svg, node) => {
        const connections = [];
        try {
          const bbox = node.getBBox();
          const transform = node.getAttribute("transform") || "";
          const tm = transform.match(/translate\\(\\s*([-\\d.]+)[,\\s]+([-\\d.]+)\\s*\\)/);
          const tx = tm ? parseFloat(tm[1]) : 0;
          const ty = tm ? parseFloat(tm[2]) : 0;
          const nodeBox = {
            left: bbox.x + tx, right: bbox.x + bbox.width + tx,
            top: bbox.y + ty, bottom: bbox.y + bbox.height + ty,
          };
          const margin = Math.max(bbox.width, bbox.height) * 0.3 + 20;
          const isNear = (px, py) => {
            return px >= nodeBox.left - margin && px <= nodeBox.right + margin &&
                   py >= nodeBox.top - margin && py <= nodeBox.bottom + margin;
          };
          // Skip elements inside node groups or defs (these are shapes, not edges)
          const skipSel = "g.node, g.entity, g.classGroup, g.cluster, g.mindmap-node, g.stateGroup, defs, marker";
          svg.querySelectorAll("path, line").forEach(el => {
            if (el.closest(skipSel)) return;
            if (node.contains(el)) return;
            if (el.tagName === "path") {
              const d = el.getAttribute("d");
              if (!d) return;
              const cmds = parsePathD(d);
              const points = getPathPoints(cmds);
              if (points.length < 2) return;
              const fp = points[0];
              const firstX = cmds[fp.ci].params[fp.pi];
              const firstY = cmds[fp.ci].params[fp.pi + 1];
              const lp = points[points.length - 1];
              const lastX = cmds[lp.ci].params[lp.pi];
              const lastY = cmds[lp.ci].params[lp.pi + 1];
              const srcConn = isNear(firstX, firstY);
              const tgtConn = isNear(lastX, lastY);
              if (srcConn || tgtConn) {
                connections.push({ el, type: "path", isSource: srcConn, isTarget: tgtConn, origD: d });
              }
            } else if (el.tagName === "line") {
              const x1 = parseFloat(el.getAttribute("x1")) || 0;
              const y1 = parseFloat(el.getAttribute("y1")) || 0;
              const x2 = parseFloat(el.getAttribute("x2")) || 0;
              const y2 = parseFloat(el.getAttribute("y2")) || 0;
              const srcConn = isNear(x1, y1);
              const tgtConn = isNear(x2, y2);
              if (srcConn || tgtConn) {
                connections.push({ el, type: "line", isSource: srcConn, isTarget: tgtConn, origX1: x1, origY1: y1, origX2: x2, origY2: y2 });
              }
            }
          });
        } catch (e) {}
        return connections;
      };

      /* ── Connect mode state ────────────────────────────── */
      let connectMode = null; // null or { sourceId }

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
                // Restore original edge paths since drag was cancelled
                if (dragState.connectedEdges) {
                  dragState.connectedEdges.forEach(conn => {
                    if (conn.type === "path" && conn.origD) {
                      conn.el.setAttribute("d", conn.origD);
                    } else if (conn.type === "line") {
                      conn.el.setAttribute("x1", conn.origX1);
                      conn.el.setAttribute("y1", conn.origY1);
                      conn.el.setAttribute("x2", conn.origX2);
                      conn.el.setAttribute("y2", conn.origY2);
                    }
                  });
                }
              }
            }
            dragState.node.style.cursor = "";
          }
          if (dragState.textNode) {
            dragState.textNode.removeAttribute("transform");
          }
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
            return;
          }

          const group = target.closest("g");
          if (selected) selected.classList.remove("mf-selected");
          if (group) {
            group.classList.add("mf-selected");
            selected = group;
          }

          send("element:selected", extractInfo(target));
        });

        svg.addEventListener("contextmenu", (event) => {
          const target = event.target;
          event.preventDefault();
          const elementType = (!target || target.nodeName === "svg") ? "canvas" : getElementType(target);
          const nodeGroup = elementType === "node" ? findDragRoot(target) : null;
          const edgeGroup = elementType === "edge" ? (target.closest("g.edgePath") || target.closest("g.edgeLabel")) : null;
          const edgeEndpoints = edgeGroup ? getEdgeEndpoints(edgeGroup.id || edgeGroup.closest?.("g.edgePath")?.id || "") : null;
          send("element:context", {
            ...extractInfo(target),
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

          // Find and cache all edges connected to this node (geometric proximity)
          if (!isGantt) {
            dragState.connectedEdges = findConnectedEdges(svg, dragNode);
          }
        });

        svg.addEventListener("pointermove", (event) => {
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
          } else {
            // Non-Gantt: move node in SVG coordinate space
            const scale = dragState.svgScale || 1;
            const svgDx = dragState.deltaX / scale;
            const svgDy = dragState.deltaY / scale;
            const newTx = dragState.origTx + svgDx;
            const newTy = dragState.origTy + svgDy;
            dragState.node.setAttribute("transform", "translate(" + newTx + ", " + newTy + ")");

            // Move connected edges using rubber-band path modification (cached from pointerdown)
            if (dragState.connectedEdges) {
              dragState.connectedEdges.forEach(conn => {
                if (conn.type === "path" && conn.origD) {
                  const origCmds = parsePathD(conn.origD);
                  const newCmds = parsePathD(conn.origD);
                  applyRubberBand(newCmds, origCmds,
                    conn.isSource ? svgDx : 0, conn.isSource ? svgDy : 0,
                    conn.isTarget ? svgDx : 0, conn.isTarget ? svgDy : 0
                  );
                  conn.el.setAttribute("d", serializePathD(newCmds));
                } else if (conn.type === "line") {
                  conn.el.setAttribute("x1", conn.origX1 + (conn.isSource ? svgDx : 0));
                  conn.el.setAttribute("y1", conn.origY1 + (conn.isSource ? svgDy : 0));
                  conn.el.setAttribute("x2", conn.origX2 + (conn.isTarget ? svgDx : 0));
                  conn.el.setAttribute("y2", conn.origY2 + (conn.isTarget ? svgDy : 0));
                }
              });
            }
          }
        });

        svg.addEventListener("pointerup", () => {
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
      };

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
          if (svgNode) wireSelection(svgNode);
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

  // Interactive diagram state
  const [positionOverrides, setPositionOverrides] = useState({});
  const [connectMode, setConnectMode] = useState(null);
  const [shapePickerNode, setShapePickerNode] = useState(null);
  const [edgeLabelEdit, setEdgeLabelEdit] = useState(null);
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
      }

      if (data.type === "element:context") {
        const selected = data.payload || null;
        setSelectedElement(selected);
        setLabelDraft(selected?.label || "");
        setHighlightLine(getMatchingLine(code, selected?.label || selected?.id || ""));

        if (toolsetKey === "gantt" && selected) {
          setContextMenu({ type: "gantt", label: selected.label });
        } else {
          // Position context menu at click location (convert iframe coords to parent coords)
          const iframeRect = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
          const menuX = iframeRect.left + (selected?.pointerX || 0);
          const menuY = iframeRect.top + (selected?.pointerY || 0);
          const elementType = selected?.elementType || "canvas";

          if (elementType === "node" || elementType === "edge" || elementType === "canvas") {
            setContextMenu({
              type: elementType,
              nodeId: selected?.nodeId || "",
              edgeSource: selected?.edgeSource || "",
              edgeTarget: selected?.edgeTarget || "",
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
  }, [contextMenu, presentMode, settingsOpen, drawerOpen, exportMenuOpen, connectMode, shapePickerNode, edgeLabelEdit]);

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
                <button
                  className="date-toggle-btn"
                  onClick={() => setShowDates((prev) => !prev)}
                >
                  {showDates ? "Hide dates" : "Show dates"}
                </button>
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

      {/* ── Node Context Menu (right-click on node) ──── */}
      {contextMenu?.type === "node" && (() => {
        const adapter = getDiagramAdapter(toolsetKey);
        const isFlowchart = toolsetKey === "flowchart";
        const nodeLabel = adapter?.nodeLabel || "node";
        return (
          <div className="context-menu-backdrop" onClick={() => setContextMenu(null)}>
            <div
              ref={contextMenuRef}
              className="context-menu"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="context-menu-item" onClick={() => {
                setLabelDraft(contextMenu.label || "");
                setDrawerOpen(true);
                setContextMenu(null);
              }}>
                Edit label
              </button>
              {isFlowchart && (
                <button className="context-menu-item" onClick={() => {
                  setShapePickerNode(contextMenu.nodeId);
                  setContextMenu(null);
                }}>
                  Change shape
                </button>
              )}
              <div className="context-menu-sep" />
              <button className="context-menu-item" onClick={() => {
                setConnectMode({ sourceId: contextMenu.nodeId });
                const frame = iframeRef.current;
                if (frame?.contentWindow) {
                  frame.contentWindow.postMessage(
                    { channel: CHANNEL, type: "mode:connect", payload: { sourceId: contextMenu.nodeId } },
                    "*"
                  );
                }
                setContextMenu(null);
                setRenderMessage(`Connect mode: click target node for edge from "${contextMenu.nodeId}"`);
              }}>
                Connect to...
              </button>
              <div className="context-menu-sep" />
              <button className="context-menu-item context-menu-danger" onClick={() => {
                if (isFlowchart) {
                  setCode((prev) => removeFlowchartNode(prev, contextMenu.nodeId));
                } else if (adapter?.removeNode) {
                  setCode((prev) => adapter.removeNode(prev, contextMenu.nodeId));
                }
                setPositionOverrides({});
                setRenderMessage(`Deleted ${nodeLabel} "${contextMenu.nodeId}"`);
                setContextMenu(null);
              }}>
                Delete {nodeLabel}
              </button>
            </div>
          </div>
        );
      })()}

      {/* ── Edge Context Menu (right-click on edge) ──── */}
      {contextMenu?.type === "edge" && (
        <div className="context-menu-backdrop" onClick={() => setContextMenu(null)}>
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="context-menu-item" onClick={() => {
              setEdgeLabelEdit({ source: contextMenu.edgeSource, target: contextMenu.edgeTarget, label: contextMenu.label || "" });
              setContextMenu(null);
            }}>
              Edit label
            </button>
            <button className="context-menu-item" onClick={() => {
              const nextArrow = contextMenu.label ? "--->" : "-.->"; // cycle
              setCode((prev) => updateFlowchartEdge(prev, contextMenu.edgeSource, contextMenu.edgeTarget, { arrowType: nextArrow }));
              setContextMenu(null);
            }}>
              Change arrow style
            </button>
            <div className="context-menu-sep" />
            <button className="context-menu-item context-menu-danger" onClick={() => {
              setCode((prev) => removeFlowchartEdge(prev, contextMenu.edgeSource, contextMenu.edgeTarget));
              setPositionOverrides({});
              setRenderMessage(`Deleted edge ${contextMenu.edgeSource} --> ${contextMenu.edgeTarget}`);
              setContextMenu(null);
            }}>
              Delete edge
            </button>
          </div>
        </div>
      )}

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
