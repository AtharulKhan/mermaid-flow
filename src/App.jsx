import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";
import { findTaskByLabel, parseGanttTasks, shiftIsoDate, updateGanttTask, toggleGanttStatus, clearGanttStatus, updateGanttAssignee, updateGanttNotes } from "./ganttUtils";

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
      :root { color-scheme: light only; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #f5f7fa;
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
        border-radius: 12px;
        background: #ffffff;
        padding: 18px;
        box-sizing: border-box;
      }
      #canvas > svg {
        width: 100%;
        height: auto;
      }
      .mf-selected * {
        stroke: #1f5da3 !important;
        stroke-width: 2.2px !important;
      }
      text.taskTextOutsideRight, text.taskTextOutsideLeft { pointer-events: all; cursor: pointer; }
      .done0,.done1,.done2,.done3,.done4,.done5,.done6,.done7,.done8,.done9 { fill: #22c55e !important; }
      .active0,.active1,.active2,.active3,.active4,.active5,.active6,.active7,.active8,.active9 { fill: #fde68a !important; }
      .crit0,.crit1,.crit2,.crit3,.crit4,.crit5,.crit6,.crit7,.crit8,.crit9 { fill: #991b1b !important; }
      .activeCrit0,.activeCrit1,.activeCrit2,.activeCrit3 { fill: #b91c1c !important; }
      .doneCrit0,.doneCrit1,.doneCrit2,.doneCrit3 { fill: #166534 !important; }
      #error {
        margin-top: 12px;
        font-size: 13px;
        color: #7e1f34;
        font-weight: 700;
      }
      #mf-tooltip {
        position: fixed;
        background: rgba(30, 30, 30, 0.92);
        color: #fff;
        font-size: 12px;
        line-height: 1.5;
        padding: 8px 12px;
        border-radius: 6px;
        pointer-events: none;
        z-index: 1000;
        max-width: 280px;
        white-space: pre-line;
        display: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
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
            dragState.node.removeAttribute("transform");
            dragState.node.style.cursor = "";
            // Restore original rect dimensions after edge resize
            if (dragState.origX != null) {
              dragState.node.setAttribute("x", String(dragState.origX));
            }
            if (dragState.origWidth != null) {
              dragState.node.setAttribute("width", String(dragState.origWidth));
            }
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
          if (!target || target.nodeName === "svg") return;
          event.preventDefault();
          send("element:context", {
            ...extractInfo(target),
            pointerX: event.clientX,
            pointerY: event.clientY,
          });
        });

        svg.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          const target = event.target;
          if (!target || target.nodeName === "svg") return;

          const isGantt = isGanttTaskTarget(target);
          let dragNode = target.closest("g") || target;
          let textNode = null;
          let dragMode = "move";

          if (isGantt) {
            const taskRect = findGanttTaskRect(target);
            if (taskRect) {
              dragNode = taskRect;
              // Find corresponding text element to move with rect
              const rId = taskRect.getAttribute("id") || "";
              if (rId) {
                textNode = svg.querySelector("#" + CSS.escape(rId + "-text"));
              }
              // Detect edge clicks for resize vs shift
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
            dragNode.style.cursor = "grabbing";
          }

          // Store original rect geometry for edge-resize restoration
          let origX = null, origWidth = null, svgScale = 1;
          if (isGantt && dragNode.nodeName === "rect") {
            origX = parseFloat(dragNode.getAttribute("x")) || 0;
            origWidth = parseFloat(dragNode.getAttribute("width")) || 0;
            try {
              const ctm = svg.getScreenCTM();
              if (ctm) svgScale = ctm.a;
            } catch (_) {}
          }

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
          };
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
              // Stretch right edge: keep x, increase width
              const newW = Math.max(4, dragState.origWidth + svgDx);
              dragState.node.setAttribute("width", String(newW));
            } else if (mode === "resize-start" && dragState.origX != null && dragState.origWidth != null) {
              // Stretch left edge: move x, decrease width
              const newX = dragState.origX + svgDx;
              const newW = Math.max(4, dragState.origWidth - svgDx);
              dragState.node.setAttribute("x", String(newX));
              dragState.node.setAttribute("width", String(newW));
              if (dragState.textNode) {
                dragState.textNode.setAttribute("transform", "translate(" + dx + " 0)");
              }
            } else {
              // Shift: translate whole bar
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
            dragState.node.setAttribute(
              "transform",
              "translate(" + dragState.deltaX + " " + dragState.deltaY + ")"
            );
          }
        });

        svg.addEventListener("pointerup", () => {
          if (!dragState) return;
          const threshold = Math.abs(dragState.deltaX) + Math.abs(dragState.deltaY);
          const payload = {
            ...extractInfo(dragState.target),
            deltaX: dragState.deltaX,
            deltaY: dragState.deltaY,
            isGanttTask: dragState.ganttTask,
            dragMode: dragState.dragMode || "shift",
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

  // Derived
  const srcDoc = useMemo(() => getIframeSrcDoc(), []);
  const lineCount = code.split("\n").length;
  const toolsetKey = classifyDiagramType(diagramType);
  const activeTemplate = DIAGRAM_LIBRARY.find((entry) => entry.id === templateId);
  const ganttTasks = useMemo(() => parseGanttTasks(code), [code]);
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
          setContextMenu({ label: selected.label });
        } else {
          setDrawerOpen(true);
        }
      }

      if (data.type === "element:dragged") {
        const payload = data.payload || {};
        setDragFeedback(
          `Dragged ${payload.label || payload.id || "element"} by ${Math.round(payload.deltaX || 0)}px x ${Math.round(
            payload.deltaY || 0
          )}px`
        );
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
  }, [code, ganttTasks, toolsetKey, showDates]);

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
        if (contextMenu) { setContextMenu(null); return; }
        if (presentMode) { setPresentMode(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (drawerOpen) { setDrawerOpen(false); return; }
        if (exportMenuOpen) { setExportMenuOpen(false); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenu, presentMode, settingsOpen, drawerOpen, exportMenuOpen]);

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
              onChange={(e) => setCode(e.target.value)}
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

      {/* ── Task Edit Modal (Gantt right-click) ──────── */}
      {contextMenu && (() => {
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
