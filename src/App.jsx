import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";
import logoSvg from "./assets/logo.svg";
import {
  findTaskByLabel,
  parseGanttTasks,
  parseGanttDirectives,
  resolveDependencies,
  addWorkingDays,
  shiftIsoDate,
  updateGanttTask,
  toggleGanttStatus,
  clearGanttStatus,
  toggleGanttMilestone,
  updateGanttAssignee,
  updateGanttNotes,
  updateGanttLink,
  updateGanttProgress,
  deleteGanttTask,
  findDependentTasks,
  findAllDependentTasks,
  removeDependencyReferences,
  insertGanttTaskAfter,
  addGanttSection,
  getGanttSections,
  moveGanttTaskToSection,
  renameGanttSection,
  computeRiskFlags,
  computeCriticalPath,
  detectCycles,
  detectConflicts,
  updateGanttDependency,
} from "./ganttUtils";
import { parseFlowchart, findNodeById, generateNodeId, addFlowchartNode, removeFlowchartNode, updateFlowchartNode, addFlowchartEdge, removeFlowchartEdge, updateFlowchartEdge, parseClassDefs, parseClassAssignments, parseStyleDirectives, createSubgraph, removeSubgraph, renameSubgraph, moveNodeToSubgraph } from "./flowchartUtils";
import { getDiagramAdapter, parseErDiagram, parseErAttribute, parseCardinality, sqlToErDiagram, erDiagramToSql, parseClassDiagram, parseStateDiagram, addStateDiagramState, addStateDiagramTransition, updateErEntity, updateErRelationship, parseSequenceDiagram, parseSequenceBlocks, parseSequenceExtras, updateSequenceMessageByIndex, removeSequenceMessageByIndex, reorderSequenceParticipants, addSequenceMessage } from "./diagramUtils";
import { parseStateDiagramEnhanced, xstateToMermaid, mermaidToXState, generateStateId, toggleStateDiagramDirection } from "./stateUtils";
import { downloadSvgHQ, downloadPngHQ, downloadPdf } from "./exportUtils";
import { useAuth } from "./firebase/AuthContext";
import { createFlow, getFlow, updateFlow, getUserSettings, saveFlowVersion, formatFirestoreError, setFlowBaseline, clearFlowBaseline } from "./firebase/firestore";
import { ganttToNotionPages, importFromNotion, syncGanttToNotion } from "./notionSync";
import ShareDialog from "./components/ShareDialog";
import CommentPanel from "./components/CommentPanel";
import VersionHistoryPanel from "./components/VersionHistoryPanel";
import ResourceLoadPanel from "./components/ResourceLoadPanel";
import { getStoredTheme, getResolvedTheme, cycleTheme, THEME_LABELS, IconSun, IconMoon, IconMonitor } from "./themeUtils";

const CHANNEL = "mermaid-flow";
const ENABLE_NOTION_INTEGRATION = false; // Temporarily disabled.

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

function normalizeAssigneeList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeAssigneeArray(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set();
  const names = [];
  for (const raw of source) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function normalizeGanttViewState(raw, fallback) {
  const state = raw && typeof raw === "object" ? raw : {};
  const nextScale = state.ganttScale === "month" ? "month" : state.ganttScale === "week" ? "week" : fallback.ganttScale;
  return {
    showDates: typeof state.showDates === "boolean" ? state.showDates : fallback.showDates,
    showGrid: typeof state.showGrid === "boolean" ? state.showGrid : fallback.showGrid,
    ganttScale: nextScale,
    pinCategories: typeof state.pinCategories === "boolean" ? state.pinCategories : fallback.pinCategories,
    showCriticalPath: typeof state.showCriticalPath === "boolean" ? state.showCriticalPath : fallback.showCriticalPath,
    showDepLines: typeof state.showDepLines === "boolean" ? state.showDepLines : fallback.showDepLines,
    executiveView: typeof state.executiveView === "boolean" ? state.executiveView : fallback.executiveView,
    showRisks: typeof state.showRisks === "boolean" ? state.showRisks : fallback.showRisks,
    showBaseline: typeof state.showBaseline === "boolean" ? state.showBaseline : fallback.showBaseline,
    selectedAssignees: normalizeAssigneeArray(
      state.selectedAssignees != null ? state.selectedAssignees : fallback.selectedAssignees
    ),
  };
}

function matchesAssigneeFilter(taskAssignee, selectedSet) {
  if (!selectedSet?.size) return true;
  const assignees = String(taskAssignee || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return assignees.some((assignee) => selectedSet.has(assignee));
}

function filterTasksByAssignee(tasks, selectedAssignees) {
  if (!tasks?.length) return [];
  const selectedSet = new Set(
    normalizeAssigneeArray(selectedAssignees).map((name) => name.toLowerCase())
  );
  if (!selectedSet.size) return tasks;

  const visibleSections = new Set();
  for (const task of tasks) {
    if (task.isVertMarker) continue;
    if (!matchesAssigneeFilter(task.assignee, selectedSet)) continue;
    const section = String(task.section || "").trim().toLowerCase();
    if (section) visibleSections.add(section);
  }

  return tasks.filter((task) => {
    if (task.isVertMarker) {
      const section = String(task.section || task.label || "").trim().toLowerCase();
      return section && visibleSections.has(section);
    }
    return matchesAssigneeFilter(task.assignee, selectedSet);
  });
}

function AssigneeTagInput({ value, onChange, suggestions }) {
  const tags = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  const [inputVal, setInputVal] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef(null);

  const filtered = suggestions.filter(
    (s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()) &&
      s.toLowerCase().includes(inputVal.toLowerCase())
  );

  const commit = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) return;
    const next = [...tags, trimmed].join(", ");
    onChange(next);
    setInputVal("");
    setActiveIdx(-1);
  };

  const remove = (idx) => {
    const next = tags.filter((_, i) => i !== idx).join(", ");
    onChange(next);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < filtered.length) {
        commit(filtered[activeIdx]);
      } else if (inputVal.trim()) {
        commit(inputVal);
      }
    } else if (e.key === "Backspace" && !inputVal && tags.length) {
      remove(tags.length - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  return (
    <div className="assignee-tag-wrap" onClick={() => inputRef.current?.focus()}>
      {tags.map((tag, i) => (
        <span key={tag + i} className="assignee-tag">
          {tag}
          <button type="button" className="assignee-tag-remove" onClick={(e) => { e.stopPropagation(); remove(i); }}>&times;</button>
        </span>
      ))}
      <div style={{ position: "relative", flex: 1, minWidth: 80 }}>
        <input
          ref={inputRef}
          className="assignee-tag-input"
          value={inputVal}
          onChange={(e) => { setInputVal(e.target.value); setActiveIdx(-1); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => { setTimeout(() => setShowSuggestions(false), 150); if (inputVal.trim()) commit(inputVal); }}
          onKeyDown={onKeyDown}
          placeholder={tags.length ? "" : "Add assignee..."}
        />
        {showSuggestions && inputVal && filtered.length > 0 && (
          <div className="assignee-suggestions">
            {filtered.map((s, i) => (
              <button
                key={s}
                type="button"
                className={`assignee-suggestion${i === activeIdx ? " active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); commit(s); }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function isMobileViewport() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 768px)").matches;
}

function getIframeSrcDoc() {
  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  return `<!doctype html>
<html lang="en" data-theme="${currentTheme}">
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
        position: relative;
        overscroll-behavior: contain;
      }
      #wrap.mf-gantt-mode {
        padding: 2px;
      }
      #canvas {
        min-height: 100%;
        padding: 16px;
        box-sizing: border-box;
        display: flex;
        justify-content: center;
        align-items: flex-start;
      }
      #canvas.mf-gantt-mode {
        padding: 0;
      }
      #canvas > svg {
        width: 100%;
        height: auto;
        max-width: 100%;
      }
      #mf-gantt-grid-header {
        position: absolute;
        z-index: 4;
        pointer-events: none;
        display: none;
      }
      #mf-gantt-role-column {
        position: absolute;
        z-index: 5;
        pointer-events: none;
        display: none;
      }
      .mf-gh-row {
        display: flex;
        border: 1px solid #d9dee8;
        border-bottom: none;
        background: #eef2ff;
      }
      .mf-gh-row.week {
        background: #f6f8fc;
      }
      .mf-gh-row.day {
        background: #ffffff;
        border-bottom: 1px solid #d9dee8;
      }
      .mf-gh-cell {
        box-sizing: border-box;
        border-right: 1px solid #dde3ed;
        color: #334155;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .mf-gh-row.month .mf-gh-cell {
        height: 24px;
        line-height: 24px;
        font-size: 11px;
        font-weight: 700;
      }
      .mf-gh-row.week .mf-gh-cell {
        height: 18px;
        line-height: 18px;
        font-size: 10px;
        color: #64748b;
        font-weight: 600;
      }
      .mf-gh-row.day .mf-gh-cell {
        height: 24px;
        line-height: 24px;
        font-size: 10px;
        color: #475569;
        font-weight: 600;
      }
      .mf-role-row {
        position: absolute;
        left: 0;
        right: 0;
        border: 1px solid #d9dee8;
        border-top: none;
        background: rgba(255, 255, 255, 0.96);
        color: #1f2937;
        font-size: 12px;
        font-weight: 700;
        display: flex;
        align-items: center;
        padding: 8px 10px;
        box-sizing: border-box;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
      .active0,.active1,.active2,.active3,.active4,.active5,.active6,.active7,.active8,.active9 { fill: #fef08a !important; rx: 6; }
      .crit0,.crit1,.crit2,.crit3,.crit4,.crit5,.crit6,.crit7,.crit8,.crit9 { fill: #ef4444 !important; rx: 6; }
      .activeCrit0,.activeCrit1,.activeCrit2,.activeCrit3 { fill: #dc2626 !important; rx: 6; }
      .doneCrit0,.doneCrit1,.doneCrit2,.doneCrit3 { fill: #16a34a !important; rx: 6; }
      /* Default (untagged) Gantt bars */
      .task0,.task1,.task2,.task3,.task4,.task5,.task6,.task7,.task8,.task9 { fill: #d1d5db !important; rx: 6; }
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
      .taskText { fill: #fff !important; font-weight: 600 !important; font-size: 12.5px !important; }
      .taskTextOutsideRight, .taskTextOutsideLeft { fill: #374151 !important; font-weight: 500 !important; font-size: 12px !important; }
      /* Milestone marker */
      .milestone { rx: 3; }
      /* ── Custom HTML Gantt ── */
      .mf-gantt-container {
        font-family: "Manrope", system-ui, sans-serif;
        font-size: 13px;
        line-height: 1;
        user-select: none;
        display: grid;
        flex: 0 0 auto;
        position: relative;
        margin-top: 16px;
        border-radius: 12px;
        border: 1px solid #d9dee8;
      }
      .mf-gantt-corner {
        position: sticky;
        left: 0;
        top: 0;
        z-index: 11;
        background: #eef2ff;
        border-bottom: 1px solid #d9dee8;
        border-right: 2px solid #d9dee8;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 700;
        font-size: 11px;
        color: #334155;
        box-sizing: border-box;
        text-align: center;
        line-height: 1.3;
        padding: 4px 8px;
        box-shadow: 10px 0 12px -12px rgba(15, 23, 42, 0.28);
      }
      .mf-gantt-corner-label {
        flex: 1;
        min-width: 0;
      }
      .mf-gantt-add-section-btn {
        border: 1px solid #cbd5e1;
        background: rgba(255, 255, 255, 0.92);
        color: #334155;
        border-radius: 999px;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        flex-shrink: 0;
      }
      .mf-gantt-add-section-btn:hover {
        background: #ffffff;
        border-color: #94a3b8;
      }
      .mf-gantt-timeline-header {
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .mf-gantt-role-cell {
        position: sticky;
        left: 0;
        z-index: 5;
        background: #ffffff;
        border-right: 2px solid #d9dee8;
        border-bottom: 1px solid #e8ecf2;
        display: flex;
        align-items: flex-start;
        padding: 10px 12px 28px 12px;
        font-weight: 700;
        font-size: 12px;
        color: #1f2937;
        white-space: normal;
        word-wrap: break-word;
        overflow-wrap: break-word;
        box-sizing: border-box;
        line-height: 1.4;
        overflow: hidden;
        box-shadow: 10px 0 12px -12px rgba(15, 23, 42, 0.25);
      }
      .mf-gantt-role-label-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
      }
      .mf-gantt-role-label-wrap > span {
        flex: 1;
        min-width: 0;
      }
      .mf-gantt-section-edit-btn {
        border: 1px solid #d5dbe8;
        background: #f8fafc;
        color: #64748b;
        border-radius: 999px;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        cursor: pointer;
        flex-shrink: 0;
        transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
      }
      .mf-gantt-section-edit-btn svg {
        width: 11px;
        height: 11px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
      }
      .mf-gantt-section-edit-btn:hover {
        background: #ffffff;
        color: #334155;
        border-color: #94a3b8;
      }
      .mf-gantt-track {
        border-bottom: 1px solid #e8ecf2;
        background: #ffffff;
        position: relative;
        box-sizing: border-box;
      }
      .mf-gantt-track:nth-child(4n+1) {
        background: #fafbfd;
      }
      .mf-gantt-track.mf-show-grid-lines {
        background-image: repeating-linear-gradient(
          90deg,
          transparent,
          transparent calc(var(--px-per-day) - 1px),
          #f1f5f9 calc(var(--px-per-day) - 1px),
          #f1f5f9 var(--px-per-day)
        );
      }
      .mf-gantt-bar {
        position: absolute;
        border-radius: 8px;
        display: flex;
        align-items: center;
        padding: 0 8px;
        cursor: grab;
        transition: box-shadow 0.12s ease, filter 0.12s ease;
        overflow: visible;
        box-sizing: border-box;
        min-width: 18px;
        z-index: 3;
        --outside-label-width: 0px;
      }
      .mf-gantt-bar:hover {
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        filter: brightness(1.06);
      }
      .mf-gantt-bar:active { cursor: grabbing; }
      .mf-gantt-progress-fill {
        position: absolute;
        right: 0; top: 0; bottom: 0;
        border-radius: 0 8px 8px 0;
        background: rgba(255, 255, 255, 0.5);
        pointer-events: none;
        z-index: 0;
        transition: width 0.2s ease;
      }
      .mf-bar-default { background: #d1d5db; }
      .mf-bar-done    { background: #22c55e; }
      .mf-bar-crit    { background: #ef4444; }
      .mf-bar-active  { background: #fef08a; }
      .mf-bar-activeCrit { background: #dc2626; }
      .mf-bar-doneCrit   { background: #16a34a; }
      .mf-bar-critical-path {
        box-shadow: 0 0 0 2.5px #ef4444, 0 0 12px rgba(239, 68, 68, 0.5);
        z-index: 2;
        outline: 2px solid #ef4444;
        outline-offset: 1px;
      }
      .mf-gantt-milestone.mf-bar-critical-path::before {
        box-shadow: 0 0 0 2.5px #ef4444, 0 0 12px rgba(239, 68, 68, 0.5);
      }
      .mf-bar-dimmed { opacity: 0.3; }
      .mf-gantt-bar:not(.mf-bar-default) .bar-label { color: #ffffff; }
      .mf-gantt-bar.mf-bar-active .bar-label {
        color: #1f2937;
        font-weight: 700;
      }
      .mf-gantt-bar.mf-bar-default .bar-label {
        color: #1f2937;
        font-weight: 700;
      }
      .bar-label {
        font-size: 11.5px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
        max-width: calc(100% - var(--date-suffix-width, 0px) - var(--link-icon-width, 0px) - 16px);
        pointer-events: none;
        line-height: 1.2;
        min-width: 0;
      }
      .mf-gantt-bar.mf-bar-narrow .bar-label {
        position: absolute;
        left: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%);
        color: #1f2937;
        font-weight: 700;
        text-shadow: 0 0 3px #fff, 0 0 3px #fff;
        max-width: none;
        overflow: visible;
        text-overflow: clip;
      }
      .mf-gantt-bar.mf-label-outside .bar-label {
        position: absolute;
        left: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%);
        color: #1f2937;
        font-weight: 700;
        text-shadow: 0 0 3px #fff, 0 0 3px #fff;
        max-width: none;
        overflow: visible;
        text-overflow: clip;
      }
      .mf-gantt-bar.mf-label-outside-left .bar-label {
        left: auto;
        right: calc(100% + 8px);
        text-align: right;
        max-width: none;
        overflow: visible;
        text-overflow: clip;
      }
      .bar-date-suffix {
        color: rgba(100, 116, 139, 0.72);
        font-size: 9.5px;
        font-weight: 400;
        position: absolute;
        right: calc(8px + var(--link-icon-width, 0px));
        top: 50%;
        transform: translateY(-50%);
        white-space: nowrap;
        pointer-events: none;
      }
      .mf-gantt-bar.mf-label-outside .bar-date-suffix {
        left: calc(100% + 8px + var(--outside-label-width, 0px) + 8px);
        right: auto;
      }
      .mf-gantt-bar.mf-label-outside-left .bar-date-suffix {
        right: calc(100% + 8px + var(--outside-label-width, 0px) + 8px);
        left: auto;
      }
      .mf-bar-resize-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 10px;
        cursor: ew-resize;
        z-index: 3;
      }
      .mf-bar-resize-handle.start { left: 0; }
      .mf-bar-resize-handle.end { right: 0; }
      .mf-dep-connector {
        position: absolute;
        right: -6px;
        top: 50%;
        transform: translateY(-50%);
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #94a3b8;
        border: 2px solid #fff;
        cursor: crosshair;
        z-index: 5;
        opacity: 0;
        transition: opacity 0.15s;
        pointer-events: auto;
      }
      .mf-gantt-bar:hover .mf-dep-connector,
      .mf-gantt-milestone:hover .mf-dep-connector { opacity: 1; }
      .mf-dep-connector:hover { background: #3b82f6; transform: translateY(-50%) scale(1.2); }
      [data-theme="dark"] .mf-dep-connector { background: #6b7280; border-color: #1c1f2b; }
      [data-theme="dark"] .mf-dep-connector:hover { background: #60a5fa; }
      .mf-gantt-bar.mf-dep-drop-target,
      .mf-gantt-milestone.mf-dep-drop-target {
        outline: 2px solid #3b82f6;
        outline-offset: 2px;
      }
      .mf-dep-drag-line {
        pointer-events: none;
        position: absolute;
        top: 0;
        left: 0;
        z-index: 10;
      }
      .bar-link-icon {
        position: absolute;
        right: 11px;
        top: 50%;
        transform: translateY(-50%);
        width: 14px;
        height: 14px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        background: rgba(255, 255, 255, 0.9);
        color: #334155;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        cursor: pointer;
        z-index: 5;
        transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease, border-color 0.12s ease;
      }
      .bar-link-icon svg {
        width: 9px;
        height: 9px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
      }
      .bar-link-icon:hover {
        transform: translateY(-50%) scale(1.06);
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.24);
      }
      .bar-link-icon:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 1px;
      }
      .mf-gantt-bar:not(.mf-bar-default):not(.mf-bar-active) .bar-link-icon {
        color: rgba(255, 255, 255, 0.92);
        border-color: rgba(255, 255, 255, 0.42);
        background: rgba(15, 23, 42, 0.16);
      }
      .mf-gantt-milestone .bar-link-icon {
        right: auto;
        left: calc(100% + 6px);
        color: #334155;
        border-color: rgba(148, 163, 184, 0.55);
        background: rgba(255, 255, 255, 0.96);
      }
      .mf-gantt-milestone.mf-label-outside-left .bar-link-icon {
        left: auto;
        right: calc(100% + 6px);
      }
      .mf-gantt-today-line {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: #ef4444;
        z-index: 4;
        pointer-events: none;
      }
      .mf-gantt-today-label {
        position: absolute;
        top: -16px;
        left: 4px;
        font-size: 10px;
        color: #9ca3af;
        white-space: nowrap;
        pointer-events: none;
      }
      .mf-gantt-today-header-label {
        position: absolute;
        top: -14px;
        transform: translateX(-50%);
        font-size: 10px;
        font-weight: 600;
        color: #94a3b8;
        background: rgba(255,255,255,0.9);
        border: 1px solid rgba(148,163,184,0.25);
        border-radius: 999px;
        padding: 1px 6px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 8;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
      }
      .mf-gantt-insert-btn {
        position: absolute;
        bottom: 6px;
        right: 6px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: rgba(255,255,255,0.9);
        border: 1px solid #d5dbe8;
        color: #a3b0c4;
        font-size: 13px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s, border-color 0.15s, color 0.15s;
        z-index: 5;
      }
      .mf-gantt-role-cell:hover .mf-gantt-insert-btn { opacity: 0.6; }
      .mf-gantt-insert-btn:hover {
        opacity: 1 !important;
        border-color: #93c5fd;
        color: #3b82f6;
        background: #ffffff;
        box-shadow: 0 1px 4px rgba(59,130,246,0.2);
      }
      .mf-gantt-bar.mf-selected {
        outline: 2.5px solid #2563eb;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(37, 99, 235, 0.3);
        border-radius: 8px;
      }
      .mf-gantt-overdue-dot {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #dc2626;
        pointer-events: none;
      }
      .mf-gantt-risk-badge {
        position: absolute;
        font-size: 11px;
        line-height: 14px;
        pointer-events: none;
        z-index: 2;
        color: #d97706;
      }
      .mf-bar-at-risk {
        box-shadow: 0 0 0 2px #f59e0b, 0 0 8px rgba(245, 158, 11, 0.35);
        border-radius: 8px;
      }
      .mf-bar-at-risk.mf-bar-critical-path {
        box-shadow: 0 0 0 2.5px #ef4444, 0 0 0 5px #f59e0b, 0 0 12px rgba(239, 68, 68, 0.5);
      }
      /* ── Cycle warning banner ── */
      .mf-gantt-cycle-banner {
        grid-column: 1 / -1;
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 600;
        color: #92400e;
        margin: 6px 8px;
      }
      .mf-gantt-cycle-banner::before { content: "\u26A0\uFE0F "; }

      /* ── Conflict badge ── */
      .mf-gantt-conflict-badge {
        position: absolute;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: #f59e0b;
        color: #fff;
        font-size: 10px;
        font-weight: 800;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 7;
        pointer-events: auto;
        cursor: help;
      }

      /* ── Slack indicator bar ── */
      .mf-gantt-slack {
        position: absolute;
        background: repeating-linear-gradient(45deg, #93c5fd, #93c5fd 3px, #dbeafe 3px, #dbeafe 6px);
        border-radius: 2px;
        opacity: 0.6;
        pointer-events: auto;
        cursor: help;
      }

      /* ── Ghost bars (drag ripple) ── */
      .mf-gantt-ghost-bar {
        position: absolute;
        background: rgba(147,197,253,0.3);
        border: 2px dashed #60a5fa;
        border-radius: 6px;
        pointer-events: none;
        z-index: 5;
        transition: left 0.08s ease;
      }
      .mf-gantt-ripple-summary {
        position: fixed;
        background: rgba(15,23,42,0.92);
        color: #fff;
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        pointer-events: none;
        z-index: 100;
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      }

      /* ── Dependency chain highlighting ── */
      .mf-dep-line-upstream { stroke: #8b5cf6 !important; stroke-width: 2.5 !important; }
      .mf-dep-line-downstream { stroke: #f97316 !important; stroke-width: 2.5 !important; }
      .mf-dep-line-dimmed { opacity: 0.1 !important; }
      .mf-gantt-bar.mf-dep-dimmed,
      .mf-gantt-milestone.mf-dep-dimmed { opacity: 0.2; filter: grayscale(0.6); transition: opacity 0.15s, filter 0.15s; }
      .mf-gantt-bar.mf-dep-upstream-bar { outline: 2px solid #8b5cf6; outline-offset: 1px; }
      .mf-gantt-bar.mf-dep-downstream-bar { outline: 2px solid #f97316; outline-offset: 1px; }
      .mf-gantt-milestone.mf-dep-upstream-bar { filter: drop-shadow(0 0 4px #8b5cf6); }
      .mf-gantt-milestone.mf-dep-downstream-bar { filter: drop-shadow(0 0 4px #f97316); }

      /* ── Baseline ghost bars ── */
      .mf-gantt-baseline-bar {
        position: absolute;
        border-radius: 8px;
        background: #94a3b8;
        opacity: 0.22;
        border: 1.5px dashed #64748b;
        pointer-events: none;
        box-sizing: border-box;
        z-index: 0;
      }
      .mf-gantt-delta-badge {
        position: absolute;
        font-size: 9px;
        font-weight: 700;
        font-family: "Manrope", system-ui, sans-serif;
        padding: 1px 4px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 4;
        line-height: 1.3;
      }
      .mf-gantt-delta-badge.mf-delta-late {
        background: #fef2f2;
        color: #dc2626;
        border: 1px solid #fecaca;
      }
      .mf-gantt-delta-badge.mf-delta-early {
        background: #f0fdf4;
        color: #16a34a;
        border: 1px solid #bbf7d0;
      }
      /* ── Milestone diamond ── */
      .mf-gantt-milestone {
        position: absolute;
        cursor: grab;
        overflow: visible;
        box-sizing: border-box;
        background: transparent !important;
        transition: filter 0.12s ease;
        min-width: 0;
        z-index: 3;
      }
      .mf-gantt-milestone::before {
        content: "";
        position: absolute;
        inset: 0;
        background: #22c55e;
        clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
      }
      .mf-gantt-milestone:hover {
        filter: brightness(1.1);
      }
      .mf-gantt-milestone:active { cursor: grabbing; }
      .mf-gantt-milestone .bar-label {
        position: absolute;
        left: calc(100% + 8px);
        top: 50%;
        transform: translateY(-50%);
        white-space: nowrap;
        color: #374151;
        font-size: 11.5px;
        font-weight: 700;
        text-shadow: 0 0 3px #fff, 0 0 3px #fff;
        pointer-events: none;
        max-width: none;
        overflow: visible;
        text-overflow: clip;
      }
      .mf-gantt-milestone.mf-label-outside-left .bar-label {
        left: auto;
        right: calc(100% + 8px);
        text-align: right;
      }
      .mf-gantt-milestone .bar-date-suffix {
        position: absolute;
        left: calc(100% + 8px + var(--outside-label-width, 0px) + 6px);
        top: 50%;
        transform: translateY(-50%);
        white-space: nowrap;
        color: #64748b;
        font-size: 10px;
        font-weight: 400;
        text-shadow: 0 0 3px #fff, 0 0 3px #fff;
        pointer-events: none;
      }
      .mf-gantt-milestone.mf-label-outside-left .bar-date-suffix {
        left: auto;
        right: calc(100% + 8px + var(--outside-label-width, 0px) + 6px);
      }
      .mf-gantt-milestone.mf-selected::before {
        filter: brightness(0.85);
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.5);
      }
      /* ── Excluded day shading ── */
      .mf-gantt-excluded-day {
        position: absolute;
        top: 0;
        bottom: 0;
        background: repeating-linear-gradient(
          135deg,
          rgba(148, 163, 184, 0.1),
          rgba(148, 163, 184, 0.1) 2px,
          transparent 2px,
          transparent 6px
        );
        pointer-events: none;
        z-index: 0;
      }
      /* ── Vertical markers ── */
      .mf-gantt-vert-marker {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: #8b5cf6;
        z-index: 3;
        pointer-events: none;
      }
      .mf-gantt-vert-label {
        position: absolute;
        top: -18px;
        left: 4px;
        font-size: 10px;
        font-weight: 600;
        color: #7c3aed;
        white-space: nowrap;
        background: rgba(255,255,255,0.9);
        padding: 1px 4px;
        border-radius: 3px;
      }
      /* ── Custom HTML Flowchart ── */
      .mf-flow-container {
        font-family: "Manrope", system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
        position: relative;
        background-image: radial-gradient(circle, #d1d5db 0.5px, transparent 0.5px);
        background-size: 20px 20px;
      }
      .mf-flow-node {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        background: #f8fafc;
        border: 1.5px solid #cbd5e1;
        color: #1e293b;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.4;
        padding: 10px 16px;
        cursor: grab;
        transition: box-shadow 0.12s ease, filter 0.12s ease;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        box-sizing: border-box;
        z-index: 2;
        word-break: break-word;
        overflow-wrap: break-word;
      }
      .mf-flow-node:hover {
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        filter: brightness(1.02);
      }
      /* Shape-specific default colors for visual richness */
      .mf-shape-rect { background: #ffffff; border-color: #6366f1; }
      .mf-shape-rounded { background: #f0f9ff; border-color: #3b82f6; }
      .mf-shape-stadium { background: #f0fdf4; border-color: #22c55e; }
      .mf-shape-diamond { background: #fef3c7; }
      .mf-shape-circle { background: #faf5ff; border-color: #8b5cf6; }
      .mf-shape-hexagon { background: #fce7f3; }
      .mf-shape-subroutine { background: #f1f5f9; border-color: #64748b; }
      .mf-shape-cylinder { background: #ecfeff; border-color: #06b6d4; }
      .mf-shape-asymmetric { background: #fff7ed; }
      .mf-flow-node:active { cursor: grabbing; }
      .mf-flow-node.mf-selected {
        outline: 2.5px solid #2563eb;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(37, 99, 235, 0.3);
      }
      .mf-flow-node.mf-connect-source {
        outline: 3px solid #16a34a;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(22, 163, 74, 0.4);
      }
      .mf-marquee {
        position: absolute;
        border: 1.5px dashed #2563eb;
        background: rgba(37, 99, 235, 0.08);
        pointer-events: none;
        z-index: 9999;
      }
      .mf-flow-subgraph.mf-subgraph-drop-target {
        outline: 2.5px dashed #2563eb;
        outline-offset: 2px;
        background: rgba(37, 99, 235, 0.06);
      }
      .mf-shape-rect { border-radius: 4px; }
      .mf-shape-rounded { border-radius: 12px; }
      .mf-shape-stadium { border-radius: 9999px; padding: 10px 24px; }
      .mf-shape-diamond {
        clip-path: polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%);
        border: none;
        padding: 20px 24px;
      }
      .mf-shape-diamond .mf-node-label { pointer-events: none; }
      .mf-shape-circle { border-radius: 50%; padding: 16px; }
      .mf-shape-double-circle {
        border-radius: 50%;
        padding: 16px;
        box-shadow: 0 0 0 4px #ffffff, 0 0 0 5.5px var(--node-stroke, #94a3b8), 0 2px 8px rgba(0,0,0,0.08);
      }
      .mf-shape-hexagon {
        clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
        border: none;
        padding: 12px 32px;
      }
      .mf-shape-subroutine {
        border-radius: 4px;
        box-shadow: inset 5px 0 0 0 #64748b, inset -5px 0 0 0 #64748b, 0 2px 8px rgba(0,0,0,0.06);
        padding: 10px 22px;
      }
      .mf-shape-cylinder {
        border-radius: 50% / 12%;
        padding: 16px 16px;
      }
      .mf-shape-parallelogram { transform: skewX(-10deg); border-radius: 4px; }
      .mf-shape-parallelogram .mf-node-label { transform: skewX(10deg); }
      .mf-shape-parallelogram-alt { transform: skewX(10deg); border-radius: 4px; }
      .mf-shape-parallelogram-alt .mf-node-label { transform: skewX(-10deg); }
      .mf-shape-trapezoid {
        clip-path: polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%);
        border: none;
        padding: 12px 24px;
      }
      .mf-shape-trapezoid-alt {
        clip-path: polygon(0% 0%, 100% 0%, 90% 100%, 10% 100%);
        border: none;
        padding: 12px 24px;
      }
      .mf-shape-asymmetric {
        clip-path: polygon(0% 0%, 85% 0%, 100% 50%, 85% 100%, 0% 100%);
        border: none;
        padding: 10px 28px 10px 16px;
      }
      /* ── v11.3.0+ New Shapes ────────────────────────── */
      .mf-shape-document {
        clip-path: polygon(0% 0%, 100% 0%, 100% 85%, 85% 92%, 65% 98%, 50% 100%, 35% 98%, 15% 92%, 0% 85%);
        border: none; padding: 10px 16px 22px 16px;
      }
      .mf-shape-documents {
        clip-path: polygon(0% 0%, 95% 0%, 95% 4%, 100% 4%, 100% 89%, 85% 95%, 65% 100%, 50% 100%, 35% 100%, 15% 95%, 0% 89%);
        border: none; padding: 10px 16px 22px 16px;
      }
      .mf-shape-notched-rect {
        clip-path: polygon(0% 8%, 8% 0%, 100% 0%, 100% 100%, 0% 100%);
        border: none; padding: 10px 16px;
      }
      .mf-shape-cloud {
        clip-path: polygon(25% 10%, 35% 2%, 50% 0%, 65% 2%, 75% 10%, 88% 12%, 97% 22%, 100% 38%, 97% 55%, 90% 68%, 80% 78%, 68% 85%, 50% 90%, 32% 85%, 20% 78%, 10% 68%, 3% 55%, 0% 38%, 3% 22%, 12% 12%);
        border: none; padding: 24px 28px;
      }
      .mf-shape-bang {
        clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
        border: none; padding: 20px 16px;
      }
      .mf-shape-bolt {
        clip-path: polygon(35% 0%, 70% 0%, 50% 38%, 78% 38%, 30% 100%, 42% 55%, 15% 55%);
        border: none; padding: 16px;
      }
      .mf-shape-brace-l {
        border: none; background: transparent; box-shadow: none;
        border-left: 2px solid #94a3b8;
        border-radius: 0 0 0 8px;
        padding: 8px 12px 8px 16px;
      }
      .mf-shape-brace-r {
        border: none; background: transparent; box-shadow: none;
        border-right: 2px solid #94a3b8;
        border-radius: 0 8px 0 0;
        padding: 8px 16px 8px 12px;
      }
      .mf-shape-braces {
        border: none; background: transparent; box-shadow: none;
        border-left: 2px solid #94a3b8; border-right: 2px solid #94a3b8;
        border-radius: 8px;
        padding: 8px 16px;
      }
      .mf-shape-triangle {
        clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
        border: none; padding: 24px 20px 10px 20px;
      }
      .mf-shape-flag {
        clip-path: polygon(0% 0%, 80% 0%, 100% 50%, 80% 100%, 0% 100%);
        border: none; padding: 10px 28px 10px 16px;
      }
      .mf-shape-hourglass {
        clip-path: polygon(0% 0%, 100% 0%, 50% 50%, 100% 100%, 0% 100%, 50% 50%);
        border: none; padding: 16px;
      }
      .mf-shape-lined-rect {
        border-radius: 4px;
        border-left: 4px solid var(--node-stroke, #64748b);
        padding: 10px 16px;
      }
      .mf-shape-small-circle {
        border-radius: 50%;
        padding: 4px;
        min-width: 16px; min-height: 16px;
        background: #475569;
      }
      .mf-shape-framed-circle {
        border-radius: 50%;
        padding: 16px;
        box-shadow: inset 0 0 0 3px #ffffff, inset 0 0 0 4.5px var(--node-stroke, #94a3b8), 0 2px 8px rgba(0,0,0,0.08);
      }
      .mf-shape-filled-circle {
        border-radius: 50%;
        padding: 4px;
        min-width: 16px; min-height: 16px;
        background: #1e293b;
        border-color: #1e293b;
      }
      .mf-shape-fork {
        border-radius: 2px;
        padding: 2px 40px;
        min-height: 6px;
        background: #475569;
        border-color: #475569;
      }
      .mf-shape-text-block {
        border: none; background: transparent;
        box-shadow: none; padding: 8px 12px;
      }
      .mf-shape-delay {
        border-radius: 0 9999px 9999px 0;
        padding: 10px 24px 10px 16px;
      }
      .mf-shape-h-cylinder {
        border-radius: 12% / 50%;
        padding: 16px 20px;
      }
      .mf-shape-lined-cylinder {
        border-radius: 50% / 12%;
        padding: 16px 16px;
        box-shadow: inset 0 5px 0 0 #94a3b8, 0 2px 8px rgba(0,0,0,0.08);
      }
      .mf-shape-curved-trapezoid {
        clip-path: polygon(5% 0%, 95% 0%, 100% 25%, 100% 100%, 0% 100%, 0% 25%);
        border: none; padding: 12px 16px;
      }
      .mf-shape-divided-rect {
        border-radius: 4px;
        padding: 10px 16px;
        box-shadow: inset 0 -1px 0 0 #94a3b8, 0 2px 8px rgba(0,0,0,0.08);
      }
      .mf-shape-flipped-triangle {
        clip-path: polygon(0% 0%, 100% 0%, 50% 100%);
        border: none; padding: 10px 20px 24px 20px;
      }
      .mf-shape-sloped-rect {
        clip-path: polygon(0% 15%, 100% 0%, 100% 100%, 0% 100%);
        border: none; padding: 14px 16px 10px 16px;
      }
      .mf-shape-window-pane {
        border-radius: 4px;
        padding: 10px 16px;
        box-shadow: inset 1px 0 0 0 #94a3b8, inset 0 1px 0 0 #94a3b8, 0 2px 8px rgba(0,0,0,0.08);
      }
      .mf-shape-crossed-circle {
        border-radius: 50%;
        padding: 16px;
        background: linear-gradient(45deg, transparent 47%, #94a3b8 47%, #94a3b8 53%, transparent 53%),
                    linear-gradient(-45deg, transparent 47%, #94a3b8 47%, #94a3b8 53%, transparent 53%),
                    #ffffff;
      }
      .mf-shape-lined-document {
        clip-path: polygon(0% 0%, 100% 0%, 100% 85%, 85% 92%, 65% 98%, 50% 100%, 35% 98%, 15% 92%, 0% 85%);
        border: none; padding: 10px 16px 22px 16px;
      }
      .mf-shape-notched-pentagon {
        clip-path: polygon(0% 15%, 50% 0%, 100% 15%, 100% 100%, 0% 100%);
        border: none; padding: 14px 16px 10px 16px;
      }
      .mf-shape-tag-document {
        clip-path: polygon(0% 0%, 100% 0%, 100% 85%, 85% 92%, 65% 98%, 50% 100%, 35% 98%, 15% 92%, 0% 85%);
        border: none; padding: 10px 16px 22px 16px;
      }
      .mf-shape-tag-rect {
        clip-path: polygon(0% 0%, 92% 0%, 100% 50%, 92% 100%, 0% 100%);
        border: none; padding: 10px 24px 10px 16px;
      }
      .mf-shape-bow-rect {
        clip-path: polygon(8% 0%, 92% 0%, 100% 50%, 92% 100%, 8% 100%, 0% 50%);
        border: none; padding: 10px 20px;
      }
      .mf-shape-stacked-rect {
        border-radius: 4px;
        padding: 10px 16px;
        box-shadow: 3px 3px 0 0 #94a3b8, 6px 6px 0 0 #cbd5e1, 0 2px 8px rgba(0,0,0,0.08);
      }

      /* Clip-path shapes need a background border layer */
      .mf-flow-node[data-clip-shape] {
        border: none;
      }
      .mf-flow-border-layer {
        position: absolute;
        inset: -2px;
        z-index: -1;
        pointer-events: none;
      }
      .mf-node-label {
        pointer-events: none;
        max-width: 200px;
      }
      .mf-node-label .mf-label-line {
        display: block;
      }
      .mf-flow-subgraph {
        position: absolute;
        border: 1.5px dashed #a5b4fc;
        border-radius: 10px;
        background: rgba(238, 242, 255, 0.4);
        z-index: 0;
      }
      .mf-flow-subgraph-label {
        position: absolute;
        top: -11px;
        left: 12px;
        background: #eef2ff;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 700;
        color: #4338ca;
        border-radius: 4px;
        white-space: nowrap;
      }
      .mf-flow-edges {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 1;
        overflow: visible;
      }
      .mf-flow-edges .mf-edge {
        pointer-events: stroke;
        cursor: pointer;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mf-flow-edges .mf-edge-hit {
        pointer-events: stroke;
        cursor: pointer;
        stroke: transparent;
        stroke-width: 14;
        fill: none;
      }
      .mf-flow-edges .mf-edge:hover { stroke: #6366f1; }
      .mf-flow-edges .mf-edge-label-bg {
        pointer-events: all;
        cursor: pointer;
      }
      .mf-flow-edges .mf-edge-label {
        pointer-events: none;
      }
      .mf-flow-port {
        position: absolute;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #2563eb;
        border: 2px solid #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
        font-size: 13px;
        font-weight: bold;
        cursor: pointer;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.15s;
        box-shadow: 0 1px 4px rgba(0,0,0,0.15);
      }
      .mf-flow-port:hover { opacity: 1 !important; transform: scale(1.1); }
      /* ── Custom ER Diagram Styles ── */
      .mf-er-container {
        font-family: "Manrope", system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
        position: relative;
      }
      .mf-er-entity {
        position: absolute;
        background: #ffffff;
        border: 1.5px solid #6366f1;
        border-radius: 6px;
        overflow: hidden;
        cursor: grab;
        min-width: 160px;
        z-index: 2;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        transition: box-shadow 0.12s ease, filter 0.12s ease;
      }
      .mf-er-entity:hover {
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
        filter: brightness(1.02);
      }
      .mf-er-entity:active { cursor: grabbing; }
      .mf-er-entity.mf-selected {
        outline: 2.5px solid #2563eb;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(37, 99, 235, 0.3);
      }
      .mf-er-entity.mf-connect-source {
        outline: 3px solid #16a34a;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(22, 163, 74, 0.4);
      }
      .mf-er-header {
        background: #6366f1;
        color: #ffffff;
        padding: 6px 12px;
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.02em;
      }
      .mf-er-attrs {
        font-size: 12px;
        font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
      }
      .mf-er-attr-row {
        display: flex;
        gap: 8px;
        padding: 4px 12px;
        border-top: 1px solid #e2e8f0;
        align-items: center;
        cursor: default;
        transition: background 0.1s;
      }
      .mf-er-attr-row:hover { background: #f1f5f9; }
      .mf-er-constraint {
        font-size: 10px;
        font-weight: 700;
        color: #6366f1;
        min-width: 20px;
        text-align: center;
      }
      .mf-er-type {
        color: #64748b;
        min-width: 44px;
      }
      .mf-er-name {
        color: #1e293b;
        font-weight: 500;
      }
      .mf-er-edges {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 1;
      }
      .mf-er-edges .mf-er-edge {
        pointer-events: stroke;
        cursor: pointer;
        transition: stroke 0.1s;
      }
      .mf-er-edges .mf-er-edge:hover { stroke: #6366f1; }
      .mf-er-edges .mf-er-edge-hit {
        fill: none;
        stroke: transparent;
        stroke-width: 16;
        pointer-events: stroke;
        cursor: pointer;
      }
      .mf-er-edges .mf-er-edge-label-bg {
        pointer-events: none;
      }
      .mf-er-edges .mf-er-edge-label {
        pointer-events: none;
      }
      .mf-er-port {
        position: absolute;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #6366f1;
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 10;
        opacity: 0.85;
        transition: transform 0.1s, opacity 0.1s;
        box-shadow: 0 1px 4px rgba(0,0,0,0.15);
      }
      .mf-er-port:hover { opacity: 1 !important; transform: scale(1.1); }
      .mf-flow-port.mf-port-dragging { opacity: 1 !important; background: #1d4ed8; transform: scale(1.2); }
      .mf-flow-drag-line { pointer-events: none; position: absolute; top: 0; left: 0; z-index: 9; }
      .mf-flow-node.mf-connect-drop-target { outline: 2.5px solid #3b82f6; outline-offset: 3px; border-radius: 6px; }
      [data-theme="dark"] .mf-flow-node.mf-connect-drop-target { outline-color: #60a5fa; }
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
        max-width: min(520px, calc(100vw - 48px));
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        display: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.1);
      }

      /* ── Custom Sequence Diagram ── */
      .mf-seq-container {
        font-family: "Manrope", system-ui, sans-serif;
        font-size: 13px;
        user-select: none;
        position: relative;
        margin: 24px auto;
        min-height: 200px;
        background: var(--panel, #ffffff);
      }
      .mf-seq-actor {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 44px;
        border-radius: 4px;
        border: 1px solid var(--border, #ced4da);
        background: var(--panel, #ffffff);
        cursor: grab;
        transition: box-shadow 0.15s, border-color 0.15s;
        z-index: 2;
        gap: 2px;
      }
      .mf-seq-actor:hover {
        border-color: var(--accent, #2563eb);
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
      }
      .mf-seq-actor.mf-selected {
        border-color: var(--accent, #2563eb);
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
      }
      .mf-seq-actor.mf-seq-actor-dragging {
        opacity: 0.7;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 20;
      }
      .mf-seq-actor.mf-seq-connect-source {
        border-color: #10b981;
        box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2);
      }
      .mf-seq-actor-icon {
        color: var(--ink, #333);
        line-height: 0;
      }
      .mf-seq-actor-label {
        font-size: 13px;
        font-weight: 500;
        color: var(--ink, #333);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
        text-align: center;
        padding: 0 10px;
      }
      .mf-seq-actor-bottom .mf-seq-actor-label {
        font-weight: 400;
      }
      .mf-seq-lifeline {
        opacity: 0.5;
      }
      .mf-seq-activation {
        opacity: 0.6;
      }
      .mf-seq-message {
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.1s;
        z-index: 1;
      }
      .mf-seq-message:hover {
        background: rgba(37, 99, 235, 0.06);
      }
      .mf-seq-message.mf-selected {
        background: rgba(37, 99, 235, 0.08);
        outline: 1px solid var(--accent, #2563eb);
      }
      .mf-seq-msg-label {
        pointer-events: none;
      }
      .mf-seq-msg-label-bg {
        pointer-events: none;
      }
      .mf-seq-drop-indicator {
        position: absolute;
        width: 3px;
        background: var(--accent, #2563eb);
        border-radius: 2px;
        opacity: 0.6;
        z-index: 15;
        pointer-events: none;
      }

      /* Swimlane view */
      .mf-seq-swimlane {
        display: flex;
        gap: 12px;
        padding: 16px;
        align-items: flex-start;
        overflow-x: auto;
        width: 100% !important;
        max-width: none !important;
      }
      .mf-seq-lane {
        border: 1px solid var(--border, #d1d5db);
        border-radius: 8px;
        background: var(--panel, #ffffff);
        overflow: hidden;
        flex: 1 1 0;
        min-width: 200px;
        max-width: 400px;
      }
      .mf-seq-lane.mf-selected {
        border-color: var(--accent, #2563eb);
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12);
      }
      .mf-seq-lane-header {
        font-size: 13px;
        font-weight: 600;
        padding: 12px 16px;
        background: var(--bg-soft, #f9fafb);
        border-bottom: 1px solid var(--border, #e5e7eb);
        cursor: pointer;
        text-align: center;
        word-break: break-word;
      }
      .mf-seq-lane-header:hover {
        background: var(--bg-hover, #f3f4f6);
      }
      .mf-seq-lane-messages {
        padding: 4px 0;
      }
      .mf-seq-lane-msg {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        padding: 8px 16px;
        font-size: 12px;
        cursor: pointer;
        min-height: 36px;
        transition: background 0.1s;
      }
      .mf-seq-lane-msg:hover {
        background: rgba(37, 99, 235, 0.05);
      }
      .mf-seq-lane-msg.mf-selected {
        background: rgba(37, 99, 235, 0.1);
      }
      .mf-seq-lane-msg-blank {
        min-height: 8px;
        cursor: default;
      }
      .mf-seq-lane-msg-blank:hover {
        background: none;
      }
      .mf-seq-lane-text {
        color: var(--ink, #333);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.4;
        white-space: normal;
        word-break: break-word;
      }
      .mf-seq-lane-meta {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .mf-seq-lane-direction {
        font-weight: 600;
        color: var(--accent, #2563eb);
        flex-shrink: 0;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 10px;
        background: rgba(37, 99, 235, 0.08);
        font-size: 11px;
      }
      .mf-seq-lane-peer {
        font-size: 10px;
        font-weight: 500;
        color: var(--ink-soft, #9ca3af);
      }

      /* ── Dark Theme ── */
      [data-theme="dark"] body,
      [data-theme="dark"] html {
        background: #14161e;
        background-image: radial-gradient(circle, #2a2e3d 0.75px, transparent 0.75px);
        color: #e4e6ed;
      }
      [data-theme="dark"] .mf-gantt-container {
        border-color: #2a2e3d;
        color: #e4e6ed;
      }
      [data-theme="dark"] .mf-gantt-corner {
        background: #1c1f2b;
        border-color: #2a2e3d;
        color: #e4e6ed;
        box-shadow: 10px 0 12px -12px rgba(0, 0, 0, 0.5);
      }
      [data-theme="dark"] .mf-gantt-add-section-btn {
        border-color: #3a3f52;
        background: rgba(28, 31, 43, 0.92);
        color: #6b7088;
      }
      [data-theme="dark"] .mf-gantt-add-section-btn:hover {
        background: #252838;
        border-color: #4a5068;
        color: #9a9fb2;
      }
      [data-theme="dark"] .mf-gantt-role-cell {
        background: #1c1f2b;
        border-color: #2a2e3d;
        color: #e4e6ed;
        box-shadow: 10px 0 12px -12px rgba(0, 0, 0, 0.5);
      }
      [data-theme="dark"] .mf-gantt-section-edit-btn {
        border-color: #3a3f52;
        background: #252838;
        color: #6b7088;
      }
      [data-theme="dark"] .mf-gantt-section-edit-btn:hover {
        background: #2a2e3d;
        color: #9a9fb2;
        border-color: #4a5068;
      }
      [data-theme="dark"] .mf-gantt-track {
        border-bottom-color: #2a2e3d;
        background: #1c1f2b;
      }
      [data-theme="dark"] .mf-gantt-track:nth-child(4n+1) {
        background: #1a1d28;
      }
      [data-theme="dark"] .mf-gantt-track.mf-show-grid-lines {
        background-image: repeating-linear-gradient(
          90deg,
          transparent,
          transparent calc(var(--px-per-day) - 1px),
          #2a2e3d calc(var(--px-per-day) - 1px),
          #2a2e3d var(--px-per-day)
        );
      }
      [data-theme="dark"] .mf-gantt-bar.mf-bar-default .bar-label,
      [data-theme="dark"] .mf-gantt-bar.mf-bar-active .bar-label {
        color: #e4e6ed;
      }
      [data-theme="dark"] .mf-gantt-progress-fill { background: rgba(0, 0, 0, 0.4); }
      [data-theme="dark"] .mf-bar-active .mf-gantt-progress-fill { background: rgba(0, 0, 0, 0.35); }
      [data-theme="dark"] .mf-bar-default { background: #3a3f52; }
      [data-theme="dark"] .mf-bar-critical-path {
        box-shadow: 0 0 0 2.5px #f87171, 0 0 12px rgba(248, 113, 113, 0.5);
        outline: 2px solid #f87171;
        outline-offset: 1px;
      }
      [data-theme="dark"] .mf-gantt-milestone.mf-bar-critical-path::before {
        box-shadow: 0 0 0 2.5px #f87171, 0 0 12px rgba(248, 113, 113, 0.5);
      }
      [data-theme="dark"] .mf-gantt-milestone::before {
        background: #4ade80;
      }
      [data-theme="dark"] .mf-gantt-milestone .bar-label {
        color: #e4e6ed;
        text-shadow: 0 0 3px #0f1117, 0 0 3px #0f1117;
      }
      [data-theme="dark"] .mf-gantt-milestone .bar-date-suffix {
        color: #9a9fb2;
        text-shadow: 0 0 3px #0f1117, 0 0 3px #0f1117;
      }
      [data-theme="dark"] .mf-gantt-risk-badge { color: #fbbf24; }
      [data-theme="dark"] .mf-bar-at-risk {
        box-shadow: 0 0 0 2px #fbbf24, 0 0 8px rgba(251, 191, 36, 0.4);
      }
      [data-theme="dark"] .mf-bar-at-risk.mf-bar-critical-path {
        box-shadow: 0 0 0 2.5px #f87171, 0 0 0 5px #fbbf24, 0 0 12px rgba(248, 113, 113, 0.5);
      }
      [data-theme="dark"] .mf-dep-lines-svg path { stroke: #d1d5db; }
      [data-theme="dark"] .mf-dep-lines-svg marker path { fill: #d1d5db; }
      [data-theme="dark"] .mf-gantt-cycle-banner { background: #451a03; border-color: #fbbf24; color: #fde68a; }
      [data-theme="dark"] .mf-gantt-conflict-badge { background: #fbbf24; color: #000; }
      [data-theme="dark"] .mf-gantt-slack { background: repeating-linear-gradient(45deg, #1e40af, #1e40af 3px, #1e3a8a 3px, #1e3a8a 6px); }
      [data-theme="dark"] .mf-gantt-ghost-bar { background: rgba(59,130,246,0.2); border-color: #3b82f6; }
      [data-theme="dark"] .mf-gantt-excluded-day {
        background: rgba(255,255,255,0.03);
      }
      [data-theme="dark"] .mf-gantt-insert-btn {
        background: #1c1f2b;
        border-color: #3a3f52;
        color: #6b7088;
      }
      [data-theme="dark"] .mf-gantt-insert-btn:hover {
        border-color: #60a5fa;
        color: #60a5fa;
        background: #1c1f2b;
      }
      [data-theme="dark"] .mf-gantt-today-line {
        border-left-color: #ef4444;
      }
      [data-theme="dark"] .mf-gantt-vert-marker {
        border-left-color: #3b82f6;
      }
      [data-theme="dark"] .mf-gantt-vert-label {
        color: #60a5fa;
      }
      [data-theme="dark"] .mf-gantt-baseline-bar {
        background: #64748b;
        opacity: 0.18;
        border-color: #94a3b8;
      }
      [data-theme="dark"] .mf-gantt-delta-badge.mf-delta-late {
        background: #451a1a;
        color: #f87171;
        border-color: #7f1d1d;
      }
      [data-theme="dark"] .mf-gantt-delta-badge.mf-delta-early {
        background: #14331c;
        color: #4ade80;
        border-color: #166534;
      }
      [data-theme="dark"] #mf-tooltip {
        background: #252838;
        color: #e4e6ed;
        border-color: rgba(255,255,255,0.1);
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      }
      /* Dark flowchart nodes */
      [data-theme="dark"] .mf-flow-node {
        background: #252838;
        border-color: #3a3f52;
        color: #e4e6ed;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      [data-theme="dark"] .mf-flow-container {
        background-image: radial-gradient(circle, #2a2e3d 0.5px, transparent 0.5px);
      }
      [data-theme="dark"] .mf-shape-rect { background: #1c1f2b; border-color: #818cf8; }
      [data-theme="dark"] .mf-shape-rounded { background: #172554; border-color: #60a5fa; }
      [data-theme="dark"] .mf-shape-stadium { background: #14532d; border-color: #4ade80; }
      [data-theme="dark"] .mf-shape-diamond { background: #451a03; }
      [data-theme="dark"] .mf-shape-circle { background: #2e1065; border-color: #a78bfa; }
      [data-theme="dark"] .mf-shape-hexagon { background: #500724; }
      [data-theme="dark"] .mf-shape-subroutine { background: #1e293b; border-color: #94a3b8; }
      [data-theme="dark"] .mf-shape-cylinder { background: #083344; border-color: #22d3ee; }
      [data-theme="dark"] .mf-flow-edge line,
      [data-theme="dark"] .mf-flow-edge path {
        stroke: #4a5068;
      }
      [data-theme="dark"] .mf-flow-edge text {
        fill: #9a9fb2;
      }
      /* Dark ER diagram styles */
      [data-theme="dark"] .mf-er-entity {
        background: #1c1f2b;
        border-color: #818cf8;
        color: #e4e6ed;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      [data-theme="dark"] .mf-er-header {
        background: #4f46e5;
        color: #f1f5f9;
      }
      [data-theme="dark"] .mf-er-attr-row {
        border-color: #2a2e3d;
      }
      [data-theme="dark"] .mf-er-attr-row:hover { background: #252838; }
      [data-theme="dark"] .mf-er-constraint { color: #a5b4fc; }
      [data-theme="dark"] .mf-er-type { color: #9a9fb2; }
      [data-theme="dark"] .mf-er-name { color: #e4e6ed; }
      [data-theme="dark"] .mf-er-edges .mf-er-edge { stroke: #4a5068; }
      [data-theme="dark"] .mf-er-edges .mf-er-edge:hover { stroke: #818cf8; }
      [data-theme="dark"] .mf-er-edges .mf-er-edge-label-bg { fill: #1c1f2b; stroke: #2a2e3d; }
      [data-theme="dark"] .mf-er-edges .mf-er-edge-label { fill: #9a9fb2; }
      [data-theme="dark"] .mf-er-port { background: #818cf8; }
      [data-theme="dark"] #mf-arrow path,
      [data-theme="dark"] #mf-arrow-rev path { fill: #6b7394; }
      [data-theme="dark"] #mf-arrow-thick path,
      [data-theme="dark"] #mf-arrow-thick-rev path { fill: #818cf8; }
      [data-theme="dark"] #mf-circle circle { fill: #6b7394; }
      [data-theme="dark"] #mf-cross path { stroke: #6b7394; }
      [data-theme="dark"] .mf-edge-label-bg {
        fill: #1c1f2b !important;
        stroke: #2a2e3d !important;
      }
      /* Dark sequence diagram */
      [data-theme="dark"] .mf-seq-actor {
        background: #1c1f2b;
        border-color: #3a3f52;
      }
      [data-theme="dark"] .mf-seq-actor:hover {
        border-color: #60a5fa;
        box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.15);
      }
      [data-theme="dark"] .mf-seq-actor-label { color: #e4e6ed; }
      [data-theme="dark"] .mf-seq-actor-icon { color: #e4e6ed; }
      [data-theme="dark"] .mf-seq-msg-label-bg {
        fill: #1c1f2b;
        stroke: #2a2e3d;
      }
      [data-theme="dark"] .mf-seq-lane {
        background: #1c1f2b;
        border-color: #2a2e3d;
      }
      [data-theme="dark"] .mf-seq-lane-header {
        background: #161922;
        border-color: #2a2e3d;
        color: #e4e6ed;
      }
      [data-theme="dark"] .mf-seq-lane-text { color: #e4e6ed; }
      [data-theme="dark"] .mf-seq-lane-direction {
        background: rgba(99, 102, 241, 0.15);
        color: #818cf8;
      }
      [data-theme="dark"] .mf-seq-lane-peer { color: #6b7088; }
      [data-theme="dark"] .mf-seq-lane-msg:hover {
        background: rgba(99, 102, 241, 0.08);
      }
      /* Dark gantt header rows */
      [data-theme="dark"] .mf-gh-row {
        background: #1c1f2b;
        border-color: #2a2e3d;
        color: #9a9fb2;
      }
      [data-theme="dark"] .mf-gh-row.month { background: #1a1d28; }
      [data-theme="dark"] .mf-gh-row.week { background: #161922; }
      [data-theme="dark"] .mf-gh-cell {
        border-color: #2a2e3d;
        color: #9a9fb2;
      }
      [data-theme="dark"] .mf-role-row {
        background: #1c1f2b;
        border-color: #2a2e3d;
        color: #e4e6ed;
      }
      /* ── Executive view banner ── */
      .mf-exec-banner {
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
      }
      .mf-exec-banner-inner {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: "Manrope", system-ui, sans-serif;
      }
      .mf-exec-progress {
        flex: 0 0 120px;
        height: 6px;
        background: #e5e7eb;
        border-radius: 3px;
        overflow: hidden;
      }
      .mf-exec-progress-bar {
        height: 100%;
        background: #22c55e;
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      .mf-exec-pct {
        font-weight: 700;
        color: #1e293b;
      }
      .mf-exec-counts {
        color: #64748b;
      }
      .mf-exec-status {
        margin-left: auto;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }
      .mf-exec-on-track {
        background: rgba(34, 197, 94, 0.15);
        color: #16a34a;
      }
      .mf-exec-at-risk {
        background: rgba(234, 179, 8, 0.15);
        color: #ca8a04;
      }
      .mf-exec-late {
        background: rgba(239, 68, 68, 0.15);
        color: #dc2626;
      }
      [data-theme="dark"] .mf-exec-banner {
        border-color: #2a2e3d;
      }
      [data-theme="dark"] .mf-exec-progress {
        background: #2a2e3d;
      }
      [data-theme="dark"] .mf-exec-pct {
        color: #e4e6ed;
      }
      [data-theme="dark"] .mf-exec-counts {
        color: #9a9fb2;
      }
      [data-theme="dark"] .mf-exec-on-track {
        background: rgba(34, 197, 94, 0.2);
        color: #4ade80;
      }
      [data-theme="dark"] .mf-exec-at-risk {
        background: rgba(234, 179, 8, 0.2);
        color: #facc15;
      }
      [data-theme="dark"] .mf-exec-late {
        background: rgba(239, 68, 68, 0.2);
        color: #f87171;
      }

      /* ── State Diagram Renderer ────────────────────── */
      .mf-state-container {
        font-family: "Manrope", system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        user-select: none;
        position: relative;
      }
      .mf-state-node {
        position: absolute;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        background: #ffffff;
        border: 2px solid #6366f1;
        border-radius: 12px;
        color: #1e293b;
        font-size: 13px;
        font-weight: 500;
        padding: 10px 20px;
        cursor: grab;
        transition: box-shadow 0.12s ease, border-color 0.12s ease;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        box-sizing: border-box;
        z-index: 2;
      }
      .mf-state-node:hover {
        box-shadow: 0 4px 16px rgba(99, 102, 241, 0.2);
        border-color: #4f46e5;
      }
      .mf-state-node:active { cursor: grabbing; }
      .mf-state-node.mf-selected {
        outline: 2.5px solid #2563eb;
        outline-offset: 2px;
        box-shadow: 0 0 10px rgba(37, 99, 235, 0.3);
      }
      .mf-state-node.mf-state-dragging {
        opacity: 0.7;
        border-color: #22c55e;
        box-shadow: 0 0 12px rgba(34, 197, 94, 0.4);
      }
      .mf-state-initial {
        width: 20px !important;
        height: 20px !important;
        min-width: 20px;
        min-height: 20px;
        padding: 0;
        border-radius: 50%;
        background: #1e293b;
        border-color: #1e293b;
        cursor: default;
      }
      .mf-state-final {
        width: 24px !important;
        height: 24px !important;
        min-width: 24px;
        min-height: 24px;
        padding: 0;
        border-radius: 50%;
        background: #ffffff;
        border: 3px solid #1e293b;
        box-shadow: inset 0 0 0 3px #ffffff, inset 0 0 0 8px #1e293b;
        cursor: default;
      }
      .mf-state-label {
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 160px;
      }
      .mf-state-edges {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        z-index: 1;
      }
      .mf-state-edges .mf-edge { pointer-events: stroke; cursor: pointer; }
      .mf-state-edges .mf-edge-hit {
        stroke: transparent;
        stroke-width: 14;
        fill: none;
        pointer-events: stroke;
        cursor: pointer;
      }
      .mf-state-edges .mf-edge:hover {
        stroke: #4f46e5;
        stroke-width: 2.5;
      }
      .mf-drag-line {
        stroke: #22c55e;
        stroke-width: 2;
        stroke-dasharray: 6,4;
        pointer-events: none;
      }
      .mf-state-node.mf-drop-target {
        border-color: #22c55e;
        box-shadow: 0 0 12px rgba(34, 197, 94, 0.4);
      }
      /* Dark state diagram */
      [data-theme="dark"] .mf-state-node {
        background: #1e293b;
        border-color: #818cf8;
        color: #e4e6ed;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      [data-theme="dark"] .mf-state-node:hover {
        box-shadow: 0 4px 16px rgba(129, 140, 248, 0.25);
        border-color: #a5b4fc;
      }
      [data-theme="dark"] .mf-state-initial {
        background: #e2e8f0;
        border-color: #e2e8f0;
      }
      [data-theme="dark"] .mf-state-final {
        background: #1e293b;
        border: 3px solid #e2e8f0;
        box-shadow: inset 0 0 0 3px #1e293b, inset 0 0 0 8px #e2e8f0;
      }
      [data-theme="dark"] .mf-state-edges .mf-edge { stroke: #4a5068; }
      [data-theme="dark"] .mf-state-edges .mf-edge-label { fill: #9a9fb2; }
      [data-theme="dark"] .mf-state-edges .mf-edge-label-bg { fill: #252838; stroke: #3a3f52; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="mf-gantt-grid-header"></div>
      <div id="mf-gantt-role-column"></div>
      <div id="canvas"></div>
      <div id="error"></div>
    </div>
    <div id="mf-tooltip"></div>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      import dagre from "https://esm.sh/@dagrejs/dagre@1.1.4";

      let selected = null;
      let dragState = null;
      let suppressClick = false;
      let currentDiagramType = "";
      let lastGanttAutoStartKey = "";
      const wrap = document.getElementById("wrap");
      const canvas = document.getElementById("canvas");
      const error = document.getElementById("error");
      const tooltipEl = document.getElementById("mf-tooltip");
      const ganttHeaderEl = document.getElementById("mf-gantt-grid-header");
      const ganttRoleColEl = document.getElementById("mf-gantt-role-column");
      const TASK_TEXT_SEL = "text.taskText, text.taskTextOutsideRight, text.taskTextOutsideLeft";
      let lastGanttAnnotation = { tasks: [], showDates: true, scale: "week" };
      const supportsHover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
      let ganttInsertLayerVisible = !supportsHover;

      const syncGanttInsertLayerVisibility = () => {
        const layer = canvas.querySelector(".mf-gantt-insert-layer");
        if (!layer) return;
        const show = !supportsHover || ganttInsertLayerVisible;
        layer.style.opacity = show ? "1" : "0";
        layer.style.pointerEvents = show ? "auto" : "none";
      };

      const setGanttMode = (enabled) => {
        wrap.classList.toggle("mf-gantt-mode", !!enabled);
        canvas.classList.toggle("mf-gantt-mode", !!enabled);
      };

      let ganttOverlayState = null;
      let ganttOverlayRaf = 0;

      const clearGanttOverlay = () => {
        ganttOverlayState = null;
        if (ganttHeaderEl) {
          ganttHeaderEl.style.display = "none";
          ganttHeaderEl.innerHTML = "";
        }
        if (ganttRoleColEl) {
          ganttRoleColEl.style.display = "none";
          ganttRoleColEl.innerHTML = "";
        }
      };

      const median = (values) => {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      const weekLabelUtc = (ms) => {
        const d = new Date(ms);
        const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayNum = dt.getUTCDay() || 7;
        dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
        return "Week " + weekNo;
      };

      const queueGanttOverlaySync = () => {
        if (!ganttOverlayState) return;
        if (ganttOverlayRaf) cancelAnimationFrame(ganttOverlayRaf);
        ganttOverlayRaf = requestAnimationFrame(() => {
          ganttOverlayRaf = 0;
          syncGanttOverlay();
        });
      };

      const syncGanttOverlay = () => {
        if (!ganttOverlayState || !ganttHeaderEl || !ganttRoleColEl) return;
        const { rowGroups, samples, minStartMs, maxEndMs, scale } = ganttOverlayState;
        if (!samples.length || !rowGroups.length) return clearGanttOverlay();

        const wrapRect = wrap.getBoundingClientRect();
        const toWrapX = (screenX) => screenX - wrapRect.left + wrap.scrollLeft;
        const toWrapY = (screenY) => screenY - wrapRect.top + wrap.scrollTop;

        // Recompute day width and X anchor using current DOM geometry (works with pan/zoom).
        const pxPerDayValues = samples
          .map((sample) => {
            const spanDays = sample.spanDays;
            if (!spanDays || !sample.rectEl?.isConnected) return 0;
            const w = sample.rectEl.getBoundingClientRect().width;
            return w > 0 ? w / spanDays : 0;
          })
          .filter((v) => v > 0);
        const pxPerDay = Math.max(
          scale === "month" ? 8 : 14,
          Math.min(scale === "month" ? 18 : 30, median(pxPerDayValues) || (scale === "month" ? 12 : 20))
        );

        const xAnchors = samples
          .map((sample) => {
            if (!sample.rectEl?.isConnected) return null;
            const rect = sample.rectEl.getBoundingClientRect();
            return toWrapX(rect.left) - ((sample.startMs - minStartMs) / 86400000) * pxPerDay;
          })
          .filter((v) => Number.isFinite(v));
        const xStart = xAnchors.length ? median(xAnchors) : (wrap.scrollLeft + 16 + leftColWidth);

        const totalDays = Math.max(1, Math.floor((maxEndMs - minStartMs) / 86400000) + 1);
        const timelineWidth = totalDays * pxPerDay;

        const wrapInnerLeft = wrap.scrollLeft + 16;
        const leftColWidth = Math.max(180, Math.min(280, Math.round(xStart - wrapInnerLeft - 8)));
        const headerRowHeight = 24;
        const headerHeight = scale === "month" ? headerRowHeight : headerRowHeight * 2;

        // Position sticky-like containers.
        ganttHeaderEl.style.display = "block";
        ganttRoleColEl.style.display = "block";
        ganttHeaderEl.style.left = Math.round(xStart) + "px";
        ganttHeaderEl.style.top = Math.round(wrap.scrollTop + 16) + "px";
        ganttHeaderEl.style.width = Math.round(timelineWidth) + "px";
        ganttRoleColEl.style.left = Math.round(wrapInnerLeft) + "px";
        ganttRoleColEl.style.top = Math.round(wrap.scrollTop + 16 + headerHeight) + "px";
        ganttRoleColEl.style.width = leftColWidth + "px";

        // Build header rows.
        const dayItems = [];
        for (let i = 0; i < totalDays; i++) {
          const ms = minStartMs + i * 86400000;
          dayItems.push({ ms, x: i * pxPerDay });
        }

        const weekGroups = [];
        let weekStart = 0;
        let currentWeek = weekLabelUtc(dayItems[0].ms);
        for (let i = 1; i < dayItems.length; i++) {
          const nextWeek = weekLabelUtc(dayItems[i].ms);
          if (nextWeek !== currentWeek) {
            weekGroups.push({ label: currentWeek, start: weekStart, end: i - 1 });
            weekStart = i;
            currentWeek = nextWeek;
          }
        }
        weekGroups.push({ label: currentWeek, start: weekStart, end: dayItems.length - 1 });

        const monthGroups = [];
        let monthStart = 0;
        let currentMonth = new Date(dayItems[0].ms).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        for (let i = 1; i < dayItems.length; i++) {
          const month = new Date(dayItems[i].ms).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          if (month !== currentMonth) {
            monthGroups.push({ label: currentMonth, start: monthStart, end: i - 1 });
            monthStart = i;
            currentMonth = month;
          }
        }
        monthGroups.push({ label: currentMonth, start: monthStart, end: dayItems.length - 1 });

        const buildRow = (cls, groups, formatter) => {
          const row = document.createElement("div");
          row.className = "mf-gh-row " + cls;
          for (const g of groups) {
            const cell = document.createElement("div");
            cell.className = "mf-gh-cell";
            cell.style.width = Math.round((g.end - g.start + 1) * pxPerDay) + "px";
            cell.textContent = formatter(g);
            row.appendChild(cell);
          }
          return row;
        };

        ganttHeaderEl.innerHTML = "";
        ganttHeaderEl.appendChild(buildRow("month", monthGroups, (g) => g.label));
        if (scale === "week") {
          ganttHeaderEl.appendChild(buildRow("week", weekGroups, (g) => g.label));
        }

        // Sync role rows to section bounds.
        for (const rowGroup of rowGroups) {
          const yValuesTop = [];
          const yValuesBottom = [];
          for (const rectEl of rowGroup.rectEls) {
            if (!rectEl?.isConnected) continue;
            const box = rectEl.getBoundingClientRect();
            yValuesTop.push(toWrapY(box.top));
            yValuesBottom.push(toWrapY(box.bottom));
          }
          if (!yValuesTop.length || !yValuesBottom.length) continue;
          const top = Math.min(...yValuesTop);
          const bottom = Math.max(...yValuesBottom);
          rowGroup.el.style.top = Math.round(top - headerHeight) + "px";
          rowGroup.el.style.height = Math.max(34, Math.round(bottom - top)) + "px";
        }
      };

      const buildGanttOverlay = (taskVisuals, scale) => {
        if (!ganttHeaderEl || !ganttRoleColEl || !taskVisuals.length) {
          clearGanttOverlay();
          return;
        }

        const grouped = new Map();
        for (const visual of taskVisuals) {
          const key = (visual.section || "Tasks").trim() || "Tasks";
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(visual);
        }

        const rowGroups = [];
        ganttRoleColEl.innerHTML = "";
        for (const [section, visuals] of grouped.entries()) {
          const rowEl = document.createElement("div");
          rowEl.className = "mf-role-row";
          rowEl.textContent = section;
          ganttRoleColEl.appendChild(rowEl);
          rowGroups.push({ section, rectEls: visuals.map((v) => v.rectEl).filter(Boolean), el: rowEl });
        }

        const samples = [];
        for (const visual of taskVisuals) {
          const startMs = visual.startMs;
          const endMs = visual.endMs ?? startMs;
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !visual.rectEl) continue;
          const spanDays = Math.max(1, Math.floor((Math.max(startMs, endMs) - Math.min(startMs, endMs)) / 86400000) + 1);
          samples.push({ rectEl: visual.rectEl, startMs: Math.min(startMs, endMs), spanDays });
        }
        if (!samples.length) {
          clearGanttOverlay();
          return;
        }

        const minStartMs = Math.min(...samples.map((s) => s.startMs));
        const maxEndMs = Math.max(...taskVisuals.map((v) => Number.isFinite(v.endMs) ? v.endMs : v.startMs));

        ganttOverlayState = {
          rowGroups,
          samples,
          minStartMs,
          maxEndMs,
          scale: scale === "month" ? "month" : "week",
        };
        queueGanttOverlaySync();
      };

      /* ── Custom HTML Gantt Renderer ─────────────────────── */
      const buildTimelineHeaderRow = (type, minDateMs, totalDays, pxPerDay) => {
        const dayMs = 86400000;
        const row = document.createElement("div");
        row.className = "mf-gh-row " + type;

        const groups = [];
        let currentKey = "";
        let groupStart = 0;

        for (let i = 0; i < totalDays; i++) {
          const ms = minDateMs + i * dayMs;
          const d = new Date(ms);
          let key;
          if (type === "month") {
            key = d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          } else {
            key = weekLabelUtc(ms);
          }
          if (key !== currentKey) {
            if (currentKey) groups.push({ label: currentKey, days: i - groupStart });
            currentKey = key;
            groupStart = i;
          }
        }
        if (currentKey) groups.push({ label: currentKey, days: totalDays - groupStart });

        for (const g of groups) {
          const cell = document.createElement("div");
          cell.className = "mf-gh-cell";
          cell.style.width = Math.round(g.days * pxPerDay) + "px";
          cell.textContent = g.label;
          row.appendChild(cell);
        }
        return row;
      };

      const fmtShort = (iso) => {
        if (!iso) return "";
        const parts = iso.split("-");
        const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
      };

      const buildOpenableTaskUrl = (raw) => {
        const value = String(raw || "").trim();
        if (!value) return "";
        const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value);
        const candidate = hasProtocol ? value : "https://" + value;
        try {
          const parsed = new URL(candidate);
          return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
        } catch {
          return "";
        }
      };

      const renderCustomGantt = (tasks, scale, showDates, showGrid, directives, compact, ganttZoom, pinCategories, showCriticalPath, showDepLines, executiveView, showRisks, riskFlags, cycles, baselineTasks, assigneeFilterApplied) => {
        setGanttMode(true);
        clearGanttOverlay();
        canvas.innerHTML = "";
        canvas.style.justifyContent = "flex-start";

        if (!tasks || !tasks.length) {
          const msg = document.createElement("div");
          msg.style.cssText = "padding:32px;color:#64748b;font-size:14px;";
          msg.textContent = assigneeFilterApplied
            ? "No tasks match the selected assignee filter."
            : "No tasks found in gantt definition.";
          canvas.appendChild(msg);
          return;
        }

        directives = directives || {};
        const excludes = directives.excludes || [];
        const weekend = directives.weekend || "";

        const dayMs = 86400000;
        const isoToMs = (iso) => {
          if (!iso || !/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)) return null;
          const val = Date.parse(iso + "T00:00:00Z");
          return Number.isFinite(val) ? val : null;
        };

        // Inline excludes checker for the iframe
        const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
        const isExcludedDay = (ms) => {
          if (!excludes.length) return false;
          const d = new Date(ms);
          const dow = d.getUTCDay();
          for (const excl of excludes) {
            if (excl === "weekends") {
              if (weekend === "friday") { if (dow === 5 || dow === 6) return true; }
              else { if (dow === 0 || dow === 6) return true; }
            } else {
              const idx = dayNames.indexOf(excl);
              if (idx >= 0 && idx === dow) return true;
            }
            // Specific date check
            if (/^\\d{4}-\\d{2}-\\d{2}$/.test(excl)) {
              const exclMs = Date.parse(excl + "T00:00:00Z");
              if (Math.abs(ms - exclMs) < dayMs) return true;
            }
          }
          return false;
        };

        // Separate vert markers from regular tasks
        const vertTasks = tasks.filter((t) => t.isVertMarker);
        const allRegularTasks = tasks.filter((t) => !t.isVertMarker);

        // Executive view: filter to milestones, critical, and overdue tasks
        const todayIso = new Date().toISOString().slice(0, 10);
        const regularTasks = executiveView
          ? allRegularTasks.filter((t) => {
              if (t.isMilestone) return true;
              const statuses = t.statusTokens || [];
              if (statuses.includes("crit")) return true;
              // Overdue: not done and end date is in the past
              const isDone = statuses.includes("done");
              const end = t.computedEnd || t.endDate || "";
              if (!isDone && end && end < todayIso) return true;
              return false;
            })
          : allRegularTasks;

        // Enrich tasks with resolved end dates
        const enriched = regularTasks.map((t) => {
          let resolvedEnd = t.endDate || t.computedEnd || "";
          if (!resolvedEnd && t.startDate && t.durationDays) {
            const d = new Date(t.startDate + "T00:00:00Z");
            d.setUTCDate(d.getUTCDate() + t.durationDays);
            resolvedEnd = d.toISOString().slice(0, 10);
          }
          return { ...t, resolvedEnd };
        });

        // Build baseline task lookup by label
        const baselineByLabel = new Map();
        if (baselineTasks && baselineTasks.length) {
          for (const bt of baselineTasks) {
            if (bt.label && !bt.isVertMarker) {
              baselineByLabel.set(bt.label.toLowerCase(), bt);
            }
          }
        }

        // Date range (include vert markers in range calculation)
        const allItems = [...enriched, ...vertTasks.map((t) => ({ startDate: t.startDate, resolvedEnd: t.startDate }))];
        const allStartMs = allItems.map((t) => isoToMs(t.startDate)).filter(Number.isFinite);
        const allEndMs = allItems.map((t) => isoToMs(t.resolvedEnd) || isoToMs(t.startDate)).filter(Number.isFinite);
        // Expand date range to include baseline tasks
        if (baselineByLabel.size) {
          for (const bt of baselineByLabel.values()) {
            const bsMs = isoToMs(bt.startDate);
            const beMs = isoToMs(bt.computedEnd) || bsMs;
            if (Number.isFinite(bsMs)) allStartMs.push(bsMs);
            if (Number.isFinite(beMs)) allEndMs.push(beMs);
          }
        }
        if (!allStartMs.length) {
          canvas.textContent = "No dated tasks found.";
          return;
        }

        const minDateMs = Math.min(...allStartMs);
        const maxDateMs = Math.max(...allEndMs);
        // Pad 2 days on each side so bars don't start at the very edge
        const paddedMin = minDateMs - 2 * dayMs;
        const paddedMax = maxDateMs + 2 * dayMs;
        const totalDays = Math.max(7, Math.ceil((paddedMax - paddedMin) / dayMs) + 1);

        const basePxPerDay = scale === "month" ? 12 : 22;
        const pxPerDay = Math.max(2, Math.round(basePxPerDay * (ganttZoom || 1)));
        const timelineWidth = totalDays * pxPerDay;
        const roleColWidth = 200;
        const rowHeight = 40;
        const barHeight = 28;
        const barGap = Math.floor((rowHeight - barHeight) / 2);
        const today = new Date().toISOString().slice(0, 10);

        // Group tasks by section
        const sectionMap = new Map();
        for (const t of enriched) {
          const key = (t.section || "Tasks").trim() || "Tasks";
          if (!sectionMap.has(key)) sectionMap.set(key, []);
          sectionMap.get(key).push(t);
        }

        const labelMeasureCanvas = document.createElement("canvas");
        const labelMeasureCtx = labelMeasureCanvas.getContext("2d");
        if (labelMeasureCtx) {
          labelMeasureCtx.font = '600 11.5px "Manrope", system-ui, sans-serif';
        }
        const suffixMeasureCanvas = document.createElement("canvas");
        const suffixMeasureCtx = suffixMeasureCanvas.getContext("2d");
        if (suffixMeasureCtx) {
          suffixMeasureCtx.font = '400 10px "Manrope", system-ui, sans-serif';
        }
        const measureLabelWidth = (text) => {
          const safeText = String(text || "");
          if (!safeText) return 0;
          if (labelMeasureCtx) return Math.ceil(labelMeasureCtx.measureText(safeText).width);
          return Math.ceil(safeText.length * 8.4);
        };
        const measureSuffixWidth = (text) => {
          const safeText = String(text || "");
          if (!safeText) return 0;
          if (suffixMeasureCtx) return Math.ceil(suffixMeasureCtx.measureText(safeText).width);
          return Math.ceil(safeText.length * 6.4);
        };

        // Build container
        // Track bar positions for dependency arrows
        const barPositions = new Map();
        let cumulativeTop = 0;

        const container = document.createElement("div");
        container.className = "mf-gantt-container";
        container.style.gridTemplateColumns = roleColWidth + "px " + timelineWidth + "px";
        container.style.width = (roleColWidth + timelineWidth) + "px";

        // === Header: Corner cell ===
        const corner = document.createElement("div");
        corner.className = "mf-gantt-corner";
        const cornerLabel = document.createElement("span");
        cornerLabel.className = "mf-gantt-corner-label";
        cornerLabel.textContent = "Category / Phase";
        corner.appendChild(cornerLabel);
        const addSectionBtn = document.createElement("button");
        addSectionBtn.type = "button";
        addSectionBtn.className = "mf-gantt-add-section-btn";
        addSectionBtn.setAttribute("aria-label", "Add category / phase");
        addSectionBtn.setAttribute("title", "Add category / phase");
        addSectionBtn.textContent = "+";
        addSectionBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          send("gantt:add-section");
        });
        corner.appendChild(addSectionBtn);
        const headerHeight = scale === "month" ? 24 : 48;
        corner.style.height = headerHeight + "px";
        if (!pinCategories) corner.style.position = "relative";
        container.appendChild(corner);

        // === Header: Timeline ===
        const timelineHeader = document.createElement("div");
        timelineHeader.className = "mf-gantt-timeline-header";
        timelineHeader.appendChild(buildTimelineHeaderRow("month", paddedMin, totalDays, pxPerDay));
        if (scale === "week") {
          timelineHeader.appendChild(buildTimelineHeaderRow("week", paddedMin, totalDays, pxPerDay));
        }
        container.appendChild(timelineHeader);

        cumulativeTop = headerHeight;

        // === Circular dependency warning banner ===
        cycles = cycles || [];
        if (cycles.length > 0) {
          const warnBanner = document.createElement("div");
          warnBanner.className = "mf-gantt-cycle-banner";
          warnBanner.textContent = "Circular dependency detected: " + cycles[0].join(" \u2192 ");
          container.appendChild(warnBanner);
          cumulativeTop += warnBanner.offsetHeight || 36;
        }

        // === Executive view: progress summary banner ===
        if (executiveView) {
          const totalCount = allRegularTasks.length;
          const doneCount = allRegularTasks.filter((t) => (t.statusTokens || []).includes("done")).length;
          const overdueCount = allRegularTasks.filter((t) => {
            const isDone = (t.statusTokens || []).includes("done");
            const end = t.computedEnd || t.endDate || "";
            return !isDone && end && end < todayIso;
          }).length;
          const critCount = allRegularTasks.filter((t) => (t.statusTokens || []).includes("crit") && !(t.statusTokens || []).includes("done")).length;
          const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;

          let statusLabel = "On track";
          let statusClass = "mf-exec-on-track";
          if (overdueCount > 0) {
            statusLabel = overdueCount + " overdue";
            statusClass = "mf-exec-late";
          } else if (critCount > 0) {
            statusLabel = "At risk";
            statusClass = "mf-exec-at-risk";
          }

          const banner = document.createElement("div");
          banner.className = "mf-exec-banner";
          banner.style.gridColumn = "1 / -1";
          banner.innerHTML =
            '<div class="mf-exec-banner-inner">' +
              '<div class="mf-exec-progress"><div class="mf-exec-progress-bar" style="width:' + pct + '%"></div></div>' +
              '<span class="mf-exec-pct">' + pct + '% complete</span>' +
              '<span class="mf-exec-counts">' + doneCount + '/' + totalCount + ' tasks done</span>' +
              '<span class="mf-exec-status ' + statusClass + '">' + statusLabel + '</span>' +
            '</div>';
          container.appendChild(banner);
        }

        // === Body: Section rows ===
        for (const [section, sectionTasks] of sectionMap.entries()) {
          // Compact mode: greedy lane packing
          let rowAssignments;
          if (compact) {
            const lanes = [];
            rowAssignments = sectionTasks.map((task) => {
              const sMs = isoToMs(task.startDate) || 0;
              const eMs = isoToMs(task.resolvedEnd) || isoToMs(task.startDate) || sMs;
              const effectiveEnd = Math.max(eMs, sMs + dayMs);
              for (let lane = 0; lane < lanes.length; lane++) {
                const conflicts = lanes[lane].some(
                  (iv) => sMs < iv.endMs && effectiveEnd > iv.startMs
                );
                if (!conflicts) {
                  lanes[lane].push({ startMs: sMs, endMs: effectiveEnd });
                  return lane;
                }
              }
              lanes.push([{ startMs: sMs, endMs: effectiveEnd }]);
              return lanes.length - 1;
            });
          } else {
            rowAssignments = sectionTasks.map((_, idx) => idx);
          }

          const numRows = compact ? Math.max(0, ...rowAssignments) + 1 : sectionTasks.length;
          const trackHeight = numRows * rowHeight;

          // Role cell
          const roleCell = document.createElement("div");
          roleCell.className = "mf-gantt-role-cell";
          roleCell.style.height = trackHeight + "px";
          if (!pinCategories) roleCell.style.position = "relative";
          const roleLabelWrap = document.createElement("div");
          roleLabelWrap.className = "mf-gantt-role-label-wrap";
          const roleLabel = document.createElement("span");
          roleLabel.textContent = section;
          roleLabelWrap.appendChild(roleLabel);
          const editSectionBtn = document.createElement("button");
          editSectionBtn.type = "button";
          editSectionBtn.className = "mf-gantt-section-edit-btn";
          editSectionBtn.setAttribute("aria-label", "Edit category / phase");
          editSectionBtn.setAttribute("title", "Edit category / phase");
          const editIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          editIcon.setAttribute("viewBox", "0 0 24 24");
          editIcon.setAttribute("aria-hidden", "true");
          const editPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          editPath.setAttribute("d", "M4 20h4l10-10-4-4L4 16v4zm12-14l2 2");
          editIcon.appendChild(editPath);
          editSectionBtn.appendChild(editIcon);
          editSectionBtn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            send("gantt:edit-section", { section });
          });
          roleLabelWrap.appendChild(editSectionBtn);
          roleCell.appendChild(roleLabelWrap);
          // Insert (+) button per section
          const lastTask = sectionTasks[sectionTasks.length - 1];
          if (lastTask) {
            const insertBtn = document.createElement("div");
            insertBtn.className = "mf-gantt-insert-btn";
            insertBtn.textContent = "+";
            insertBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              send("gantt:add-between", { afterLabel: lastTask.label, section: section });
            });
            roleCell.appendChild(insertBtn);
          }
          container.appendChild(roleCell);

          // Track
          const track = document.createElement("div");
          track.className = "mf-gantt-track";
          track.style.height = trackHeight + "px";
          track.style.setProperty("--px-per-day", pxPerDay + "px");
          if (showGrid) track.classList.add("mf-show-grid-lines");

          // Excluded day shading
          if (excludes.length) {
            for (let dayIdx = 0; dayIdx < totalDays; dayIdx++) {
              const dMs = paddedMin + dayIdx * dayMs;
              if (isExcludedDay(dMs)) {
                const stripe = document.createElement("div");
                stripe.className = "mf-gantt-excluded-day";
                stripe.style.left = (dayIdx * pxPerDay) + "px";
                stripe.style.width = pxPerDay + "px";
                track.appendChild(stripe);
              }
            }
          }

          sectionTasks.forEach((task, idx) => {
            const startMs = isoToMs(task.startDate);
            const endMs = isoToMs(task.resolvedEnd) || startMs;
            if (!Number.isFinite(startMs)) return;

            const left = Math.round(((startMs - paddedMin) / dayMs) * pxPerDay);
            const width = Math.max(Math.round(pxPerDay), Math.round(((Math.max(endMs, startMs + dayMs) - startMs) / dayMs) * pxPerDay));
            const top = rowAssignments[idx] * rowHeight + barGap;

            // Baseline ghost bar
            const baselineTask = baselineByLabel.get((task.label || "").toLowerCase());
            if (baselineTask && !task.isMilestone) {
              const blStartMs = isoToMs(baselineTask.startDate);
              const blEndMs = isoToMs(baselineTask.computedEnd) || blStartMs;
              if (Number.isFinite(blStartMs)) {
                const blLeft = Math.round(((blStartMs - paddedMin) / dayMs) * pxPerDay);
                const blWidth = Math.max(Math.round(pxPerDay), Math.round(((Math.max(blEndMs, blStartMs + dayMs) - blStartMs) / dayMs) * pxPerDay));
                const ghost = document.createElement("div");
                ghost.className = "mf-gantt-baseline-bar";
                ghost.style.left = blLeft + "px";
                ghost.style.width = blWidth + "px";
                ghost.style.top = top + "px";
                ghost.style.height = barHeight + "px";
                ghost.setAttribute("data-mf-tip", "Baseline: " + (baselineTask.startDate || "") + " – " + (baselineTask.computedEnd || ""));
                track.appendChild(ghost);
              }
            }

            // Delta badge (baseline vs current start date)
            if (baselineTask && task.startDate && baselineTask.startDate) {
              const baselineStartMs = isoToMs(baselineTask.startDate);
              if (Number.isFinite(startMs) && Number.isFinite(baselineStartMs)) {
                const deltaDays = Math.round((startMs - baselineStartMs) / dayMs);
                if (deltaDays !== 0) {
                  const badge = document.createElement("div");
                  badge.className = "mf-gantt-delta-badge" + (deltaDays > 0 ? " mf-delta-late" : " mf-delta-early");
                  badge.textContent = (deltaDays > 0 ? "+" : "") + deltaDays + "d";
                  badge.style.top = (top - 12) + "px";
                  badge.style.left = left + "px";
                  track.appendChild(badge);
                }
              }
            }

            // Status-based color
            const statuses = task.statusTokens || [];
            let barClass = "mf-bar-default";
            if (statuses.includes("done") && statuses.includes("crit")) barClass = "mf-bar-doneCrit";
            else if (statuses.includes("active") && statuses.includes("crit")) barClass = "mf-bar-activeCrit";
            else if (statuses.includes("done")) barClass = "mf-bar-done";
            else if (statuses.includes("crit")) barClass = "mf-bar-crit";
            else if (statuses.includes("active")) barClass = "mf-bar-active";

            // Critical path highlighting — dim ALL non-critical tasks
            let cpClass = "";
            if (showCriticalPath) {
              cpClass = task.isCriticalPath ? " mf-bar-critical-path" : " mf-bar-dimmed";
            }

            const bar = document.createElement("div");
            const isNarrow = width < 70;
            const showsMetaSuffix = showDates && !!task.startDate;
            let barLeft = left;
            let barPixelWidth = width;

            // Milestone rendering: diamond shape
            if (task.isMilestone) {
              const diamondSize = barHeight;
              const milestoneLeft = left + Math.floor(width / 2) - Math.floor(diamondSize / 2);
              barLeft = milestoneLeft;
              barPixelWidth = diamondSize;
              bar.className = "mf-gantt-milestone " + barClass + cpClass;
              bar.style.left = milestoneLeft + "px";
              bar.style.width = diamondSize + "px";
              bar.style.height = diamondSize + "px";
              bar.style.top = top + "px";
            } else {
              bar.className = "mf-gantt-bar " + barClass + (isNarrow && !showsMetaSuffix ? " mf-bar-narrow" : "") + cpClass;
              bar.style.left = left + "px";
              bar.style.width = width + "px";
              bar.style.top = top + "px";
              bar.style.height = barHeight + "px";
            }
            bar.setAttribute("data-task-label", task.label || "");
            const rawTaskLink = String(task.link || "").trim();
            const openableTaskLink = buildOpenableTaskUrl(rawTaskLink);
            const hasTaskLink = Boolean(rawTaskLink);
            bar.style.setProperty("--link-icon-width", hasTaskLink ? "24px" : "0px");

            if (!task.isMilestone) {
              const startHandle = document.createElement("div");
              startHandle.className = "mf-bar-resize-handle start";
              startHandle.setAttribute("data-drag-mode", "resize-start");
              const endHandle = document.createElement("div");
              endHandle.className = "mf-bar-resize-handle end";
              endHandle.setAttribute("data-drag-mode", "resize-end");
              bar.append(startHandle, endHandle);
            }

            // Progress fill overlay (white wash on unfilled portion)
            if (!task.isMilestone && task.progress != null && task.progress > 0 && task.progress < 100) {
              const progressFill = document.createElement("div");
              progressFill.className = "mf-gantt-progress-fill";
              progressFill.style.width = (100 - Math.min(100, task.progress)) + "%";
              bar.appendChild(progressFill);
            }

            // Dependency connector handle (drag from this to create a dependency)
            const depConn = document.createElement("div");
            depConn.className = "mf-dep-connector";
            bar.appendChild(depConn);

            depConn.addEventListener("pointerdown", (e) => {
              e.stopPropagation();
              e.preventDefault();
              // Hide any visible tooltip during drag
              tooltipEl.style.display = "none";
              // Capture pointer so events keep firing even outside the element
              depConn.setPointerCapture(e.pointerId);

              const fromId = task.idToken || task.label || "";
              const fromLabel = task.label || "";
              const canvasRect = canvas.getBoundingClientRect();
              // Look up bar position from the map (populated at render time)
              const barKey = (task.idToken || task.label || "").toLowerCase();
              const pos = barPositions.get(barKey);
              const startX = pos ? pos.right + 2 : 0;
              const startY = pos ? pos.centerY : 0;

              // Create temporary SVG drag line
              const svgNS = "http://www.w3.org/2000/svg";
              const dragSvg = document.createElementNS(svgNS, "svg");
              dragSvg.setAttribute("class", "mf-dep-drag-line");
              dragSvg.style.width = canvas.scrollWidth + "px";
              dragSvg.style.height = canvas.scrollHeight + "px";
              const dragLine = document.createElementNS(svgNS, "line");
              dragLine.setAttribute("x1", startX);
              dragLine.setAttribute("y1", startY);
              dragLine.setAttribute("x2", startX);
              dragLine.setAttribute("y2", startY);
              dragLine.setAttribute("stroke", "#3b82f6");
              dragLine.setAttribute("stroke-width", "2");
              dragLine.setAttribute("stroke-dasharray", "6 3");
              dragSvg.appendChild(dragLine);
              const ganttContainer = canvas.querySelector(".mf-gantt-container");
              ganttContainer.appendChild(dragSvg);

              let currentTarget = null;
              let dragging = false;

              const onMove = (ev) => {
                dragging = true;
                tooltipEl.style.display = "none";
                const mx = ev.clientX - canvasRect.left + canvas.scrollLeft;
                const my = ev.clientY - canvasRect.top + canvas.scrollTop;
                dragLine.setAttribute("x2", mx);
                dragLine.setAttribute("y2", my);

                // Temporarily hide drag SVG to find element underneath
                dragSvg.style.display = "none";
                const el = document.elementFromPoint(ev.clientX, ev.clientY);
                dragSvg.style.display = "";
                const targetBar = el?.closest(".mf-gantt-bar, .mf-gantt-milestone");
                if (currentTarget && currentTarget !== targetBar) {
                  currentTarget.classList.remove("mf-dep-drop-target");
                }
                if (targetBar && targetBar !== bar) {
                  targetBar.classList.add("mf-dep-drop-target");
                  currentTarget = targetBar;
                } else {
                  currentTarget = null;
                }
              };

              const onUp = (ev) => {
                depConn.removeEventListener("pointermove", onMove);
                depConn.removeEventListener("pointerup", onUp);
                try { depConn.releasePointerCapture(ev.pointerId); } catch (_) {}
                dragSvg.remove();
                if (!dragging) return;
                if (currentTarget) {
                  currentTarget.classList.remove("mf-dep-drop-target");
                  const targetLabel = currentTarget.getAttribute("data-task-label") || currentTarget.getAttribute("data-label") || "";
                  if (targetLabel && targetLabel !== fromLabel) {
                    send("gantt:dep-created", { fromId, fromLabel, targetLabel });
                  }
                }
              };

              depConn.addEventListener("pointermove", onMove);
              depConn.addEventListener("pointerup", onUp);
            });

            // Bar label
            const labelSpan = document.createElement("span");
            labelSpan.className = "bar-label";
            labelSpan.textContent = task.label || "";
            bar.appendChild(labelSpan);

            // Date suffix (not for milestones)
            let dateSuffixWidth = 0;
            if (showsMetaSuffix) {
              const dateSuffix = document.createElement("span");
              dateSuffix.className = "bar-date-suffix";
              const startStr = fmtShort(task.startDate);
              const endStr = task.resolvedEnd ? fmtShort(task.resolvedEnd) : "";
              let dateStr = endStr ? startStr + " – " + endStr : startStr;
              if (task.assignee) dateStr += " · " + task.assignee;
              dateSuffix.textContent = dateStr;
              bar.appendChild(dateSuffix);
              // Measure before mount so label always reserves suffix space.
              dateSuffixWidth = measureSuffixWidth(dateStr) + 4;
              bar.style.setProperty("--date-suffix-width", dateSuffixWidth + "px");
            } else {
              bar.style.setProperty("--date-suffix-width", "0px");
            }

            if (hasTaskLink) {
              const linkBtn = document.createElement("button");
              linkBtn.type = "button";
              linkBtn.className = "bar-link-icon";
              linkBtn.setAttribute("title", rawTaskLink);
              linkBtn.setAttribute("aria-label", "Open task link");

              const linkIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              linkIcon.setAttribute("viewBox", "0 0 24 24");
              linkIcon.setAttribute("aria-hidden", "true");
              const linkPathA = document.createElementNS("http://www.w3.org/2000/svg", "path");
              linkPathA.setAttribute("d", "M10.8 13.2a3 3 0 0 1 0-4.2l3-3a3 3 0 1 1 4.2 4.2l-1.2 1.2");
              const linkPathB = document.createElementNS("http://www.w3.org/2000/svg", "path");
              linkPathB.setAttribute("d", "M13.2 10.8a3 3 0 0 1 0 4.2l-3 3a3 3 0 1 1-4.2-4.2l1.2-1.2");
              linkIcon.append(linkPathA, linkPathB);
              linkBtn.appendChild(linkIcon);

              linkBtn.addEventListener("pointerdown", (event) => {
                event.stopPropagation();
              });
              linkBtn.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!openableTaskLink) return;
                window.open(openableTaskLink, "_blank", "noopener,noreferrer");
              });

              bar.appendChild(linkBtn);
            }

            const labelWidth = measureLabelWidth(task.label || "");
            bar.style.setProperty("--outside-label-width", labelWidth + "px");
            if (task.isMilestone) {
              const rightSpace = timelineWidth - (barLeft + barPixelWidth);
              if (rightSpace < labelWidth + 14) bar.classList.add("mf-label-outside-left");
            } else {
              const innerLabelWidth = Math.max(
                0,
                width -
                  16 -
                  (dateSuffixWidth ? dateSuffixWidth + 6 : 0) -
                  (hasTaskLink ? 24 : 0)
              );
              if (labelWidth > innerLabelWidth) {
                // Keep task title outside-right when it doesn't fit in the bar.
                bar.classList.add("mf-label-outside");
              }
            }

            if (!task.isMilestone) {
              const hasOutsideLabel =
                bar.classList.contains("mf-label-outside") ||
                bar.classList.contains("mf-label-outside-left");
              if (hasOutsideLabel) {
                labelSpan.style.maxWidth = "none";
              } else {
                const reservedWidth =
                  (dateSuffixWidth ? dateSuffixWidth + 6 : 0) +
                  (hasTaskLink ? 24 : 0) +
                  16;
                // Avoid negative max-width values; those can invalidate CSS and cause overlap.
                const clampedLabelWidth = Math.max(0, width - reservedWidth);
                labelSpan.style.maxWidth = clampedLabelWidth + "px";
              }
            }

            // Tooltip
            const isDone = statuses.includes("done");
            const isOverdue = task.resolvedEnd && !isDone && task.resolvedEnd < today;
            let tip = task.label || "";
            if (task.isMilestone) tip += "\\nMilestone";
            if (statuses.length) {
              const sMap = { done: "Done", active: "Active", crit: "Critical" };
              tip += "\\nStatus: " + statuses.map((s) => sMap[s] || s).join(", ");
            }
            if (task.startDate) tip += "\\nStart: " + fmtShort(task.startDate);
            if (task.resolvedEnd) tip += "\\nEnd: " + fmtShort(task.resolvedEnd);
            if (isOverdue) tip += "\\nOVERDUE";
            if (task.assignee) tip += "\\nAssignee: " + task.assignee;
            if (task.notes) tip += "\\nNotes: " + task.notes;
            if (task.progress != null) tip += "\\nProgress: " + task.progress + "%";
            if (rawTaskLink) tip += "\\nLink: " + rawTaskLink;
            // Dependency info in tooltip
            if (task.afterDeps && task.afterDeps.length) {
              tip += "\\nDepends on: " + task.afterDeps.join(", ");
            }
            if (task.conflicts && task.conflicts.length) {
              tip += "\\n\\u26a0 Scheduling conflict: this task starts before " + task.conflicts.map(function(c) { return '"' + c.depLabel + '" finishes (' + c.overlapDays + "d overlap)"; }).join(", ");
            }
            if (typeof task.slackDays === "number" && task.slackDays > 0) {
              tip += "\\nBuffer: " + task.slackDays + " day" + (task.slackDays !== 1 ? "s" : "") + " before this delays the project";
            }
            if (task.isCriticalPath) tip += "\\n\\u2b50 Critical path \\u2014 any delay here delays the project";
            const taskRisk = showRisks && riskFlags[task.label];
            if (taskRisk && taskRisk.reasons.length > 0) {
              for (const r of taskRisk.reasons) tip += "\\n\\u26A0 " + r;
            }
            bar.setAttribute("data-mf-tip", tip);
            bar.setAttribute("data-label", (task.idToken || task.label || "").toLowerCase());

            // Record bar position for dependency arrows
            const barKey = (task.idToken || task.label || "").toLowerCase();
            if (barKey) {
              barPositions.set(barKey, {
                left: roleColWidth + barLeft,
                right: roleColWidth + barLeft + barPixelWidth,
                centerY: cumulativeTop + top + barHeight / 2,
              });
            }

            // Overdue dot
            if (isOverdue && !task.isMilestone) {
              const dot = document.createElement("div");
              dot.className = "mf-gantt-overdue-dot";
              dot.style.left = (left - 12) + "px";
              dot.style.top = (top + barHeight / 2 - 4) + "px";
              track.appendChild(dot);
            }

            // Risk badge
            if (taskRisk && taskRisk.flags.length > 0 && !task.isMilestone) {
              const riskBadge = document.createElement("div");
              riskBadge.className = "mf-gantt-risk-badge";
              riskBadge.style.left = (left - 12) + "px";
              riskBadge.style.top = isOverdue ? (top + barHeight / 2 + 6) + "px" : (top + barHeight / 2 - 6) + "px";
              riskBadge.textContent = "\\u26A0";
              track.appendChild(riskBadge);
              bar.classList.add("mf-bar-at-risk");
            }

            // Conflict badge
            if (task.conflicts && task.conflicts.length > 0 && !task.isMilestone) {
              var conflictBadge = document.createElement("div");
              conflictBadge.className = "mf-gantt-conflict-badge";
              conflictBadge.textContent = "!";
              conflictBadge.style.left = (barLeft - 14) + "px";
              conflictBadge.style.top = (top - 2) + "px";
              conflictBadge.setAttribute("data-mf-tip",
                "Scheduling conflict \\u2014 this task starts too early:\\n" +
                task.conflicts.map(function(c) { return 'Starts ' + c.overlapDays + " day" + (c.overlapDays !== 1 ? "s" : "") + ' before "' + c.depLabel + '" finishes'; }).join("\\n")
              );
              track.appendChild(conflictBadge);
            }

            // Slack indicator bar
            if (typeof task.slackDays === "number" && task.slackDays > 0 && !task.isMilestone && showCriticalPath) {
              var slackPx = Math.round(task.slackDays * pxPerDay);
              var slackBar = document.createElement("div");
              slackBar.className = "mf-gantt-slack";
              slackBar.style.left = (barLeft + barPixelWidth) + "px";
              slackBar.style.width = Math.min(slackPx, timelineWidth - barLeft - barPixelWidth) + "px";
              slackBar.style.top = (top + barHeight / 2 - 2) + "px";
              slackBar.style.height = "4px";
              slackBar.setAttribute("data-mf-tip", "Buffer: " + task.slackDays + " day" + (task.slackDays !== 1 ? "s" : "") + "\\nThis task can slip by " + task.slackDays + " day" + (task.slackDays !== 1 ? "s" : "") + " without delaying the project");
              track.appendChild(slackBar);
            }

            // Click handler: select task + highlight dependency chain
            bar.addEventListener("click", (e) => {
              e.stopPropagation();
              // Clear previous selection & dep highlighting
              canvas.querySelectorAll(".mf-gantt-bar.mf-selected, .mf-gantt-milestone.mf-selected").forEach((el) => el.classList.remove("mf-selected"));
              canvas.querySelectorAll(".mf-dep-upstream-bar,.mf-dep-downstream-bar,.mf-dep-dimmed,.mf-dep-line-upstream,.mf-dep-line-downstream,.mf-dep-line-dimmed").forEach((el) => {
                el.classList.remove("mf-dep-upstream-bar","mf-dep-downstream-bar","mf-dep-dimmed","mf-dep-line-upstream","mf-dep-line-downstream","mf-dep-line-dimmed");
              });
              bar.classList.add("mf-selected");
              send("element:selected", { label: task.label, id: "", elementType: "node" });

              // Build forward/reverse dependency maps
              const depFwd = {};
              const depRev = {};
              for (const t of enriched) {
                const k = (t.idToken || t.label || "").toLowerCase();
                depFwd[k] = depFwd[k] || [];
                depRev[k] = depRev[k] || [];
                for (const d of t.afterDeps || []) {
                  const dk = d.toLowerCase();
                  depFwd[dk] = depFwd[dk] || [];
                  depFwd[dk].push(k);
                  depRev[k].push(dk);
                }
              }

              const thisKey = (task.idToken || task.label || "").toLowerCase();

              // BFS upstream
              const upstream = new Set();
              let q = [...(depRev[thisKey] || [])];
              for (const k of q) upstream.add(k);
              let qi = 0;
              while (qi < q.length) {
                const cur = q[qi++];
                for (const dep of (depRev[cur] || [])) {
                  if (!upstream.has(dep)) { upstream.add(dep); q.push(dep); }
                }
              }

              // BFS downstream
              const downstream = new Set();
              q = [...(depFwd[thisKey] || [])];
              for (const k of q) downstream.add(k);
              qi = 0;
              while (qi < q.length) {
                const cur = q[qi++];
                for (const dep of (depFwd[cur] || [])) {
                  if (!downstream.has(dep)) { downstream.add(dep); q.push(dep); }
                }
              }

              const hasChain = upstream.size > 0 || downstream.size > 0;
              if (hasChain) {
                // Highlight bars
                canvas.querySelectorAll(".mf-gantt-bar, .mf-gantt-milestone").forEach((b) => {
                  const lbl = b.getAttribute("data-label");
                  if (!lbl) return;
                  if (upstream.has(lbl)) b.classList.add("mf-dep-upstream-bar");
                  else if (downstream.has(lbl)) b.classList.add("mf-dep-downstream-bar");
                  else if (lbl !== thisKey) b.classList.add("mf-dep-dimmed");
                });
                // Highlight dep lines
                const svg = canvas.querySelector(".mf-dep-lines-svg");
                if (svg) {
                  svg.querySelectorAll("path[data-from]").forEach((p) => {
                    const f = p.getAttribute("data-from");
                    const t = p.getAttribute("data-to");
                    if ((upstream.has(f) || f === thisKey) && (upstream.has(t) || t === thisKey)) p.classList.add("mf-dep-line-upstream");
                    else if ((downstream.has(f) || f === thisKey) && (downstream.has(t) || t === thisKey)) p.classList.add("mf-dep-line-downstream");
                    else p.classList.add("mf-dep-line-dimmed");
                  });
                }
              }
            });

            // Context menu
            bar.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              e.stopPropagation();
              canvas.querySelectorAll(".mf-gantt-bar.mf-selected, .mf-gantt-milestone.mf-selected").forEach((el) => el.classList.remove("mf-selected"));
              bar.classList.add("mf-selected");
              send("element:context", {
                label: task.label,
                id: "",
                elementType: "node",
                pointerX: e.clientX,
                pointerY: e.clientY,
              });
            });

            // Drag handler
            let dragInfo = null;
            bar.addEventListener("pointerdown", (e) => {
              if (e.button !== 0) return;
              if (e.target.closest(".bar-link-icon")) return;
              if (e.target.closest(".mf-dep-connector")) return;
              e.preventDefault();
              const rect = bar.getBoundingClientRect();
              const relX = e.clientX - rect.left;
              const edgeZone = Math.max(rect.width * 0.15, 8);
              const explicitMode = e.target.closest(".mf-bar-resize-handle")?.getAttribute("data-drag-mode");
              let mode = explicitMode || "shift";
              // Milestones only support shift (no resize)
              if (!task.isMilestone && !explicitMode) {
                if (relX > rect.width - edgeZone) mode = "resize-end";
                else if (relX < edgeZone) mode = "resize-start";
              }

              dragInfo = {
                startX: e.clientX,
                origLeft: parseFloat(bar.style.left),
                origWidth: parseFloat(bar.style.width),
                mode,
                moved: false,
              };
              bar.style.cursor = mode.startsWith("resize") ? "ew-resize" : "grabbing";
              bar.setPointerCapture(e.pointerId);
            });

            bar.addEventListener("pointermove", (e) => {
              if (!dragInfo) return;
              const dx = e.clientX - dragInfo.startX;
              if (Math.abs(dx) > 2) dragInfo.moved = true;
              if (!dragInfo.moved) return;

              if (dragInfo.mode === "resize-end") {
                bar.style.width = Math.max(4, dragInfo.origWidth + dx) + "px";
              } else if (dragInfo.mode === "resize-start") {
                bar.style.left = (dragInfo.origLeft + dx) + "px";
                bar.style.width = Math.max(4, dragInfo.origWidth - dx) + "px";
              } else {
                bar.style.left = (dragInfo.origLeft + dx) + "px";

                // Ghost bars: show ripple effect on downstream tasks
                if (task.durationDays && barPositions.size > 0) {
                  const pxDay = dragInfo.origWidth / task.durationDays;
                  const tentShift = Math.round(dx / pxDay);
                  // Build downstream set via BFS
                  const fwd = {};
                  for (const t of enriched) {
                    const k = (t.idToken || t.label || "").toLowerCase();
                    for (const d of t.afterDeps || []) {
                      const dk = d.toLowerCase();
                      fwd[dk] = fwd[dk] || [];
                      fwd[dk].push(k);
                    }
                  }
                  const dsSet = new Set();
                  const dsQ = [...(fwd[(task.idToken || task.label || "").toLowerCase()] || [])];
                  for (const k of dsQ) dsSet.add(k);
                  let dsi = 0;
                  while (dsi < dsQ.length) {
                    const cur = dsQ[dsi++];
                    for (const dep of (fwd[cur] || [])) {
                      if (!dsSet.has(dep)) { dsSet.add(dep); dsQ.push(dep); }
                    }
                  }
                  // Remove old ghosts
                  canvas.querySelectorAll(".mf-gantt-ghost-bar").forEach(function(g) { g.remove(); });
                  var oldRipple = document.querySelector(".mf-gantt-ripple-summary");
                  if (oldRipple) oldRipple.remove();
                  if (dsSet.size > 0 && tentShift !== 0) {
                    var shiftPx = tentShift * pxDay;
                    for (var dKey of dsSet) {
                      var dPos = barPositions.get(dKey);
                      if (!dPos) continue;
                      var parentTrack = bar.closest(".mf-gantt-track");
                      // Find the actual track for this bar (search all tracks)
                      var allTracks = container.querySelectorAll(".mf-gantt-track");
                      for (var trk of allTracks) {
                        var match = trk.querySelector('[data-label="' + dKey + '"]');
                        if (match) {
                          var ghost = document.createElement("div");
                          ghost.className = "mf-gantt-ghost-bar";
                          ghost.style.left = (parseFloat(match.style.left) + shiftPx) + "px";
                          ghost.style.top = match.style.top;
                          ghost.style.width = match.style.width;
                          ghost.style.height = match.style.height || (barHeight + "px");
                          trk.appendChild(ghost);
                          break;
                        }
                      }
                    }
                    var ripple = document.createElement("div");
                    ripple.className = "mf-gantt-ripple-summary";
                    ripple.textContent = "Affects " + dsSet.size + " task" + (dsSet.size !== 1 ? "s" : "") + ", shifts by " + Math.abs(tentShift) + "d";
                    ripple.style.left = (e.clientX + 16) + "px";
                    ripple.style.top = (e.clientY - 30) + "px";
                    document.body.appendChild(ripple);
                  }
                }
              }
            });

            bar.addEventListener("pointerup", (e) => {
              if (!dragInfo) return;
              const dx = e.clientX - dragInfo.startX;
              bar.releasePointerCapture(e.pointerId);

              // Send downstream labels for rescheduling prompt
              const downstreamLabels = [];
              if (dragInfo.mode === "shift" && task.durationDays) {
                const fwd = {};
                for (const t of enriched) {
                  const k = (t.idToken || t.label || "").toLowerCase();
                  for (const d of t.afterDeps || []) {
                    const dk = d.toLowerCase();
                    fwd[dk] = fwd[dk] || [];
                    fwd[dk].push(k);
                  }
                }
                const dsSet = new Set();
                const dsQ = [...(fwd[(task.idToken || task.label || "").toLowerCase()] || [])];
                for (const k of dsQ) dsSet.add(k);
                let dsi = 0;
                while (dsi < dsQ.length) {
                  const cur = dsQ[dsi++];
                  for (const dep of (fwd[cur] || [])) {
                    if (!dsSet.has(dep)) { dsSet.add(dep); dsQ.push(dep); }
                  }
                }
                for (const t of enriched) {
                  const k = (t.idToken || t.label || "").toLowerCase();
                  if (dsSet.has(k)) downstreamLabels.push(t.label);
                }
              }

              if (dragInfo.moved && Math.abs(dx) > 4) {
                send("gantt:dragged", {
                  label: task.label,
                  deltaX: dx,
                  barWidth: dragInfo.origWidth,
                  dragMode: dragInfo.mode,
                  downstreamLabels,
                });
              }

              // Clean up ghosts and ripple summary
              canvas.querySelectorAll(".mf-gantt-ghost-bar").forEach(function(g) { g.remove(); });
              var oldRipple = document.querySelector(".mf-gantt-ripple-summary");
              if (oldRipple) oldRipple.remove();

              // Reset bar (re-render will come from code update)
              bar.style.left = dragInfo.origLeft + "px";
              bar.style.width = dragInfo.origWidth + "px";
              bar.style.cursor = "";
              dragInfo = null;
            });

            track.appendChild(bar);
          });

          // (Insert buttons moved to role cell)

          container.appendChild(track);
          cumulativeTop += trackHeight;
        }

        // Click on empty canvas area to clear dependency highlighting
        container.addEventListener("click", (e) => {
          if (e.target === container || e.target.classList.contains("mf-gantt-track")) {
            container.querySelectorAll(".mf-dep-upstream-bar,.mf-dep-downstream-bar,.mf-dep-dimmed,.mf-dep-line-upstream,.mf-dep-line-downstream,.mf-dep-line-dimmed").forEach((el) => {
              el.classList.remove("mf-dep-upstream-bar","mf-dep-downstream-bar","mf-dep-dimmed","mf-dep-line-upstream","mf-dep-line-downstream","mf-dep-line-dimmed");
            });
          }
        });

        // Vertical markers (vert)
        for (const vt of vertTasks) {
          const vtMs = isoToMs(vt.startDate || vt.computedEnd);
          if (vtMs === null || vtMs < paddedMin || vtMs > paddedMax) continue;
          const vtLeft = roleColWidth + Math.round(((vtMs - paddedMin) / dayMs) * pxPerDay);
          const vtLine = document.createElement("div");
          vtLine.className = "mf-gantt-vert-marker";
          vtLine.style.left = vtLeft + "px";
          const vtLabel = document.createElement("div");
          vtLabel.className = "mf-gantt-vert-label";
          vtLabel.textContent = vt.label || "";
          vtLine.appendChild(vtLabel);
          container.appendChild(vtLine);
        }

        // Dependency arrows
        if (showDepLines) {
          const svgNS = "http://www.w3.org/2000/svg";
          const totalHeight = cumulativeTop;
          const totalWidth = roleColWidth + timelineWidth;
          const svg = document.createElementNS(svgNS, "svg");
          svg.setAttribute("class", "mf-dep-lines-svg");
          svg.setAttribute("width", totalWidth);
          svg.setAttribute("height", totalHeight);
          svg.setAttribute("viewBox", "0 0 " + totalWidth + " " + totalHeight);
          svg.style.position = "absolute";
          svg.style.top = "0";
          svg.style.left = "0";
          svg.style.pointerEvents = "none";
          svg.style.zIndex = "2";

          // Arrowhead markers
          const defs = document.createElementNS(svgNS, "defs");
          const makeMarker = (id, color) => {
            const m = document.createElementNS(svgNS, "marker");
            m.setAttribute("id", id);
            m.setAttribute("viewBox", "0 0 10 10");
            m.setAttribute("refX", "9");
            m.setAttribute("refY", "5");
            m.setAttribute("markerWidth", "6");
            m.setAttribute("markerHeight", "6");
            m.setAttribute("orient", "auto-start-reverse");
            const p = document.createElementNS(svgNS, "path");
            p.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
            p.setAttribute("fill", color);
            m.appendChild(p);
            return m;
          };
          defs.appendChild(makeMarker("dep-arrow", "#374151"));
          defs.appendChild(makeMarker("dep-arrow-cp", "#ef4444"));
          svg.appendChild(defs);

          // Build critical path set for coloring arrows
          const cpSet = new Set();
          if (showCriticalPath) {
            for (const t of enriched) {
              if (t.isCriticalPath) cpSet.add((t.idToken || t.label || "").toLowerCase());
            }
          }

          const allRegularTasks = enriched;
          for (const task of allRegularTasks) {
            if (!task.afterDeps || !task.afterDeps.length) continue;
            const toKey = (task.idToken || task.label || "").toLowerCase();
            const toPos = barPositions.get(toKey);
            if (!toPos) continue;

            for (const depId of task.afterDeps) {
              const fromKey = depId.toLowerCase();
              const fromPos = barPositions.get(fromKey);
              if (!fromPos) continue;

              const x1 = fromPos.right + 2;
              const y1 = fromPos.centerY;
              const x2 = toPos.left - 2;
              const y2 = toPos.centerY;
              const isCpEdge = showCriticalPath && cpSet.has(fromKey) && cpSet.has(toKey);

              const path = document.createElementNS(svgNS, "path");
              if (Math.abs(y1 - y2) < 2) {
                // Same row: straight horizontal line
                path.setAttribute("d", "M " + x1 + " " + y1 + " L " + x2 + " " + y2);
              } else {
                // Smooth S-curve from predecessor right → dependent left
                const gapX = x2 - x1;
                const cx1 = x1 + Math.max(gapX * 0.4, 20);
                const cx2 = x2 - Math.max(gapX * 0.4, 20);
                path.setAttribute("d", "M " + x1 + " " + y1 + " C " + cx1 + " " + y1 + " " + cx2 + " " + y2 + " " + x2 + " " + y2);
              }
              path.setAttribute("stroke", isCpEdge ? "#ef4444" : "#374151");
              path.setAttribute("stroke-width", isCpEdge ? "2" : "1.5");
              path.setAttribute("fill", "none");
              path.setAttribute("marker-end", isCpEdge ? "url(#dep-arrow-cp)" : "url(#dep-arrow)");
              path.setAttribute("data-from", fromKey);
              path.setAttribute("data-to", toKey);
              svg.appendChild(path);
            }
          }

          container.appendChild(svg);
        }

        // Today line (respect todayMarker directive)
        const todayMarkerVal = (directives.todayMarker || "on").trim().toLowerCase();
        if (todayMarkerVal !== "off") {
          const todayMs = isoToMs(today);
          if (todayMs !== null && todayMs >= paddedMin && todayMs <= paddedMax) {
            const todayLeft = roleColWidth + Math.round(((todayMs - paddedMin) / dayMs) * pxPerDay);
            const todayLine = document.createElement("div");
            todayLine.className = "mf-gantt-today-line";
            todayLine.style.left = todayLeft + "px";
            // Custom styling support
            if (todayMarkerVal !== "on" && todayMarkerVal !== "") {
              const pairs = (directives.todayMarker || "").split(",");
              for (const pair of pairs) {
                const parts = pair.split(":");
                if (parts.length < 2) continue;
                const key = parts[0].trim();
                const val = parts.slice(1).join(":").trim();
                if (key === "stroke") todayLine.style.background = val;
                if (key === "stroke-width") todayLine.style.width = val;
                if (key === "opacity") todayLine.style.opacity = val;
              }
            }
            const todayDate = new Date(today + "T00:00:00");
            const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            const todayShort = monthNames[todayDate.getMonth()] + " " + todayDate.getDate();
            const todayHeaderLabel = document.createElement("div");
            todayHeaderLabel.className = "mf-gantt-today-header-label";
            todayHeaderLabel.style.left = todayLeft + "px";
            todayHeaderLabel.textContent = "Today · " + todayShort;
            container.appendChild(todayHeaderLabel);
            container.appendChild(todayLine);

            const autoStartKey = scale + "|" + paddedMin + "|" + paddedMax + "|" + totalDays;
            if (autoStartKey !== lastGanttAutoStartKey) {
              lastGanttAutoStartKey = autoStartKey;
              requestAnimationFrame(() => {
                const targetScroll = Math.max(0, todayLeft - roleColWidth - 8);
                wrap.scrollLeft = targetScroll;
                queueGanttOverlaySync();
              });
            }
          }
        }

        // Click on empty area deselects
        container.addEventListener("click", (e) => {
          if (e.target === container || e.target.classList.contains("mf-gantt-track")) {
            canvas.querySelectorAll(".mf-gantt-bar.mf-selected, .mf-gantt-milestone.mf-selected").forEach((el) => el.classList.remove("mf-selected"));
            send("element:selected", null);
          }
        });

        canvas.appendChild(container);
      };

      /* ── Custom HTML Flowchart Renderer ─────────────────── */

      const escapeHtml = (str) => { const s = String(str).replace(/&/g, "&amp;"); return s.replace(new RegExp("<","g"), "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); };

      const measureNodeDimensions = (nodes, classDefMap, classAssignments) => {
        const measurer = document.createElement("div");
        measurer.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:-9999px;left:-9999px;font-family:Manrope,system-ui,sans-serif;font-size:13px;line-height:1.4;";
        document.body.appendChild(measurer);
        const dims = {};
        for (const node of nodes) {
          const el = document.createElement("div");
          el.className = "mf-flow-node mf-shape-" + (node.shape || "rect");
          el.style.position = "static";
          el.style.maxWidth = "220px";
          const raw = node.label || node.id || "";
          const brRe = new RegExp("<br\\s*\\/?>", "gi");
          const lines = raw.replace(brRe, "\\n").split("\\n");
          el.innerHTML = '<div class="mf-node-label">' + lines.map(l => '<span class="mf-label-line">' + escapeHtml(l) + '<\/span>').join("") + '<\/div>';
          const cn = classAssignments[node.id];
          const cd = cn ? classDefMap[cn] : null;
          if (cd?.fill) el.style.background = cd.fill;
          measurer.appendChild(el);
          let w = el.offsetWidth + 2;
          let h = el.offsetHeight + 2;
          if (node.shape === "diamond") { const d = Math.ceil(Math.sqrt(w * w + h * h)) + 16; w = d; h = d; }
          if (node.shape === "circle" || node.shape === "double-circle") { const d = Math.max(w, h) + (node.shape === "double-circle" ? 16 : 8); w = d; h = d; }
          if (node.shape === "hexagon") { w = Math.max(w * 1.35, w + 32); }
          if (node.shape === "triangle" || node.shape === "flipped-triangle") { w = Math.max(w * 1.4, w + 24); h = Math.max(h * 1.3, h + 20); }
          if (node.shape === "cloud") { w = Math.max(w * 1.4, w + 32); h = Math.max(h * 1.3, h + 24); }
          if (node.shape === "small-circle" || node.shape === "filled-circle") { const d = Math.max(20, Math.min(w, h)); w = d; h = d; }
          if (node.shape === "fork") { w = Math.max(w, 80); h = Math.max(h, 8); }
          if (node.shape === "hourglass" || node.shape === "bang") { const d = Math.max(w, h) + 12; w = d; h = d; }
          if (node.shape === "bow-rect") { w = Math.max(w * 1.2, w + 20); }
          dims[node.id] = { width: Math.max(w, 50), height: Math.max(h, 36) };
          measurer.removeChild(el);
        }
        document.body.removeChild(measurer);
        return dims;
      };

      const layoutFlowchart = (parsed, nodeDims) => {
        const { direction, nodes, edges, subgraphs } = parsed;
        const rdMap = { TD: "TB", TB: "TB", LR: "LR", RL: "RL", BT: "BT" };
        const g = new dagre.graphlib.Graph({ compound: true });
        g.setGraph({ rankdir: rdMap[direction] || "TB", nodesep: 50, ranksep: 60, edgesep: 20, marginx: 40, marginy: 40 });
        g.setDefaultEdgeLabel(() => ({}));
        for (const n of nodes) {
          const d = nodeDims[n.id] || { width: 100, height: 40 };
          g.setNode(n.id, { width: d.width, height: d.height, label: n.label || n.id, shape: n.shape || "rect" });
        }
        for (const sg of subgraphs) {
          if (!g.hasNode(sg.id)) g.setNode(sg.id, { label: sg.label || sg.id, clusterLabelPos: "top", width: 0, height: 0 });
          for (const n of nodes) {
            if (n.lineIndex > sg.lineIndex && (sg.endLineIndex < 0 || n.lineIndex < sg.endLineIndex)) {
              g.setParent(n.id, sg.id);
            }
          }
        }
        for (const e of edges) {
          if (g.hasNode(e.source) && g.hasNode(e.target)) {
            g.setEdge(e.source, e.target, { label: e.label || "", arrowType: e.arrowType || "-->", minlen: e.minlen || 1 });
          }
        }
        dagre.layout(g);
        return g;
      };

      const getConnectionPt = (cx, cy, hw, hh, tx, ty, shape) => {
        const dx = tx - cx;
        const dy = ty - cy;
        const angle = Math.atan2(dy, dx);
        if (shape === "circle" || shape === "double-circle") {
          const r = Math.max(hw, hh);
          return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
        }
        if (shape === "diamond") {
          const absC = Math.abs(Math.cos(angle));
          const absS = Math.abs(Math.sin(angle));
          const t = 1 / ((absC / hw) + (absS / hh));
          return { x: cx + t * Math.cos(angle), y: cy + t * Math.sin(angle) };
        }
        // Rectangle / default
        const ar = hh / (hw || 1);
        const tanA = Math.abs(dy / (dx || 0.001));
        if (tanA > ar) {
          const iy = cy + (dy > 0 ? hh : -hh);
          return { x: cx + (dy !== 0 ? hh * (dx / Math.abs(dy)) : 0), y: iy };
        }
        const ix = cx + (dx > 0 ? hw : -hw);
        return { x: ix, y: cy + (dx !== 0 ? hw * (dy / Math.abs(dx)) : 0) };
      };

      const buildEdgeSvgPath = (points) => {
        if (!points || points.length < 2) return "";
        if (points.length === 2) {
          const sp = points[0], tp = points[1];
          const ddx = tp.x - sp.x, ddy = tp.y - sp.y;
          const off = Math.max(Math.hypot(ddx, ddy) * 0.35, 25);
          let c1x, c1y, c2x, c2y;
          if (Math.abs(ddx) > Math.abs(ddy)) {
            c1x = sp.x + (ddx > 0 ? off : -off); c1y = sp.y;
            c2x = tp.x - (ddx > 0 ? off : -off); c2y = tp.y;
          } else {
            c1x = sp.x; c1y = sp.y + (ddy > 0 ? off : -off);
            c2x = tp.x; c2y = tp.y - (ddy > 0 ? off : -off);
          }
          return "M " + sp.x.toFixed(1) + " " + sp.y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + tp.x.toFixed(1) + " " + tp.y.toFixed(1);
        }
        // Multi-point: Catmull-Rom to cubic bezier
        const pts = [points[0], ...points, points[points.length - 1]];
        let d = "M " + points[0].x.toFixed(1) + " " + points[0].y.toFixed(1);
        for (let i = 1; i < points.length; i++) {
          const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
          const t = 1 / 6;
          const c1x = p1.x + t * (p2.x - p0.x);
          const c1y = p1.y + t * (p2.y - p0.y);
          const c2x = p2.x - t * (p3.x - p1.x);
          const c2y = p2.y - t * (p3.y - p1.y);
          d += " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + p2.x.toFixed(1) + " " + p2.y.toFixed(1);
        }
        return d;
      };

      const buildSelfLoopPath = (nodeEl) => {
        const nx = parseFloat(nodeEl.style.left), ny = parseFloat(nodeEl.style.top);
        const nw = nodeEl.offsetWidth || 100, nh = nodeEl.offsetHeight || 40;
        const cx = nx + nw / 2, topY = ny;
        const loopH = 40, loopW = 30;
        return "M " + (cx - loopW) + " " + topY + " C " + (cx - loopW) + " " + (topY - loopH) + " " + (cx + loopW) + " " + (topY - loopH) + " " + (cx + loopW) + " " + topY;
      };

      const updateFlowEdgesForNode = (edgeSvg, edges, nodeId, nodeEls, nodeDims) => {
        for (const e of edges) {
          if (e.source !== nodeId && e.target !== nodeId) continue;
          const pathEl = edgeSvg.querySelector('.mf-edge[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
          const hitEl = edgeSvg.querySelector('.mf-edge-hit[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
          if (!pathEl) continue;
          const srcEl = nodeEls[e.source];
          const tgtEl = nodeEls[e.target];
          if (!srcEl || !tgtEl) continue;
          // Self-loop
          if (e.source === e.target) {
            const nd = buildSelfLoopPath(srcEl);
            pathEl.setAttribute("d", nd);
            if (hitEl) hitEl.setAttribute("d", nd);
            const bg = edgeSvg.querySelector('.mf-edge-label-bg[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
            const lbl = edgeSvg.querySelector('.mf-edge-label[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
            if (lbl) {
              const nx = parseFloat(srcEl.style.left), ny = parseFloat(srcEl.style.top);
              const nw = srcEl.offsetWidth || 100;
              lbl.setAttribute("x", (nx + nw / 2).toFixed(1)); lbl.setAttribute("y", (ny - 25).toFixed(1));
            }
            if (bg && lbl) { try { const bb = lbl.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(ex) {} }
            continue;
          }
          const sDim = nodeDims[e.source] || { width: 100, height: 40 };
          const tDim = nodeDims[e.target] || { width: 100, height: 40 };
          const sx = parseFloat(srcEl.style.left) + sDim.width / 2;
          const sy = parseFloat(srcEl.style.top) + sDim.height / 2;
          const tx = parseFloat(tgtEl.style.left) + tDim.width / 2;
          const ty = parseFloat(tgtEl.style.top) + tDim.height / 2;
          const sShape = srcEl.getAttribute("data-shape") || "rect";
          const tShape = tgtEl.getAttribute("data-shape") || "rect";
          const sp = getConnectionPt(sx, sy, sDim.width / 2, sDim.height / 2, tx, ty, sShape);
          const tp = getConnectionPt(tx, ty, tDim.width / 2, tDim.height / 2, sx, sy, tShape);
          const dist = Math.hypot(tp.x - sp.x, tp.y - sp.y);
          const off = Math.max(dist * 0.35, 25);
          const ddx = tp.x - sp.x;
          const ddy = tp.y - sp.y;
          let c1x, c1y, c2x, c2y;
          if (Math.abs(ddx) > Math.abs(ddy)) {
            c1x = sp.x + (ddx > 0 ? off : -off); c1y = sp.y;
            c2x = tp.x - (ddx > 0 ? off : -off); c2y = tp.y;
          } else {
            c1x = sp.x; c1y = sp.y + (ddy > 0 ? off : -off);
            c2x = tp.x; c2y = tp.y - (ddy > 0 ? off : -off);
          }
          const nd = "M " + sp.x.toFixed(1) + " " + sp.y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + tp.x.toFixed(1) + " " + tp.y.toFixed(1);
          pathEl.setAttribute("d", nd);
          if (hitEl) hitEl.setAttribute("d", nd);
          // Update label position — bezier midpoint at t=0.5
          const bg = edgeSvg.querySelector('.mf-edge-label-bg[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
          const lbl = edgeSvg.querySelector('.mf-edge-label[data-source="' + CSS.escape(e.source) + '"][data-target="' + CSS.escape(e.target) + '"]');
          if (lbl) {
            const mx = 0.125 * sp.x + 0.375 * c1x + 0.375 * c2x + 0.125 * tp.x;
            const my = 0.125 * sp.y + 0.375 * c1y + 0.375 * c2y + 0.125 * tp.y;
            lbl.setAttribute("x", mx.toFixed(1)); lbl.setAttribute("y", my.toFixed(1));
          }
          if (bg && lbl) { try { const bb = lbl.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(ex) {} }
        }
      };

      const renderCustomFlowchart = (flowData, classDefs, classAssignments, styleOvr, styleDirectives) => {
        setGanttMode(false);
        clearGanttOverlay();
        canvas.innerHTML = "";
        canvas.style.justifyContent = "center";

        const GRID_SIZE = 20;
        const snapToGrid = (val) => Math.round(val / GRID_SIZE) * GRID_SIZE;

        let multiSelected = new Set();
        let marqueeState = null;

        const sendMultiSelection = () => {
          const nodeIds = [...multiSelected];
          const screenBoxes = {};
          const nodePositions = {};
          for (const nid of nodeIds) {
            const el = nodeEls[nid];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            screenBoxes[nid] = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            nodePositions[nid] = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
          }
          send("elements:selected", { nodeIds, screenBoxes, nodePositions });
        };

        const highlightMultiSelected = () => {
          container.querySelectorAll(".mf-flow-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
          for (const nid of multiSelected) {
            const el = nodeEls[nid];
            if (el) el.classList.add("mf-selected");
          }
        };

        if (!flowData || !flowData.nodes || !flowData.nodes.length) {
          const msg = document.createElement("div");
          msg.style.cssText = "padding:32px;color:#64748b;font-size:14px;text-align:center;";
          msg.textContent = "No nodes found in flowchart.";
          canvas.appendChild(msg);
          return;
        }

        // Build classDefMap
        const classDefMap = {};
        for (const cd of (classDefs || [])) classDefMap[cd.name] = cd;

        // Measure and layout
        const nodeDims = measureNodeDimensions(flowData.nodes, classDefMap, classAssignments || {});
        const g = layoutFlowchart(flowData, nodeDims);
        const graphInfo = g.graph();
        const gw = (graphInfo.width || 600) + 80;
        const gh = (graphInfo.height || 400) + 80;

        const container = document.createElement("div");
        container.className = "mf-flow-container";
        container.style.width = gw + "px";
        container.style.height = gh + "px";

        // Subgraphs
        const subgraphEls = {};
        for (const sg of (flowData.subgraphs || [])) {
          const sgNode = g.node(sg.id);
          if (!sgNode || !sgNode.width) continue;
          const div = document.createElement("div");
          div.className = "mf-flow-subgraph";
          div.setAttribute("data-subgraph-id", sg.id);
          div.style.left = (sgNode.x - sgNode.width / 2) + "px";
          div.style.top = (sgNode.y - sgNode.height / 2) + "px";
          div.style.width = sgNode.width + "px";
          div.style.height = sgNode.height + "px";
          const lbl = document.createElement("div");
          lbl.className = "mf-flow-subgraph-label";
          lbl.textContent = sg.label || sg.id;
          // Double-click to rename
          lbl.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            send("subgraph:rename-intent", { subgraphId: sg.id, currentLabel: sg.label || sg.id });
          });
          // Right-click context menu
          lbl.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            send("subgraph:context", { subgraphId: sg.id, label: sg.label || sg.id, pointerX: ev.clientX, pointerY: ev.clientY });
          });
          div.appendChild(lbl);
          container.appendChild(div);
          subgraphEls[sg.id] = div;
        }

        // SVG edge overlay
        const ns = "http://www.w3.org/2000/svg";
        const edgeSvg = document.createElementNS(ns, "svg");
        edgeSvg.setAttribute("class", "mf-flow-edges");
        edgeSvg.setAttribute("width", gw);
        edgeSvg.setAttribute("height", gh);
        edgeSvg.style.width = gw + "px";
        edgeSvg.style.height = gh + "px";

        // Arrow marker
        const defs = document.createElementNS(ns, "defs");
        const mkArrow = (id, color) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "7");
          m.setAttribute("refX", "9"); m.setAttribute("refY", "3.5"); m.setAttribute("orient", "auto");
          const p = document.createElementNS(ns, "polygon");
          p.setAttribute("points", "0 0, 10 3.5, 0 7"); p.setAttribute("fill", color);
          m.appendChild(p); return m;
        };
        const mkArrowRev = (id, color) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "7");
          m.setAttribute("refX", "1"); m.setAttribute("refY", "3.5"); m.setAttribute("orient", "auto");
          const p = document.createElementNS(ns, "polygon");
          p.setAttribute("points", "10 0, 0 3.5, 10 7"); p.setAttribute("fill", color);
          m.appendChild(p); return m;
        };
        const mkCircleMarker = (id, color) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "10");
          m.setAttribute("refX", "5"); m.setAttribute("refY", "5"); m.setAttribute("orient", "auto");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", "5"); c.setAttribute("cy", "5"); c.setAttribute("r", "4");
          c.setAttribute("fill", "none"); c.setAttribute("stroke", color); c.setAttribute("stroke-width", "1.5");
          m.appendChild(c); return m;
        };
        const mkCrossMarker = (id, color) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "10");
          m.setAttribute("refX", "5"); m.setAttribute("refY", "5"); m.setAttribute("orient", "auto");
          const l1 = document.createElementNS(ns, "line");
          l1.setAttribute("x1", "1"); l1.setAttribute("y1", "1"); l1.setAttribute("x2", "9"); l1.setAttribute("y2", "9");
          l1.setAttribute("stroke", color); l1.setAttribute("stroke-width", "1.5");
          const l2 = document.createElementNS(ns, "line");
          l2.setAttribute("x1", "9"); l2.setAttribute("y1", "1"); l2.setAttribute("x2", "1"); l2.setAttribute("y2", "9");
          l2.setAttribute("stroke", color); l2.setAttribute("stroke-width", "1.5");
          m.appendChild(l1); m.appendChild(l2); return m;
        };
        defs.appendChild(mkArrow("mf-arrow", "#8b9dc3"));
        defs.appendChild(mkArrow("mf-arrow-thick", "#6366f1"));
        defs.appendChild(mkArrowRev("mf-arrow-rev", "#8b9dc3"));
        defs.appendChild(mkArrowRev("mf-arrow-thick-rev", "#6366f1"));
        defs.appendChild(mkCircleMarker("mf-circle", "#8b9dc3"));
        defs.appendChild(mkCrossMarker("mf-cross", "#8b9dc3"));
        edgeSvg.appendChild(defs);

        // Render edges
        const edgeGroup = document.createElementNS(ns, "g");
        for (const edge of (flowData.edges || [])) {
          const at = edge.arrowType || "-->";
          // Self-loop: use dagre node position to draw arc
          if (edge.source === edge.target) {
            const selfNode = g.node(edge.source);
            if (!selfNode) continue;
            const selfDim = nodeDims[edge.source] || { width: 100, height: 40 };
            const ovr = positionOverrides[edge.source] || { dx: 0, dy: 0 };
            const selfLeft = (selfNode.x - selfDim.width / 2) + (ovr.absX != null ? (ovr.absX - (selfNode.x - selfDim.width / 2)) : (ovr.dx || 0));
            const selfTop = (selfNode.y - selfDim.height / 2) + (ovr.absX != null ? (ovr.absY - (selfNode.y - selfDim.height / 2)) : (ovr.dy || 0));
            const selfCx = selfLeft + selfDim.width / 2;
            const loopH = 40, loopW = 30;
            const d = "M " + (selfCx - loopW) + " " + selfTop + " C " + (selfCx - loopW) + " " + (selfTop - loopH) + " " + (selfCx + loopW) + " " + (selfTop - loopH) + " " + (selfCx + loopW) + " " + selfTop;
            const hit = document.createElementNS(ns, "path");
            hit.setAttribute("d", d); hit.setAttribute("class", "mf-edge-hit");
            hit.setAttribute("data-source", edge.source); hit.setAttribute("data-target", edge.target);
            edgeGroup.appendChild(hit);
            const path = document.createElementNS(ns, "path");
            path.setAttribute("d", d); path.setAttribute("fill", "none");
            path.setAttribute("stroke", "#8b9dc3"); path.setAttribute("stroke-width", "1.5");
            path.setAttribute("marker-end", "url(#mf-arrow)");
            path.setAttribute("class", "mf-edge");
            path.setAttribute("data-source", edge.source); path.setAttribute("data-target", edge.target);
            edgeGroup.appendChild(path);
            if (edge.label) {
              const bg = document.createElementNS(ns, "rect");
              bg.setAttribute("class", "mf-edge-label-bg");
              bg.setAttribute("data-source", edge.source); bg.setAttribute("data-target", edge.target);
              bg.setAttribute("rx", "4"); bg.setAttribute("fill", "#f8f9fb"); bg.setAttribute("stroke", "#e2e8f0"); bg.setAttribute("stroke-width", "0.5");
              edgeGroup.appendChild(bg);
              const txt = document.createElementNS(ns, "text");
              txt.setAttribute("x", selfCx); txt.setAttribute("y", selfTop - 25);
              txt.setAttribute("text-anchor", "middle"); txt.setAttribute("dominant-baseline", "central");
              txt.setAttribute("font-size", "11"); txt.setAttribute("font-family", "Manrope,system-ui,sans-serif");
              txt.setAttribute("fill", "#475569"); txt.setAttribute("font-weight", "500");
              txt.setAttribute("class", "mf-edge-label");
              txt.setAttribute("data-source", edge.source); txt.setAttribute("data-target", edge.target);
              txt.textContent = edge.label;
              edgeGroup.appendChild(txt);
            }
            continue;
          }
          const de = g.edge(edge.source, edge.target);
          if (!de || !de.points) continue;
          const d = buildEdgeSvgPath(de.points);
          const hasArrow = at === "-->" || at === "--->" || at === "==>" || at === "-.->";
          const isThick = at === "==>" || at === "===" || at === "<==>";
          const isDashed = at === "-.->" || at === "-.-" || at === "<-.->";
          const hasCircleEnd = at === "--o";
          const hasCrossEnd = at === "--x";
          const isBiArrow = at === "<-->" || at === "<-.->" || at === "<==>";
          const isBiCircle = at === "o--o";
          const isBiCross = at === "x--x";

          // Invisible hit area
          const hit = document.createElementNS(ns, "path");
          hit.setAttribute("d", d); hit.setAttribute("class", "mf-edge-hit");
          hit.setAttribute("data-source", edge.source); hit.setAttribute("data-target", edge.target);
          edgeGroup.appendChild(hit);

          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d); path.setAttribute("fill", "none");
          path.setAttribute("stroke", isThick ? "#6366f1" : "#8b9dc3");
          path.setAttribute("stroke-width", isThick ? "2.5" : "1.5");
          if (isDashed) path.setAttribute("stroke-dasharray", "6,3");
          if (hasArrow) path.setAttribute("marker-end", isThick ? "url(#mf-arrow-thick)" : "url(#mf-arrow)");
          else if (hasCircleEnd) path.setAttribute("marker-end", "url(#mf-circle)");
          else if (hasCrossEnd) path.setAttribute("marker-end", "url(#mf-cross)");
          if (isBiArrow) {
            path.setAttribute("marker-end", isThick ? "url(#mf-arrow-thick)" : "url(#mf-arrow)");
            path.setAttribute("marker-start", isThick ? "url(#mf-arrow-thick-rev)" : "url(#mf-arrow-rev)");
          } else if (isBiCircle) {
            path.setAttribute("marker-end", "url(#mf-circle)");
            path.setAttribute("marker-start", "url(#mf-circle)");
          } else if (isBiCross) {
            path.setAttribute("marker-end", "url(#mf-cross)");
            path.setAttribute("marker-start", "url(#mf-cross)");
          }
          path.setAttribute("class", "mf-edge");
          path.setAttribute("data-source", edge.source); path.setAttribute("data-target", edge.target);
          edgeGroup.appendChild(path);

          if (edge.label) {
            const pts = de.points;
            const mid = pts[Math.floor(pts.length / 2)];
            const bg = document.createElementNS(ns, "rect");
            bg.setAttribute("class", "mf-edge-label-bg");
            bg.setAttribute("data-source", edge.source); bg.setAttribute("data-target", edge.target);
            bg.setAttribute("rx", "4"); bg.setAttribute("fill", "#f8f9fb"); bg.setAttribute("stroke", "#e2e8f0"); bg.setAttribute("stroke-width", "0.5");
            edgeGroup.appendChild(bg);
            const txt = document.createElementNS(ns, "text");
            txt.setAttribute("x", mid.x); txt.setAttribute("y", mid.y);
            txt.setAttribute("text-anchor", "middle"); txt.setAttribute("dominant-baseline", "central");
            txt.setAttribute("font-size", "11"); txt.setAttribute("font-family", "Manrope,system-ui,sans-serif");
            txt.setAttribute("fill", "#475569"); txt.setAttribute("font-weight", "500");
            txt.setAttribute("class", "mf-edge-label");
            txt.setAttribute("data-source", edge.source); txt.setAttribute("data-target", edge.target);
            txt.textContent = edge.label;
            edgeGroup.appendChild(txt);
          }
        }
        edgeSvg.appendChild(edgeGroup);
        container.appendChild(edgeSvg);

        // Render nodes
        const nodeEls = {};
        let connectMode = null;

        for (const node of flowData.nodes) {
          const pos = g.node(node.id);
          if (!pos) continue;
          const dim = nodeDims[node.id] || { width: 100, height: 40 };
          const shape = node.shape || "rect";

          const el = document.createElement("div");
          el.className = "mf-flow-node mf-shape-" + shape;
          el.setAttribute("data-node-id", node.id);
          el.setAttribute("data-shape", shape);

          // Apply position (with overrides — absolute or delta)
          const ovr = positionOverrides[node.id];
          const baseX = pos.x - dim.width / 2;
          const baseY = pos.y - dim.height / 2;
          if (ovr && ovr.absX != null) {
            el.style.left = ovr.absX + "px";
            el.style.top = ovr.absY + "px";
          } else {
            el.style.left = (baseX + (ovr?.dx || 0)) + "px";
            el.style.top = (baseY + (ovr?.dy || 0)) + "px";
          }
          el.style.width = dim.width + "px";
          el.style.height = dim.height + "px";

          // classDef styling
          const assignedClass = (classAssignments || {})[node.id];
          const cd = assignedClass ? classDefMap[assignedClass] : null;
          if (cd) {
            if (cd.fill) el.style.background = cd.fill;
            if (cd.stroke) { el.style.borderColor = cd.stroke; el.style.setProperty("--node-stroke", cd.stroke); }
            if (cd.color) el.style.color = cd.color;
            if (cd.strokeWidth) el.style.borderWidth = cd.strokeWidth;
            if (cd.strokeDasharray) el.style.borderStyle = "dashed";
            if (cd.fontSize) el.style.fontSize = cd.fontSize;
            if (cd.fontWeight) el.style.fontWeight = cd.fontWeight;
            if (cd.fontStyle) el.style.fontStyle = cd.fontStyle;
            if (cd.fontFamily) el.style.fontFamily = cd.fontFamily;
          }
          // Per-node style directives (e.g. "style id1 fill:#f9f,stroke:#333")
          const sd = (styleDirectives || {})[node.id];
          if (sd) {
            if (sd.fill) el.style.background = sd.fill;
            if (sd.stroke) { el.style.borderColor = sd.stroke; el.style.setProperty("--node-stroke", sd.stroke); }
            if (sd.color) el.style.color = sd.color;
            if (sd.strokeWidth) el.style.borderWidth = sd.strokeWidth;
            if (sd.strokeDasharray) el.style.borderStyle = "dashed";
          }
          // Runtime style overrides
          const so = (styleOvr || {})[node.id];
          if (so) {
            if (so.fill) el.style.background = so.fill;
            if (so.stroke) el.style.borderColor = so.stroke;
            if (so.textColor) el.style.color = so.textColor;
            if (so.strokeStyle === "dashed") el.style.borderStyle = "dashed";
          }

          // For clip-path shapes, create background border layer
          const clipShapes = ["diamond", "hexagon", "trapezoid", "trapezoid-alt", "asymmetric",
            "document", "documents", "notched-rect", "cloud", "bang", "bolt", "triangle", "flag",
            "hourglass", "curved-trapezoid", "flipped-triangle", "sloped-rect",
            "notched-pentagon", "tag-document", "tag-rect", "bow-rect", "lined-document"];
          if (clipShapes.includes(shape)) {
            el.setAttribute("data-clip-shape", shape);
            const borderLayer = document.createElement("div");
            borderLayer.className = "mf-flow-border-layer mf-shape-" + shape;
            borderLayer.style.background = sd?.stroke || cd?.stroke || so?.stroke || "#cbd5e1";
            el.appendChild(borderLayer);
          }

          // Label
          const labelDiv = document.createElement("div");
          labelDiv.className = "mf-node-label";
          const raw = node.label || node.id || "";
          const brRe2 = new RegExp("<br\\s*\\/?>", "gi");
          const labelLines = raw.replace(brRe2, "\\n").split("\\n");
          labelDiv.innerHTML = labelLines.map(l => '<span class="mf-label-line">' + escapeHtml(l) + '<\/span>').join("");
          el.appendChild(labelDiv);

          // Tooltip
          // Rich tooltip
          {
            let tip = node.label || node.id;
            tip += "\\nID: " + node.id;
            const shapeNames = { rect: "Rectangle", rounded: "Rounded", diamond: "Decision", circle: "Circle", stadium: "Stadium", hexagon: "Hexagon", parallelogram: "Parallelogram", trapezoid: "Trapezoid", "double-circle": "Double Circle", cylinder: "Cylinder", subroutine: "Subroutine", asymmetric: "Asymmetric" };
            tip += "\\nShape: " + (shapeNames[shape] || shape);
            const inE = (flowData.edges || []).filter(e => e.target === node.id);
            const outE = (flowData.edges || []).filter(e => e.source === node.id);
            if (inE.length) tip += "\\nInputs: " + inE.map(e => e.source).join(", ");
            if (outE.length) tip += "\\nOutputs: " + outE.map(e => e.target).join(", ");
            const parentSg = (flowData.subgraphs || []).find(sg => (sg.nodeIds || []).includes(node.id));
            if (parentSg) tip += "\\nGroup: " + (parentSg.label || parentSg.id);
            if (assignedClass) tip += "\\nClass: " + assignedClass;
            el.setAttribute("data-mf-tip", tip);
          }

          // Click (with shift-click multi-select)
          el.addEventListener("click", (ev) => {
            if (suppressClick) return;
            ev.stopPropagation();
            if (ev.shiftKey) {
              // Toggle this node in multi-selection
              if (multiSelected.has(node.id)) {
                multiSelected.delete(node.id);
              } else {
                multiSelected.add(node.id);
              }
              highlightMultiSelected();
              sendMultiSelection();
            } else {
              // Single select — clear multi-select
              multiSelected.clear();
              multiSelected.add(node.id);
              container.querySelectorAll(".mf-flow-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
              el.classList.add("mf-selected");
              const rect = el.getBoundingClientRect();
              send("element:selected", {
                label: node.label || node.id, id: node.id, nodeId: node.id, elementType: "node",
                screenBox: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              });
            }
          });

          // Context menu
          el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            container.querySelectorAll(".mf-flow-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            el.classList.add("mf-selected");
            send("element:context", {
              label: node.label || node.id, id: node.id, nodeId: node.id, elementType: "node",
              pointerX: ev.clientX, pointerY: ev.clientY,
            });
          });

          // Drag (supports group drag when multiple nodes selected)
          let dragInfo = null;
          el.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            if (connectMode) {
              if (node.id !== connectMode.sourceId) {
                send("connect:complete", { sourceId: connectMode.sourceId, targetId: node.id });
              }
              ev.preventDefault();
              return;
            }
            ev.preventDefault();
            suppressClick = false;
            const isGroupDrag = multiSelected.has(node.id) && multiSelected.size > 1;
            const groupOrigins = {};
            if (isGroupDrag) {
              for (const nid of multiSelected) {
                const nel = nodeEls[nid];
                if (nel) groupOrigins[nid] = { left: parseFloat(nel.style.left), top: parseFloat(nel.style.top) };
              }
            }
            dragInfo = { startX: ev.clientX, startY: ev.clientY, origLeft: parseFloat(el.style.left), origTop: parseFloat(el.style.top), moved: false, isGroupDrag, groupOrigins };
            el.style.cursor = "grabbing"; el.style.zIndex = "100";
            el.setPointerCapture(ev.pointerId);
          });
          el.addEventListener("pointermove", (ev) => {
            if (!dragInfo) return;
            const dx = ev.clientX - dragInfo.startX;
            const dy = ev.clientY - dragInfo.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragInfo.moved = true;
            if (!dragInfo.moved) return;
            if (dragInfo.isGroupDrag) {
              for (const [nid, orig] of Object.entries(dragInfo.groupOrigins)) {
                const nel = nodeEls[nid];
                if (nel) {
                  nel.style.left = snapToGrid(orig.left + dx) + "px";
                  nel.style.top = snapToGrid(orig.top + dy) + "px";
                  updateFlowEdgesForNode(edgeSvg, flowData.edges, nid, nodeEls, nodeDims);
                }
              }
              updateSubgraphBounds();
            } else {
              el.style.left = snapToGrid(dragInfo.origLeft + dx) + "px";
              el.style.top = snapToGrid(dragInfo.origTop + dy) + "px";
              updateFlowEdgesForNode(edgeSvg, flowData.edges, node.id, nodeEls, nodeDims);
              updateSubgraphBounds();
              // Subgraph drop target highlighting (single drag only)
              const nodeCx = (dragInfo.origLeft + dx) + el.offsetWidth / 2;
              const nodeCy = (dragInfo.origTop + dy) + el.offsetHeight / 2;
              container.querySelectorAll(".mf-flow-subgraph.mf-subgraph-drop-target").forEach(s => s.classList.remove("mf-subgraph-drop-target"));
              dragInfo.dropSubgraphId = null;
              for (const [sgId, sgEl] of Object.entries(subgraphEls)) {
                const sl = parseFloat(sgEl.style.left);
                const st = parseFloat(sgEl.style.top);
                const sw = sgEl.offsetWidth;
                const sh = sgEl.offsetHeight;
                if (nodeCx > sl && nodeCx < sl + sw && nodeCy > st && nodeCy < st + sh) {
                  sgEl.classList.add("mf-subgraph-drop-target");
                  dragInfo.dropSubgraphId = sgId;
                  break;
                }
              }
            }
          });
          el.addEventListener("pointerup", (ev) => {
            if (!dragInfo) return;
            const dx = ev.clientX - dragInfo.startX;
            const dy = ev.clientY - dragInfo.startY;
            el.releasePointerCapture(ev.pointerId);
            el.style.cursor = ""; el.style.zIndex = "";
            container.querySelectorAll(".mf-flow-subgraph.mf-subgraph-drop-target").forEach(s => s.classList.remove("mf-subgraph-drop-target"));
            if (dragInfo.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
              suppressClick = true;
              setTimeout(() => { suppressClick = false; }, 200);
              if (dragInfo.isGroupDrag) {
                const moves = {};
                for (const nid of Object.keys(dragInfo.groupOrigins)) {
                  const nel = nodeEls[nid];
                  if (nel) {
                    positionOverrides[nid] = { absX: parseFloat(nel.style.left), absY: parseFloat(nel.style.top) };
                  }
                  moves[nid] = { deltaX: dx, deltaY: dy, absX: positionOverrides[nid]?.absX, absY: positionOverrides[nid]?.absY };
                }
                send("elements:dragged", { moves });
              } else {
                positionOverrides[node.id] = { absX: parseFloat(el.style.left), absY: parseFloat(el.style.top) };
                // Check for subgraph drop
                if (dragInfo.dropSubgraphId) {
                  send("node:dropped-into-subgraph", { nodeId: node.id, subgraphId: dragInfo.dropSubgraphId });
                } else {
                  send("element:dragged", { label: node.label || node.id, nodeId: node.id, deltaX: dx, deltaY: dy, absX: positionOverrides[node.id].absX, absY: positionOverrides[node.id].absY, isGanttTask: false });
                }
              }
            }
            dragInfo = null;
          });

          // Hover port indicators with drag-to-connect
          el.addEventListener("mouseenter", () => {
            if (connectMode) return;
            container.querySelectorAll(".mf-flow-port").forEach(p => p.remove());
            const left = parseFloat(el.style.left);
            const top = parseFloat(el.style.top);
            const w = dim.width; const h = dim.height;
            const cx = left + w / 2; const cy = top + h / 2;
            const portPositions = [
              { name: "top", x: cx - 9, y: top - 22, anchorX: cx, anchorY: top },
              { name: "bottom", x: cx - 9, y: top + h + 4, anchorX: cx, anchorY: top + h },
              { name: "left", x: left - 22, y: cy - 9, anchorX: left, anchorY: cy },
              { name: "right", x: left + w + 4, y: cy - 9, anchorX: left + w, anchorY: cy },
            ];
            for (const pp of portPositions) {
              const port = document.createElement("div");
              port.className = "mf-flow-port";
              port.style.left = pp.x + "px"; port.style.top = pp.y + "px"; port.style.opacity = "1";
              port.textContent = "+";

              // Drag-to-connect
              let portDrag = null;
              port.addEventListener("pointerdown", (pe) => {
                pe.stopPropagation();
                pe.preventDefault();
                port.setPointerCapture(pe.pointerId);
                port.classList.add("mf-port-dragging");

                // Create temporary SVG drag line
                const svgNS = "http://www.w3.org/2000/svg";
                const dragSvg = document.createElementNS(svgNS, "svg");
                dragSvg.setAttribute("class", "mf-flow-drag-line");
                dragSvg.style.width = container.scrollWidth + "px";
                dragSvg.style.height = container.scrollHeight + "px";
                const dragLine = document.createElementNS(svgNS, "line");
                dragLine.setAttribute("x1", pp.anchorX);
                dragLine.setAttribute("y1", pp.anchorY);
                dragLine.setAttribute("x2", pp.anchorX);
                dragLine.setAttribute("y2", pp.anchorY);
                dragLine.setAttribute("stroke", "#3b82f6");
                dragLine.setAttribute("stroke-width", "2");
                dragLine.setAttribute("stroke-dasharray", "6 3");
                dragSvg.appendChild(dragLine);
                container.appendChild(dragSvg);

                portDrag = { dragSvg, dragLine, dragging: false, currentTarget: null };
              });
              port.addEventListener("pointermove", (pe) => {
                if (!portDrag) return;
                portDrag.dragging = true;
                const cr = container.getBoundingClientRect();
                const mx = pe.clientX - cr.left + container.scrollLeft;
                const my = pe.clientY - cr.top + container.scrollTop;
                portDrag.dragLine.setAttribute("x2", mx);
                portDrag.dragLine.setAttribute("y2", my);

                // Hit-test: hide SVG to find element underneath
                portDrag.dragSvg.style.display = "none";
                const hitEl = document.elementFromPoint(pe.clientX, pe.clientY);
                portDrag.dragSvg.style.display = "";
                const targetNode = hitEl?.closest(".mf-flow-node");
                if (portDrag.currentTarget && portDrag.currentTarget !== targetNode) {
                  portDrag.currentTarget.classList.remove("mf-connect-drop-target");
                }
                if (targetNode && targetNode !== el) {
                  targetNode.classList.add("mf-connect-drop-target");
                  portDrag.currentTarget = targetNode;
                } else {
                  portDrag.currentTarget = null;
                }
              });
              port.addEventListener("pointerup", (pe) => {
                if (!portDrag) return;
                try { port.releasePointerCapture(pe.pointerId); } catch(_) {}
                port.classList.remove("mf-port-dragging");
                portDrag.dragSvg.remove();
                if (portDrag.dragging && portDrag.currentTarget) {
                  portDrag.currentTarget.classList.remove("mf-connect-drop-target");
                  const targetId = portDrag.currentTarget.getAttribute("data-node-id");
                  if (targetId && targetId !== node.id) {
                    send("connect:complete", { sourceId: node.id, targetId: targetId });
                  }
                } else if (!portDrag.dragging) {
                  // Plain click (no drag) — open node creation form
                  send("port:clicked", { nodeId: node.id, port: pp.name });
                }
                portDrag = null;
                container.querySelectorAll(".mf-flow-port").forEach(p => p.remove());
              });
              // Also handle pointer leaving without up (cancel)
              port.addEventListener("pointercancel", (pe) => {
                if (!portDrag) return;
                try { port.releasePointerCapture(pe.pointerId); } catch(_) {}
                port.classList.remove("mf-port-dragging");
                portDrag.dragSvg.remove();
                if (portDrag.currentTarget) portDrag.currentTarget.classList.remove("mf-connect-drop-target");
                portDrag = null;
              });

              container.appendChild(port);
            }
          });
          el.addEventListener("mouseleave", () => {
            setTimeout(() => {
              if (!container.querySelector(".mf-flow-port:hover") && !container.querySelector(".mf-flow-port.mf-port-dragging")) {
                container.querySelectorAll(".mf-flow-port").forEach(p => p.remove());
              }
            }, 200);
          });

          container.appendChild(el);
          nodeEls[node.id] = el;
        }

        // Dynamic subgraph bounds
        const updateSubgraphBounds = () => {
          for (const sg of (flowData.subgraphs || [])) {
            const sgEl = subgraphEls[sg.id];
            if (!sgEl) continue;
            const childNodes = (sg.nodeIds || []).map(id => nodeEls[id]).filter(Boolean);
            if (childNodes.length === 0) continue;
            const pad = 20;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const ch of childNodes) {
              const l = parseFloat(ch.style.left), t = parseFloat(ch.style.top);
              minX = Math.min(minX, l); minY = Math.min(minY, t);
              maxX = Math.max(maxX, l + ch.offsetWidth);
              maxY = Math.max(maxY, t + ch.offsetHeight);
            }
            sgEl.style.left = (minX - pad) + "px";
            sgEl.style.top = (minY - pad - 24) + "px";
            sgEl.style.width = (maxX - minX + 2 * pad) + "px";
            sgEl.style.height = (maxY - minY + 2 * pad + 24) + "px";
          }
        };
        updateSubgraphBounds();

        // Adjust edge label backgrounds after render
        edgeSvg.querySelectorAll(".mf-edge-label").forEach(lbl => {
          try {
            const bb = lbl.getBBox();
            const src = lbl.getAttribute("data-source");
            const tgt = lbl.getAttribute("data-target");
            const bg = edgeSvg.querySelector('.mf-edge-label-bg[data-source="' + CSS.escape(src) + '"][data-target="' + CSS.escape(tgt) + '"]');
            if (bg) { bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); }
          } catch(ex) {}
        });

        // Edge click/context handlers
        edgeSvg.addEventListener("click", (ev) => {
          const t = ev.target;
          if (t.classList.contains("mf-edge-hit") || t.classList.contains("mf-edge") || t.classList.contains("mf-edge-label-bg")) {
            ev.stopPropagation();
            const src = t.getAttribute("data-source") || "";
            const tgt = t.getAttribute("data-target") || "";
            send("element:selected", { label: "", id: "", nodeId: "", elementType: "edge", edgeSource: src, edgeTarget: tgt });
          }
        });
        edgeSvg.addEventListener("contextmenu", (ev) => {
          const t = ev.target;
          if (t.classList.contains("mf-edge-hit") || t.classList.contains("mf-edge") || t.classList.contains("mf-edge-label-bg") || t.classList.contains("mf-edge-label")) {
            ev.preventDefault(); ev.stopPropagation();
            const src = t.getAttribute("data-source") || "";
            const tgt = t.getAttribute("data-target") || "";
            send("element:context", { label: "", id: "", nodeId: "", elementType: "edge", edgeSource: src, edgeTarget: tgt, pointerX: ev.clientX, pointerY: ev.clientY });
          }
        });

        // Empty area handlers
        container.addEventListener("click", (ev) => {
          if (ev.target === container && !marqueeState) {
            multiSelected.clear();
            container.querySelectorAll(".mf-flow-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            send("element:selected", null);
          }
        });
        container.addEventListener("contextmenu", (ev) => {
          if (ev.target === container) {
            ev.preventDefault();
            send("element:context", { label: "", id: "", nodeId: "", elementType: "canvas", pointerX: ev.clientX, pointerY: ev.clientY });
          }
        });

        // Marquee (box) select
        container.addEventListener("pointerdown", (ev) => {
          if (ev.target !== container || ev.button !== 0 || connectMode) return;
          const cr = container.getBoundingClientRect();
          marqueeState = { startX: ev.clientX - cr.left, startY: ev.clientY - cr.top, el: null, active: false };
        });
        container.addEventListener("pointermove", (ev) => {
          if (!marqueeState) return;
          const cr = container.getBoundingClientRect();
          const curX = ev.clientX - cr.left;
          const curY = ev.clientY - cr.top;
          const dx = Math.abs(curX - marqueeState.startX);
          const dy = Math.abs(curY - marqueeState.startY);
          if (!marqueeState.active && (dx > 5 || dy > 5)) {
            marqueeState.active = true;
            const mEl = document.createElement("div");
            mEl.className = "mf-marquee";
            container.appendChild(mEl);
            marqueeState.el = mEl;
          }
          if (!marqueeState.active) return;
          const left = Math.min(marqueeState.startX, curX);
          const top = Math.min(marqueeState.startY, curY);
          const w = Math.abs(curX - marqueeState.startX);
          const h = Math.abs(curY - marqueeState.startY);
          marqueeState.el.style.left = left + "px";
          marqueeState.el.style.top = top + "px";
          marqueeState.el.style.width = w + "px";
          marqueeState.el.style.height = h + "px";
          // Check overlap with nodes
          multiSelected.clear();
          for (const [nid, nel] of Object.entries(nodeEls)) {
            const nl = parseFloat(nel.style.left);
            const nt = parseFloat(nel.style.top);
            const nw = nel.offsetWidth;
            const nh = nel.offsetHeight;
            if (nl + nw > left && nl < left + w && nt + nh > top && nt < top + h) {
              multiSelected.add(nid);
            }
          }
          highlightMultiSelected();
        });
        container.addEventListener("pointerup", (ev) => {
          if (!marqueeState) return;
          if (marqueeState.el) marqueeState.el.remove();
          if (marqueeState.active && multiSelected.size > 0) {
            sendMultiSelection();
          }
          marqueeState = null;
        });

        // Size edge label backgrounds after DOM paint
        requestAnimationFrame(() => {
          edgeSvg.querySelectorAll(".mf-edge-label").forEach(txt => {
            const bg = edgeSvg.querySelector('.mf-edge-label-bg[data-source="' + txt.getAttribute("data-source") + '"][data-target="' + txt.getAttribute("data-target") + '"]');
            if (!bg) return;
            try { const bb = txt.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(e) {}
          });
        });

        // Connect mode listener
        const handleConnectMsg = (ev) => {
          const d = ev.data;
          if (!d || d.channel !== "${CHANNEL}") return;
          if (d.type === "mode:connect") {
            connectMode = { sourceId: d.payload?.sourceId || "" };
            container.style.cursor = "crosshair";
            const src = container.querySelector('[data-node-id="' + CSS.escape(connectMode.sourceId) + '"]');
            if (src) src.classList.add("mf-connect-source");
          }
          if (d.type === "mode:normal") {
            connectMode = null;
            container.style.cursor = "";
            container.querySelectorAll(".mf-connect-source").forEach(n => n.classList.remove("mf-connect-source"));
          }
          if (d.type === "flowchart:select") {
            const nid = d.payload?.nodeId || "";
            container.querySelectorAll(".mf-flow-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            multiSelected.clear();
            if (nid) {
              const nd = container.querySelector('[data-node-id="' + CSS.escape(nid) + '"]');
              if (nd) nd.classList.add("mf-selected");
              multiSelected.add(nid);
            }
          }
          if (d.type === "layout:reset") {
            // Clear iframe-side position overrides so dagre layout takes effect on re-render
            for (const key of Object.keys(positionOverrides)) delete positionOverrides[key];
          }
          if (d.type === "flowchart:multiselect") {
            const ids = d.payload?.nodeIds || [];
            multiSelected.clear();
            for (const nid of ids) multiSelected.add(nid);
            highlightMultiSelected();
          }
        };
        window.addEventListener("message", handleConnectMsg);

        canvas.appendChild(container);
      };

      /* ── Custom ER Diagram Renderer ────────────────────── */

      const parseErAttr = (str) => {
        const raw = (str || "").trim();
        const parts = raw.split(/\\s+/);
        return { type: parts[0] || "", name: parts[1] || "", constraint: (parts[2] || "").toUpperCase(), raw };
      };

      const splitCardinality = (card) => {
        const str = (card || "").trim();
        const idx = str.indexOf("--");
        if (idx < 0) return { src: "||", tgt: "o{" };
        return { src: str.slice(0, idx), tgt: str.slice(idx + 2) };
      };

      const measureErDimensions = (entities) => {
        const measurer = document.createElement("div");
        measurer.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:-9999px;left:-9999px;font-family:'SF Mono','Fira Code',Manrope,system-ui,monospace;font-size:12px;line-height:1.4;";
        document.body.appendChild(measurer);
        const dims = {};
        for (const entity of entities) {
          const el = document.createElement("div");
          el.style.cssText = "display:inline-block;white-space:nowrap;";
          // Header
          const header = document.createElement("div");
          header.style.cssText = "padding:6px 12px;font-weight:600;font-size:13px;font-family:Manrope,system-ui,sans-serif;";
          header.textContent = entity.id;
          el.appendChild(header);
          // Attributes
          let maxAttrW = 0;
          for (const a of entity.attributes) {
            const row = document.createElement("div");
            row.style.cssText = "padding:4px 12px;display:flex;gap:8px;";
            const attr = parseErAttr(a);
            row.innerHTML = (attr.constraint ? '<span style="min-width:20px;font-size:10px;font-weight:700;">' + attr.constraint + '</span>' : '') + '<span style="min-width:40px;">' + escapeHtml(attr.type) + '</span><span>' + escapeHtml(attr.name) + '</span>';
            el.appendChild(row);
          }
          measurer.appendChild(el);
          const attrCount = entity.attributes.length;
          const minW = attrCount > 0 ? 180 : 100;
          const w = Math.max(el.offsetWidth + 24, minW);
          const h = 34 + attrCount * 28 + 8;
          dims[entity.id] = { width: Math.min(w, 300), height: Math.max(h, 42) };
          measurer.removeChild(el);
        }
        document.body.removeChild(measurer);
        return dims;
      };

      const layoutErDiagram = (erData, nodeDims, direction) => {
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: direction || "LR", nodesep: 80, ranksep: 120, marginx: 40, marginy: 40 });
        g.setDefaultEdgeLabel(() => ({}));
        for (const e of erData.entities) {
          const d = nodeDims[e.id] || { width: 180, height: 60 };
          g.setNode(e.id, { width: d.width, height: d.height });
        }
        for (const r of erData.relationships) {
          if (g.hasNode(r.source) && g.hasNode(r.target)) {
            g.setEdge(r.source, r.target, { label: r.label || "", cardinality: r.cardinality || "||--o{" });
          }
        }
        dagre.layout(g);
        return g;
      };

      const updateErEdgesForNode = (edgeSvg, relationships, nodeId, nodeEls, nodeDims) => {
        for (const r of relationships) {
          if (r.source !== nodeId && r.target !== nodeId) continue;
          const pathEl = edgeSvg.querySelector('.mf-er-edge[data-source="' + CSS.escape(r.source) + '"][data-target="' + CSS.escape(r.target) + '"]');
          const hitEl = edgeSvg.querySelector('.mf-er-edge-hit[data-source="' + CSS.escape(r.source) + '"][data-target="' + CSS.escape(r.target) + '"]');
          if (!pathEl) continue;
          const srcEl = nodeEls[r.source];
          const tgtEl = nodeEls[r.target];
          if (!srcEl || !tgtEl) continue;
          const sDim = nodeDims[r.source] || { width: 180, height: 60 };
          const tDim = nodeDims[r.target] || { width: 180, height: 60 };
          const sx = parseFloat(srcEl.style.left) + sDim.width / 2;
          const sy = parseFloat(srcEl.style.top) + sDim.height / 2;
          const tx = parseFloat(tgtEl.style.left) + tDim.width / 2;
          const ty = parseFloat(tgtEl.style.top) + tDim.height / 2;
          const sp = getConnectionPt(sx, sy, sDim.width / 2, sDim.height / 2, tx, ty, "rect");
          const tp = getConnectionPt(tx, ty, tDim.width / 2, tDim.height / 2, sx, sy, "rect");
          const dist = Math.hypot(tp.x - sp.x, tp.y - sp.y);
          const off = Math.max(dist * 0.35, 25);
          const ddx = tp.x - sp.x;
          const ddy = tp.y - sp.y;
          let c1x, c1y, c2x, c2y;
          if (Math.abs(ddx) > Math.abs(ddy)) {
            c1x = sp.x + (ddx > 0 ? off : -off); c1y = sp.y;
            c2x = tp.x - (ddx > 0 ? off : -off); c2y = tp.y;
          } else {
            c1x = sp.x; c1y = sp.y + (ddy > 0 ? off : -off);
            c2x = tp.x; c2y = tp.y - (ddy > 0 ? off : -off);
          }
          const nd = "M " + sp.x.toFixed(1) + " " + sp.y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + tp.x.toFixed(1) + " " + tp.y.toFixed(1);
          pathEl.setAttribute("d", nd);
          if (hitEl) hitEl.setAttribute("d", nd);
          const bg = edgeSvg.querySelector('.mf-er-edge-label-bg[data-source="' + CSS.escape(r.source) + '"][data-target="' + CSS.escape(r.target) + '"]');
          const lbl = edgeSvg.querySelector('.mf-er-edge-label[data-source="' + CSS.escape(r.source) + '"][data-target="' + CSS.escape(r.target) + '"]');
          if (lbl) { lbl.setAttribute("x", ((sp.x + tp.x) / 2).toFixed(1)); lbl.setAttribute("y", ((sp.y + tp.y) / 2).toFixed(1)); }
          if (bg && lbl) { try { const bb = lbl.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(e) {} }
        }
      };

      const renderCustomErDiagram = (erData, styleOvr, layoutDirection) => {
        setGanttMode(false);
        clearGanttOverlay();
        canvas.innerHTML = "";
        canvas.style.justifyContent = "center";

        if (!erData || !erData.entities || !erData.entities.length) {
          const msg = document.createElement("div");
          msg.style.cssText = "padding:32px;color:#64748b;font-size:14px;text-align:center;";
          msg.textContent = "No entities found in ER diagram.";
          canvas.appendChild(msg);
          return;
        }

        // Measure and layout
        const nodeDims = measureErDimensions(erData.entities);
        const g = layoutErDiagram(erData, nodeDims, layoutDirection);
        const graphInfo = g.graph();
        const gw = (graphInfo.width || 600) + 80;
        const gh = (graphInfo.height || 400) + 80;

        const container = document.createElement("div");
        container.className = "mf-er-container";
        container.style.width = gw + "px";
        container.style.height = gh + "px";

        // SVG edge overlay
        const ns = "http://www.w3.org/2000/svg";
        const edgeSvg = document.createElementNS(ns, "svg");
        edgeSvg.setAttribute("class", "mf-er-edges");
        edgeSvg.setAttribute("width", gw);
        edgeSvg.setAttribute("height", gh);
        edgeSvg.style.width = gw + "px";
        edgeSvg.style.height = gh + "px";

        // Cardinality SVG markers (crow's foot notation)
        const defs = document.createElementNS(ns, "defs");

        // || exactly one: two parallel lines perpendicular to the path
        const mkExactlyOne = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "14"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "12"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const l1 = document.createElementNS(ns, "line");
          l1.setAttribute("x1", "8"); l1.setAttribute("y1", "2"); l1.setAttribute("x2", "8"); l1.setAttribute("y2", "12");
          l1.setAttribute("stroke", "#64748b"); l1.setAttribute("stroke-width", "1.5");
          const l2 = document.createElementNS(ns, "line");
          l2.setAttribute("x1", "12"); l2.setAttribute("y1", "2"); l2.setAttribute("x2", "12"); l2.setAttribute("y2", "12");
          l2.setAttribute("stroke", "#64748b"); l2.setAttribute("stroke-width", "1.5");
          m.appendChild(l1); m.appendChild(l2); return m;
        };

        // o| zero or one: circle + one line
        const mkZeroOne = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "20"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "18"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", "6"); c.setAttribute("cy", "7"); c.setAttribute("r", "4");
          c.setAttribute("fill", "none"); c.setAttribute("stroke", "#64748b"); c.setAttribute("stroke-width", "1.5");
          const l = document.createElementNS(ns, "line");
          l.setAttribute("x1", "14"); l.setAttribute("y1", "2"); l.setAttribute("x2", "14"); l.setAttribute("y2", "12");
          l.setAttribute("stroke", "#64748b"); l.setAttribute("stroke-width", "1.5");
          m.appendChild(c); m.appendChild(l); return m;
        };

        // |{ one or many: line + crow's foot (three prongs)
        const mkOneMany = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "18"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "16"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const l = document.createElementNS(ns, "line");
          l.setAttribute("x1", "4"); l.setAttribute("y1", "2"); l.setAttribute("x2", "4"); l.setAttribute("y2", "12");
          l.setAttribute("stroke", "#64748b"); l.setAttribute("stroke-width", "1.5");
          // Crow's foot prongs
          const p1 = document.createElementNS(ns, "line");
          p1.setAttribute("x1", "16"); p1.setAttribute("y1", "7"); p1.setAttribute("x2", "8"); p1.setAttribute("y2", "2");
          p1.setAttribute("stroke", "#64748b"); p1.setAttribute("stroke-width", "1.5");
          const p2 = document.createElementNS(ns, "line");
          p2.setAttribute("x1", "16"); p2.setAttribute("y1", "7"); p2.setAttribute("x2", "8"); p2.setAttribute("y2", "7");
          p2.setAttribute("stroke", "#64748b"); p2.setAttribute("stroke-width", "1.5");
          const p3 = document.createElementNS(ns, "line");
          p3.setAttribute("x1", "16"); p3.setAttribute("y1", "7"); p3.setAttribute("x2", "8"); p3.setAttribute("y2", "12");
          p3.setAttribute("stroke", "#64748b"); p3.setAttribute("stroke-width", "1.5");
          m.appendChild(l); m.appendChild(p1); m.appendChild(p2); m.appendChild(p3); return m;
        };

        // o{ zero or many: circle + crow's foot
        const mkZeroMany = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "24"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "22"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", "6"); c.setAttribute("cy", "7"); c.setAttribute("r", "4");
          c.setAttribute("fill", "none"); c.setAttribute("stroke", "#64748b"); c.setAttribute("stroke-width", "1.5");
          // Crow's foot prongs
          const p1 = document.createElementNS(ns, "line");
          p1.setAttribute("x1", "22"); p1.setAttribute("y1", "7"); p1.setAttribute("x2", "14"); p1.setAttribute("y2", "2");
          p1.setAttribute("stroke", "#64748b"); p1.setAttribute("stroke-width", "1.5");
          const p2 = document.createElementNS(ns, "line");
          p2.setAttribute("x1", "22"); p2.setAttribute("y1", "7"); p2.setAttribute("x2", "14"); p2.setAttribute("y2", "7");
          p2.setAttribute("stroke", "#64748b"); p2.setAttribute("stroke-width", "1.5");
          const p3 = document.createElementNS(ns, "line");
          p3.setAttribute("x1", "22"); p3.setAttribute("y1", "7"); p3.setAttribute("x2", "14"); p3.setAttribute("y2", "12");
          p3.setAttribute("stroke", "#64748b"); p3.setAttribute("stroke-width", "1.5");
          m.appendChild(c); m.appendChild(p1); m.appendChild(p2); m.appendChild(p3); return m;
        };

        // Reversed variants (for marker-start, which renders at the start of the path)
        const mkExactlyOneRev = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "14"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "2"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const l1 = document.createElementNS(ns, "line");
          l1.setAttribute("x1", "2"); l1.setAttribute("y1", "2"); l1.setAttribute("x2", "2"); l1.setAttribute("y2", "12");
          l1.setAttribute("stroke", "#64748b"); l1.setAttribute("stroke-width", "1.5");
          const l2 = document.createElementNS(ns, "line");
          l2.setAttribute("x1", "6"); l2.setAttribute("y1", "2"); l2.setAttribute("x2", "6"); l2.setAttribute("y2", "12");
          l2.setAttribute("stroke", "#64748b"); l2.setAttribute("stroke-width", "1.5");
          m.appendChild(l1); m.appendChild(l2); return m;
        };

        const mkZeroOneRev = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "20"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "2"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          const l = document.createElementNS(ns, "line");
          l.setAttribute("x1", "2"); l.setAttribute("y1", "2"); l.setAttribute("x2", "2"); l.setAttribute("y2", "12");
          l.setAttribute("stroke", "#64748b"); l.setAttribute("stroke-width", "1.5");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", "14"); c.setAttribute("cy", "7"); c.setAttribute("r", "4");
          c.setAttribute("fill", "none"); c.setAttribute("stroke", "#64748b"); c.setAttribute("stroke-width", "1.5");
          m.appendChild(l); m.appendChild(c); return m;
        };

        const mkOneManyRev = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "18"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "2"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          // Crow's foot prongs (at start)
          const p1 = document.createElementNS(ns, "line");
          p1.setAttribute("x1", "2"); p1.setAttribute("y1", "7"); p1.setAttribute("x2", "10"); p1.setAttribute("y2", "2");
          p1.setAttribute("stroke", "#64748b"); p1.setAttribute("stroke-width", "1.5");
          const p2 = document.createElementNS(ns, "line");
          p2.setAttribute("x1", "2"); p2.setAttribute("y1", "7"); p2.setAttribute("x2", "10"); p2.setAttribute("y2", "7");
          p2.setAttribute("stroke", "#64748b"); p2.setAttribute("stroke-width", "1.5");
          const p3 = document.createElementNS(ns, "line");
          p3.setAttribute("x1", "2"); p3.setAttribute("y1", "7"); p3.setAttribute("x2", "10"); p3.setAttribute("y2", "12");
          p3.setAttribute("stroke", "#64748b"); p3.setAttribute("stroke-width", "1.5");
          const l = document.createElementNS(ns, "line");
          l.setAttribute("x1", "14"); l.setAttribute("y1", "2"); l.setAttribute("x2", "14"); l.setAttribute("y2", "12");
          l.setAttribute("stroke", "#64748b"); l.setAttribute("stroke-width", "1.5");
          m.appendChild(p1); m.appendChild(p2); m.appendChild(p3); m.appendChild(l); return m;
        };

        const mkZeroManyRev = (id) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "24"); m.setAttribute("markerHeight", "14");
          m.setAttribute("refX", "2"); m.setAttribute("refY", "7"); m.setAttribute("orient", "auto");
          // Crow's foot prongs
          const p1 = document.createElementNS(ns, "line");
          p1.setAttribute("x1", "2"); p1.setAttribute("y1", "7"); p1.setAttribute("x2", "10"); p1.setAttribute("y2", "2");
          p1.setAttribute("stroke", "#64748b"); p1.setAttribute("stroke-width", "1.5");
          const p2 = document.createElementNS(ns, "line");
          p2.setAttribute("x1", "2"); p2.setAttribute("y1", "7"); p2.setAttribute("x2", "10"); p2.setAttribute("y2", "7");
          p2.setAttribute("stroke", "#64748b"); p2.setAttribute("stroke-width", "1.5");
          const p3 = document.createElementNS(ns, "line");
          p3.setAttribute("x1", "2"); p3.setAttribute("y1", "7"); p3.setAttribute("x2", "10"); p3.setAttribute("y2", "12");
          p3.setAttribute("stroke", "#64748b"); p3.setAttribute("stroke-width", "1.5");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", "18"); c.setAttribute("cy", "7"); c.setAttribute("r", "4");
          c.setAttribute("fill", "none"); c.setAttribute("stroke", "#64748b"); c.setAttribute("stroke-width", "1.5");
          m.appendChild(p1); m.appendChild(p2); m.appendChild(p3); m.appendChild(c); return m;
        };

        // End markers (at target end of path)
        defs.appendChild(mkExactlyOne("mf-er-one"));
        defs.appendChild(mkZeroOne("mf-er-zero-one"));
        defs.appendChild(mkOneMany("mf-er-one-many"));
        defs.appendChild(mkZeroMany("mf-er-zero-many"));
        // Start markers (at source end of path) — reversed
        defs.appendChild(mkExactlyOneRev("mf-er-one-rev"));
        defs.appendChild(mkZeroOneRev("mf-er-zero-one-rev"));
        defs.appendChild(mkOneManyRev("mf-er-one-many-rev"));
        defs.appendChild(mkZeroManyRev("mf-er-zero-many-rev"));
        edgeSvg.appendChild(defs);

        // Map cardinality token to marker id
        const cardToMarkerId = (token, isStart) => {
          const t = token.replace(/[{}]/g, m => m === "{" ? "{" : "}").trim();
          const suffix = isStart ? "-rev" : "";
          if (t === "||") return "mf-er-one" + suffix;
          if (t === "o|" || t === "|o") return "mf-er-zero-one" + suffix;
          if (t === "|{" || t === "}|") return "mf-er-one-many" + suffix;
          if (t === "o{" || t === "}o") return "mf-er-zero-many" + suffix;
          return "mf-er-one" + suffix; // default
        };

        // Render relationship edges
        const edgeGroup = document.createElementNS(ns, "g");
        for (const rel of (erData.relationships || [])) {
          const de = g.edge(rel.source, rel.target);
          if (!de || !de.points) continue;

          const pts = de.points;
          const sp = pts[0];
          const tp = pts[pts.length - 1];
          const dist = Math.hypot(tp.x - sp.x, tp.y - sp.y);
          const off = Math.max(dist * 0.35, 25);
          const ddx = tp.x - sp.x;
          const ddy = tp.y - sp.y;
          let c1x, c1y, c2x, c2y;
          if (Math.abs(ddx) > Math.abs(ddy)) {
            c1x = sp.x + (ddx > 0 ? off : -off); c1y = sp.y;
            c2x = tp.x - (ddx > 0 ? off : -off); c2y = tp.y;
          } else {
            c1x = sp.x; c1y = sp.y + (ddy > 0 ? off : -off);
            c2x = tp.x; c2y = tp.y - (ddy > 0 ? off : -off);
          }
          const d = "M " + sp.x.toFixed(1) + " " + sp.y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + tp.x.toFixed(1) + " " + tp.y.toFixed(1);

          // Parse cardinality for markers
          const card = splitCardinality(rel.cardinality);

          // Invisible hit area
          const hit = document.createElementNS(ns, "path");
          hit.setAttribute("d", d); hit.setAttribute("class", "mf-er-edge-hit");
          hit.setAttribute("data-source", rel.source); hit.setAttribute("data-target", rel.target);
          edgeGroup.appendChild(hit);

          // Visible path
          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d); path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#94a3b8"); path.setAttribute("stroke-width", "1.5");
          path.setAttribute("class", "mf-er-edge");
          path.setAttribute("data-source", rel.source); path.setAttribute("data-target", rel.target);
          path.setAttribute("marker-start", "url(#" + cardToMarkerId(card.src, true) + ")");
          path.setAttribute("marker-end", "url(#" + cardToMarkerId(card.tgt, false) + ")");
          edgeGroup.appendChild(path);

          // Label
          if (rel.label) {
            const mid = pts[Math.floor(pts.length / 2)];
            const bg = document.createElementNS(ns, "rect");
            bg.setAttribute("class", "mf-er-edge-label-bg");
            bg.setAttribute("data-source", rel.source); bg.setAttribute("data-target", rel.target);
            bg.setAttribute("rx", "4"); bg.setAttribute("fill", "#f8f9fb"); bg.setAttribute("stroke", "#e2e8f0"); bg.setAttribute("stroke-width", "0.5");
            edgeGroup.appendChild(bg);
            const txt = document.createElementNS(ns, "text");
            txt.setAttribute("x", mid.x); txt.setAttribute("y", mid.y);
            txt.setAttribute("text-anchor", "middle"); txt.setAttribute("dominant-baseline", "central");
            txt.setAttribute("font-size", "11"); txt.setAttribute("font-family", "Manrope,system-ui,sans-serif");
            txt.setAttribute("fill", "#475569"); txt.setAttribute("font-weight", "500");
            txt.setAttribute("class", "mf-er-edge-label");
            txt.setAttribute("data-source", rel.source); txt.setAttribute("data-target", rel.target);
            txt.textContent = rel.label;
            edgeGroup.appendChild(txt);
          }

          // Edge click handler — show cardinality selector
          hit.addEventListener("click", (ev) => {
            ev.stopPropagation();
            send("element:selected", {
              label: rel.label || "", id: rel.source + "-" + rel.target,
              edgeSource: rel.source, edgeTarget: rel.target, elementType: "edge",
            });
            // Show cardinality selector popup
            container.querySelectorAll(".mf-er-card-popup").forEach(p => p.remove());
            const popup = document.createElement("div");
            popup.className = "mf-er-card-popup";
            popup.style.cssText = "position:absolute;left:" + ev.clientX + "px;top:" + ev.clientY + "px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:100;padding:4px;font-size:12px;font-family:Manrope,system-ui,sans-serif;";
            const card = splitCardinality(rel.cardinality);
            const options = [
              { token: "||", label: "Exactly one", symbol: "||" },
              { token: "o|", label: "Zero or one", symbol: "o|" },
              { token: "|{", label: "One or many", symbol: "|{" },
              { token: "o{", label: "Zero or many", symbol: "o{" },
            ];
            // Source side
            const srcLabel = document.createElement("div");
            srcLabel.style.cssText = "padding:4px 8px;font-weight:600;color:#64748b;font-size:11px;";
            srcLabel.textContent = "Source (" + rel.source + ")";
            popup.appendChild(srcLabel);
            for (const opt of options) {
              const btn = document.createElement("div");
              btn.style.cssText = "padding:4px 8px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px;" + (card.src === opt.token ? "background:#ede9fe;color:#6366f1;font-weight:600;" : "");
              btn.innerHTML = '<span style="font-family:monospace;font-size:13px;min-width:24px;">' + opt.symbol + '</span><span>' + opt.label + '</span>';
              btn.addEventListener("mouseenter", () => { btn.style.background = "#f1f5f9"; });
              btn.addEventListener("mouseleave", () => { btn.style.background = card.src === opt.token ? "#ede9fe" : ""; });
              btn.addEventListener("click", (pe) => {
                pe.stopPropagation();
                const newCard = opt.token + "--" + card.tgt;
                send("er:cardinality-changed", { source: rel.source, target: rel.target, cardinality: newCard });
                popup.remove();
              });
              popup.appendChild(btn);
            }
            // Divider
            const div = document.createElement("div");
            div.style.cssText = "height:1px;background:#e2e8f0;margin:4px 0;";
            popup.appendChild(div);
            // Target side
            const tgtLabel = document.createElement("div");
            tgtLabel.style.cssText = "padding:4px 8px;font-weight:600;color:#64748b;font-size:11px;";
            tgtLabel.textContent = "Target (" + rel.target + ")";
            popup.appendChild(tgtLabel);
            for (const opt of options) {
              const btn = document.createElement("div");
              btn.style.cssText = "padding:4px 8px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px;" + (card.tgt === opt.token ? "background:#ede9fe;color:#6366f1;font-weight:600;" : "");
              btn.innerHTML = '<span style="font-family:monospace;font-size:13px;min-width:24px;">' + opt.symbol + '</span><span>' + opt.label + '</span>';
              btn.addEventListener("mouseenter", () => { btn.style.background = "#f1f5f9"; });
              btn.addEventListener("mouseleave", () => { btn.style.background = card.tgt === opt.token ? "#ede9fe" : ""; });
              btn.addEventListener("click", (pe) => {
                pe.stopPropagation();
                const newCard = card.src + "--" + opt.token;
                send("er:cardinality-changed", { source: rel.source, target: rel.target, cardinality: newCard });
                popup.remove();
              });
              popup.appendChild(btn);
            }
            // Dismiss on outside click
            const dismiss = (de) => { if (!popup.contains(de.target)) { popup.remove(); document.removeEventListener("click", dismiss); } };
            setTimeout(() => document.addEventListener("click", dismiss), 10);
            container.appendChild(popup);
          });
          hit.addEventListener("contextmenu", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            send("element:context", {
              label: rel.label || "", id: rel.source + "-" + rel.target,
              edgeSource: rel.source, edgeTarget: rel.target, elementType: "edge",
              pointerX: ev.clientX, pointerY: ev.clientY,
            });
          });
        }
        edgeSvg.appendChild(edgeGroup);
        container.appendChild(edgeSvg);

        // Render entity cards
        const nodeEls = {};
        let connectMode = null;

        for (const entity of erData.entities) {
          const pos = g.node(entity.id);
          if (!pos) continue;
          const dim = nodeDims[entity.id] || { width: 180, height: 60 };

          const el = document.createElement("div");
          el.className = "mf-er-entity";
          el.setAttribute("data-node-id", entity.id);

          // Apply position (with overrides)
          const ovr = positionOverrides[entity.id] || { dx: 0, dy: 0 };
          const baseX = pos.x - dim.width / 2;
          const baseY = pos.y - dim.height / 2;
          el.style.left = (baseX + (ovr.dx || 0)) + "px";
          el.style.top = (baseY + (ovr.dy || 0)) + "px";
          el.style.width = dim.width + "px";

          // Style overrides
          const so = (styleOvr || {})[entity.id];
          if (so) {
            if (so.fill) el.style.background = so.fill;
            if (so.stroke) el.style.borderColor = so.stroke;
            if (so.textColor) el.style.color = so.textColor;
            if (so.strokeStyle === "dashed") el.style.borderStyle = "dashed";
            else if (so.strokeStyle === "none") el.style.borderWidth = "0";
          }

          // Header — use stroke color as header background if set, fill for body
          const header = document.createElement("div");
          header.className = "mf-er-header";
          header.textContent = entity.id;
          if (so?.stroke) header.style.background = so.stroke;
          if (so?.textColor) header.style.color = so.textColor;
          el.appendChild(header);

          // Attributes table
          const attrsDiv = document.createElement("div");
          attrsDiv.className = "mf-er-attrs";
          for (let idx = 0; idx < entity.attributes.length; idx++) {
            const attr = parseErAttr(entity.attributes[idx]);
            const row = document.createElement("div");
            row.className = "mf-er-attr-row";
            row.setAttribute("data-attr-idx", idx);
            if (attr.constraint) {
              const badge = document.createElement("span");
              badge.className = "mf-er-constraint";
              badge.textContent = attr.constraint;
              row.appendChild(badge);
            }
            const typeSpan = document.createElement("span");
            typeSpan.className = "mf-er-type";
            typeSpan.textContent = attr.type;
            row.appendChild(typeSpan);
            const nameSpan = document.createElement("span");
            nameSpan.className = "mf-er-name";
            nameSpan.textContent = attr.name;
            row.appendChild(nameSpan);
            attrsDiv.appendChild(row);
          }
          el.appendChild(attrsDiv);

          // Tooltip
          el.setAttribute("data-mf-tip", entity.id + " (" + entity.attributes.length + " attributes)");

          // Click → select (with screenBox for style toolbar)
          el.addEventListener("click", (ev) => {
            if (suppressClick) return;
            ev.stopPropagation();
            container.querySelectorAll(".mf-er-entity.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            el.classList.add("mf-selected");
            const rect = el.getBoundingClientRect();
            send("element:selected", {
              label: entity.id, id: entity.id, nodeId: entity.id, elementType: "node",
              screenBox: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            });
          });

          // Right-click → context menu
          el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            container.querySelectorAll(".mf-er-entity.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            el.classList.add("mf-selected");
            send("element:context", {
              label: entity.id, id: entity.id, nodeId: entity.id, elementType: "node",
              pointerX: ev.clientX, pointerY: ev.clientY,
            });
          });

          // Drag
          let dragInfo = null;
          el.addEventListener("pointerdown", (ev) => {
            if (ev.button !== 0) return;
            if (connectMode) {
              if (entity.id !== connectMode.sourceId) {
                send("connect:complete", { sourceId: connectMode.sourceId, targetId: entity.id });
              }
              ev.preventDefault();
              return;
            }
            ev.preventDefault();
            suppressClick = false;
            dragInfo = { startX: ev.clientX, startY: ev.clientY, origLeft: parseFloat(el.style.left), origTop: parseFloat(el.style.top), moved: false };
            el.style.cursor = "grabbing"; el.style.zIndex = "100";
            el.setPointerCapture(ev.pointerId);
          });
          el.addEventListener("pointermove", (ev) => {
            if (!dragInfo) return;
            const dx = ev.clientX - dragInfo.startX;
            const dy = ev.clientY - dragInfo.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragInfo.moved = true;
            if (!dragInfo.moved) return;
            el.style.left = (dragInfo.origLeft + dx) + "px";
            el.style.top = (dragInfo.origTop + dy) + "px";
            updateErEdgesForNode(edgeSvg, erData.relationships, entity.id, nodeEls, nodeDims);
          });
          el.addEventListener("pointerup", (ev) => {
            if (!dragInfo) return;
            const dx = ev.clientX - dragInfo.startX;
            const dy = ev.clientY - dragInfo.startY;
            el.releasePointerCapture(ev.pointerId);
            el.style.cursor = ""; el.style.zIndex = "";
            if (dragInfo.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
              suppressClick = true;
              setTimeout(() => { suppressClick = false; }, 200);
              positionOverrides[entity.id] = positionOverrides[entity.id] || { dx: 0, dy: 0 };
              positionOverrides[entity.id].dx += dx;
              positionOverrides[entity.id].dy += dy;
              send("element:dragged", { label: entity.id, nodeId: entity.id, deltaX: dx, deltaY: dy, isGanttTask: false, accumulatedDx: positionOverrides[entity.id].dx, accumulatedDy: positionOverrides[entity.id].dy });
            }
            dragInfo = null;
          });

          // Double-click header → inline rename
          header.addEventListener("dblclick", (ev) => {
            ev.stopPropagation();
            const oldName = entity.id;
            const input = document.createElement("input");
            input.className = "mf-er-inline-input";
            input.value = oldName;
            input.style.cssText = "width:100%;border:none;background:transparent;color:inherit;font:inherit;padding:0;outline:none;";
            header.textContent = "";
            header.appendChild(input);
            input.focus();
            input.select();
            const commit = () => {
              const newName = input.value.trim();
              if (newName && newName !== oldName) {
                send("er:entity-renamed", { entityId: oldName, newName });
              }
              header.textContent = newName || oldName;
            };
            input.addEventListener("blur", commit);
            input.addEventListener("keydown", (ke) => {
              if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
              if (ke.key === "Escape") { input.value = oldName; input.blur(); }
            });
          });

          // Double-click attribute row → inline edit
          attrsDiv.querySelectorAll(".mf-er-attr-row").forEach((row) => {
            row.addEventListener("dblclick", (ev) => {
              ev.stopPropagation();
              const attrIdx = parseInt(row.getAttribute("data-attr-idx"), 10);
              const oldValue = entity.attributes[attrIdx] || "";
              const input = document.createElement("input");
              input.className = "mf-er-inline-input";
              input.value = oldValue;
              input.style.cssText = "width:100%;border:none;background:transparent;color:inherit;font:inherit;padding:0;outline:none;font-size:12px;";
              row.innerHTML = "";
              row.appendChild(input);
              input.focus();
              input.select();
              const commit = () => {
                const newValue = input.value.trim();
                if (newValue !== oldValue) {
                  send("er:attribute-edited", { entityId: entity.id, attrIdx, newValue: newValue || oldValue });
                }
                // Restore display
                const attr = parseErAttr(newValue || oldValue);
                row.innerHTML = "";
                if (attr.constraint) {
                  const badge = document.createElement("span");
                  badge.className = "mf-er-constraint";
                  badge.textContent = attr.constraint;
                  row.appendChild(badge);
                }
                const ts = document.createElement("span");
                ts.className = "mf-er-type"; ts.textContent = attr.type;
                row.appendChild(ts);
                const ns2 = document.createElement("span");
                ns2.className = "mf-er-name"; ns2.textContent = attr.name;
                row.appendChild(ns2);
              };
              input.addEventListener("blur", commit);
              input.addEventListener("keydown", (ke) => {
                if (ke.key === "Enter") { ke.preventDefault(); input.blur(); }
                if (ke.key === "Escape") { input.value = oldValue; input.blur(); }
              });
            });
          });

          // Hover port indicators (for drag-to-create-relationship)
          el.addEventListener("mouseenter", () => {
            if (connectMode) return;
            container.querySelectorAll(".mf-er-port").forEach(p => p.remove());
            const left = parseFloat(el.style.left);
            const top = parseFloat(el.style.top);
            const w = dim.width; const h = parseFloat(el.offsetHeight || dim.height);
            const cx = left + w / 2; const cy = top + h / 2;
            const portPositions = [
              { name: "top", x: cx - 9, y: top - 22 },
              { name: "bottom", x: cx - 9, y: top + h + 4 },
              { name: "left", x: left - 22, y: cy - 9 },
              { name: "right", x: left + w + 4, y: cy - 9 },
            ];
            for (const pp of portPositions) {
              const port = document.createElement("div");
              port.className = "mf-er-port";
              port.style.left = pp.x + "px"; port.style.top = pp.y + "px";
              port.textContent = "+";
              port.addEventListener("click", (pe) => {
                pe.stopPropagation();
                send("port:clicked", { nodeId: entity.id, port: pp.name });
                container.querySelectorAll(".mf-er-port").forEach(p => p.remove());
              });
              container.appendChild(port);
            }
          });

          nodeEls[entity.id] = el;
          container.appendChild(el);
        }

        // Remove ports on mouse leave
        container.addEventListener("mouseleave", () => {
          container.querySelectorAll(".mf-er-port").forEach(p => p.remove());
        });

        // Canvas click → deselect
        container.addEventListener("click", (ev) => {
          if (ev.target === container || ev.target === edgeSvg) {
            container.querySelectorAll(".mf-er-entity.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            send("element:selected", null);
          }
        });

        // Canvas right-click
        container.addEventListener("contextmenu", (ev) => {
          if (ev.target === container || ev.target === edgeSvg) {
            ev.preventDefault();
            send("element:context", { elementType: "canvas", pointerX: ev.clientX, pointerY: ev.clientY });
          }
        });

        // Fix label backgrounds after render
        requestAnimationFrame(() => {
          edgeSvg.querySelectorAll(".mf-er-edge-label").forEach((lbl) => {
            const src = lbl.getAttribute("data-source");
            const tgt = lbl.getAttribute("data-target");
            const bg = edgeSvg.querySelector('.mf-er-edge-label-bg[data-source="' + CSS.escape(src) + '"][data-target="' + CSS.escape(tgt) + '"]');
            if (bg) { try { const bb = lbl.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(e) {} }
          });
        });

        // Listen for connect mode and selection messages
        const handleErMsg = (msgEv) => {
          const d = msgEv.data;
          if (!d || d.channel !== "mermaidflow") return;
          if (d.type === "mode:connect") {
            connectMode = d.payload || null;
            container.querySelectorAll(".mf-er-entity").forEach(n => n.classList.remove("mf-connect-source"));
            if (connectMode?.sourceId) {
              const nd = container.querySelector('[data-node-id="' + CSS.escape(connectMode.sourceId) + '"]');
              if (nd) nd.classList.add("mf-connect-source");
            }
          }
          if (d.type === "mode:connect-cancel") {
            connectMode = null;
            container.querySelectorAll(".mf-er-entity").forEach(n => n.classList.remove("mf-connect-source"));
          }
          if (d.type === "er:select") {
            const nid = d.payload?.nodeId || "";
            container.querySelectorAll(".mf-er-entity.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            if (nid) {
              const nd = container.querySelector('[data-node-id="' + CSS.escape(nid) + '"]');
              if (nd) nd.classList.add("mf-selected");
            }
          }
        };
        window.addEventListener("message", handleErMsg);

        canvas.appendChild(container);
      };

      /* ── Custom State Diagram Renderer ─────────────── */
      const renderCustomStateDiagram = (parsed) => {
        setGanttMode(false);
        clearGanttOverlay();
        canvas.innerHTML = "";
        canvas.style.justifyContent = "center";

        const states = parsed?.states || [];
        const transitions = parsed?.transitions || [];
        const direction = parsed?.direction || "LR";

        if (!states.length) {
          const msg = document.createElement("div");
          msg.style.cssText = "padding:32px;color:#64748b;font-size:14px;text-align:center;";
          msg.textContent = "No states found in diagram.";
          canvas.appendChild(msg);
          return;
        }

        // Measure state dimensions
        const stateDims = {};
        const measurer = document.createElement("div");
        measurer.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:500 13px Manrope,system-ui,sans-serif;padding:10px 20px;";
        document.body.appendChild(measurer);
        for (const s of states) {
          if (s.pseudo === "initial") { stateDims[s.id] = { width: 20, height: 20 }; continue; }
          if (s.pseudo === "final") { stateDims[s.id] = { width: 24, height: 24 }; continue; }
          measurer.textContent = s.label || s.id;
          const w = Math.max(80, measurer.offsetWidth + 8);
          const h = Math.max(40, measurer.offsetHeight + 4);
          stateDims[s.id] = { width: w, height: h };
        }
        document.body.removeChild(measurer);

        // Dagre layout
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: direction === "TB" ? "TB" : "LR", nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 });
        g.setDefaultEdgeLabel(() => ({}));

        for (const s of states) {
          const d = stateDims[s.id] || { width: 80, height: 40 };
          g.setNode(s.id, { width: d.width, height: d.height, label: s.label || s.id });
        }

        // Deduplicate edges for dagre (it doesn't support multi-edges natively)
        const edgeKey = (s, t) => s + ">>>" + t;
        const seenEdges = new Set();
        for (const t of transitions) {
          const key = edgeKey(t.source, t.target);
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          if (g.hasNode(t.source) && g.hasNode(t.target) && t.source !== t.target) {
            g.setEdge(t.source, t.target, { label: t.label || "" });
          }
        }

        dagre.layout(g);

        const graphInfo = g.graph();
        const gw = (graphInfo.width || 600) + 80;
        const gh = (graphInfo.height || 400) + 80;

        const container = document.createElement("div");
        container.className = "mf-state-container";
        container.style.width = gw + "px";
        container.style.height = gh + "px";

        // SVG edge overlay
        const ns = "http://www.w3.org/2000/svg";
        const edgeSvg = document.createElementNS(ns, "svg");
        edgeSvg.setAttribute("class", "mf-state-edges");
        edgeSvg.setAttribute("width", gw);
        edgeSvg.setAttribute("height", gh);
        edgeSvg.style.width = gw + "px";
        edgeSvg.style.height = gh + "px";

        // Arrow markers
        const defs = document.createElementNS(ns, "defs");
        const mkArrowSt = (id, color) => {
          const m = document.createElementNS(ns, "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", "10"); m.setAttribute("markerHeight", "7");
          m.setAttribute("refX", "9"); m.setAttribute("refY", "3.5"); m.setAttribute("orient", "auto");
          const p = document.createElementNS(ns, "polygon");
          p.setAttribute("points", "0 0, 10 3.5, 0 7"); p.setAttribute("fill", color);
          m.appendChild(p); return m;
        };
        defs.appendChild(mkArrowSt("mf-state-arrow", "#8b9dc3"));
        defs.appendChild(mkArrowSt("mf-state-arrow-active", "#6366f1"));
        edgeSvg.appendChild(defs);

        // Helper: connection point on a state boundary
        const stateConnectionPt = (cx, cy, hw, hh, tx, ty, isPseudo) => {
          const dx = tx - cx;
          const dy = ty - cy;
          const angle = Math.atan2(dy, dx);
          if (isPseudo) {
            // Circle
            const r = Math.max(hw, hh);
            return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
          }
          // Rounded rectangle
          const ar = hh / (hw || 1);
          const tanA = Math.abs(dy / (dx || 0.001));
          if (tanA > ar) {
            const iy = cy + (dy > 0 ? hh : -hh);
            return { x: cx + (dy !== 0 ? hh * (dx / Math.abs(dy)) : 0), y: iy };
          }
          const ix = cx + (dx > 0 ? hw : -hw);
          return { x: ix, y: cy + (dx !== 0 ? hw * (dy / Math.abs(dx)) : 0) };
        };

        // Track node elements and centers for edge updates
        const nodeEls = {};
        const nodeCenters = {};

        // Render transitions as cubic Bezier paths
        const edgeGroup = document.createElementNS(ns, "g");

        // Collect self-loops
        const selfLoops = transitions.filter(t => t.source === t.target);
        const normalTransitions = transitions.filter(t => t.source !== t.target);

        // Group normal transitions by source-target pair to stack labels
        const edgePairs = new Map();
        for (const t of normalTransitions) {
          const key = edgeKey(t.source, t.target);
          if (!edgePairs.has(key)) edgePairs.set(key, []);
          edgePairs.get(key).push(t);
        }

        for (const [key, group] of edgePairs) {
          const t = group[0];
          const sPos = g.node(t.source);
          const tPos = g.node(t.target);
          if (!sPos || !tPos) continue;
          const sDim = stateDims[t.source] || { width: 80, height: 40 };
          const tDim = stateDims[t.target] || { width: 80, height: 40 };
          const sState = states.find(s => s.id === t.source);
          const tState = states.find(s => s.id === t.target);
          const sIsPseudo = !!(sState && sState.pseudo);
          const tIsPseudo = !!(tState && tState.pseudo);

          const sp = stateConnectionPt(sPos.x, sPos.y, sDim.width / 2, sDim.height / 2, tPos.x, tPos.y, sIsPseudo);
          const tp = stateConnectionPt(tPos.x, tPos.y, tDim.width / 2, tDim.height / 2, sPos.x, sPos.y, tIsPseudo);

          const dist = Math.hypot(tp.x - sp.x, tp.y - sp.y);
          const off = Math.max(dist * 0.35, 25);
          const ddx = tp.x - sp.x;
          const ddy = tp.y - sp.y;
          let c1x, c1y, c2x, c2y;
          if (Math.abs(ddx) > Math.abs(ddy)) {
            c1x = sp.x + (ddx > 0 ? off : -off); c1y = sp.y;
            c2x = tp.x - (ddx > 0 ? off : -off); c2y = tp.y;
          } else {
            c1x = sp.x; c1y = sp.y + (ddy > 0 ? off : -off);
            c2x = tp.x; c2y = tp.y - (ddy > 0 ? off : -off);
          }
          const d = "M " + sp.x.toFixed(1) + " " + sp.y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + tp.x.toFixed(1) + " " + tp.y.toFixed(1);

          // Hit area
          const hit = document.createElementNS(ns, "path");
          hit.setAttribute("d", d); hit.setAttribute("class", "mf-edge-hit");
          hit.setAttribute("data-source", t.source); hit.setAttribute("data-target", t.target);
          edgeGroup.appendChild(hit);

          // Visible path
          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d); path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#8b9dc3"); path.setAttribute("stroke-width", "1.5");
          path.setAttribute("marker-end", "url(#mf-state-arrow)");
          path.setAttribute("class", "mf-edge");
          path.setAttribute("data-source", t.source); path.setAttribute("data-target", t.target);
          edgeGroup.appendChild(path);

          // Labels (stack multiple labels for same source→target pair)
          const combinedLabel = group.map(tr => tr.label).filter(Boolean).join(" / ");
          if (combinedLabel) {
            const midX = (sp.x + tp.x) / 2;
            const midY = (sp.y + tp.y) / 2;
            const bg = document.createElementNS(ns, "rect");
            bg.setAttribute("class", "mf-edge-label-bg");
            bg.setAttribute("data-source", t.source); bg.setAttribute("data-target", t.target);
            bg.setAttribute("rx", "4"); bg.setAttribute("fill", "#f8f9fb"); bg.setAttribute("stroke", "#e2e8f0"); bg.setAttribute("stroke-width", "0.5");
            edgeGroup.appendChild(bg);
            const txt = document.createElementNS(ns, "text");
            txt.setAttribute("x", midX); txt.setAttribute("y", midY);
            txt.setAttribute("text-anchor", "middle"); txt.setAttribute("dominant-baseline", "central");
            txt.setAttribute("font-size", "11"); txt.setAttribute("font-family", "Manrope,system-ui,sans-serif");
            txt.setAttribute("fill", "#475569"); txt.setAttribute("font-weight", "500");
            txt.setAttribute("class", "mf-edge-label");
            txt.setAttribute("data-source", t.source); txt.setAttribute("data-target", t.target);
            txt.textContent = combinedLabel;
            edgeGroup.appendChild(txt);
          }
        }

        // Self-loop rendering
        for (const t of selfLoops) {
          const sPos = g.node(t.source);
          if (!sPos) continue;
          const sDim = stateDims[t.source] || { width: 80, height: 40 };
          const topY = sPos.y - sDim.height / 2;
          const cx = sPos.x;
          const loopR = 22;
          const d = "M " + (cx - 12).toFixed(1) + " " + topY.toFixed(1)
            + " C " + (cx - 12).toFixed(1) + " " + (topY - loopR * 2).toFixed(1)
            + " " + (cx + 12).toFixed(1) + " " + (topY - loopR * 2).toFixed(1)
            + " " + (cx + 12).toFixed(1) + " " + topY.toFixed(1);

          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d); path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#8b9dc3"); path.setAttribute("stroke-width", "1.5");
          path.setAttribute("marker-end", "url(#mf-state-arrow)");
          path.setAttribute("class", "mf-edge");
          path.setAttribute("data-source", t.source); path.setAttribute("data-target", t.target);
          edgeGroup.appendChild(path);

          if (t.label) {
            const txt = document.createElementNS(ns, "text");
            txt.setAttribute("x", cx); txt.setAttribute("y", topY - loopR * 2 + 4);
            txt.setAttribute("text-anchor", "middle"); txt.setAttribute("dominant-baseline", "auto");
            txt.setAttribute("font-size", "11"); txt.setAttribute("font-family", "Manrope,system-ui,sans-serif");
            txt.setAttribute("fill", "#475569"); txt.setAttribute("font-weight", "500");
            txt.setAttribute("class", "mf-edge-label");
            txt.textContent = t.label;
            edgeGroup.appendChild(txt);
          }
        }

        edgeSvg.appendChild(edgeGroup);
        container.appendChild(edgeSvg);

        // Render state nodes
        let suppressClick = false;
        let dragConnect = null;
        let dragLine = null;

        for (const state of states) {
          const pos = g.node(state.id);
          if (!pos) continue;
          const dim = stateDims[state.id] || { width: 80, height: 40 };

          const el = document.createElement("div");
          const isPseudo = !!state.pseudo;
          el.className = "mf-state-node" + (state.pseudo === "initial" ? " mf-state-initial" : "") + (state.pseudo === "final" ? " mf-state-final" : "");
          el.setAttribute("data-state-id", state.id);
          el.style.left = (pos.x - dim.width / 2) + "px";
          el.style.top = (pos.y - dim.height / 2) + "px";
          el.style.width = dim.width + "px";
          el.style.height = dim.height + "px";

          if (!isPseudo) {
            const labelSpan = document.createElement("span");
            labelSpan.className = "mf-state-label";
            labelSpan.textContent = state.label || state.id;
            el.appendChild(labelSpan);
            el.setAttribute("data-mf-tip", state.label || state.id);
          }

          nodeCenters[state.id] = { x: pos.x, y: pos.y };

          // Click
          el.addEventListener("click", (ev) => {
            if (suppressClick) return;
            ev.stopPropagation();
            container.querySelectorAll(".mf-state-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            el.classList.add("mf-selected");
            // Map pseudo IDs back to [*]
            const outId = state.pseudo ? "[*]" : state.id;
            const outLabel = state.pseudo ? "[*]" : (state.label || state.id);
            send("element:selected", {
              label: outLabel, id: outId, nodeId: outId, elementType: "node",
            });
          });

          // Context menu
          el.addEventListener("contextmenu", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            container.querySelectorAll(".mf-state-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            el.classList.add("mf-selected");
            const outId = state.pseudo ? "[*]" : state.id;
            send("element:context", {
              label: state.label || state.id, id: outId, nodeId: outId, elementType: "node",
              pointerX: ev.clientX, pointerY: ev.clientY,
            });
          });

          // Drag-to-connect (pointer down → move → up)
          if (!isPseudo || state.pseudo === "initial") {
            let dragInfo = null;
            el.addEventListener("pointerdown", (ev) => {
              if (ev.button !== 0) return;
              ev.preventDefault();
              dragInfo = { startX: ev.clientX, startY: ev.clientY, moved: false };
              el.setPointerCapture(ev.pointerId);
            });
            el.addEventListener("pointermove", (ev) => {
              if (!dragInfo) return;
              const dx = ev.clientX - dragInfo.startX;
              const dy = ev.clientY - dragInfo.startY;
              if (!dragInfo.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                dragInfo.moved = true;
                el.classList.add("mf-state-dragging");
                // Create drag line
                const svgRect = edgeSvg.getBoundingClientRect();
                dragLine = document.createElementNS(ns, "line");
                dragLine.setAttribute("class", "mf-drag-line");
                dragLine.setAttribute("x1", pos.x);
                dragLine.setAttribute("y1", pos.y);
                dragLine.setAttribute("x2", pos.x);
                dragLine.setAttribute("y2", pos.y);
                edgeSvg.appendChild(dragLine);
                dragConnect = { sourceId: state.id, el: el };
              }
              if (dragInfo.moved && dragLine) {
                const svgRect = edgeSvg.getBoundingClientRect();
                dragLine.setAttribute("x2", ev.clientX - svgRect.left);
                dragLine.setAttribute("y2", ev.clientY - svgRect.top);

                // Highlight potential drop targets
                container.querySelectorAll(".mf-drop-target").forEach(n => n.classList.remove("mf-drop-target"));
                const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
                const targetNode = targetEl?.closest?.("[data-state-id]");
                if (targetNode && targetNode !== el) {
                  targetNode.classList.add("mf-drop-target");
                }
              }
            });
            el.addEventListener("pointerup", (ev) => {
              if (!dragInfo) return;
              try { el.releasePointerCapture(ev.pointerId); } catch(_) {}
              el.classList.remove("mf-state-dragging");
              container.querySelectorAll(".mf-drop-target").forEach(n => n.classList.remove("mf-drop-target"));

              if (dragInfo.moved && dragConnect) {
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 200);
                // Find target under cursor
                if (dragLine) { dragLine.remove(); dragLine = null; }
                const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
                const targetNode = targetEl?.closest?.("[data-state-id]");
                if (targetNode && targetNode !== el) {
                  const targetId = targetNode.getAttribute("data-state-id");
                  // Map pseudo IDs back to [*]
                  const srcOut = state.pseudo ? "[*]" : state.id;
                  let tgtOut = targetId;
                  const tgtState = states.find(s => s.id === targetId);
                  if (tgtState && tgtState.pseudo) tgtOut = "[*]";
                  send("state:connect", { sourceId: srcOut, targetId: tgtOut });
                }
              } else {
                if (dragLine) { dragLine.remove(); dragLine = null; }
              }
              dragConnect = null;
              dragInfo = null;
            });
          }

          container.appendChild(el);
          nodeEls[state.id] = el;
        }

        // Edge click handlers
        edgeSvg.addEventListener("click", (ev) => {
          const t = ev.target;
          if (t.classList.contains("mf-edge-hit") || t.classList.contains("mf-edge") || t.classList.contains("mf-edge-label-bg") || t.classList.contains("mf-edge-label")) {
            ev.stopPropagation();
            const src = t.getAttribute("data-source") || "";
            const tgt = t.getAttribute("data-target") || "";
            send("element:selected", { label: "", id: "", nodeId: "", elementType: "edge", edgeSource: src, edgeTarget: tgt });
          }
        });
        edgeSvg.addEventListener("contextmenu", (ev) => {
          const t = ev.target;
          if (t.classList.contains("mf-edge-hit") || t.classList.contains("mf-edge") || t.classList.contains("mf-edge-label-bg") || t.classList.contains("mf-edge-label")) {
            ev.preventDefault(); ev.stopPropagation();
            const src = t.getAttribute("data-source") || "";
            const tgt = t.getAttribute("data-target") || "";
            send("element:context", { label: "", id: "", nodeId: "", elementType: "edge", edgeSource: src, edgeTarget: tgt, pointerX: ev.clientX, pointerY: ev.clientY });
          }
        });

        // Empty area click
        container.addEventListener("click", (ev) => {
          if (ev.target === container) {
            container.querySelectorAll(".mf-state-node.mf-selected").forEach(n => n.classList.remove("mf-selected"));
            send("element:selected", null);
          }
        });
        container.addEventListener("contextmenu", (ev) => {
          if (ev.target === container) {
            ev.preventDefault();
            send("element:context", { label: "", id: "", nodeId: "", elementType: "canvas", pointerX: ev.clientX, pointerY: ev.clientY });
          }
        });

        // Size edge label backgrounds after DOM paint
        requestAnimationFrame(() => {
          edgeSvg.querySelectorAll(".mf-edge-label").forEach(txt => {
            const src = txt.getAttribute("data-source");
            const tgt = txt.getAttribute("data-target");
            const bg = edgeSvg.querySelector('.mf-edge-label-bg[data-source="' + src + '"][data-target="' + tgt + '"]');
            if (!bg) return;
            try { const bb = txt.getBBox(); bg.setAttribute("x", bb.x - 4); bg.setAttribute("y", bb.y - 2); bg.setAttribute("width", bb.width + 8); bg.setAttribute("height", bb.height + 4); } catch(e) {}
          });
        });

        canvas.appendChild(container);
      };

      const isDarkFill = (el) => {
        if (!el) return false;
        const fill = (window.getComputedStyle(el).fill || el.getAttribute("fill") || "").trim();
        if (!fill || fill === "none") return false;

        const hexMatch = fill.match(/^#([0-9a-f]{3,8})$/i);
        let parts = null;
        if (hexMatch) {
          const hex = hexMatch[1];
          if (hex.length === 3 || hex.length === 4) {
            parts = [
              parseInt(hex[0] + hex[0], 16),
              parseInt(hex[1] + hex[1], 16),
              parseInt(hex[2] + hex[2], 16),
            ];
          } else if (hex.length === 6 || hex.length === 8) {
            parts = [
              parseInt(hex.slice(0, 2), 16),
              parseInt(hex.slice(2, 4), 16),
              parseInt(hex.slice(4, 6), 16),
            ];
          }
        }

        if (!parts) {
          const rgbMatch = fill.match(/^rgba?\\(([^)]+)\\)$/i);
          if (!rgbMatch) return false;
          parts = rgbMatch[1].split(",").map((p) => parseFloat(p.trim()));
        }

        const r = Number.isFinite(parts[0]) ? parts[0] / 255 : 1;
        const g = Number.isFinite(parts[1]) ? parts[1] / 255 : 1;
        const b = Number.isFinite(parts[2]) ? parts[2] / 255 : 1;
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return luminance < 0.58;
      };

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

      const positionTooltip = (cx, cy) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const tipRect = tooltipEl.getBoundingClientRect();
        const tipW = tipRect.width || 300;
        const tipH = tipRect.height || 120;
        const margin = 12;
        // Flip above cursor if it would overflow the bottom
        const top = (cy + margin + tipH > vh) ? Math.max(margin, cy - tipH - margin) : cy + margin;
        // Shift left if it would overflow the right edge
        const left = (cx + margin + tipW > vw) ? Math.max(margin, vw - tipW - margin) : cx + margin;
        tooltipEl.style.left = left + "px";
        tooltipEl.style.top = top + "px";
      };

      canvas.addEventListener("mouseover", (e) => {
        // Hide tooltip when hovering dependency connector
        if (e.target.closest(".mf-dep-connector")) {
          tooltipEl.style.display = "none";
          return;
        }
        // Support both SVG elements (rect/text) and HTML elements (div with data-mf-tip)
        const tipEl = e.target.closest("[data-mf-tip]");
        const tip = tipEl ? tipEl.getAttribute("data-mf-tip") : "";
        if (!tip) return;
        tooltipEl.textContent = tip;
        tooltipEl.style.display = "block";
        positionTooltip(e.clientX, e.clientY);
      });
      canvas.addEventListener("mousemove", (e) => {
        if (tooltipEl.style.display === "block") {
          positionTooltip(e.clientX, e.clientY);
        }
      });
      canvas.addEventListener("mouseout", (e) => {
        if (e.target.closest("[data-mf-tip]") || e.target.nodeName === "rect" || e.target.nodeName === "text" || e.target.nodeName === "tspan") {
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

      /* ── Custom Sequence Diagram Renderer ─────────────────── */
      const renderCustomSequence = (participants, messages, blocks, extras, swimlaneView) => {
        setGanttMode(false);
        clearGanttOverlay();
        canvas.innerHTML = "";
        canvas.style.justifyContent = "center";

        if (!participants.length && !messages.length) {
          canvas.textContent = "Empty sequence diagram";
          return;
        }

        const MIN_COL_W = 200;
        const MAX_COL_W = 350;
        const MARGIN = 40;
        const rowHeight = 52;
        const actorHeight = 44;
        const actorPad = 16;
        const lifelineStartY = actorHeight + actorPad;
        const msgStartY = lifelineStartY + 14;

        // --- Measure actor label widths for dynamic columns ---
        const measurer = document.createElement("div");
        measurer.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;top:-9999px;left:-9999px;font-family:Manrope,system-ui,sans-serif;font-size:13px;";
        document.body.appendChild(measurer);
        const colWidths = [];
        for (const p of participants) {
          const el = document.createElement("span");
          el.style.cssText = "font-weight:600;white-space:nowrap;padding:0 10px;";
          el.textContent = p.label || p.id;
          measurer.appendChild(el);
          colWidths.push(Math.min(MAX_COL_W, Math.max(el.offsetWidth + 40, MIN_COL_W)));
          measurer.removeChild(el);
        }
        // Measure message labels — expand columns if needed
        const msgCanvas = document.createElement("canvas");
        const msgCtx = msgCanvas.getContext("2d");
        if (msgCtx) msgCtx.font = '500 13px Manrope, system-ui, sans-serif';
        for (const m of messages) {
          if (!m.text) continue;
          const si = participants.findIndex(p => p.id === m.source);
          const ti = participants.findIndex(p => p.id === m.target);
          if (si < 0 || ti < 0 || si === ti) continue;
          const textW = msgCtx ? msgCtx.measureText(m.text).width + 32 : m.text.length * 8;
          const lo = Math.min(si, ti), hi = Math.max(si, ti);
          let avail = 0;
          for (let i = lo; i <= hi; i++) avail += colWidths[i];
          if (textW > avail) {
            const perCol = Math.ceil((textW - avail) / (hi - lo + 1));
            for (let i = lo; i <= hi; i++) colWidths[i] = Math.min(MAX_COL_W, colWidths[i] + perCol);
          }
        }
        document.body.removeChild(measurer);

        // Cumulative offsets for variable-width columns
        const colOffsets = [MARGIN];
        for (let i = 0; i < colWidths.length; i++) colOffsets.push(colOffsets[i] + colWidths[i]);
        const totalWidth = colOffsets[colWidths.length] + MARGIN;
        const actorCenterX = (idx) => colOffsets[idx] + colWidths[idx] / 2;

        const activations = (extras && extras.activations) || [];
        const notes = (extras && extras.notes) || [];

        // Compute message rows needed (including block labels and notes)
        const rowItems = [];
        let msgIdx = 0;
        let blockStackDepth = 0;
        const blockStarts = {};
        const blockEnds = {};
        if (blocks) {
          for (const b of blocks) {
            blockStarts[b.startLine] = b;
            blockEnds[b.endLine] = b;
            for (const d of (b.dividers || [])) {
              blockStarts[d.lineIndex] = { ...b, dividerLabel: d.label, isDivider: true };
            }
          }
        }

        // Build row items from messages in order, interleaving block markers
        for (let mi = 0; mi < messages.length; mi++) {
          rowItems.push({ type: "message", index: mi, msg: messages[mi] });
        }

        // Also add notes as inline items after their line positions
        for (const note of notes) {
          rowItems.push({ type: "note", note });
        }

        const bodyHeight = Math.max(rowItems.length * rowHeight + 40, 120);
        const totalHeight = actorHeight + actorPad + bodyHeight + actorHeight + actorPad;

        // --- Swimlane view ---
        if (swimlaneView) {
          const container = document.createElement("div");
          container.className = "mf-seq-container mf-seq-swimlane";
          // Swimlane uses flex layout — no fixed widths

          for (let pi = 0; pi < participants.length; pi++) {
            const p = participants[pi];
            const lane = document.createElement("div");
            lane.className = "mf-seq-lane";
            lane.setAttribute("data-participant-id", p.id);

            const header = document.createElement("div");
            header.className = "mf-seq-lane-header";
            header.textContent = p.label || p.id;
            lane.appendChild(header);

            // Click to select actor
            header.addEventListener("click", (e) => {
              e.stopPropagation();
              container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
              lane.classList.add("mf-selected");
              send("element:selected", { elementType: "node", nodeId: p.id, label: p.label || p.id });
            });
            header.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              e.stopPropagation();
              send("element:context", { elementType: "node", nodeId: p.id, label: p.label || p.id, pointerX: e.clientX, pointerY: e.clientY });
            });

            const msgList = document.createElement("div");
            msgList.className = "mf-seq-lane-messages";

            for (let mi = 0; mi < messages.length; mi++) {
              const m = messages[mi];
              const isSender = m.source === p.id;
              const isReceiver = m.target === p.id;
              if (!isSender && !isReceiver) {
                // Blank row to maintain vertical alignment across lanes
                const blank = document.createElement("div");
                blank.className = "mf-seq-lane-msg mf-seq-lane-msg-blank";
                msgList.appendChild(blank);
                continue;
              }

              const row = document.createElement("div");
              row.className = "mf-seq-lane-msg";
              row.setAttribute("data-message-index", mi);

              // Primary: message text (full width, wrapping)
              const text = document.createElement("span");
              text.className = "mf-seq-lane-text";
              text.textContent = m.text || "(no label)";
              row.appendChild(text);

              // Meta line: direction badge + peer name
              const meta = document.createElement("div");
              meta.className = "mf-seq-lane-meta";
              const dir = document.createElement("span");
              dir.className = "mf-seq-lane-direction";
              dir.textContent = isSender ? "\u2192" : "\u2190";
              meta.appendChild(dir);
              const peer = document.createElement("span");
              peer.className = "mf-seq-lane-peer";
              peer.textContent = (isSender ? "to " : "from ") + (isSender ? m.target : m.source);
              meta.appendChild(peer);
              row.appendChild(meta);

              row.addEventListener("click", (e) => {
                e.stopPropagation();
                container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
                row.classList.add("mf-selected");
                send("element:selected", { elementType: "edge", edgeSource: m.source, edgeTarget: m.target, messageIndex: mi, label: m.text || "" });
              });
              row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                send("element:context", { elementType: "edge", edgeSource: m.source, edgeTarget: m.target, messageIndex: mi, label: m.text || "", arrowType: m.arrowType || "->>", pointerX: e.clientX, pointerY: e.clientY });
              });

              msgList.appendChild(row);
            }

            lane.appendChild(msgList);
            container.appendChild(lane);
          }

          // Deselect on background click
          container.addEventListener("click", (e) => {
            if (e.target === container) {
              container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
              send("element:selected", null);
            }
          });
          container.addEventListener("contextmenu", (e) => {
            if (e.target === container) {
              e.preventDefault();
              send("element:context", { elementType: "canvas", pointerX: e.clientX, pointerY: e.clientY });
            }
          });

          canvas.appendChild(container);
          return;
        }

        // --- Normal sequence view ---
        const container = document.createElement("div");
        container.className = "mf-seq-container";
        container.style.width = totalWidth + "px";
        container.style.minHeight = totalHeight + "px";
        container.style.position = "relative";

        // === SVG layer for lifelines and arrows ===
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", totalWidth);
        svg.setAttribute("height", totalHeight);
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.pointerEvents = "none";
        svg.style.overflow = "visible";

        // Arrow marker definitions (larger for better visibility)
        const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        const mkr = (id, w, h, rx, ry) => {
          const m = document.createElementNS("http://www.w3.org/2000/svg", "marker");
          m.setAttribute("id", id); m.setAttribute("markerWidth", w); m.setAttribute("markerHeight", h);
          m.setAttribute("refX", rx); m.setAttribute("refY", ry); m.setAttribute("orient", "auto");
          return m;
        };
        // Filled arrowhead (for ->> and -->>)
        const mkFilled = mkr("mf-seq-arrow-filled", "11", "8", "10", "4");
        const filledPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        filledPath.setAttribute("d", "M0,0 L11,4 L0,8 Z");
        filledPath.setAttribute("fill", "var(--ink, #333)");
        mkFilled.appendChild(filledPath); defs.appendChild(mkFilled);

        // Open arrowhead (for -> and -->)
        const mkOpen = mkr("mf-seq-arrow-open", "11", "8", "10", "4");
        const openPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        openPath.setAttribute("d", "M0,0 L11,4 L0,8");
        openPath.setAttribute("fill", "none");
        openPath.setAttribute("stroke", "var(--ink, #333)");
        openPath.setAttribute("stroke-width", "1.5");
        mkOpen.appendChild(openPath); defs.appendChild(mkOpen);

        // Reverse filled arrowhead (for self-message loops)
        const mkFilledRev = mkr("mf-seq-arrow-filled-rev", "11", "8", "1", "4");
        const filledRevPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        filledRevPath.setAttribute("d", "M11,0 L0,4 L11,8 Z");
        filledRevPath.setAttribute("fill", "var(--ink, #333)");
        mkFilledRev.appendChild(filledRevPath); defs.appendChild(mkFilledRev);

        // X marker (for -x and --x)
        const mkX = mkr("mf-seq-arrow-x", "14", "14", "7", "7");
        const xLine1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
        xLine1.setAttribute("x1", "2"); xLine1.setAttribute("y1", "2");
        xLine1.setAttribute("x2", "12"); xLine1.setAttribute("y2", "12");
        xLine1.setAttribute("stroke", "var(--ink, #333)"); xLine1.setAttribute("stroke-width", "2");
        const xLine2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
        xLine2.setAttribute("x1", "12"); xLine2.setAttribute("y1", "2");
        xLine2.setAttribute("x2", "2"); xLine2.setAttribute("y2", "12");
        xLine2.setAttribute("stroke", "var(--ink, #333)"); xLine2.setAttribute("stroke-width", "2");
        mkX.appendChild(xLine1); mkX.appendChild(xLine2); defs.appendChild(mkX);
        svg.appendChild(defs);

        // Collect label bg+text pairs for deferred getBBox sizing
        const labelPairs = [];

        // Draw lifelines
        for (let pi = 0; pi < participants.length; pi++) {
          const cx = actorCenterX(pi);
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", cx);
          line.setAttribute("y1", lifelineStartY);
          line.setAttribute("x2", cx);
          line.setAttribute("y2", totalHeight - actorHeight - actorPad);
          line.setAttribute("stroke", "var(--border, #d1d5db)");
          line.setAttribute("stroke-width", "1");
          line.setAttribute("stroke-dasharray", "6,4");
          line.classList.add("mf-seq-lifeline");
          svg.appendChild(line);
        }

        // Draw activations
        for (const act of activations) {
          const pIdx = participants.findIndex((p) => p.id === act.participantId);
          if (pIdx < 0) continue;
          // Find the message index range for this activation
          const startMsgIdx = messages.findIndex((m) => m.lineIndex >= act.startLine);
          const endMsgIdx = messages.findIndex((m) => m.lineIndex >= act.endLine);
          if (startMsgIdx < 0) continue;
          const cx = actorCenterX(pIdx);
          const y1 = msgStartY + startMsgIdx * rowHeight;
          const y2 = endMsgIdx >= 0 ? msgStartY + endMsgIdx * rowHeight : y1 + rowHeight;
          const actRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          actRect.setAttribute("x", cx - 6);
          actRect.setAttribute("y", y1 - 4);
          actRect.setAttribute("width", "12");
          actRect.setAttribute("height", Math.max(y2 - y1 + 8, 16));
          actRect.setAttribute("rx", "2");
          actRect.setAttribute("fill", "var(--accent-soft, rgba(37,99,235,0.08))");
          actRect.setAttribute("stroke", "var(--border, #d1d5db)");
          actRect.setAttribute("stroke-width", "1");
          actRect.classList.add("mf-seq-activation");
          svg.appendChild(actRect);
        }

        // Draw message arrows
        for (let mi = 0; mi < messages.length; mi++) {
          const m = messages[mi];
          const srcIdx = participants.findIndex((p) => p.id === m.source);
          const tgtIdx = participants.findIndex((p) => p.id === m.target);
          if (srcIdx < 0 || tgtIdx < 0) continue;

          const y = msgStartY + mi * rowHeight + rowHeight / 2;
          const srcX = actorCenterX(srcIdx);
          const tgtX = actorCenterX(tgtIdx);
          const isSelf = srcIdx === tgtIdx;

          const arrow = m.arrowType || "->>";
          const isDashed = arrow.startsWith("--");
          const isX = arrow.endsWith("x");
          const isAsync = arrow.endsWith(")");
          const isFilled = arrow.endsWith(">>");
          const isOpen = arrow.endsWith(">") && !isFilled;

          if (isSelf) {
            // Self-message: loop to the right and back
            const loopW = 36;
            const loopH = 24;
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", "M" + srcX + "," + y + " H" + (srcX + loopW) + " V" + (y + loopH) + " H" + srcX);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", "var(--ink, #333)");
            path.setAttribute("stroke-width", "1.5");
            if (isDashed) path.setAttribute("stroke-dasharray", "6,3");
            path.setAttribute("marker-end", isX ? "url(#mf-seq-arrow-x)" : isFilled ? "url(#mf-seq-arrow-filled-rev)" : "url(#mf-seq-arrow-open)");
            svg.appendChild(path);
          } else {
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", srcX);
            line.setAttribute("y1", y);
            line.setAttribute("x2", tgtX);
            line.setAttribute("y2", y);
            line.setAttribute("stroke", "var(--ink, #333)");
            line.setAttribute("stroke-width", "1.5");
            if (isDashed) line.setAttribute("stroke-dasharray", "6,3");
            if (isX) {
              line.setAttribute("marker-end", "url(#mf-seq-arrow-x)");
            } else if (isFilled) {
              line.setAttribute("marker-end", "url(#mf-seq-arrow-filled)");
            } else {
              line.setAttribute("marker-end", "url(#mf-seq-arrow-open)");
            }
            svg.appendChild(line);
          }

          // Message label with background
          if (m.text) {
            const labelX = isSelf ? srcX + 40 : (srcX + tgtX) / 2;
            const labelY = isSelf ? y + 6 : y - 10;
            const labelBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            labelBg.setAttribute("rx", "2");
            labelBg.setAttribute("fill", "var(--panel, #ffffff)");
            labelBg.classList.add("mf-seq-msg-label-bg");
            svg.appendChild(labelBg);
            const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            textEl.setAttribute("x", labelX);
            textEl.setAttribute("y", labelY);
            textEl.setAttribute("text-anchor", isSelf ? "start" : "middle");
            textEl.setAttribute("font-size", "12");
            textEl.setAttribute("font-weight", "400");
            textEl.setAttribute("fill", "var(--ink, #333)");
            textEl.setAttribute("font-family", '"Manrope", system-ui, sans-serif');
            textEl.classList.add("mf-seq-msg-label");
            textEl.textContent = m.text;
            svg.appendChild(textEl);
            labelPairs.push({ bg: labelBg, text: textEl });
          }
        }

        // Block overlays skipped — structure is visible in the code editor.
        // Only render divider lines (else/and) as subtle horizontal dashes.
        for (const block of (blocks || [])) {
          if (!block.dividers || !block.dividers.length) continue;
          for (const div of block.dividers) {
            const divMsgIdx = messages.findIndex((m) => m.lineIndex > div.lineIndex);
            if (divMsgIdx < 0) continue;
            const divY = msgStartY + divMsgIdx * rowHeight - 12;
            const divLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
            divLine.setAttribute("x1", MARGIN);
            divLine.setAttribute("y1", divY);
            divLine.setAttribute("x2", totalWidth - MARGIN);
            divLine.setAttribute("y2", divY);
            divLine.setAttribute("stroke", "var(--border, #e5e7eb)");
            divLine.setAttribute("stroke-dasharray", "4,3");
            svg.appendChild(divLine);
          }
        }

        // Draw notes
        for (const note of notes) {
          // Position note near the relevant actor(s)
          const actorIdxs = note.actors.map((a) => participants.findIndex((p) => p.id === a || p.label === a)).filter((i) => i >= 0);
          if (!actorIdxs.length) continue;
          const minX = Math.min(...actorIdxs.map((i) => actorCenterX(i)));
          const maxX = Math.max(...actorIdxs.map((i) => actorCenterX(i)));
          // Find approximate Y from line index
          const noteMsgIdx = messages.findIndex((m) => m.lineIndex > note.lineIndex);
          const noteY = noteMsgIdx >= 0 ? msgStartY + noteMsgIdx * rowHeight - 6 : msgStartY + messages.length * rowHeight;
          const noteW = Math.max(maxX - minX + 60, 80);
          const noteX = (minX + maxX) / 2 - noteW / 2;
          const noteRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          noteRect.setAttribute("x", noteX);
          noteRect.setAttribute("y", noteY);
          noteRect.setAttribute("width", noteW);
          noteRect.setAttribute("height", "24");
          noteRect.setAttribute("rx", "3");
          noteRect.setAttribute("fill", "var(--note-bg, #fefce8)");
          noteRect.setAttribute("stroke", "var(--note-border, #fde68a)");
          noteRect.setAttribute("stroke-width", "0.5");
          svg.appendChild(noteRect);
          const noteText = document.createElementNS("http://www.w3.org/2000/svg", "text");
          noteText.setAttribute("x", noteX + noteW / 2);
          noteText.setAttribute("y", noteY + 16);
          noteText.setAttribute("text-anchor", "middle");
          noteText.setAttribute("font-size", "11");
          noteText.setAttribute("fill", "var(--ink, #333)");
          noteText.setAttribute("font-family", '"Manrope", system-ui, sans-serif');
          noteText.textContent = note.text;
          svg.appendChild(noteText);
        }

        container.appendChild(svg);

        // === Actor header boxes (HTML, positioned absolutely above lifelines) ===
        const actorPositions = [];
        for (let pi = 0; pi < participants.length; pi++) {
          const p = participants[pi];
          const cx = actorCenterX(pi);
          actorPositions.push({ id: p.id, cx });

          // Top actor box
          const topBox = document.createElement("div");
          topBox.className = "mf-seq-actor" + (p.type === "actor" ? " mf-seq-actor-person" : "");
          topBox.setAttribute("data-participant-id", p.id);
          topBox.style.left = (cx - colWidths[pi] / 2 + 8) + "px";
          topBox.style.top = "0";
          topBox.style.width = (colWidths[pi] - 16) + "px";
          topBox.style.position = "absolute";

          if (p.type === "actor") {
            const icon = document.createElement("div");
            icon.className = "mf-seq-actor-icon";
            icon.innerHTML = '<svg width="16" height="20" viewBox="0 0 20 24"><circle cx="10" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="9" x2="10" y2="17" stroke="currentColor" stroke-width="1.5"/><line x1="3" y1="13" x2="17" y2="13" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="17" x2="4" y2="23" stroke="currentColor" stroke-width="1.5"/><line x1="10" y1="17" x2="16" y2="23" stroke="currentColor" stroke-width="1.5"/></svg>';
            topBox.appendChild(icon);
          }

          const label = document.createElement("div");
          label.className = "mf-seq-actor-label";
          label.textContent = p.label || p.id;
          topBox.appendChild(label);

          // Event listeners
          topBox.addEventListener("click", (e) => {
            e.stopPropagation();
            container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
            topBox.classList.add("mf-selected");
            // Also highlight bottom box
            const bottomMatch = container.querySelector('.mf-seq-actor-bottom[data-participant-id="' + CSS.escape(p.id) + '"]');
            if (bottomMatch) bottomMatch.classList.add("mf-selected");
            send("element:selected", { elementType: "node", nodeId: p.id, label: p.label || p.id });
          });
          topBox.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            send("element:context", { elementType: "node", nodeId: p.id, label: p.label || p.id, pointerX: e.clientX, pointerY: e.clientY });
          });

          // Drag to reorder
          let dragStartX = 0, dragOrigLeft = 0, isDragging = false;
          topBox.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            dragStartX = e.clientX;
            dragOrigLeft = parseFloat(topBox.style.left);
            isDragging = false;
            topBox.setPointerCapture(e.pointerId);
            topBox.style.zIndex = "10";
            topBox.style.cursor = "grabbing";
          });
          topBox.addEventListener("pointermove", (e) => {
            if (!topBox.hasPointerCapture(e.pointerId)) return;
            const dx = e.clientX - dragStartX;
            if (Math.abs(dx) > 4) isDragging = true;
            if (isDragging) {
              topBox.style.left = (dragOrigLeft + dx) + "px";
              topBox.classList.add("mf-seq-actor-dragging");
              // Highlight drop position
              const currentCx = dragOrigLeft + dx + (colWidths[pi] - 16) / 2;
              let newIdx = 0;
              for (let i = 0; i < actorPositions.length; i++) {
                if (currentCx > actorPositions[i].cx) newIdx = i + 1;
              }
              container.querySelectorAll(".mf-seq-drop-indicator").forEach((el) => el.remove());
              const indicator = document.createElement("div");
              indicator.className = "mf-seq-drop-indicator";
              const prevIdx = Math.min(newIdx - 1, actorPositions.length - 1);
              const dropX = newIdx === 0 ? MARGIN : (colOffsets[prevIdx + 1] - 1);
              indicator.style.left = dropX + "px";
              indicator.style.top = "0";
              indicator.style.height = totalHeight + "px";
              container.appendChild(indicator);
            }
          });
          topBox.addEventListener("pointerup", (e) => {
            if (!topBox.hasPointerCapture(e.pointerId)) return;
            topBox.releasePointerCapture(e.pointerId);
            topBox.style.zIndex = "";
            topBox.style.cursor = "";
            topBox.classList.remove("mf-seq-actor-dragging");
            container.querySelectorAll(".mf-seq-drop-indicator").forEach((el) => el.remove());
            if (isDragging) {
              const dx = e.clientX - dragStartX;
              const currentCx = dragOrigLeft + dx + (colWidths[pi] - 16) / 2;
              let newIdx = 0;
              for (let i = 0; i < actorPositions.length; i++) {
                if (currentCx > actorPositions[i].cx) newIdx = i + 1;
              }
              // Adjust: if dragged right past own position, subtract 1
              const currentIdx = participants.findIndex((pp) => pp.id === p.id);
              if (newIdx > currentIdx) newIdx = Math.max(0, newIdx - 1);
              if (newIdx !== currentIdx) {
                send("seq:reorder", { participantId: p.id, newIndex: newIdx });
              } else {
                topBox.style.left = dragOrigLeft + "px";
              }
            }
            isDragging = false;
          });

          container.appendChild(topBox);

          // Bottom actor box (mirror)
          const bottomBox = document.createElement("div");
          bottomBox.className = "mf-seq-actor mf-seq-actor-bottom" + (p.type === "actor" ? " mf-seq-actor-person" : "");
          bottomBox.setAttribute("data-participant-id", p.id);
          bottomBox.style.left = (cx - colWidths[pi] / 2 + 8) + "px";
          bottomBox.style.top = (totalHeight - actorHeight) + "px";
          bottomBox.style.width = (colWidths[pi] - 16) + "px";
          bottomBox.style.position = "absolute";
          const bottomLabel = document.createElement("div");
          bottomLabel.className = "mf-seq-actor-label";
          bottomLabel.textContent = p.label || p.id;
          bottomBox.appendChild(bottomLabel);
          bottomBox.addEventListener("click", (e) => {
            e.stopPropagation();
            container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
            topBox.classList.add("mf-selected");
            bottomBox.classList.add("mf-selected");
            send("element:selected", { elementType: "node", nodeId: p.id, label: p.label || p.id });
          });
          container.appendChild(bottomBox);
        }

        // === Clickable message hit areas (HTML overlays) ===
        for (let mi = 0; mi < messages.length; mi++) {
          const m = messages[mi];
          const srcIdx = participants.findIndex((p) => p.id === m.source);
          const tgtIdx = participants.findIndex((p) => p.id === m.target);
          if (srcIdx < 0 || tgtIdx < 0) continue;

          const y = msgStartY + mi * rowHeight + rowHeight / 2;
          const srcX = actorCenterX(srcIdx);
          const tgtX = actorCenterX(tgtIdx);
          const isSelf = srcIdx === tgtIdx;

          const hitArea = document.createElement("div");
          hitArea.className = "mf-seq-message";
          hitArea.setAttribute("data-message-index", mi);
          hitArea.setAttribute("data-msg-source", m.source);
          hitArea.setAttribute("data-msg-target", m.target);
          const minX = isSelf ? srcX : Math.min(srcX, tgtX);
          const maxX = isSelf ? srcX + 50 : Math.max(srcX, tgtX);
          hitArea.style.left = (minX - 4) + "px";
          hitArea.style.top = (y - 16) + "px";
          hitArea.style.width = (maxX - minX + 8) + "px";
          hitArea.style.height = (isSelf ? 36 : 32) + "px";
          hitArea.style.position = "absolute";

          hitArea.addEventListener("click", (e) => {
            e.stopPropagation();
            container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
            hitArea.classList.add("mf-selected");
            send("element:selected", { elementType: "edge", edgeSource: m.source, edgeTarget: m.target, messageIndex: mi, label: m.text || "" });
          });
          hitArea.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            send("element:context", { elementType: "edge", edgeSource: m.source, edgeTarget: m.target, messageIndex: mi, label: m.text || "", arrowType: m.arrowType || "->>", pointerX: e.clientX, pointerY: e.clientY });
          });
          container.appendChild(hitArea);
        }

        // === Connect mode listener ===
        let seqConnectMode = null;
        window.addEventListener("message", (e) => {
          if (!e.data || e.data.channel !== "${CHANNEL}") return;
          if (e.data.type === "mode:connect") {
            seqConnectMode = e.data.payload || {};
            container.style.cursor = "crosshair";
            // Highlight source actor
            const srcEl = container.querySelector('.mf-seq-actor[data-participant-id="' + CSS.escape(seqConnectMode.sourceId) + '"]');
            if (srcEl) srcEl.classList.add("mf-seq-connect-source");
          }
          if (e.data.type === "mode:normal") {
            seqConnectMode = null;
            container.style.cursor = "";
            container.querySelectorAll(".mf-seq-connect-source").forEach((el) => el.classList.remove("mf-seq-connect-source"));
          }
        });

        // Actor click in connect mode
        container.querySelectorAll(".mf-seq-actor").forEach((actorEl) => {
          actorEl.addEventListener("click", (e) => {
            if (!seqConnectMode) return;
            const targetId = actorEl.getAttribute("data-participant-id");
            if (targetId && targetId !== seqConnectMode.sourceId) {
              send("connect:complete", { sourceId: seqConnectMode.sourceId, targetId });
              seqConnectMode = null;
              container.style.cursor = "";
              container.querySelectorAll(".mf-seq-connect-source").forEach((el) => el.classList.remove("mf-seq-connect-source"));
            }
          });
        });

        // Deselect on background click
        container.addEventListener("click", (e) => {
          if (e.target === container) {
            container.querySelectorAll(".mf-selected").forEach((el) => el.classList.remove("mf-selected"));
            send("element:selected", null);
          }
        });
        container.addEventListener("contextmenu", (e) => {
          if (e.target === container) {
            e.preventDefault();
            send("element:context", { elementType: "canvas", pointerX: e.clientX, pointerY: e.clientY });
          }
        });

        canvas.appendChild(container);

        // Deferred getBBox pass — size label backgrounds after DOM attachment
        for (const pair of labelPairs) {
          try {
            const bb = pair.text.getBBox();
            const px = pair.padX || 6;
            const py = pair.padY || 2;
            pair.bg.setAttribute("x", bb.x - px);
            pair.bg.setAttribute("y", bb.y - py);
            pair.bg.setAttribute("width", bb.width + px * 2);
            pair.bg.setAttribute("height", bb.height + py * 2);
          } catch (e) { /* getBBox unavailable */ }
        }
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
        // Custom flowchart: apply to HTML nodes
        const flowContainer = canvas.querySelector(".mf-flow-container");
        if (flowContainer) {
          for (const [nodeId, style] of Object.entries(styleOverrides)) {
            const el = flowContainer.querySelector('[data-node-id="' + CSS.escape(nodeId) + '"]');
            if (!el) continue;
            if (style.fill) el.style.background = style.fill;
            if (style.stroke) {
              el.style.borderColor = style.stroke;
              el.style.setProperty("--node-stroke", style.stroke);
              const borderLayer = el.querySelector(".mf-flow-border-layer");
              if (borderLayer) borderLayer.style.background = style.stroke;
            }
            if (style.textColor) {
              el.style.color = style.textColor;
              el.querySelectorAll(".mf-label-line").forEach(s => { s.style.color = style.textColor; });
            }
            if (style.strokeStyle === "dashed") el.style.borderStyle = "dashed";
            else if (style.strokeStyle === "solid") el.style.borderStyle = "solid";
            else if (style.strokeStyle === "none") el.style.borderColor = "transparent";
          }
          return;
        }
        // Custom ER diagram: apply to HTML entity cards
        const erContainer = canvas.querySelector(".mf-er-container");
        if (erContainer) {
          for (const [nodeId, style] of Object.entries(styleOverrides)) {
            const el = erContainer.querySelector('[data-node-id="' + CSS.escape(nodeId) + '"]');
            if (!el) continue;
            if (style.fill) el.style.background = style.fill;
            if (style.stroke) {
              el.style.borderColor = style.stroke;
              const header = el.querySelector(".mf-er-header");
              if (header) header.style.background = style.stroke;
            }
            if (style.textColor) el.style.color = style.textColor;
            if (style.strokeStyle === "dashed") el.style.borderStyle = "dashed";
            else if (style.strokeStyle === "solid") el.style.borderStyle = "solid";
            else if (style.strokeStyle === "none") el.style.borderColor = "transparent";
          }
          return;
        }
        // SVG diagrams: apply to SVG elements
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
        queueGanttOverlaySync();
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
      wrap.addEventListener("wheel", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        // For Gantt charts, delegate zoom to parent (adjusts time density, not CSS scale)
        if (currentDiagramType.toLowerCase().includes("gantt")) {
          const delta = e.deltaY > 0 ? -0.2 : 0.2;
          send("gantt:zoom", { delta });
          return;
        }
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
      wrap.addEventListener("scroll", queueGanttOverlaySync, { passive: true });

      wrap.addEventListener("dblclick", (e) => {
        // Only reset if double-clicking on background, not on SVG elements
        if (e.target === wrap || e.target === canvas) {
          zoomLevel = 1; panX = 0; panY = 0;
          applyCanvasTransform();
        }
      });
      if (supportsHover) {
        wrap.addEventListener("pointerenter", () => {
          ganttInsertLayerVisible = true;
          syncGanttInsertLayerVisibility();
        });
        wrap.addEventListener("pointerleave", () => {
          ganttInsertLayerVisible = false;
          syncGanttInsertLayerVisibility();
        });
      }

      const annotateGanttBars = (tasks, showDates, scale = "week") => {
        const svg = canvas.querySelector("svg");
        if (!svg) return;
        svg.querySelectorAll(".mf-date-tspan").forEach(el => el.remove());
        svg.querySelectorAll(".mf-overdue-dot").forEach(el => el.remove());
        svg.querySelectorAll(".mf-tooltip").forEach(el => el.remove());
        svg.querySelectorAll(".mf-gantt-insert-layer").forEach(el => el.remove());
        svg.querySelectorAll(".mf-task-clip-defs").forEach(el => el.remove());

        const texts = Array.from(svg.querySelectorAll(TASK_TEXT_SEL));
        const rects = Array.from(svg.querySelectorAll("rect")).filter(r => /\\btask\\b/.test(r.className?.baseVal || ""));
        const today = new Date().toISOString().slice(0, 10);
        const insertAnchors = [];
        const taskVisuals = [];
        const svgWidth = svg.getBoundingClientRect?.().width || 0;
        const compactMode = svgWidth > 0 && svgWidth < 860;
        const dayMs = 24 * 60 * 60 * 1000;

        const isoToMs = (iso) => {
          if (!iso || !/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)) return null;
          const value = Date.parse(iso + "T00:00:00Z");
          return Number.isFinite(value) ? value : null;
        };

        const datedSpans = tasks
          .map((t) => {
            const startIso = t.startDate || "";
            const endIso = t.endDate || t.computedEnd || "";
            const startMs = isoToMs(startIso);
            const endMs = isoToMs(endIso || startIso);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
            return {
              start: Math.min(startMs, endMs),
              end: Math.max(startMs, endMs),
            };
          })
          .filter(Boolean);

        if (datedSpans.length) {
          const minStart = Math.min(...datedSpans.map((s) => s.start));
          const maxEnd = Math.max(...datedSpans.map((s) => s.end));
          const daySpan = Math.max(1, Math.floor((maxEnd - minStart) / dayMs) + 1);
          // Weekly mode is default and denser; monthly is the densest.
          const target = scale === "month" ? 1200 : 1800;
          const minPerDay = scale === "month" ? 8 : 12;
          const maxPerDay = scale === "month" ? 16 : 28;
          const pixelsPerDay = Math.max(minPerDay, Math.min(maxPerDay, Math.round(target / daySpan)));
          const preferredWidth = daySpan * pixelsPerDay + 540;
          const minFloor = scale === "month" ? 1200 : 1400;
          const minWidth = Math.max(minFloor, Math.min(9000, Math.round(preferredWidth)));
          svg.style.width = "max-content";
          svg.style.minWidth = minWidth + "px";
          svg.style.maxWidth = "none";
          svg.style.height = "auto";
          canvas.style.justifyContent = "flex-start";
        }

        // With fixed left role column, hide Mermaid section labels/backdrops to avoid duplication.
        svg.querySelectorAll("text.sectionTitle, .sectionTitle, rect.section0, rect.section1, rect.section2, rect.section3").forEach((el) => {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
        });

        const viewBox = svg.viewBox?.baseVal;
        const viewRight = viewBox ? viewBox.x + viewBox.width : Number.POSITIVE_INFINITY;

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
          const tokens = t.statusTokens || [];
          const isDone = tokens.includes("done");
          const isOverdue = endDate && !isDone && endDate < today;
          let isDarkBar = tokens.some((s) => s === "done" || s === "crit" || s === "activeCrit" || s === "doneCrit");

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
            isDarkBar = isDarkFill(rectEl) || isDarkBar;
            const rectBox = rectEl.getBBox();
            if (textEl) {
              const leftPad = Math.max(7, Math.min(14, rectBox.height * 0.34));
              const textColor = isDarkBar ? "#f8fafc" : "#0f172a";
              const availableWidth = Math.max(8, rectBox.width - leftPad - 8);
              const fullLabel = t.label || textEl.textContent || "";
              textEl.textContent = fullLabel;
              const labelWidth = textEl.getComputedTextLength ? textEl.getComputedTextLength() : textEl.getBBox().width;
              const outsidePad = 8;
              const drawOutside = labelWidth > availableWidth;
              const rightSpace = viewRight - (rectBox.x + rectBox.width);
              const drawOutsideRight = drawOutside && rightSpace >= labelWidth + outsidePad;

              textEl.setAttribute("x", String(drawOutside
                ? (drawOutsideRight ? rectBox.x + rectBox.width + outsidePad : rectBox.x - outsidePad)
                : rectBox.x + leftPad));
              textEl.setAttribute("y", String(rectBox.y + rectBox.height / 2));
              textEl.setAttribute("text-anchor", drawOutside ? (drawOutsideRight ? "start" : "end") : "start");
              textEl.setAttribute("dominant-baseline", "central");
              textEl.setAttribute("alignment-baseline", "middle");
              textEl.setAttribute("fill", drawOutside ? "#0f172a" : textColor);
              textEl.style.paintOrder = drawOutside ? "stroke" : "normal";
              textEl.style.stroke = drawOutside ? "rgba(248,250,252,0.95)" : "none";
              textEl.style.strokeWidth = drawOutside ? "3" : "0";
              textEl.removeAttribute("clip-path");
            }

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
            if (t.link) tip += "\\nLink: " + t.link;
            rectEl.setAttribute("data-mf-tip", tip);
            // Store task metadata for live drag tooltip
            if (t.startDate) rectEl.setAttribute("data-mf-start", t.startDate);
            if (endDate) rectEl.setAttribute("data-mf-end", endDate);
            if (t.durationDays) rectEl.setAttribute("data-mf-days", String(t.durationDays));
            // Also set on text element so tooltip works when hovering labels
            if (textEl) textEl.setAttribute("data-mf-tip", tip);

            if (isOverdue) {
              const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
              dot.setAttribute("class", "mf-overdue-dot");
              dot.setAttribute("cx", String(rectBox.x - 8));
              dot.setAttribute("cy", String(rectBox.y + rectBox.height / 2));
              dot.setAttribute("r", "4");
              dot.setAttribute("fill", "#dc2626");
              rectEl.parentElement.appendChild(dot);
            }

            taskVisuals.push({
              section: t.section || "",
              rectEl,
              startMs: isoToMs(t.startDate || ""),
              endMs: isoToMs(endDate || t.startDate || ""),
            });
            insertAnchors.push({ label: t.label, rectEl });
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
          tspan.setAttribute("fill", isDarkBar ? "rgba(255,255,255,0.76)" : "#64748b");
          tspan.setAttribute("font-size", "0.74em");
          tspan.setAttribute("font-weight", "400");
          tspan.textContent = " (" + dateStr + ")";
          textEl.appendChild(tspan);

          if (!rectEl) return;

          const rectBox = rectEl.getBBox();
          const leftPad = Math.max(7, Math.min(14, rectBox.height * 0.34));
          const availableWidth = Math.max(8, rectBox.width - leftPad - 8);
          const textLength = textEl.getComputedTextLength ? textEl.getComputedTextLength() : textEl.getBBox().width;
          // Keep date metadata only when there is enough room in the bar.
          if (textLength > availableWidth && textEl.querySelector(".mf-date-tspan")) {
            textEl.querySelectorAll(".mf-date-tspan").forEach((el) => el.remove());
          }
        });

        buildGanttOverlay(taskVisuals, scale);

        if (!insertAnchors.length) return;
        const controlsLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
        controlsLayer.setAttribute("class", "mf-gantt-insert-layer");
        controlsLayer.style.transition = "opacity 140ms ease";
        svg.appendChild(controlsLayer);
        syncGanttInsertLayerVisibility();

        const maxRight = insertAnchors.reduce((max, anchor) => {
          const box = anchor.rectEl.getBBox();
          return Math.max(max, box.x + box.width);
        }, 0);
        const rightBound = viewBox?.width ? viewBox.x + viewBox.width - (compactMode ? 10 : 12) : maxRight + 18;
        const iconRadius = compactMode ? 6 : 7;
        const iconFontSize = compactMode ? 11 : 12;
        const iconOffset = compactMode ? 10 : 14;
        const minGapY = compactMode ? 12 : 16;
        const desiredX = maxRight + iconOffset;
        const iconX = Math.min(desiredX, rightBound);

        insertAnchors.forEach((anchor, index) => {
          const currentBox = anchor.rectEl.getBBox();
          const nextAnchor = insertAnchors[index + 1];
          const nextTop = nextAnchor ? nextAnchor.rectEl.getBBox().y : currentBox.y + currentBox.height + 28;
          const currentBottom = currentBox.y + currentBox.height;
          const gapMid = currentBottom + Math.max(minGapY, (nextTop - currentBottom) / 2);

          const btn = document.createElementNS("http://www.w3.org/2000/svg", "g");
          btn.setAttribute("class", "mf-gantt-insert-btn");
          btn.setAttribute("transform", "translate(" + iconX + " " + gapMid + ")");
          btn.setAttribute("cursor", "pointer");
          btn.setAttribute("opacity", compactMode ? "0.2" : "0.26");

          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("r", String(iconRadius));
          circle.setAttribute("fill", "rgba(255,255,255,0.72)");
          circle.setAttribute("stroke", "#d5dbe8");
          circle.setAttribute("stroke-width", "1");

          const plus = document.createElementNS("http://www.w3.org/2000/svg", "text");
          plus.setAttribute("text-anchor", "middle");
          plus.setAttribute("dominant-baseline", "central");
          plus.setAttribute("fill", "#a3b0c4");
          plus.setAttribute("font-size", String(iconFontSize));
          plus.setAttribute("font-weight", "600");
          plus.textContent = "+";

          btn.appendChild(circle);
          btn.appendChild(plus);
          controlsLayer.appendChild(btn);

          btn.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            send("gantt:add-between", { afterLabel: anchor.label });
          });
          btn.addEventListener("mouseenter", () => {
            btn.setAttribute("opacity", "0.72");
            circle.setAttribute("fill", "#ffffff");
            circle.setAttribute("stroke", "#93c5fd");
            plus.setAttribute("fill", "#3b82f6");
          });
          btn.addEventListener("mouseleave", () => {
            btn.setAttribute("opacity", compactMode ? "0.2" : "0.26");
            circle.setAttribute("fill", "rgba(255,255,255,0.72)");
            circle.setAttribute("stroke", "#d5dbe8");
            plus.setAttribute("fill", "#a3b0c4");
          });
        });
      };

      let ganttResizeRaf = 0;
      window.addEventListener("resize", () => {
        if (!lastGanttAnnotation.tasks.length) return;
        if (ganttResizeRaf) cancelAnimationFrame(ganttResizeRaf);
        ganttResizeRaf = requestAnimationFrame(() => {
          annotateGanttBars(lastGanttAnnotation.tasks, lastGanttAnnotation.showDates, lastGanttAnnotation.scale);
          ganttResizeRaf = 0;
        });
      });

      window.addEventListener("message", async (event) => {
        const data = event.data;
        if (!data || data.channel !== "${CHANNEL}") return;

        if (data.type === "gantt:annotate") {
          lastGanttAnnotation = {
            tasks: data.payload?.tasks || [],
            showDates: data.payload?.showDates !== false,
            scale: data.payload?.scale === "month" ? "month" : "week",
          };
          annotateGanttBars(lastGanttAnnotation.tasks, lastGanttAnnotation.showDates, lastGanttAnnotation.scale);
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

        if (data.type === "gantt:select") {
          const label = data.payload?.label || "";
          canvas.querySelectorAll(".mf-gantt-bar.mf-selected, .mf-gantt-milestone.mf-selected").forEach((el) => el.classList.remove("mf-selected"));
          if (label) {
            const bar = canvas.querySelector('.mf-gantt-bar[data-task-label="' + CSS.escape(label) + '"], .mf-gantt-milestone[data-task-label="' + CSS.escape(label) + '"]');
            if (bar) bar.classList.add("mf-selected");
          }
          return;
        }

        if (data.type === "set-app-theme") {
          document.documentElement.setAttribute("data-theme", data.payload?.theme || "light");
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
          const dtLower = (currentDiagramType || "").toLowerCase();
          const isGantt = dtLower.includes("gantt");
          const isFlowchart = dtLower.includes("flow") || dtLower === "graph";
          const isEr = dtLower.includes("er");

          if (isGantt) {
            // Custom HTML Gantt renderer — bypass Mermaid SVG
            const gd = data.payload?.ganttData || {};
            renderCustomGantt(gd.tasks || [], gd.scale || "week", gd.showDates !== false, gd.showGrid || false, gd.directives || {}, gd.compact || false, gd.ganttZoom || 1, gd.pinCategories !== false, gd.showCriticalPath || false, gd.showDepLines || false, gd.executiveView || false, gd.showRisks || false, gd.riskFlags || {}, gd.cycles || [], gd.baselineTasks || null, gd.assigneeFilterApplied || false);
            send("render:success", { diagramType: currentDiagramType, svg: "", isCustomGantt: true });
          } else if (isFlowchart) {
            // Custom HTML Flowchart renderer — bypass Mermaid SVG
            const fd = data.payload?.flowchartData || {};
            renderCustomFlowchart(fd.parsed || {}, fd.classDefs || [], fd.classAssignments || {}, fd.styleOverrides || {}, fd.styleDirectives || {});
            send("render:success", { diagramType: currentDiagramType, svg: "", isCustomFlowchart: true });
          } else if (isEr) {
            // Custom HTML ER Diagram renderer — bypass Mermaid SVG
            const ed = data.payload?.erData || {};
            renderCustomErDiagram(ed.parsed || { entities: [], relationships: [] }, ed.styleOverrides || {}, ed.layoutDirection || "LR");
            send("render:success", { diagramType: currentDiagramType, svg: "", isCustomEr: true });
          } else if (dtLower.includes("sequence")) {
            // Custom Sequence Diagram renderer
            const sd = data.payload?.sequenceData || {};
            renderCustomSequence(sd.participants || [], sd.messages || [], sd.blocks || [], sd.extras || {}, sd.swimlaneView || false);
            send("render:success", { diagramType: currentDiagramType, svg: "", isCustomSequence: true });
          } else if (dtLower.includes("state")) {
            // Custom HTML State Diagram renderer — bypass Mermaid SVG
            const sd = data.payload?.stateData || {};
            renderCustomStateDiagram(sd.parsed || {});
            send("render:success", { diagramType: currentDiagramType, svg: "", isCustomState: true });
          } else {
            setGanttMode(false);
            // Standard Mermaid SVG rendering
            const token = "diagram_" + Date.now();
            const { svg } = await mermaid.render(token, code);
            canvas.innerHTML = svg;

            const svgNode = canvas.querySelector("svg");
            if (svgNode) {
              clearGanttOverlay();
              svgNode.style.width = "";
              svgNode.style.minWidth = "";
              svgNode.style.maxWidth = "";
              svgNode.style.height = "";
              canvas.style.justifyContent = "center";
              wireSelection(svgNode);
            }
            send("render:success", { diagramType: parseResult?.diagramType || "", svg });
          }
        } catch (err) {
          setGanttMode(false);
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

const IconUndo = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="7 11 3 7 7 3" />
    <path d="M16 16v-5.5a3.5 3.5 0 00-3.5-3.5H3" />
  </svg>
);

const IconRedo = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="13 11 17 7 13 3" />
    <path d="M4 16v-5.5a3.5 3.5 0 013.5-3.5H17" />
  </svg>
);

/* ── URL params & embed helpers ────────────────────────── */
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    embed: params.get("embed") === "1",
    codeParam: params.get("code") || null,
    themeParam: params.get("theme") || null,
    typeParam: params.get("type") || null,
    editableParam: params.get("editable") !== "0", // default: editable
  };
}

function decodeCodeParam(encoded) {
  try {
    return decodeURIComponent(escape(atob(encoded)));
  } catch {
    return null;
  }
}

function encodeCodeParam(code) {
  return btoa(unescape(encodeURIComponent(code)));
}

const STORAGE_KEY = "mermaid-flow:diagrams";
const LAST_DIAGRAM_KEY = "mermaid-flow:last";

function loadSavedDiagrams() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDiagramToStorage(name, code) {
  const diagrams = loadSavedDiagrams();
  const existing = diagrams.findIndex((d) => d.name === name);
  const entry = { name, code, updatedAt: new Date().toISOString() };
  if (existing >= 0) diagrams[existing] = entry;
  else diagrams.unshift(entry);
  // Keep max 50 saved diagrams
  if (diagrams.length > 50) diagrams.length = 50;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(diagrams));
}

function deleteDiagramFromStorage(name) {
  const diagrams = loadSavedDiagrams().filter((d) => d.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(diagrams));
}

function saveLastDiagram(code, tabs, activeTabId) {
  try {
    if (tabs && tabs.length > 0) {
      localStorage.setItem(LAST_DIAGRAM_KEY, JSON.stringify({ code, tabs, activeTabId }));
    } else {
      localStorage.setItem(LAST_DIAGRAM_KEY, code);
    }
  } catch {}
}

function loadLastDiagram() {
  try {
    const raw = localStorage.getItem(LAST_DIAGRAM_KEY);
    if (!raw) return null;
    // Try parsing as JSON (new format with tabs)
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.code) return parsed;
    } catch {}
    // Fallback: plain string (old format)
    return raw;
  } catch { return null; }
}

/* ── Main App ─────────────────────────────────────────── */
function App() {
  const iframeRef = useRef(null);
  const editorRef = useRef(null);
  const exportMenuRef = useRef(null);
  const mobileActionsRef = useRef(null);
  const mobileViewMenuRef = useRef(null);
  const ganttViewMenuRef = useRef(null);
  const ganttAnalysisMenuRef = useRef(null);
  const ganttAssigneeMenuRef = useRef(null);

  // Undo/redo history
  const historyRef = useRef({ past: [], future: [] });
  const lastCommitTimeRef = useRef(0);
  const skipNextHistoryPushRef = useRef(false);
  const typingTimerRef = useRef(null);
  const pendingTypingSnapshotRef = useRef(null);

  // Router integration
  const params = useParams();
  const navigate = useNavigate();
  const flowId = params?.flowId || null;

  // Auth context
  const { user: currentUser } = useAuth();

  // URL params (read once on mount)
  const urlParams = useRef(getUrlParams());
  const isEmbed = urlParams.current.embed;
  const isEditable = urlParams.current.editableParam;

  // Resolve initial code: URL param > localStorage > default
  const lastDiagramData = useRef(loadLastDiagram());
  const initialCode = (() => {
    if (urlParams.current.codeParam) {
      const decoded = decodeCodeParam(urlParams.current.codeParam);
      if (decoded) return decoded;
    }
    const last = lastDiagramData.current;
    if (last && !urlParams.current.embed) {
      if (typeof last === "object" && last.tabs && last.tabs.length > 0) {
        // Restore the active tab's code (or first tab if activeTabId not found)
        const savedActiveId = last.activeTabId;
        const activeTab = savedActiveId && last.tabs.find((t) => t.id === savedActiveId);
        return activeTab ? activeTab.code : last.tabs[0].code;
      }
      if (typeof last === "object" && last.code) return last.code;
      return last;
    }
    return DEFAULT_CODE;
  })();

  // Theme mode (light / dark / system)
  const [themeMode, setThemeMode] = useState(getStoredTheme);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getStoredTheme() === "system") {
        const resolved = getResolvedTheme("system");
        document.documentElement.setAttribute("data-theme", resolved);
        setThemeMode("system"); // trigger re-render for icon
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Core state
  const [code, setCode] = useState(initialCode);
  const [theme, setTheme] = useState(urlParams.current.themeParam || "neo");
  const [flowMeta, setFlowMeta] = useState(null); // { name, projectId, sharing, etc. }
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  const [versionPanelOpen, setVersionPanelOpen] = useState(false);
  const [resourcePanelOpen, setResourcePanelOpen] = useState(false);
  const [notionSyncOpen, setNotionSyncOpen] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiChartType, setAiChartType] = useState("gantt");
  const [aiContext, setAiContext] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [convertTargetType, setConvertTargetType] = useState("flowchart");
  const [convertLoading, setConvertLoading] = useState(false);
  const [convertError, setConvertError] = useState("");
  const [aiPreview, setAiPreview] = useState(null); // { code, title, summary, source }
  const [aiPreviewOpen, setAiPreviewOpen] = useState(false);
  const [diagramTabs, setDiagramTabs] = useState(() => {
    const last = lastDiagramData.current;
    if (last && typeof last === "object" && last.tabs && last.tabs.length > 0 && !urlParams.current.embed && !urlParams.current.codeParam) {
      return last.tabs;
    }
    return [{ id: "tab-0", label: "Main", code: initialCode }];
  });
  const [activeTabId, setActiveTabId] = useState(() => {
    const last = lastDiagramData.current;
    if (last && typeof last === "object" && last.tabs && last.tabs.length > 0 && !urlParams.current.embed && !urlParams.current.codeParam) {
      // Restore the saved active tab, or fall back to first tab
      if (last.activeTabId && last.tabs.some((t) => t.id === last.activeTabId)) {
        return last.activeTabId;
      }
      return last.tabs[0].id;
    }
    return "tab-0";
  });
  const [renamingTabId, setRenamingTabId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [notionDbId, setNotionDbId] = useState("");
  const [notionToken, setNotionToken] = useState("");
  const [securityLevel, setSecurityLevel] = useState("strict");
  const [renderer, setRenderer] = useState("dagre");
  const [autoRender, setAutoRender] = useState(true);
  const [diagramType, setDiagramType] = useState("flowchart");
  const [renderSvg, setRenderSvg] = useState("");
  const [renderStatus, setRenderStatus] = useState("idle");
  const [renderMessage, setRenderMessage] = useState("");
  const [selectedElement, setSelectedElement] = useState(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState(new Set());
  const [multiNodePositions, setMultiNodePositions] = useState({});
  const [flowClipboard, setFlowClipboard] = useState(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [highlightLine, setHighlightLine] = useState(null);
  const [templateId, setTemplateId] = useState("flowchart");
  const [dragFeedback, setDragFeedback] = useState("");
  const [ganttDraft, setGanttDraft] = useState({
    label: "",
    startDate: "",
    endDate: "",
    status: [],
    isMilestone: false,
    assignee: "",
    notes: "",
    link: "",
    section: "",
    progress: "",
    dependsOn: [],
  });
  const [ganttDeleteConfirm, setGanttDeleteConfirm] = useState(null);
  const ganttDraftLockedRef = useRef(false);

  // UI state
  const [editorCollapsed, setEditorCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.location.pathname.startsWith("/flow/");
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileViewMenuOpen, setMobileViewMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentMode, setPresentMode] = useState(false);
  const [editorWidth, setEditorWidth] = useState(30);
  const initialPinCategories = !isMobileViewport();
  const [showDates, setShowDates] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [ganttScale, setGanttScale] = useState("week"); // "week" | "month"
  const [compactMode, setCompactMode] = useState(false);
  const [ganttZoom, setGanttZoom] = useState(1.0); // multiplier on pxPerDay for Gantt time density
  const [pinCategories, setPinCategories] = useState(initialPinCategories); // sticky Category/Phase column
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [showDepLines, setShowDepLines] = useState(false);
  const [executiveView, setExecutiveView] = useState(false); // filtered view: milestones, crit, overdue only
  const [showRisks, setShowRisks] = useState(false);
  const [selectedAssignees, setSelectedAssignees] = useState([]);
  const [assigneeFilterQuery, setAssigneeFilterQuery] = useState("");
  const [ganttDropdown, setGanttDropdown] = useState(null); // null | "view" | "analysis" | "assignees"
  const [showChainView, setShowChainView] = useState(false);
  const [sequenceSwimlaneView, setSequenceSwimlaneView] = useState(false);
  const [messageCreationForm, setMessageCreationForm] = useState(null);
  const toggleGanttDropdown = (name) => setGanttDropdown((prev) => prev === name ? null : name);
  const [stateDropdown, setStateDropdown] = useState(null); // null | "view" | "xstate"
  const [transitionLabelModal, setTransitionLabelModal] = useState(null); // { sourceId, targetId, label }
  const toggleStateDropdown = (name) => setStateDropdown((prev) => prev === name ? null : name);
  const [baselineCode, setBaselineCode] = useState(null);
  const [baselineSetAt, setBaselineSetAt] = useState(null);
  const [showBaseline, setShowBaseline] = useState(true);
  const lastSavedGanttViewStateRef = useRef("");

  // Interactive diagram state
  const [positionOverrides, setPositionOverrides] = useState({});
  const [styleOverrides, setStyleOverrides] = useState({}); // { [nodeId]: { fill?, stroke?, strokeStyle?, textColor? } }
  const [connectMode, setConnectMode] = useState(null);
  const [shapePickerNode, setShapePickerNode] = useState(null);
  const [edgeLabelEdit, setEdgeLabelEdit] = useState(null);
  const [nodeEditModal, setNodeEditModal] = useState(null); // { type: "node"|"edge", nodeId?, label, shape?, edgeSource?, edgeTarget?, arrowType? }
  const [nodeCreationForm, setNodeCreationForm] = useState(null); // { sourceNodeId, port, label, description }
  const [sqlImportOpen, setSqlImportOpen] = useState(false);
  const [sqlImportValue, setSqlImportValue] = useState("");
  const [sqlExportContent, setSqlExportContent] = useState(null);
  const [erLayoutDir, setErLayoutDir] = useState("LR"); // "LR" or "TB"
  const [zoomLevel, setZoomLevel] = useState(1);
  const [styleToolbar, setStyleToolbar] = useState(null); // { nodeId, x, y, yBottom, activeDropdown }
  const contextMenuRef = useRef(null);

  // Undo/redo button state + ref mirrors for stale-closure safety
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const codeRef = useRef(code);
  const positionOverridesRef = useRef(positionOverrides);
  const styleOverridesRef = useRef(styleOverrides);

  // Derived
  const srcDoc = useMemo(() => getIframeSrcDoc(), []);
  const lineCount = code.split("\n").length;
  const flowHeaderName = String(flowMeta?.name || "").trim();
  const toolsetKey = classifyDiagramType(diagramType);
  const activeTemplate = DIAGRAM_LIBRARY.find((entry) => entry.id === templateId);
  const ganttTasks = useMemo(() => parseGanttTasks(code), [code]);
  const criticalPathLabels = useMemo(() => {
    if (toolsetKey !== "gantt") return [];
    const resolved = resolveDependencies(ganttTasks.map((t) => ({ ...t })));
    const { criticalSet } = computeCriticalPath(resolved);
    // Order critical tasks by dependency chain
    const cpTasks = resolved.filter((t) => criticalSet.has(t.idToken || t.label || ""));
    const remaining = new Set(cpTasks.map((t) => t.label));
    const byLabel = new Map(cpTasks.map((t) => [t.label, t]));
    const ordered = [];
    while (remaining.size > 0) {
      let found = false;
      for (const label of remaining) {
        const task = byLabel.get(label);
        const depsInCp = (task.afterDeps || []).filter((d) => remaining.has(d) || ordered.includes(d));
        if (depsInCp.every((d) => ordered.includes(d))) {
          ordered.push(label);
          remaining.delete(label);
          found = true;
          break;
        }
      }
      if (!found && remaining.size > 0) {
        const label = Array.from(remaining)[0];
        ordered.push(label);
        remaining.delete(label);
      }
    }
    return ordered;
  }, [code, ganttTasks, toolsetKey]);
  const resolvedGanttTasks = useMemo(() => {
    if (toolsetKey !== "gantt") return [];
    const directives = parseGanttDirectives(code);
    const tasks = resolveDependencies(parseGanttTasks(code));
    return tasks.map((t) => {
      const effectiveStart = t.startDate || t.resolvedStartDate || "";
      let computedEnd = t.endDate || t.resolvedEndDate || "";
      if (!computedEnd && effectiveStart && t.durationDays) {
        computedEnd = directives.excludes.length
          ? addWorkingDays(effectiveStart, t.durationDays, directives.excludes, directives.weekend)
          : (() => {
              const d = new Date(effectiveStart + "T00:00:00Z");
              d.setUTCDate(d.getUTCDate() + t.durationDays);
              return d.toISOString().slice(0, 10);
            })();
      }
      return {
        label: t.label,
        startDate: effectiveStart,
        computedEnd,
        assignee: t.assignee || "",
        section: t.section || "",
      };
    });
  }, [code, toolsetKey]);
  const baselineTasks = useMemo(() => {
    if (!baselineCode) return null;
    const dirs = parseGanttDirectives(baselineCode);
    const raw = resolveDependencies(parseGanttTasks(baselineCode));
    return raw.map((t) => {
      const effectiveStart = t.startDate || t.resolvedStartDate || "";
      let computedEnd = t.endDate || t.resolvedEndDate || "";
      if (!computedEnd && effectiveStart && t.durationDays) {
        computedEnd = dirs.excludes.length
          ? addWorkingDays(effectiveStart, t.durationDays, dirs.excludes, dirs.weekend)
          : (() => {
              const d = new Date(effectiveStart + "T00:00:00Z");
              d.setUTCDate(d.getUTCDate() + t.durationDays);
              return d.toISOString().slice(0, 10);
            })();
      }
      return {
        label: t.label,
        startDate: effectiveStart,
        computedEnd,
        section: t.section || "",
        isMilestone: t.isMilestone || false,
        isVertMarker: t.isVertMarker || false,
      };
    });
  }, [baselineCode]);
  const ganttSections = useMemo(() => {
    const ordered = [];
    const seen = new Set();
    for (const section of getGanttSections(code)) {
      const name = String(section?.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(name);
    }
    for (const task of ganttTasks) {
      const name = String(task.section || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(name);
    }
    return ordered;
  }, [code, ganttTasks]);
  const ganttSectionOptions = useMemo(() => {
    const options = [...ganttSections];
    const selectedSection = String(ganttDraft.section || "").trim();
    if (
      selectedSection &&
      !options.some((section) => section.toLowerCase() === selectedSection.toLowerCase())
    ) {
      options.push(selectedSection);
    }
    return options;
  }, [ganttSections, ganttDraft.section]);
  const ganttViewState = useMemo(
    () => ({
      showDates,
      showGrid,
      ganttScale,
      pinCategories,
      showCriticalPath,
      showDepLines,
      executiveView,
      showRisks,
      showBaseline,
      selectedAssignees: normalizeAssigneeArray(selectedAssignees),
    }),
    [
      showDates,
      showGrid,
      ganttScale,
      pinCategories,
      showCriticalPath,
      showDepLines,
      executiveView,
      showRisks,
      showBaseline,
      selectedAssignees,
    ]
  );
  const allAssignees = useMemo(() => {
    const set = new Set();
    for (const t of ganttTasks) {
      if (!t.assignee) continue;
      for (const name of t.assignee.split(",")) {
        const trimmed = name.trim();
        if (trimmed) set.add(trimmed);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [ganttTasks]);
  const assigneeFilterOptions = useMemo(() => {
    const merged = [...allAssignees];
    for (const selected of selectedAssignees) {
      if (!merged.some((name) => name.toLowerCase() === selected.toLowerCase())) {
        merged.push(selected);
      }
    }
    return merged.sort((a, b) => a.localeCompare(b));
  }, [allAssignees, selectedAssignees]);
  const filteredAssigneeOptions = useMemo(() => {
    const query = assigneeFilterQuery.trim().toLowerCase();
    if (!query) return assigneeFilterOptions;
    return assigneeFilterOptions.filter((name) => name.toLowerCase().includes(query));
  }, [assigneeFilterOptions, assigneeFilterQuery]);
  const hasAssigneeFilter = selectedAssignees.length > 0;
  const flowchartData = useMemo(() => {
    if (toolsetKey === "flowchart") return parseFlowchart(code);
    return { direction: "TD", nodes: [], edges: [], subgraphs: [] };
  }, [code, toolsetKey]);
  const stateDiagramData = useMemo(() => {
    if (toolsetKey === "stateDiagram") return parseStateDiagramEnhanced(code);
    return { states: [], transitions: [], direction: "LR", hasInitial: false, hasFinal: false };
  }, [code, toolsetKey]);
  const selectedGanttTask = useMemo(
    () => findTaskByLabel(ganttTasks, selectedElement?.label || ""),
    [ganttTasks, selectedElement]
  );
  const mermaidRenderConfig = useMemo(
    () => ({
      theme,
      securityLevel,
      flowchart: { defaultRenderer: renderer },
      gantt: {
        barHeight: 32,
        barGap: 20,
        topPadding: 72,
        leftPadding: 156,
        rightPadding: 96,
        gridLineStartPadding: 210,
        fontSize: 14,
      },
    }),
    [theme, securityLevel, renderer]
  );
  const quickTools =
    DIAGRAM_LIBRARY.find((entry) => entry.id === toolsetKey)?.quickTools ||
    DIAGRAM_LIBRARY.find((entry) => entry.id === "flowchart")?.quickTools ||
    [];
  const logAppFirestoreError = (operation, err, context = {}) => {
    console.error(`[App] ${operation} failed`, {
      error: formatFirestoreError(err),
      code: err?.code || "unknown",
      context,
    });
  };

  const currentFlowRole = currentUser && flowMeta
    ? (flowMeta.ownerId === currentUser.uid ? "owner" : flowMeta.sharing?.[currentUser.uid] || null)
    : null;
  const hasPublicEditAccess = flowMeta?.publicAccess === "edit";
  const canEditCurrentFlow = currentFlowRole === "owner" || currentFlowRole === "edit" || hasPublicEditAccess;
  const hasPublicCommentAccess = ["comment", "edit"].includes(flowMeta?.publicAccess || "");
  const canCommentCurrentFlow = canEditCurrentFlow || currentFlowRole === "comment" || hasPublicCommentAccess;
  const toggleAssigneeFilter = (assignee) => {
    const target = String(assignee || "").trim();
    if (!target) return;
    setSelectedAssignees((prev) => {
      const normalized = normalizeAssigneeArray(prev);
      const idx = normalized.findIndex((name) => name.toLowerCase() === target.toLowerCase());
      if (idx >= 0) return normalized.filter((_, i) => i !== idx);
      return [...normalized, target];
    });
  };

  /* ── Undo / Redo engine ─────────────────────────────── */
  useEffect(() => { codeRef.current = code; }, [code]);
  useEffect(() => { positionOverridesRef.current = positionOverrides; }, [positionOverrides]);
  useEffect(() => { styleOverridesRef.current = styleOverrides; }, [styleOverrides]);

  const commitSnapshot = useCallback((snapCode, snapPos, snapStyle, opts = {}) => {
    if (skipNextHistoryPushRef.current) return;
    const now = Date.now();
    const history = historyRef.current;
    if (opts.dragBatch && history.past.length > 0 && (now - lastCommitTimeRef.current) < 500) {
      lastCommitTimeRef.current = now;
      return;
    }
    history.past.push({ code: snapCode, positionOverrides: snapPos, styleOverrides: snapStyle });
    if (history.past.length > 50) history.past.shift();
    history.future = [];
    lastCommitTimeRef.current = now;
    setCanUndo(history.past.length > 0);
    setCanRedo(false);
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current = { past: [], future: [] };
    setCanUndo(false);
    setCanRedo(false);
    pendingTypingSnapshotRef.current = null;
    clearTimeout(typingTimerRef.current);
  }, []);

  const handleUndo = useCallback(() => {
    const history = historyRef.current;
    if (history.past.length === 0) return;
    history.future.unshift({
      code: codeRef.current,
      positionOverrides: positionOverridesRef.current,
      styleOverrides: styleOverridesRef.current,
    });
    const snapshot = history.past.pop();
    skipNextHistoryPushRef.current = true;
    pendingTypingSnapshotRef.current = null;
    clearTimeout(typingTimerRef.current);
    setCode(snapshot.code);
    setPositionOverrides(snapshot.positionOverrides);
    setStyleOverrides(snapshot.styleOverrides);
    window.setTimeout(() => { skipNextHistoryPushRef.current = false; }, 0);
    setCanUndo(history.past.length > 0);
    setCanRedo(history.future.length > 0);
    window.requestAnimationFrame(() => {
      const frame = iframeRef.current;
      if (frame?.contentWindow) {
        frame.contentWindow.postMessage(
          { channel: CHANNEL, type: "apply:styles", payload: { overrides: snapshot.styleOverrides } },
          "*"
        );
      }
    });
  }, []);

  const handleRedo = useCallback(() => {
    const history = historyRef.current;
    if (history.future.length === 0) return;
    history.past.push({
      code: codeRef.current,
      positionOverrides: positionOverridesRef.current,
      styleOverrides: styleOverridesRef.current,
    });
    const snapshot = history.future.shift();
    skipNextHistoryPushRef.current = true;
    pendingTypingSnapshotRef.current = null;
    clearTimeout(typingTimerRef.current);
    setCode(snapshot.code);
    setPositionOverrides(snapshot.positionOverrides);
    setStyleOverrides(snapshot.styleOverrides);
    window.setTimeout(() => { skipNextHistoryPushRef.current = false; }, 0);
    setCanUndo(history.past.length > 0);
    setCanRedo(history.future.length > 0);
    window.requestAnimationFrame(() => {
      const frame = iframeRef.current;
      if (frame?.contentWindow) {
        frame.contentWindow.postMessage(
          { channel: CHANNEL, type: "apply:styles", payload: { overrides: snapshot.styleOverrides } },
          "*"
        );
      }
    });
  }, []);

  const commitSnapshotNow = useCallback((opts = {}) => {
    commitSnapshot(codeRef.current, positionOverridesRef.current, styleOverridesRef.current, opts);
  }, [commitSnapshot]);

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
        const result = { type: "node", nodeId, label: item.label || item.id || nodeId, shape: "rect", connections };
        if (item.type === "actor" || item.type === "participant") result.participantType = item.type;
        return result;
      }
    }
    return { type: "node", nodeId, label: nodeId, shape: "rect", connections };
  };

  /* ── Render ──────────────────────────────────────────── */
  const postRender = () => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;

    setRenderStatus("rendering");

    // Pre-compute gantt data so the iframe can render custom HTML gantt
    const directives = parseGanttDirectives(code);
    const tasks = resolveDependencies(parseGanttTasks(code));
    const { criticalSet, connectedSet, slackByTask } = computeCriticalPath(tasks);
    const cycles = detectCycles(tasks);
    const allConflicts = detectConflicts(tasks);
    const conflictsByTask = new Map();
    for (const c of allConflicts) {
      if (!conflictsByTask.has(c.taskLabel)) conflictsByTask.set(c.taskLabel, []);
      conflictsByTask.get(c.taskLabel).push(c);
    }
    const enrichedTasks = tasks.map((t) => {
      const effectiveStart = t.startDate || t.resolvedStartDate || "";
      let computedEnd = t.endDate || t.resolvedEndDate || "";
      if (!computedEnd && effectiveStart && t.durationDays) {
        computedEnd = directives.excludes.length
          ? addWorkingDays(effectiveStart, t.durationDays, directives.excludes, directives.weekend)
          : (() => {
              const d = new Date(effectiveStart + "T00:00:00Z");
              d.setUTCDate(d.getUTCDate() + t.durationDays);
              return d.toISOString().slice(0, 10);
            })();
      }
      const taskKey = t.idToken || t.label || "";
      return {
        label: t.label,
        startDate: effectiveStart,
        endDate: t.endDate,
        durationDays: t.durationDays,
        computedEnd,
        assignee: t.assignee || "",
        statusTokens: t.statusTokens || [],
        notes: t.notes || "",
        link: t.link || "",
        progress: t.progress != null ? t.progress : null,
        section: t.section || "",
        isMilestone: t.isMilestone || false,
        isVertMarker: t.isVertMarker || false,
        afterDeps: t.afterDeps || [],
        idToken: t.idToken || "",
        hasExplicitDate: t.hasExplicitDate,
        isCriticalPath: criticalSet.has(taskKey),
        isConnected: connectedSet ? connectedSet.has(taskKey) : false,
        slackDays: slackByTask.get(taskKey) || 0,
        conflicts: conflictsByTask.get(t.label) || [],
      };
    });
    const visibleTasks = filterTasksByAssignee(enrichedTasks, selectedAssignees);
    const ganttData = {
      tasks: visibleTasks,
      directives,
      scale: ganttScale,
      showDates,
      showGrid,
      compact: compactMode || directives.displayMode === "compact",
      ganttZoom,
      pinCategories,
      showCriticalPath,
      showDepLines,
      executiveView,
      showRisks,
      riskFlags: showRisks ? computeRiskFlags(visibleTasks) : {},
      cycles,
      baselineTasks: showBaseline ? baselineTasks : null,
      assigneeFilterApplied: selectedAssignees.length > 0,
    };

    // Pre-compute flowchart data so the iframe can render custom HTML flowchart
    const flowchartPayload = {
      parsed: parseFlowchart(code),
      classDefs: parseClassDefs(code),
      classAssignments: parseClassAssignments(code),
      styleDirectives: parseStyleDirectives(code),
      styleOverrides,
    };

    // Pre-compute ER data so the iframe can render custom HTML ER diagram
    const erPayload = {
      parsed: parseErDiagram(code),
      styleOverrides,
      layoutDirection: erLayoutDir,
    };

    // Pre-compute sequence data so the iframe can render custom sequence diagram
    const seqParsed = parseSequenceDiagram(code);
    const sequencePayload = {
      participants: seqParsed.participants,
      messages: seqParsed.messages,
      blocks: parseSequenceBlocks(code),
      extras: parseSequenceExtras(code),
      swimlaneView: sequenceSwimlaneView,
    };

    // Pre-compute state diagram data so the iframe can render custom HTML state diagram
    const statePayload = {
      parsed: parseStateDiagramEnhanced(code),
    };

    frame.contentWindow.postMessage(
      {
        channel: CHANNEL,
        type: "render",
        payload: {
          code,
          config: mermaidRenderConfig,
          ganttData,
          flowchartData: flowchartPayload,
          erData: erPayload,
          sequenceData: sequencePayload,
          stateData: statePayload,
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
  }, [code, autoRender, mermaidRenderConfig, showCriticalPath, showDepLines, erLayoutDir, sequenceSwimlaneView]);

  /* ── Sync app theme to iframe ─────────────────────────── */
  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    const resolved = getResolvedTheme(themeMode);
    frame.contentWindow.postMessage(
      { channel: CHANNEL, type: "set-app-theme", payload: { theme: resolved } },
      "*"
    );
  }, [themeMode]);

  /* ── Load user's Notion settings when sync panel opens ── */
  useEffect(() => {
    if (!ENABLE_NOTION_INTEGRATION) return;
    if (!notionSyncOpen || !currentUser) return;
    (async () => {
      try {
        const settings = await getUserSettings(currentUser.uid);
        const notion = settings.notion || {};
        if (notion.apiKey && !notionToken) setNotionToken(notion.apiKey);
        if (notion.defaultDatabaseId && !notionDbId) setNotionDbId(notion.defaultDatabaseId);
      } catch {}
    })();
  }, [notionSyncOpen, currentUser]);

  /* ── Load flow from Firestore ────────────────────────── */
  const flowLoadedRef = useRef(false);
  const lastVersionSaveRef = useRef(0);
  const lastVersionCodeRef = useRef("");
  useEffect(() => {
    if (!flowId) {
      lastSavedGanttViewStateRef.current = "";
      return;
    }
    flowLoadedRef.current = false;
    lastSavedGanttViewStateRef.current = "";
    (async () => {
      try {
        const flow = await getFlow(flowId);
        if (flow) {
          const defaultViewState = {
            showDates: true,
            showGrid: false,
            ganttScale: "week",
            pinCategories: initialPinCategories,
            showCriticalPath: false,
            showDepLines: false,
            executiveView: false,
            showRisks: false,
            showBaseline: true,
            selectedAssignees: [],
          };
          const savedViewState = normalizeGanttViewState(flow.ganttViewState, defaultViewState);
          lastSavedGanttViewStateRef.current = JSON.stringify(savedViewState);

          const flowCode = flow.code || DEFAULT_CODE;
          clearHistory();
          if (flow.tabs && flow.tabs.length > 0) {
            setDiagramTabs(flow.tabs);
            // Restore the active tab, or default to first tab
            const restoredTabId = flow.activeTabId && flow.tabs.some((t) => t.id === flow.activeTabId)
              ? flow.activeTabId : flow.tabs[0].id;
            const restoredTab = flow.tabs.find((t) => t.id === restoredTabId);
            setActiveTabId(restoredTabId);
            setCode(restoredTab.code);
            lastVersionCodeRef.current = restoredTab.code;
          } else {
            setDiagramTabs([{ id: "tab-0", label: "Main", code: flowCode }]);
            setActiveTabId("tab-0");
            setCode(flowCode);
            lastVersionCodeRef.current = flowCode;
          }
          if (flow.diagramType) setDiagramType(flow.diagramType);
          setFlowMeta(flow);
          setBaselineCode(flow.baselineCode || null);
          setBaselineSetAt(flow.baselineSetAt || null);
          setShowDates(savedViewState.showDates);
          setShowGrid(savedViewState.showGrid);
          setGanttScale(savedViewState.ganttScale);
          setPinCategories(savedViewState.pinCategories);
          setShowCriticalPath(savedViewState.showCriticalPath);
          setShowDepLines(savedViewState.showDepLines);
          setExecutiveView(savedViewState.executiveView);
          setShowRisks(savedViewState.showRisks);
          setShowBaseline(savedViewState.showBaseline);
          setSelectedAssignees(savedViewState.selectedAssignees);
          // Delay marking loaded so the auto-save doesn't fire on initial load
          window.setTimeout(() => { flowLoadedRef.current = true; }, 3000);
        } else {
          lastSavedGanttViewStateRef.current = "";
          flowLoadedRef.current = true;
        }
      } catch (err) {
        logAppFirestoreError("loadFlow/getFlow", err, { flowId });
        setRenderMessage(`Load failed: ${formatFirestoreError(err)}`);
        flowLoadedRef.current = true;
      }
    })();
  }, [flowId]);

  /* ── Auto-save to Firestore (debounced) ────────────── */
  useEffect(() => {
    if (!flowId || isEmbed) return;
    // Don't save until the flow has loaded (prevents overwriting with default)
    if (!flowLoadedRef.current) return;
    // Only save if user has edit permissions
    const userRole = flowMeta?.sharing?.[currentUser?.uid];
    const isOwner = flowMeta?.ownerId === currentUser?.uid;
    const canPubliclyEdit = flowMeta?.publicAccess === "edit";
    if (!isOwner && userRole !== "edit" && !canPubliclyEdit) return;
    const handle = window.setTimeout(async () => {
      try {
        const tabsSnapshot = diagramTabs.map((t) => t.id === activeTabId ? { ...t, code } : t);
        await updateFlow(flowId, { code, diagramType, tabs: tabsSnapshot, activeTabId });
        const now = Date.now();
        if (now - lastVersionSaveRef.current >= 10 * 60 * 1000 && code !== lastVersionCodeRef.current) {
          lastVersionSaveRef.current = now;
          lastVersionCodeRef.current = code;
          const tabsSnapshot = diagramTabs.map((t) => t.id === activeTabId ? { ...t, code } : t);
          saveFlowVersion(flowId, { code, diagramType, tabs: tabsSnapshot }).catch(() => {});
        }
      } catch (err) {
        logAppFirestoreError("autoSave/updateFlow", err, {
          flowId,
          diagramType,
          userUid: currentUser?.uid || null,
        });
        console.warn("Auto-save failed:", formatFirestoreError(err));
      }
    }, 2000);
    return () => window.clearTimeout(handle);
  }, [code, flowId, diagramType, flowMeta, currentUser, diagramTabs, activeTabId]);

  useEffect(() => {
    if (ganttDropdown === "assignees" || mobileViewMenuOpen) return;
    setAssigneeFilterQuery("");
  }, [ganttDropdown, mobileViewMenuOpen]);

  /* ── Persist gantt view preferences ─────────────────── */
  useEffect(() => {
    if (!flowId || isEmbed || toolsetKey !== "gantt") return;
    if (!flowLoadedRef.current) return;
    const userRole = flowMeta?.sharing?.[currentUser?.uid];
    const isOwner = flowMeta?.ownerId === currentUser?.uid;
    const canPubliclyEdit = flowMeta?.publicAccess === "edit";
    if (!isOwner && userRole !== "edit" && !canPubliclyEdit) return;

    const serialized = JSON.stringify(ganttViewState);
    if (serialized === lastSavedGanttViewStateRef.current) return;

    const handle = window.setTimeout(async () => {
      try {
        await updateFlow(flowId, { ganttViewState });
        lastSavedGanttViewStateRef.current = serialized;
      } catch (err) {
        logAppFirestoreError("autoSave/updateFlowPreferences", err, {
          flowId,
          userUid: currentUser?.uid || null,
        });
        console.warn("Gantt view autosave failed:", formatFirestoreError(err));
      }
    }, 600);

    return () => window.clearTimeout(handle);
  }, [flowId, isEmbed, toolsetKey, flowMeta, currentUser, ganttViewState]);

  /* ── Auto-save to localStorage ─────────────────────── */
  useEffect(() => {
    if (isEmbed) return; // don't save in embed mode
    const handle = window.setTimeout(() => {
      // Save current tab's code into diagramTabs before persisting
      const updatedTabs = diagramTabs.map((t) => t.id === activeTabId ? { ...t, code } : t);
      saveLastDiagram(code, updatedTabs, activeTabId);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [code, diagramTabs, activeTabId]);

  /* ── Parent frame postMessage API (for Notion etc.) ── */
  useEffect(() => {
    if (!window.parent || window.parent === window) return;

    const handleParentMessage = (event) => {
      const msg = event.data;
      if (!msg || msg.channel !== "mermaid-flow-host") return;

      if (msg.type === "set-code" && typeof msg.code === "string") {
        setCode(msg.code);
        clearHistory();
      }
      if (msg.type === "get-code") {
        window.parent.postMessage({
          channel: "mermaid-flow-host",
          type: "code-update",
          code,
        }, "*");
      }
      if (msg.type === "set-theme" && typeof msg.theme === "string") {
        setTheme(msg.theme);
      }
    };
    window.addEventListener("message", handleParentMessage);
    return () => window.removeEventListener("message", handleParentMessage);
  }, [code]);

  /* ── Notify parent on code changes (for Notion etc.) ── */
  useEffect(() => {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage({
      channel: "mermaid-flow-host",
      type: "code-update",
      code,
    }, "*");
  }, [code]);

  /* ── Gantt draft sync ────────────────────────────────── */
  // Build a stable fingerprint of the selected task's data so the draft
  // only resets when the underlying task genuinely changes — not when
  // ganttTasks is recomputed and the object reference happens to differ.
  const selectedGanttTaskFingerprint = selectedGanttTask
    ? [
        selectedGanttTask.label,
        selectedGanttTask.startDate,
        selectedGanttTask.endDate,
        (selectedGanttTask.statusTokens || []).join(","),
        selectedGanttTask.isMilestone,
        selectedGanttTask.assignee,
        selectedGanttTask.notes,
        selectedGanttTask.link,
        selectedGanttTask.section,
        selectedGanttTask.progress,
        (selectedGanttTask.afterDeps || []).join(","),
      ].join("|")
    : "";
  // Unlock the gantt draft when the modal closes so syncing can resume.
  // Declared before the sync useEffect so it fires first in the same commit.
  useEffect(() => {
    console.log("[DEP-DEBUG] unlock useEffect fired", { contextMenuType: contextMenu?.type, locked: ganttDraftLockedRef.current });
    if (contextMenu?.type !== "gantt") {
      ganttDraftLockedRef.current = false;
    }
  }, [contextMenu]);
  useEffect(() => {
    console.log("[DEP-DEBUG] sync useEffect fired", { locked: ganttDraftLockedRef.current, fingerprint: selectedGanttTaskFingerprint, hasTask: !!selectedGanttTask, deps: selectedGanttTask?.afterDeps });
    // While the Gantt modal is open, don't overwrite user edits to ganttDraft
    if (ganttDraftLockedRef.current) {
      console.log("[DEP-DEBUG] LOCKED — skipping sync");
      return;
    }
    if (!selectedGanttTask) {
      console.log("[DEP-DEBUG] No selected task — clearing draft");
      setGanttDraft({ label: "", startDate: "", endDate: "", status: [], isMilestone: false, assignee: "", notes: "", link: "", section: "", progress: "", dependsOn: [] });
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
      isMilestone: selectedGanttTask.isMilestone || false,
      assignee: selectedGanttTask.assignee || "",
      notes: selectedGanttTask.notes || "",
      link: selectedGanttTask.link || "",
      section: selectedGanttTask.section || "",
      progress: selectedGanttTask.progress !== null && selectedGanttTask.progress !== undefined ? String(selectedGanttTask.progress) : "",
      dependsOn: selectedGanttTask.afterDeps || [],
    });
    console.log("[DEP-DEBUG] Draft synced from task", { deps: selectedGanttTask.afterDeps, contextMenuType: contextMenu?.type });
    // Lock the draft while the modal is open to prevent future syncs
    // from overwriting user edits (e.g., dep removal via X button)
    if (contextMenu?.type === "gantt") {
      ganttDraftLockedRef.current = true;
      console.log("[DEP-DEBUG] LOCKED after sync (modal is open)");
    }
  }, [selectedGanttTaskFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

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

        // Custom renderers already handled everything inside the iframe; skip SVG post-processing.
        const isCustomGantt = payload.isCustomGantt || false;
        const isCustomFlowchart = payload.isCustomFlowchart || false;
        const isCustomEr = payload.isCustomEr || false;
        const isCustomSequence = payload.isCustomSequence || false;
        const isCustomState = payload.isCustomState || false;
        const isCustomRenderer = isCustomGantt || isCustomFlowchart || isCustomEr || isCustomSequence || isCustomState;

        // Apply position overrides after re-render (SVG diagrams only)
        if (!isCustomRenderer && Object.keys(positionOverrides).length > 0) {
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            frame.contentWindow.postMessage(
              { channel: CHANNEL, type: "apply:positions", payload: { overrides: positionOverrides } },
              "*"
            );
          }
        }

        // Send parsed edge data for custom edge rendering (SVG diagrams only)
        const tk = classifyDiagramType(payload.diagramType || "");
        const edgeTypes = ["flowchart", "erDiagram", "stateDiagram", "classDiagram"];
        if (!isCustomRenderer && edgeTypes.includes(tk)) {
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

        // Apply style overrides after render (SVG diagrams only; custom renderers handle styles internally)
        if (!isCustomRenderer && Object.keys(styleOverrides).length > 0) {
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

        // Re-send multi-select highlight after custom flowchart re-render
        if (isCustomFlowchart && selectedNodeIds.size > 0) {
          const frame = iframeRef.current;
          if (frame?.contentWindow) {
            setTimeout(() => {
              frame.contentWindow.postMessage(
                { channel: CHANNEL, type: "flowchart:multiselect", payload: { nodeIds: [...selectedNodeIds] } },
                "*"
              );
            }, 50);
          }
        }
      }

      if (data.type === "render:error") {
        setRenderStatus("error");
        setRenderMessage(data.payload?.message || "Render failed");
      }

      if (data.type === "element:selected") {
        const selected = data.payload || null;
        console.log("[DEP-DEBUG] element:selected received", { label: selected?.label, elementType: selected?.elementType, isNull: !selected });
        setSelectedElement(selected);
        setLabelDraft(selected?.label || "");
        setHighlightLine(getMatchingLine(code, selected?.label || selected?.id || ""));

        if (selected?.elementType === "node" && selected?.screenBox && selected?.nodeId) {
          setSelectedNodeIds(new Set([selected.nodeId]));
          const ir = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
          setStyleToolbar({
            nodeId: selected.nodeId,
            x: ir.left + (selected.screenBox.left + selected.screenBox.right) / 2,
            y: ir.top + selected.screenBox.top,
            yBottom: ir.top + selected.screenBox.bottom,
            activeDropdown: null,
          });
        } else {
          setSelectedNodeIds(new Set());
          setStyleToolbar(null);
        }
      }

      if (data.type === "elements:selected") {
        const { nodeIds = [], screenBoxes = {}, nodePositions = {} } = data.payload || {};
        const ids = new Set(nodeIds);
        setSelectedNodeIds(ids);
        setMultiNodePositions(nodePositions);
        if (ids.size > 1) {
          // Multi-select: show toolbar above bounding box of all selected
          setSelectedElement({ elementType: "multi", nodeIds: [...ids] });
          const ir = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const nid of ids) {
            const box = screenBoxes[nid];
            if (!box) continue;
            if (box.left < minX) minX = box.left;
            if (box.top < minY) minY = box.top;
            if (box.right > maxX) maxX = box.right;
            if (box.bottom > maxY) maxY = box.bottom;
          }
          setStyleToolbar({
            nodeId: [...ids][0],
            multiNodeIds: [...ids],
            x: ir.left + (minX + maxX) / 2,
            y: ir.top + minY,
            yBottom: ir.top + maxY,
            activeDropdown: null,
          });
        } else if (ids.size === 1) {
          const nid = [...ids][0];
          const box = screenBoxes[nid];
          if (box) {
            const ir = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
            setSelectedElement({ elementType: "node", nodeId: nid, label: nid, id: nid });
            setStyleToolbar({
              nodeId: nid,
              x: ir.left + (box.left + box.right) / 2,
              y: ir.top + box.top,
              yBottom: ir.top + box.bottom,
              activeDropdown: null,
            });
          }
        } else {
          setSelectedElement(null);
          setStyleToolbar(null);
        }
      }

      if (data.type === "elements:dragged") {
        commitSnapshotNow({ dragBatch: true });
        setStyleToolbar(null);
        const moves = data.payload?.moves || {};
        setPositionOverrides((prev) => {
          const next = { ...prev };
          for (const [nid, m] of Object.entries(moves)) {
            if (m.absX != null) {
              next[nid] = { absX: m.absX, absY: m.absY };
            } else {
              next[nid] = { dx: m.accumulatedDx || 0, dy: m.accumulatedDy || 0 };
            }
          }
          return next;
        });
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
            let messageIndex;
            if (toolsetKey === "flowchart") {
              const edge = flowchartData.edges.find(e => e.source === src && e.target === tgt);
              if (edge) arrowType = edge.arrowType || "-->";
            } else if (toolsetKey === "sequenceDiagram") {
              arrowType = selected?.arrowType || "->>";
              messageIndex = selected?.messageIndex;
            }
            setNodeEditModal({
              type: "edge",
              edgeSource: src,
              edgeTarget: tgt,
              label: selected?.label || "",
              arrowType,
              messageIndex,
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
        commitSnapshotNow({ dragBatch: true });
        setStyleToolbar(null);
        const payload = data.payload || {};
        if (!payload.isGanttTask && payload.nodeId) {
          setPositionOverrides((prev) => ({
            ...prev,
            [payload.nodeId]: payload.absX != null
              ? { absX: payload.absX, absY: payload.absY }
              : { dx: payload.accumulatedDx || 0, dy: payload.accumulatedDy || 0 },
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
          commitSnapshotNow();
          let updated = removeFlowchartEdge(code, srcNodeId, tgtNodeId);
          if (end === "source") {
            updated = addFlowchartEdge(updated, { source: newNodeId, target: tgtNodeId });
            setRenderMessage("Reconnected edge: " + newNodeId + " --> " + tgtNodeId);
          } else {
            updated = addFlowchartEdge(updated, { source: srcNodeId, target: newNodeId });
            setRenderMessage("Reconnected edge: " + srcNodeId + " --> " + newNodeId);
          }
          setCode(updated);
        }
      }

      if (data.type === "connect:complete") {
        const payload = data.payload || {};
        if (payload.sourceId && payload.targetId) {
          commitSnapshotNow();
          if (toolsetKey === "erDiagram") {
            setCode((prev) => {
              const parsed = parseErDiagram(prev);
              const exists = parsed.relationships.some(r =>
                (r.source === payload.sourceId && r.target === payload.targetId) ||
                (r.source === payload.targetId && r.target === payload.sourceId)
              );
              if (exists) return prev;
              return prev + "\n    " + payload.sourceId + " ||--o{ " + payload.targetId + " : relates";
            });
            setRenderMessage(`Added relationship ${payload.sourceId} --> ${payload.targetId}`);
          } else if (toolsetKey === "sequenceDiagram") {
            // Open message creation form instead of immediately adding
            setMessageCreationForm({ source: payload.sourceId, target: payload.targetId, text: "", arrowType: "->>" });
          } else {
            setCode((prev) => addFlowchartEdge(prev, { source: payload.sourceId, target: payload.targetId }));
            setRenderMessage(`Added edge ${payload.sourceId} --> ${payload.targetId}`);
          }
        }
        setConnectMode(null);
        // Tell iframe to exit connect mode
        const frame = iframeRef.current;
        if (frame?.contentWindow) {
          frame.contentWindow.postMessage({ channel: CHANNEL, type: "mode:normal" }, "*");
        }
      }

      // ER diagram inline editing messages
      if (data.type === "er:entity-renamed") {
        const { entityId, newName } = data.payload || {};
        if (entityId && newName) {
          setCode((prev) => updateErEntity(prev, entityId, { newName }));
          setPositionOverrides({});
          setRenderMessage(`Renamed entity "${entityId}" → "${newName}"`);
        }
      }

      if (data.type === "er:attribute-edited") {
        const { entityId, attrIdx, newValue } = data.payload || {};
        if (entityId && newValue !== undefined && attrIdx >= 0) {
          setCode((prev) => {
            const parsed = parseErDiagram(prev);
            const entity = parsed.entities.find(e => e.id === entityId);
            if (!entity) return prev;
            const attrs = [...entity.attributes];
            attrs[attrIdx] = newValue;
            return updateErEntity(prev, entityId, { attributes: attrs });
          });
          setRenderMessage(`Updated attribute on "${entityId}"`);
        }
      }

      if (data.type === "er:cardinality-changed") {
        const { source, target, cardinality } = data.payload || {};
        if (source && target && cardinality) {
          setCode((prev) => updateErRelationship(prev, source, target, { cardinality }));
          setRenderMessage(`Changed cardinality on ${source} → ${target}`);
        }
      }

      if (data.type === "seq:reorder") {
        const payload = data.payload || {};
        if (payload.participantId !== undefined && payload.newIndex !== undefined) {
          setCode((prev) => reorderSequenceParticipants(prev, payload.participantId, payload.newIndex));
          setRenderMessage("Reordered " + payload.participantId);
        }
      }

      if (data.type === "gantt:zoom") {
        const delta = data.payload?.delta || 0;
        setGanttZoom((prev) => Math.max(0.2, Math.min(4, +(prev + delta).toFixed(1))));
        return;
      }

      if (data.type === "gantt:edit-section") {
        const currentSection = String(data.payload?.section || "").trim();
        if (!currentSection) return;
        const nextSection = window.prompt("Rename category / phase", currentSection);
        if (nextSection == null) return;
        const normalized = nextSection.trim();
        if (!normalized || normalized === currentSection) return;
        commitSnapshotNow();
        setCode((prev) => renameGanttSection(prev, currentSection, normalized));
        setRenderMessage(`Renamed "${currentSection}" to "${normalized}"`);
        return;
      }

      if (data.type === "gantt:add-section") {
        const nextSection = window.prompt("New category / phase name");
        if (nextSection == null) return;
        const normalized = nextSection.trim();
        if (!normalized) return;
        const exists = getGanttSections(code).some(
          (section) => section.name.toLowerCase() === normalized.toLowerCase()
        );
        if (exists) {
          setRenderMessage(`Category "${normalized}" already exists`);
          return;
        }
        commitSnapshotNow();
        setCode((prev) => addGanttSection(prev, normalized));
        setRenderMessage(`Added category "${normalized}"`);
        return;
      }

      if (data.type === "gantt:dragged") {
        commitSnapshotNow({ dragBatch: true });
        const payload = data.payload || {};
        const task = findTaskByLabel(ganttTasks, payload.label || "");
        if (!task) {
          setRenderMessage("Drag captured, but no matching Gantt task found");
          return;
        }
        if (!task.durationDays || !payload.barWidth) {
          setRenderMessage("Cannot resize: task has no duration");
          return;
        }

        // Resolve dependencies to get computed start date for after-based tasks
        const resolved = resolveDependencies(ganttTasks.map((t) => ({ ...t })));
        const resolvedTask = findTaskByLabel(resolved, payload.label || "");
        const effectiveStart = task.startDate || (resolvedTask && resolvedTask.resolvedStartDate) || "";
        if (!effectiveStart) {
          setRenderMessage("Cannot move: task has no resolved start date");
          return;
        }

        const pixelsPerDay = payload.barWidth / task.durationDays;
        const dayShift = Math.round((payload.deltaX || 0) / pixelsPerDay);
        if (!dayShift) return;

        const dragMode = payload.dragMode || "shift";
        if (dragMode === "resize-end") {
          // Change duration — works for both explicit-date and after-based tasks
          const newDays = Math.max(1, task.durationDays + dayShift);
          setCode((prev) => updateGanttTask(prev, task, { duration: newDays + "d" }));
          setRenderMessage(`Updated "${task.label}" duration to ${newDays}d`);
        } else if (dragMode === "resize-start") {
          const nextStart = shiftIsoDate(effectiveStart, dayShift);
          setCode((prev) => updateGanttTask(prev, task, { startDate: nextStart }));
          if (!task.hasExplicitDate) setRenderMessage(`Moved "${task.label}" start to ${nextStart} (replaced dependency)`);
          else setRenderMessage(`Updated "${task.label}" start to ${nextStart}`);
        } else {
          const nextStart = shiftIsoDate(effectiveStart, dayShift);
          const updates = { startDate: nextStart };
          if (task.endDate) {
            updates.endDate = shiftIsoDate(task.endDate, dayShift);
          }
          setCode((prev) => updateGanttTask(prev, task, updates));
          if (!task.hasExplicitDate) setRenderMessage(`Moved "${task.label}" to ${nextStart} (replaced dependency)`);
          else setRenderMessage(`Updated "${task.label}" to ${nextStart}`);
        }
        setHighlightLine(task.lineIndex + 1);
      }

      if (data.type === "gantt:dep-created") {
        const { fromId, fromLabel, targetLabel } = data.payload || {};
        if (!fromLabel || !targetLabel) return;
        commitSnapshotNow();
        // Find the target task (the one that will depend on fromId)
        const targetTask = findTaskByLabel(ganttTasks, targetLabel);
        if (!targetTask) {
          setRenderMessage("Could not find target task");
          return;
        }
        // Resolve the fromId: use idToken if available, otherwise label
        const fromTask = findTaskByLabel(ganttTasks, fromLabel);
        const resolvedFromId = fromTask ? (fromTask.idToken || fromTask.label) : fromId;
        // Add the dependency: target task now depends on from task
        const existingDeps = targetTask.afterDeps || [];
        if (existingDeps.map((d) => d.toLowerCase()).includes(resolvedFromId.toLowerCase())) {
          setRenderMessage(`"${targetLabel}" already depends on "${fromLabel}"`);
          return;
        }
        const newDeps = [...existingDeps, resolvedFromId];
        setCode((prev) => {
          const freshTasks = parseGanttTasks(prev);
          const freshTarget = findTaskByLabel(freshTasks, targetLabel);
          if (!freshTarget) return prev;
          return updateGanttDependency(prev, freshTarget, newDeps);
        });
        setRenderMessage(`Added dependency: "${targetLabel}" now depends on "${fromLabel}"`);
        setHighlightLine(targetTask.lineIndex + 1);
      }

      if (data.type === "gantt:add-between") {
        commitSnapshotNow();
        const afterLabel = (data.payload?.afterLabel || "").trim();
        const afterTask = findTaskByLabel(ganttTasks, afterLabel);
        if (!afterTask) {
          setRenderMessage(`Could not find task "${afterLabel}" to insert after`);
          return;
        }

        const lowerLabels = new Set(ganttTasks.map((t) => t.label.toLowerCase()));
        let nextLabel = "New task";
        let labelCounter = 2;
        while (lowerLabels.has(nextLabel.toLowerCase())) {
          nextLabel = `New task ${labelCounter}`;
          labelCounter += 1;
        }

        const usedIds = new Set(ganttTasks.map((t) => (t.idToken || "").toLowerCase()).filter(Boolean));
        const baseId = ((afterTask.idToken || "task").toLowerCase().replace(/[^a-z0-9_-]/g, "")) || "task";
        let nextId = baseId;
        let idCounter = 2;
        while (usedIds.has(nextId)) {
          nextId = `${baseId}${idCounter}`;
          idCounter += 1;
        }

        const todayIso = new Date().toISOString().slice(0, 10);
        const nextStart =
          afterTask.endDate ||
          (afterTask.startDate && afterTask.durationDays
            ? shiftIsoDate(afterTask.startDate, afterTask.durationDays)
            : afterTask.startDate || todayIso);
        const nextEnd = shiftIsoDate(nextStart, 3);

        const updated = insertGanttTaskAfter(code, afterTask, {
          label: nextLabel,
          indent: afterTask.indent,
          idToken: nextId,
          startDate: nextStart,
          endDate: nextEnd,
        });

        setCode(updated);
        const freshTasks = parseGanttTasks(updated);
        const insertedTask = findTaskByLabel(freshTasks, nextLabel);
        if (insertedTask) {
          setHighlightLine(insertedTask.lineIndex + 1);
          setSelectedElement({ label: insertedTask.label, id: "" });
        }
        setRenderMessage(`Inserted "${nextLabel}" after "${afterTask.label}"`);
        return;
      }

      // ── Subgraph management messages ──────────────────
      if (data.type === "node:dropped-into-subgraph") {
        const { nodeId, subgraphId } = data.payload || {};
        if (!nodeId || !subgraphId) return;
        commitSnapshotNow();
        setCode((prev) => moveNodeToSubgraph(prev, nodeId, subgraphId));
        setPositionOverrides({});
        setRenderMessage(`Moved "${nodeId}" into subgraph "${subgraphId}"`);
        return;
      }

      if (data.type === "subgraph:rename-intent") {
        const { subgraphId, currentLabel } = data.payload || {};
        if (!subgraphId) return;
        const newLabel = window.prompt("Rename subgraph", currentLabel || subgraphId);
        if (newLabel == null || !newLabel.trim() || newLabel.trim() === currentLabel) return;
        commitSnapshotNow();
        setCode((prev) => renameSubgraph(prev, subgraphId, newLabel.trim()));
        setRenderMessage(`Renamed subgraph to "${newLabel.trim()}"`);
        return;
      }

      if (data.type === "subgraph:context") {
        const { subgraphId, label, pointerX, pointerY } = data.payload || {};
        if (!subgraphId) return;
        const ir = iframeRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
        setContextMenu({
          type: "subgraph",
          subgraphId,
          label: label || subgraphId,
          x: ir.left + (pointerX || 0),
          y: ir.top + (pointerY || 0),
        });
        return;
      }

      /* ── State diagram handlers ───────────────────── */
      if (data.type === "state:connect") {
        const { sourceId, targetId } = data.payload || {};
        if (sourceId && targetId) {
          setTransitionLabelModal({ sourceId, targetId, label: "" });
        }
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [code, ganttTasks, toolsetKey, showDates, ganttScale, positionOverrides, flowchartData]);

  /* ── Re-render gantt when display toggles change ────── */
  useEffect(() => {
    if (toolsetKey !== "gantt") return;
    if (!autoRender) return;
    const handle = window.setTimeout(postRender, 100);
    return () => window.clearTimeout(handle);
  }, [showDates, ganttScale, showGrid, compactMode, ganttZoom, pinCategories, showCriticalPath, showDepLines, executiveView, showRisks, selectedAssignees, toolsetKey, showBaseline, baselineTasks]);

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

  /* ── Outside click for top/view dropdowns ────────────── */
  useEffect(() => {
    if (!exportMenuOpen && !mobileActionsOpen && !mobileViewMenuOpen && !ganttDropdown) return;
    const handler = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
      if (mobileActionsRef.current && !mobileActionsRef.current.contains(e.target)) {
        setMobileActionsOpen(false);
      }
      if (mobileViewMenuRef.current && !mobileViewMenuRef.current.contains(e.target)) {
        setMobileViewMenuOpen(false);
      }
      if (ganttDropdown) {
        const inView = ganttViewMenuRef.current?.contains(e.target);
        const inAnalysis = ganttAnalysisMenuRef.current?.contains(e.target);
        const inAssignees = ganttAssigneeMenuRef.current?.contains(e.target);
        if (!inView && !inAnalysis && !inAssignees) setGanttDropdown(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [exportMenuOpen, mobileActionsOpen, mobileViewMenuOpen, ganttDropdown]);

  /* ── Keyboard shortcuts ──────────────────────────────── */
  useEffect(() => {
    const handler = (e) => {
      const isInputFocused = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
        || document.activeElement?.contentEditable === "true";

      // Ctrl+Z / Cmd+Z: Undo
      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !isInputFocused) {
        e.preventDefault();
        handleUndo();
        return;
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y: Redo
      if (((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && e.shiftKey && !isInputFocused)
        || (e.key === "y" && (e.ctrlKey || e.metaKey) && !isInputFocused)) {
        e.preventDefault();
        handleRedo();
        return;
      }
      // Delete / Backspace: delete selected flowchart node(s)
      if ((e.key === "Delete" || e.key === "Backspace") && !isInputFocused && toolsetKey === "flowchart") {
        if (selectedNodeIds.size > 1) {
          e.preventDefault();
          commitSnapshotNow();
          setCode((prev) => {
            let c = prev;
            for (const nid of selectedNodeIds) c = removeFlowchartNode(c, nid);
            return c;
          });
          setPositionOverrides({});
          setStyleToolbar(null);
          setSelectedElement(null);
          setSelectedNodeIds(new Set());
          setRenderMessage(`Deleted ${selectedNodeIds.size} nodes`);
          return;
        }
        const nodeId = styleToolbar?.nodeId || selectedElement?.nodeId;
        if (nodeId && selectedElement?.elementType === "node") {
          e.preventDefault();
          commitSnapshotNow();
          setCode((prev) => removeFlowchartNode(prev, nodeId));
          setPositionOverrides({});
          setStyleToolbar(null);
          setSelectedElement(null);
          setSelectedNodeIds(new Set());
          setRenderMessage(`Deleted "${nodeId}"`);
          return;
        }
      }
      // Ctrl+D / Cmd+D: duplicate node(s) (flowchart) or toggle chain view (gantt)
      if (e.key === "d" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (toolsetKey === "gantt") {
          e.preventDefault();
          setShowChainView((prev) => !prev);
          return;
        }
        if (toolsetKey === "flowchart" && !isInputFocused) {
          // Multi-select duplicate
          if (selectedNodeIds.size > 1) {
            e.preventDefault();
            commitSnapshotNow();
            const ids = [...selectedNodeIds];
            const nodes = flowchartData.nodes.filter((n) => selectedNodeIds.has(n.id));
            const edges = flowchartData.edges.filter((ed) => selectedNodeIds.has(ed.source) && selectedNodeIds.has(ed.target));
            const idMap = {};
            let currentCode = codeRef.current;
            let allNodes = [...flowchartData.nodes];
            for (const n of nodes) {
              const newId = generateNodeId(allNodes);
              idMap[n.id] = newId;
              currentCode = addFlowchartNode(currentCode, { id: newId, label: n.label || "Node", shape: n.shape || "rect" });
              allNodes.push({ id: newId });
            }
            for (const ed of edges) {
              const ns = idMap[ed.source]; const nt = idMap[ed.target];
              if (ns && nt) currentCode = addFlowchartEdge(currentCode, { source: ns, target: nt, label: ed.label, arrowType: ed.arrowType });
            }
            const newPosOverrides = { ...positionOverridesRef.current };
            const newStyleOverrides = { ...styleOverridesRef.current };
            for (const [oldId, newId] of Object.entries(idMap)) {
              const orig = positionOverrides[oldId] || {};
              if (orig.absX != null) {
                newPosOverrides[newId] = { absX: orig.absX + 40, absY: orig.absY + 40 };
              } else {
                newPosOverrides[newId] = { dx: (orig.dx || 0) + 40, dy: (orig.dy || 0) + 40 };
              }
              if (styleOverrides[oldId]) newStyleOverrides[newId] = { ...styleOverrides[oldId] };
            }
            setCode(currentCode);
            setPositionOverrides(newPosOverrides);
            setStyleOverrides(newStyleOverrides);
            setSelectedNodeIds(new Set(Object.values(idMap)));
            setRenderMessage(`Duplicated ${ids.length} nodes`);
            return;
          }
          // Single node duplicate
          const nodeId = styleToolbar?.nodeId || selectedElement?.nodeId;
          if (nodeId) {
            e.preventDefault();
            const node = flowchartData.nodes.find((n) => n.id === nodeId);
            if (node) {
              commitSnapshotNow();
              const newId = generateNodeId(flowchartData.nodes);
              setCode((prev) => addFlowchartNode(prev, { id: newId, label: node.label || nodeId, shape: node.shape || "rect" }));
              setPositionOverrides({});
              setRenderMessage(`Duplicated "${nodeId}" as "${newId}"`);
            }
            return;
          }
        }
        return;
      }
      // Arrow keys: nudge selected node(s) (10px, Shift: 1px)
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && !isInputFocused && toolsetKey === "flowchart") {
        const nodesToNudge = selectedNodeIds.size > 0 ? [...selectedNodeIds] : (selectedElement?.nodeId ? [selectedElement.nodeId] : []);
        if (nodesToNudge.length > 0) {
          e.preventDefault();
          const step = e.shiftKey ? 1 : 10;
          let dx = 0, dy = 0;
          if (e.key === "ArrowUp") dy = -step;
          if (e.key === "ArrowDown") dy = step;
          if (e.key === "ArrowLeft") dx = -step;
          if (e.key === "ArrowRight") dx = step;
          commitSnapshotNow({ dragBatch: true });
          setPositionOverrides((prev) => {
            const next = { ...prev };
            for (const nid of nodesToNudge) {
              const p = prev[nid];
              if (p && p.absX != null) {
                next[nid] = { absX: p.absX + dx, absY: p.absY + dy };
              } else {
                next[nid] = { dx: ((p?.dx) || 0) + dx, dy: ((p?.dy) || 0) + dy };
              }
            }
            return next;
          });
          return;
        }
      }
      // Ctrl+A / Cmd+A: select all nodes (flowchart only)
      if (e.key === "a" && (e.ctrlKey || e.metaKey) && !isInputFocused && toolsetKey === "flowchart") {
        e.preventDefault();
        const allIds = new Set(flowchartData.nodes.map((n) => n.id));
        setSelectedNodeIds(allIds);
        setSelectedElement({ elementType: "multi", nodeIds: [...allIds] });
        const frame = iframeRef.current;
        if (frame?.contentWindow) {
          frame.contentWindow.postMessage({ channel: CHANNEL, type: "flowchart:multiselect", payload: { nodeIds: [...allIds] } }, "*");
        }
        return;
      }
      // Ctrl+C / Cmd+C: copy selected flowchart nodes
      if (e.key === "c" && (e.ctrlKey || e.metaKey) && !isInputFocused && toolsetKey === "flowchart" && selectedNodeIds.size > 0) {
        e.preventDefault();
        const ids = [...selectedNodeIds];
        const nodes = flowchartData.nodes.filter((n) => selectedNodeIds.has(n.id));
        const edges = flowchartData.edges.filter((e) => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target));
        const relativePositions = {};
        const styleSnapshot = {};
        for (const nid of ids) {
          relativePositions[nid] = multiNodePositions[nid] || positionOverrides[nid] || { dx: 0, dy: 0, x: 0, y: 0 };
          if (styleOverrides[nid]) styleSnapshot[nid] = { ...styleOverrides[nid] };
        }
        setFlowClipboard({ nodes: nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape })), edges: edges.map((e) => ({ source: e.source, target: e.target, label: e.label, arrowType: e.arrowType })), relativePositions, styleSnapshot });
        setRenderMessage(`Copied ${ids.length} node${ids.length > 1 ? "s" : ""}`);
        return;
      }
      // Ctrl+V / Cmd+V: paste flowchart clipboard
      if (e.key === "v" && (e.ctrlKey || e.metaKey) && !isInputFocused && toolsetKey === "flowchart" && flowClipboard) {
        e.preventDefault();
        commitSnapshotNow();
        const idMap = {};
        let currentCode = codeRef.current;
        const currentParsed = parseFlowchart(currentCode);
        let allNodes = [...currentParsed.nodes];
        for (const n of flowClipboard.nodes) {
          const newId = generateNodeId(allNodes);
          idMap[n.id] = newId;
          currentCode = addFlowchartNode(currentCode, { id: newId, label: n.label || "Node", shape: n.shape || "rect" });
          allNodes.push({ id: newId });
        }
        for (const e of flowClipboard.edges) {
          const newSrc = idMap[e.source]; const newTgt = idMap[e.target];
          if (newSrc && newTgt) currentCode = addFlowchartEdge(currentCode, { source: newSrc, target: newTgt, label: e.label, arrowType: e.arrowType });
        }
        // Position overrides offset by 40px
        const newPosOverrides = { ...positionOverridesRef.current };
        for (const [oldId, newId] of Object.entries(idMap)) {
          const orig = flowClipboard.relativePositions[oldId] || {};
          if (orig.absX != null) {
            newPosOverrides[newId] = { absX: orig.absX + 40, absY: orig.absY + 40 };
          } else {
            newPosOverrides[newId] = { dx: (orig.dx || 0) + 40, dy: (orig.dy || 0) + 40 };
          }
        }
        // Style overrides
        const newStyleOverrides = { ...styleOverridesRef.current };
        for (const [oldId, newId] of Object.entries(idMap)) {
          if (flowClipboard.styleSnapshot[oldId]) newStyleOverrides[newId] = { ...flowClipboard.styleSnapshot[oldId] };
        }
        setCode(currentCode);
        setPositionOverrides(newPosOverrides);
        setStyleOverrides(newStyleOverrides);
        const newIds = new Set(Object.values(idMap));
        setSelectedNodeIds(newIds);
        setRenderMessage(`Pasted ${flowClipboard.nodes.length} node${flowClipboard.nodes.length > 1 ? "s" : ""}`);
        return;
      }
      if (e.key === "Escape") {
        if (showChainView) { setShowChainView(false); return; }
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
        if (ganttDropdown) { setGanttDropdown(null); return; }
        if (stateDropdown) { setStateDropdown(null); return; }
        if (transitionLabelModal) { setTransitionLabelModal(null); return; }
        if (mobileViewMenuOpen) { setMobileViewMenuOpen(false); return; }
        if (mobileActionsOpen) { setMobileActionsOpen(false); return; }
        if (exportMenuOpen) { setExportMenuOpen(false); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [contextMenu, presentMode, settingsOpen, drawerOpen, exportMenuOpen, mobileActionsOpen, mobileViewMenuOpen, connectMode, shapePickerNode, edgeLabelEdit, nodeEditModal, nodeCreationForm, styleToolbar, ganttDropdown, showChainView, toolsetKey, handleUndo, handleRedo, selectedElement, selectedNodeIds, flowchartData, commitSnapshotNow, flowClipboard, multiNodePositions, positionOverrides, styleOverrides]);

  /* ── Style Toolbar ──────────────────────────────────── */
  const applyToolbarStyle = (nodeId, stylePatch) => {
    commitSnapshotNow();
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
    commitSnapshotNow();
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
    commitSnapshotNow();
    if (!selectedElement?.label || !labelDraft.trim()) return;
    const updated = replaceFirstLabel(code, selectedElement.label, labelDraft.trim());
    setCode(updated);
  };

  const applyGanttTaskPatch = () => {
    commitSnapshotNow();
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

    // Apply milestone toggle
    const msTasks = parseGanttTasks(updated);
    const msTask = findTaskByLabel(msTasks, nextLabel);
    if (msTask) {
      updated = toggleGanttMilestone(updated, msTask, ganttDraft.isMilestone);
    }

    // Apply assignee
    const assigneeTasks = parseGanttTasks(updated);
    const assigneeTask = findTaskByLabel(assigneeTasks, nextLabel);
    if (assigneeTask) {
      updated = updateGanttAssignee(updated, assigneeTask, normalizeAssigneeList(ganttDraft.assignee));
    }

    // Apply notes
    const notesTasks = parseGanttTasks(updated);
    const notesTask = findTaskByLabel(notesTasks, nextLabel);
    if (notesTask) {
      updated = updateGanttNotes(updated, notesTask, ganttDraft.notes.trim());
    }

    // Apply link
    const linkTasks = parseGanttTasks(updated);
    const linkTask = findTaskByLabel(linkTasks, nextLabel);
    if (linkTask) {
      updated = updateGanttLink(updated, linkTask, ganttDraft.link.trim());
    }

    // Apply progress
    const progressTasks = parseGanttTasks(updated);
    const progressTask = findTaskByLabel(progressTasks, nextLabel);
    if (progressTask) {
      updated = updateGanttProgress(updated, progressTask, ganttDraft.progress);
    }

    // Apply dependency changes
    const depTasks = parseGanttTasks(updated);
    const depTask = findTaskByLabel(depTasks, nextLabel);
    if (depTask) {
      updated = updateGanttDependency(updated, depTask, ganttDraft.dependsOn);
    }

    // Move task to a different category / phase when changed
    const sectionTasks = parseGanttTasks(updated);
    const sectionTask = findTaskByLabel(sectionTasks, nextLabel);
    if (sectionTask) {
      updated = moveGanttTaskToSection(updated, sectionTask, ganttDraft.section);
    }

    const finalTasks = parseGanttTasks(updated);
    const finalTask = findTaskByLabel(finalTasks, nextLabel);

    setCode(updated);
    setRenderMessage(`Updated "${nextLabel}"`);
    setHighlightLine(finalTask ? finalTask.lineIndex + 1 : null);
    if (finalTask) {
      setSelectedElement({ label: finalTask.label, id: "" });
    }
  };

  // mode: "check" (show dialog if dependents), "taskOnly", "deleteAll"
  const handleDeleteGanttTask = (label, mode = "check") => {
    commitSnapshotNow();
    const task = findTaskByLabel(ganttTasks, label);
    if (!task) return;

    // Show confirmation dialog if there are dependents
    if (mode === "check") {
      const allDependents = findAllDependentTasks(ganttTasks, task);
      if (allDependents.length > 0) {
        const directDependents = findDependentTasks(ganttTasks, task);
        setGanttDeleteConfirm({ task, dependents: allDependents, directDependents });
        return;
      }
    }

    let updated = code;
    if (mode === "deleteAll") {
      // Cascade: delete the task and all transitive dependents
      const allDependents = findAllDependentTasks(ganttTasks, task);
      const allToDelete = [task, ...allDependents].sort((a, b) => b.lineIndex - a.lineIndex);
      for (const t of allToDelete) {
        const current = findTaskByLabel(parseGanttTasks(updated), t.label);
        if (current) updated = deleteGanttTask(updated, current);
      }
    } else {
      // Remove dependency references, replacing "after" with explicit dates
      // when a dependent would lose all its timing info
      const resolved = resolveDependencies(ganttTasks.map((t) => ({ ...t })));
      updated = removeDependencyReferences(updated, ganttTasks, resolved, task);
      const refreshed = findTaskByLabel(parseGanttTasks(updated), task.label);
      updated = deleteGanttTask(updated, refreshed || task);
    }

    setCode(updated);
    setRenderMessage(`Deleted "${task.label}"`);
    setHighlightLine(null);
    if (selectedElement?.label && selectedElement.label.toLowerCase() === task.label.toLowerCase()) {
      setSelectedElement(null);
    }
    setGanttDeleteConfirm(null);
  };

  const handleStatusToggle = (flag) => {
    commitSnapshotNow();
    const label = contextMenu?.label || selectedElement?.label;
    const task = findTaskByLabel(ganttTasks, label);
    if (!task) return;
    const updated = toggleGanttStatus(code, task, flag);
    setCode(updated);
    setRenderMessage(`Toggled "${flag}" on "${task.label}"`);
    setHighlightLine(task.lineIndex + 1);
  };

  const handleStatusClear = () => {
    commitSnapshotNow();
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
    clearHistory();
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
    const embed = `<iframe title="Mermaid Flow Embed" style="width:100%;height:500px;border:0;" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(embedDoc)}"></iframe>`;
    await navigator.clipboard.writeText(embed);
    setRenderMessage("Iframe embed snippet copied");
  };

  const downloadSvg = () => {
    if (!renderSvg) return;
    const name = flowMeta?.name || "diagram";
    downloadSvgHQ(renderSvg, `${name}.svg`);
  };

  const downloadPng = async () => {
    if (!renderSvg) return;
    const name = flowMeta?.name || "diagram";
    try {
      await downloadPngHQ(renderSvg, `${name}.png`, 3);
    } catch (err) {
      setRenderMessage("PNG export failed: " + err.message);
    }
  };

  const handleDownloadPdf = async () => {
    if (!renderSvg) return;
    const name = flowMeta?.name || "diagram";
    try {
      await downloadPdf(renderSvg, `${name}.pdf`);
      setRenderMessage("PDF downloaded");
    } catch (err) {
      setRenderMessage("PDF export failed: " + err.message);
    }
  };

  const handleNotionSync = async () => {
    if (!notionDbId.trim() || !notionToken.trim()) {
      setRenderMessage("Enter Notion database ID and token");
      return;
    }
    try {
      const created = await syncGanttToNotion(
        code,
        notionDbId.trim(),
        notionToken.trim()
      );
      setRenderMessage(`Synced ${created.length} tasks to Notion`);
    } catch (err) {
      // Fallback for missing proxy: copy payload so user can send it manually.
      try {
        const pages = ganttToNotionPages(code, notionDbId.trim());
        await navigator.clipboard.writeText(JSON.stringify(pages, null, 2));
        setRenderMessage(
          `Notion sync failed (${err.message}). Copied ${pages.length} task payloads to clipboard for manual proxy use.`
        );
      } catch (fallbackErr) {
        setRenderMessage("Notion sync error: " + fallbackErr.message);
      }
    }
  };

  const handleCopyNotionPayload = async () => {
    if (!notionDbId.trim()) {
      setRenderMessage("Enter Notion database ID");
      return;
    }
    try {
      const pages = ganttToNotionPages(code, notionDbId.trim());
      await navigator.clipboard.writeText(JSON.stringify(pages, null, 2));
      setRenderMessage(`${pages.length} Notion task payloads copied`);
    } catch (err) {
      setRenderMessage("Payload generation error: " + err.message);
    }
  };

  const handleNotionImport = async () => {
    if (!notionDbId.trim() || !notionToken.trim()) {
      setRenderMessage("Enter Notion database ID and token");
      return;
    }
    try {
      const ganttCode = await importFromNotion(
        notionDbId.trim(),
        notionToken.trim(),
        flowMeta?.name || "Imported Timeline"
      );
      setCode(ganttCode);
      clearHistory();
      setRenderMessage("Imported from Notion");
    } catch (err) {
      setRenderMessage("Notion import error: " + err.message);
    }
  };

  const copyShareLink = async () => {
    const encoded = encodeCodeParam(code);
    const base = window.location.origin + window.location.pathname;
    const url = `${base}?code=${encoded}`;
    await navigator.clipboard.writeText(url);
    setRenderMessage("Shareable link copied");
  };

  const copyNotionEmbed = async () => {
    const encoded = encodeCodeParam(code);
    const base = window.location.origin + window.location.pathname;
    const url = `${base}?embed=1&code=${encoded}`;
    await navigator.clipboard.writeText(url);
    setRenderMessage("Notion embed URL copied — paste into Notion as an Embed block");
  };

  // Saved diagrams state
  const [savedDiagrams, setSavedDiagrams] = useState(() => loadSavedDiagrams());
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);

  const handleSaveDiagram = () => {
    if (!saveName.trim()) return;
    saveDiagramToStorage(saveName.trim(), code);
    setSavedDiagrams(loadSavedDiagrams());
    setSaveDialogOpen(false);
    setSaveName("");
    setRenderMessage(`Saved "${saveName.trim()}"`);
  };

  const handleLoadDiagram = (diagram) => {
    setCode(diagram.code);
    clearHistory();
    setSelectedElement(null);
    setHighlightLine(null);
    setRenderMessage(`Loaded "${diagram.name}"`);
  };

  const handleAiGenerate = async () => {
    if (!aiContext.trim()) {
      setAiError("Please describe your project or requirements.");
      return;
    }
    setAiLoading(true);
    setAiError("");
    try {
      const res = await fetch("https://us-central1-mermaidflow-487516.cloudfunctions.net/aiGenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chartType: aiChartType,
          context: aiContext.trim(),
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setAiModalOpen(false);
      setAiPreview({ code: data.code, title: data.title || "Untitled", summary: data.summary || "", source: "generate" });
      setAiPreviewOpen(true);
    } catch (err) {
      setAiError(err.message || "Generation failed. Please try again.");
    } finally {
      setAiLoading(false);
    }
  };

  const handleAiConvert = async () => {
    setConvertLoading(true);
    setConvertError("");
    try {
      const res = await fetch("https://us-central1-mermaidflow-487516.cloudfunctions.net/aiConvert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCode: code,
          targetChartType: convertTargetType,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setConvertModalOpen(false);
      setAiPreview({ code: data.code, title: data.title || "Converted diagram", summary: data.summary || "", source: "convert" });
      setAiPreviewOpen(true);
    } catch (err) {
      setConvertError(err.message || "Conversion failed. Please try again.");
    } finally {
      setConvertLoading(false);
    }
  };

  const handleAiPreviewAccept = () => {
    if (!aiPreview) return;
    // Save current tab code before adding new tab
    setDiagramTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, code } : t));
    const newTab = {
      id: Date.now().toString(),
      label: aiPreview.title || (aiPreview.source === "convert" ? "Conversion" : "AI Generated"),
      code: aiPreview.code,
    };
    setDiagramTabs((prev) => [...prev, newTab]);
    setCode(newTab.code);
    setActiveTabId(newTab.id);
    setSelectedElement(null);
    setHighlightLine(null);
    setPositionOverrides({});
    const label = aiPreview.source === "convert" ? "Converted" : "AI generated";
    setRenderMessage(`${label}: ${aiPreview.title}`);
    setAiPreviewOpen(false);
    setAiPreview(null);
    setAiContext("");
  };

  const handleAiPreviewReject = () => {
    setAiPreviewOpen(false);
    setAiPreview(null);
  };

  const switchTab = (tabId) => {
    if (tabId === activeTabId) return;
    // Save current tab's code before switching
    setDiagramTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, code } : t));
    // Load new tab's code
    const tab = diagramTabs.find((t) => t.id === tabId);
    if (tab) {
      setCode(tab.code);
      setActiveTabId(tabId);
    }
    setSelectedElement(null);
    setHighlightLine(null);
    setPositionOverrides({});
  };

  const closeTab = (tabId) => {
    if (diagramTabs.length <= 1) return; // always keep at least one tab
    const idx = diagramTabs.findIndex((t) => t.id === tabId);
    setDiagramTabs((prev) => prev.filter((t) => t.id !== tabId));
    if (activeTabId === tabId) {
      // Switch to adjacent tab
      const nextTab = diagramTabs[idx === 0 ? 1 : idx - 1];
      if (nextTab) {
        setCode(nextTab.code);
        setActiveTabId(nextTab.id);
      }
      setSelectedElement(null);
      setHighlightLine(null);
      setPositionOverrides({});
    }
  };

  const addNewTab = () => {
    // Save current tab's code first
    setDiagramTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, code } : t));
    const newTab = {
      id: Date.now().toString(),
      label: `Tab ${diagramTabs.length + 1}`,
      code: "",
    };
    setDiagramTabs((prev) => [...prev, newTab]);
    setCode(newTab.code);
    setActiveTabId(newTab.id);
    setSelectedElement(null);
    setHighlightLine(null);
    setPositionOverrides({});
  };

  const startRenameTab = (tabId) => {
    const tab = diagramTabs.find((t) => t.id === tabId);
    if (!tab) return;
    setRenamingTabId(tabId);
    setRenameValue(tab.label);
  };

  const commitRenameTab = () => {
    if (renamingTabId && renameValue.trim()) {
      setDiagramTabs((prev) => prev.map((t) => t.id === renamingTabId ? { ...t, label: renameValue.trim() } : t));
    }
    setRenamingTabId(null);
    setRenameValue("");
  };

  const dragTabRef = useRef(null);
  const handleTabDragStart = (e, tabId) => {
    dragTabRef.current = tabId;
    e.dataTransfer.effectAllowed = "move";
  };
  const handleTabDragOver = (e, tabId) => {
    e.preventDefault();
    if (!dragTabRef.current || dragTabRef.current === tabId) return;
    setDiagramTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === dragTabRef.current);
      const toIdx = prev.findIndex((t) => t.id === tabId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const handleTabDragEnd = () => {
    dragTabRef.current = null;
  };

  const handleDeleteDiagram = (name) => {
    deleteDiagramFromStorage(name);
    setSavedDiagrams(loadSavedDiagrams());
    setRenderMessage(`Deleted "${name}"`);
  };

  const handleSaveToCloud = async () => {
    if (!currentUser || flowId || cloudSaving) return;
    setCloudSaving(true);
    try {
      const created = await createFlow(currentUser.uid, {
        name: flowMeta?.name || "Untitled",
        code,
        diagramType,
        projectId: null,
        subprojectId: null,
        tags: [],
        ganttViewState,
      });
      setRenderMessage("Saved to Firebase. Autosave is now active.");
      navigate(`/editor/${created.id}`);
    } catch (err) {
      logAppFirestoreError("saveToCloud/createFlow", err, {
        userUid: currentUser.uid,
        diagramType,
      });
      setRenderMessage(`Cloud save failed: ${formatFirestoreError(err)}`);
    } finally {
      setCloudSaving(false);
    }
  };

  const handleManualSave = async () => {
    if (manualSaving || cloudSaving) return;

    if (flowId) {
      if (!canEditCurrentFlow) {
        setRenderMessage("You do not have edit access for this flow");
        return;
      }
      setManualSaving(true);
      try {
        await updateFlow(flowId, {
          code,
          diagramType,
          name: flowMeta?.name || "Untitled",
          ganttViewState,
        });
        lastSavedGanttViewStateRef.current = JSON.stringify(ganttViewState);
        setRenderMessage("Saved to Firebase");
      } catch (err) {
        logAppFirestoreError("manualSave/updateFlow", err, {
          flowId,
          diagramType,
          userUid: currentUser?.uid || null,
        });
        setRenderMessage(`Save failed: ${formatFirestoreError(err)}`);
      } finally {
        setManualSaving(false);
      }
      return;
    }

    if (currentUser) {
      await handleSaveToCloud();
      return;
    }

    const baseName = (flowMeta?.name || "Untitled").trim() || "Untitled";
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const localName = `${baseName} ${stamp}`;
    saveDiagramToStorage(localName, code);
    setSavedDiagrams(loadSavedDiagrams());
    setRenderMessage(`Saved locally as "${localName}"`);
  };

  /* ── Render ──────────────────────────────────────────── */

  /* ── Embed mode: minimal UI with just the preview ───── */
  if (isEmbed) {
    return (
      <main className="app-shell embed-mode">
        {isEditable && (
          <header className="embed-toolbar">
            <div className="brand">
              <img src={logoSvg} alt="MF" className="brand-mark" />
              <span className="embed-title">Mermaid Flow</span>
            </div>
            <div className="toolbar">
              <button className="soft-btn small" onClick={() => {
                const encoded = encodeCodeParam(code);
                const base = window.location.origin + window.location.pathname;
                window.open(`${base}?code=${encoded}`, "_blank");
              }}>
                Open in editor
              </button>
            </div>
          </header>
        )}
        <div className="embed-preview">
          <iframe
            title="Mermaid embed preview"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
            ref={iframeRef}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      {/* ── Header ──────────────────────────────────────── */}
      <header className="top-strip">
        <button
          className="brand brand-home-btn"
          title="Go to home"
          onClick={() => navigate(currentUser ? "/dashboard" : "/")}
        >
          <img src={logoSvg} alt="MF" className="brand-mark" />
          <div className="brand-text">
            <h1>Mermaid Flow</h1>
            {flowHeaderName && (
              <span className="flow-name-badge" title={flowHeaderName}>
                · {flowHeaderName}
              </span>
            )}
          </div>
        </button>

        <div className="toolbar">
          <button
            className="icon-btn desktop-only"
            title={editorCollapsed ? "Show editor" : "Hide editor"}
            onClick={() => setEditorCollapsed(!editorCollapsed)}
          >
            <IconSidebar />
          </button>

          {!autoRender && (
            <button className="soft-btn primary desktop-only" onClick={postRender}>
              Render
            </button>
          )}

          <button className="icon-btn desktop-only" title="Undo (Ctrl+Z)" onClick={handleUndo} disabled={!canUndo}>
            <IconUndo />
          </button>
          <button className="icon-btn desktop-only" title="Redo (Ctrl+Shift+Z)" onClick={handleRedo} disabled={!canRedo}>
            <IconRedo />
          </button>

          <button
            className="soft-btn primary desktop-only"
            onClick={handleManualSave}
            disabled={manualSaving || cloudSaving}
          >
            {manualSaving || cloudSaving ? "Saving..." : "Save"}
          </button>

          <div className="dropdown-wrap desktop-only" ref={exportMenuRef}>
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
              <button className="dropdown-item" onClick={() => { copyShareLink(); setExportMenuOpen(false); }}>
                Copy shareable link
              </button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => { copyNotionEmbed(); setExportMenuOpen(false); }}>
                Copy Notion embed URL
              </button>
              <button className="dropdown-item" onClick={() => { copyEmbed(); setExportMenuOpen(false); }}>
                Copy iframe embed (HTML)
              </button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => { downloadSvg(); setExportMenuOpen(false); }}>
                Download SVG
              </button>
              <button className="dropdown-item" onClick={() => { downloadPng(); setExportMenuOpen(false); }}>
                Download PNG (3x)
              </button>
              <button className="dropdown-item" onClick={() => { handleDownloadPdf(); setExportMenuOpen(false); }}>
                Download PDF
              </button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => { setSaveDialogOpen(true); setExportMenuOpen(false); }}>
                Save local copy
              </button>
            </div>
          </div>

          {flowId && currentUser && canEditCurrentFlow && (
            <button
              className="soft-btn small desktop-only"
              onClick={() => setShareDialogOpen(true)}
            >
              Share
            </button>
          )}
          {flowId && canCommentCurrentFlow && (
            <button
              className="soft-btn small desktop-only"
              onClick={() => setCommentPanelOpen(!commentPanelOpen)}
            >
              Comments
            </button>
          )}
          {flowId && currentUser && (
            <button
              className="soft-btn small desktop-only"
              onClick={() => setVersionPanelOpen(!versionPanelOpen)}
            >
              History
            </button>
          )}

          {ENABLE_NOTION_INTEGRATION && toolsetKey === "gantt" && (
            <button
              className="soft-btn small desktop-only"
              onClick={() => setNotionSyncOpen(!notionSyncOpen)}
            >
              Notion
            </button>
          )}

          {toolsetKey === "gantt" && (
            <button
              className="soft-btn small desktop-only"
              onClick={() => setResourcePanelOpen(!resourcePanelOpen)}
              style={resourcePanelOpen ? { background: "var(--accent-soft)" } : undefined}
            >
              Resources
            </button>
          )}

          <button
            className="icon-btn"
            title={THEME_LABELS[themeMode]}
            onClick={() => setThemeMode(cycleTheme())}
          >
            {themeMode === "dark" ? <IconMoon /> : themeMode === "light" ? <IconSun /> : <IconMonitor />}
          </button>

          <div className="dropdown-wrap mobile-only" ref={mobileActionsRef}>
                <button
                  className="soft-btn mobile-menu-btn"
                  onClick={() => {
                    setMobileActionsOpen((prev) => !prev);
                    setExportMenuOpen(false);
                    setMobileViewMenuOpen(false);
                  }}
                >
                  Menu
                </button>
            <div className={`dropdown-menu mobile-dropdown ${mobileActionsOpen ? "open" : ""}`}>
              <button className="dropdown-item" onClick={() => { handleManualSave(); setMobileActionsOpen(false); }}>
                {manualSaving || cloudSaving ? "Saving..." : "Save"}
              </button>
              <button className="dropdown-item" onClick={() => { copyCode(); setMobileActionsOpen(false); }}>
                Copy Mermaid code
              </button>
              <button className="dropdown-item" onClick={() => { copyShareLink(); setMobileActionsOpen(false); }}>
                Copy shareable link
              </button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => { downloadSvg(); setMobileActionsOpen(false); }}>
                Export SVG
              </button>
              <button className="dropdown-item" onClick={() => { downloadPng(); setMobileActionsOpen(false); }}>
                Export PNG
              </button>
              <button className="dropdown-item" onClick={() => { handleDownloadPdf(); setMobileActionsOpen(false); }}>
                Export PDF
              </button>
              <div className="dropdown-sep" />
              <button className="dropdown-item" onClick={() => { setSaveDialogOpen(true); setMobileActionsOpen(false); }}>
                Save local copy
              </button>
              {flowId && currentUser && canEditCurrentFlow && (
                <button className="dropdown-item" onClick={() => { setShareDialogOpen(true); setMobileActionsOpen(false); }}>
                  Share
                </button>
              )}
              {flowId && canCommentCurrentFlow && (
                <button className="dropdown-item" onClick={() => { setCommentPanelOpen((prev) => !prev); setMobileActionsOpen(false); }}>
                  Comments
                </button>
              )}
              {flowId && currentUser && (
                <button className="dropdown-item" onClick={() => { setVersionPanelOpen((prev) => !prev); setMobileActionsOpen(false); }}>
                  History
                </button>
              )}
              {ENABLE_NOTION_INTEGRATION && toolsetKey === "gantt" && (
                <button className="dropdown-item" onClick={() => { setNotionSyncOpen((prev) => !prev); setMobileActionsOpen(false); }}>
                  Notion
                </button>
              )}
            </div>
          </div>
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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="soft-btn small ai-btn"
                onClick={() => setAiModalOpen(true)}
              >
                Create with AI
              </button>
              <button
                className="soft-btn small ai-btn convert-btn"
                onClick={() => setConvertModalOpen(true)}
              >
                Convert
              </button>
              <span>{lineCount} lines &middot; {diagramType || "unknown"}</span>
            </div>
          </div>
          <div className="editor-tab-bar">
            {diagramTabs.map((tab) => (
              <button
                key={tab.id}
                className={`editor-tab ${activeTabId === tab.id ? "active" : ""}`}
                onClick={() => switchTab(tab.id)}
                onDoubleClick={() => startRenameTab(tab.id)}
                draggable={renamingTabId !== tab.id}
                onDragStart={(e) => handleTabDragStart(e, tab.id)}
                onDragOver={(e) => handleTabDragOver(e, tab.id)}
                onDragEnd={handleTabDragEnd}
              >
                {renamingTabId === tab.id ? (
                  <input
                    className="editor-tab-rename"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRenameTab}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRenameTab(); if (e.key === "Escape") { setRenamingTabId(null); } }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className="editor-tab-label">{tab.label}</span>
                )}
                {diagramTabs.length > 1 && (
                  <span
                    className="editor-tab-close"
                    onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  >
                    &times;
                  </span>
                )}
              </button>
            ))}
            <button className="editor-tab editor-tab-add" onClick={addNewTab} title="New tab">
              +
            </button>
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
              onChange={(e) => {
                if (!pendingTypingSnapshotRef.current) {
                  pendingTypingSnapshotRef.current = { code: codeRef.current, positionOverrides: positionOverridesRef.current, styleOverrides: styleOverridesRef.current };
                }
                clearTimeout(typingTimerRef.current);
                typingTimerRef.current = setTimeout(() => {
                  if (pendingTypingSnapshotRef.current) {
                    commitSnapshot(pendingTypingSnapshotRef.current.code, pendingTypingSnapshotRef.current.positionOverrides, pendingTypingSnapshotRef.current.styleOverrides);
                    pendingTypingSnapshotRef.current = null;
                  }
                }, 800);
                setDiagramTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, code: e.target.value } : t));
                setCode(e.target.value); setPositionOverrides({});
              }}
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
            {toolsetKey === "gantt" && (
              <div className="dropdown-wrap mobile-only" ref={mobileViewMenuRef}>
                <button
                  className="date-toggle-btn mobile-menu-btn"
                  onClick={() => {
                    setMobileViewMenuOpen((prev) => !prev);
                    setMobileActionsOpen(false);
                    setExportMenuOpen(false);
                  }}
                >
                  View options
                </button>
                <div className={`dropdown-menu mobile-dropdown ${mobileViewMenuOpen ? "open" : ""}`}>
                  <button className="dropdown-item" onClick={() => { setShowGrid((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {showGrid ? "Hide grid" : "Show grid"}
                  </button>
                  <button className="dropdown-item" onClick={() => { setShowDates((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {showDates ? "Hide dates" : "Show dates"}
                  </button>
                  <div className="dropdown-sep" />
                  <button className="dropdown-item" onClick={() => { setGanttScale("week"); setMobileViewMenuOpen(false); }}>
                    Week view
                  </button>
                  <button className="dropdown-item" onClick={() => { setGanttScale("month"); setMobileViewMenuOpen(false); }}>
                    Month view
                  </button>
                  <button className="dropdown-item" onClick={() => { setPinCategories((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {pinCategories ? "Unpin labels" : "Pin labels"}
                  </button>
                  <button className="dropdown-item" onClick={() => { setShowCriticalPath((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {showCriticalPath ? "Hide critical path" : "Critical path"}
                  </button>
                  <button className="dropdown-item" onClick={() => { setShowDepLines((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {showDepLines ? "Hide dep lines" : "Dep lines"}
                  </button>
                  <button className="dropdown-item" onClick={() => { setShowRisks((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {showRisks ? "Hide risks" : "Show risks"}
                  </button>
                  <div className="dropdown-sep" />
                  <div className="dropdown-search-wrap">
                    <input
                      type="search"
                      className="dropdown-search-input"
                      placeholder="Search assignee..."
                      value={assigneeFilterQuery}
                      onChange={(e) => setAssigneeFilterQuery(e.target.value)}
                    />
                  </div>
                  {filteredAssigneeOptions.length > 0 ? (
                    filteredAssigneeOptions.map((assignee) => {
                      const checked = selectedAssignees.some(
                        (name) => name.toLowerCase() === assignee.toLowerCase()
                      );
                      return (
                        <button
                          key={`mobile-assignee-${assignee}`}
                          className="dropdown-item"
                          onClick={() => {
                            toggleAssigneeFilter(assignee);
                            setMobileViewMenuOpen(false);
                          }}
                        >
                          <span className="dropdown-item-check">{checked ? "\u2713" : ""}</span>{assignee}
                        </button>
                      );
                    })
                  ) : (
                    <div className="dropdown-item-empty">
                      {assigneeFilterQuery.trim() ? "No matching assignees" : "No assignees found"}
                    </div>
                  )}
                  {hasAssigneeFilter && (
                    <button className="dropdown-item" onClick={() => { setSelectedAssignees([]); setMobileViewMenuOpen(false); }}>
                      <span className="dropdown-item-check">\u2715</span>Clear assignee filter
                    </button>
                  )}
                  <div className="dropdown-sep" />
                  <button className="dropdown-item" onClick={() => { setExecutiveView((prev) => !prev); setMobileViewMenuOpen(false); }}>
                    {executiveView ? "All tasks" : "Executive"}
                  </button>
                  {flowId && baselineCode && (
                    <button className="dropdown-item" onClick={() => { setShowBaseline((prev) => !prev); setMobileViewMenuOpen(false); }}>
                      {showBaseline ? "Hide baseline" : "Show baseline"}
                    </button>
                  )}
                  {flowId && canEditCurrentFlow && (
                    <button className="dropdown-item" onClick={async () => {
                      try {
                        await setFlowBaseline(flowId, code);
                        setBaselineCode(code);
                        setBaselineSetAt(new Date());
                        setShowBaseline(true);
                      } catch (err) {
                        console.warn("Set baseline failed:", formatFirestoreError(err));
                      }
                      setMobileViewMenuOpen(false);
                    }}>
                      {baselineCode ? "Update baseline" : "Set baseline"}
                    </button>
                  )}
                  {flowId && canEditCurrentFlow && baselineCode && (
                    <button className="dropdown-item" onClick={async () => {
                      try {
                        await clearFlowBaseline(flowId);
                        setBaselineCode(null);
                        setBaselineSetAt(null);
                        setShowBaseline(false);
                      } catch (err) {
                        console.warn("Clear baseline failed:", formatFirestoreError(err));
                      }
                      setMobileViewMenuOpen(false);
                    }}>
                      Clear baseline
                    </button>
                  )}
                </div>
              </div>
            )}
            <span className="preview-hint desktop-only">
              {toolsetKey === "flowchart" && (
                <button
                  className={`date-toggle-btn`}
                  title={flowchartData.direction === "LR" ? "Switch to top-to-bottom layout" : "Switch to left-to-right layout"}
                  onClick={() => {
                    const cur = flowchartData.direction || "TD";
                    const next = cur === "LR" ? "TD" : "LR";
                    setCode((prev) => prev.replace(/^(\s*(?:flowchart|graph))\s+(LR|RL|TD|TB|BT)/m, `$1 ${next}`));
                    setPositionOverrides({});
                  }}
                >
                  {flowchartData.direction === "LR" ? "\u2195 Top-Bottom" : "\u2194 Left-Right"}
                </button>
              )}
              {toolsetKey === "erDiagram" && (
                <button
                  className={`date-toggle-btn`}
                  title={erLayoutDir === "LR" ? "Switch to top-to-bottom layout" : "Switch to left-to-right layout"}
                  onClick={() => {
                    setErLayoutDir((prev) => prev === "LR" ? "TB" : "LR");
                    setPositionOverrides({});
                  }}
                >
                  {erLayoutDir === "LR" ? "\u2195 Top-Bottom" : "\u2194 Left-Right"}
                </button>
              )}
              {toolsetKey === "gantt" && (
                <>
                  <div className="dropdown-wrap" ref={ganttViewMenuRef}>
                    <button
                      className={`date-toggle-btn${ganttDropdown === "view" ? " active" : ""}`}
                      onClick={() => toggleGanttDropdown("view")}
                    >
                      View &#x25BE;
                    </button>
                    <div className={`dropdown-menu${ganttDropdown === "view" ? " open" : ""}`}>
                      <button className="dropdown-item" onClick={() => setGanttScale("week")}>
                        <span className="dropdown-item-check">{ganttScale === "week" ? "\u2713" : ""}</span>Week view
                      </button>
                      <button className="dropdown-item" onClick={() => setGanttScale("month")}>
                        <span className="dropdown-item-check">{ganttScale === "month" ? "\u2713" : ""}</span>Month view
                      </button>
                      <div className="dropdown-sep" />
                      <button className="dropdown-item" onClick={() => setShowGrid((p) => !p)}>
                        <span className="dropdown-item-check">{showGrid ? "\u2713" : ""}</span>Show grid
                      </button>
                      <button className="dropdown-item" onClick={() => setShowDates((p) => !p)}>
                        <span className="dropdown-item-check">{showDates ? "\u2713" : ""}</span>Show dates
                      </button>
                      <button className="dropdown-item" onClick={() => setPinCategories((p) => !p)}>
                        <span className="dropdown-item-check">{pinCategories ? "\u2713" : ""}</span>Pin labels
                      </button>
                    </div>
                  </div>
                  <div className="dropdown-wrap" ref={ganttAnalysisMenuRef}>
                    <button
                      className={`date-toggle-btn${ganttDropdown === "analysis" ? " active" : ""}`}
                      onClick={() => toggleGanttDropdown("analysis")}
                    >
                      Analysis &#x25BE;
                    </button>
                    <div className={`dropdown-menu${ganttDropdown === "analysis" ? " open" : ""}`}>
                      <button className="dropdown-item" onClick={() => setShowCriticalPath((p) => !p)}>
                        <span className="dropdown-item-check">{showCriticalPath ? "\u2713" : ""}</span>Critical path
                      </button>
                      <button className="dropdown-item" onClick={() => setShowDepLines((p) => !p)}>
                        <span className="dropdown-item-check">{showDepLines ? "\u2713" : ""}</span>Dep lines
                      </button>
                      <button className="dropdown-item" onClick={() => setShowRisks((p) => !p)}>
                        <span className="dropdown-item-check">{showRisks ? "\u2713" : ""}</span>Risk flags
                      </button>
                      <button className="dropdown-item" onClick={() => { setShowChainView((p) => !p); setGanttDropdown(null); }}>
                        <span className="dropdown-item-check">{showChainView ? "\u2713" : ""}</span>Chain view
                      </button>
                    </div>
                  </div>
                  <div className="dropdown-wrap" ref={ganttAssigneeMenuRef}>
                    <button
                      className={`date-toggle-btn${ganttDropdown === "assignees" || hasAssigneeFilter ? " active" : ""}`}
                      onClick={() => toggleGanttDropdown("assignees")}
                    >
                      {hasAssigneeFilter ? `Assignees (${selectedAssignees.length})` : "Assignees"} &#x25BE;
                    </button>
                    <div className={`dropdown-menu gantt-assignee-menu${ganttDropdown === "assignees" ? " open" : ""}`}>
                      <div className="dropdown-search-wrap">
                        <input
                          type="search"
                          className="dropdown-search-input"
                          placeholder="Search assignee..."
                          value={assigneeFilterQuery}
                          onChange={(e) => setAssigneeFilterQuery(e.target.value)}
                        />
                      </div>
                      {filteredAssigneeOptions.length > 0 ? (
                        filteredAssigneeOptions.map((assignee) => {
                          const checked = selectedAssignees.some(
                            (name) => name.toLowerCase() === assignee.toLowerCase()
                          );
                          return (
                            <button
                              key={assignee}
                              className="dropdown-item"
                              onClick={() => toggleAssigneeFilter(assignee)}
                            >
                              <span className="dropdown-item-check">{checked ? "\u2713" : ""}</span>{assignee}
                            </button>
                          );
                        })
                      ) : (
                        <div className="dropdown-item-empty">
                          {assigneeFilterQuery.trim() ? "No matching assignees" : "No assignees found"}
                        </div>
                      )}
                      {hasAssigneeFilter && (
                        <>
                          <div className="dropdown-sep" />
                          <button className="dropdown-item" onClick={() => setSelectedAssignees([])}>
                            <span className="dropdown-item-check">\u2715</span>Clear filter
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    className={`date-toggle-btn${executiveView ? " active" : ""}`}
                    onClick={() => setExecutiveView((prev) => !prev)}
                  >
                    {executiveView ? "All tasks" : "Executive"}
                  </button>
                  {flowId && (
                    <>
                      <span style={{ display: "inline-block", width: 1, height: 16, background: "var(--line)", margin: "0 4px", verticalAlign: "middle" }} />
                      {baselineCode ? (
                        <>
                          <button
                            className={`date-toggle-btn${showBaseline ? " active" : ""}`}
                            onClick={() => setShowBaseline((prev) => !prev)}
                          >
                            {showBaseline ? "Hide baseline" : "Show baseline"}
                          </button>
                          {canEditCurrentFlow && (
                            <>
                              <button
                                className="date-toggle-btn"
                                onClick={async () => {
                                  try {
                                    await setFlowBaseline(flowId, code);
                                    setBaselineCode(code);
                                    setBaselineSetAt(new Date());
                                    setShowBaseline(true);
                                  } catch (err) {
                                    console.warn("Set baseline failed:", formatFirestoreError(err));
                                  }
                                }}
                              >
                                Update baseline
                              </button>
                              <button
                                className="date-toggle-btn"
                                onClick={async () => {
                                  try {
                                    await clearFlowBaseline(flowId);
                                    setBaselineCode(null);
                                    setBaselineSetAt(null);
                                    setShowBaseline(false);
                                  } catch (err) {
                                    console.warn("Clear baseline failed:", formatFirestoreError(err));
                                  }
                                }}
                              >
                                Clear baseline
                              </button>
                            </>
                          )}
                        </>
                      ) : (
                        canEditCurrentFlow && (
                          <button
                            className="date-toggle-btn"
                            onClick={async () => {
                              try {
                                await setFlowBaseline(flowId, code);
                                setBaselineCode(code);
                                setBaselineSetAt(new Date());
                                setShowBaseline(true);
                              } catch (err) {
                                console.warn("Set baseline failed:", formatFirestoreError(err));
                              }
                            }}
                          >
                            Set baseline
                          </button>
                        )
                      )}
                    </>
                  )}
                </>
              )}
              {toolsetKey === "sequenceDiagram" && (
                <button
                  className={`date-toggle-btn${sequenceSwimlaneView ? " active" : ""}`}
                  onClick={() => setSequenceSwimlaneView((v) => !v)}
                >
                  {sequenceSwimlaneView ? "Timeline" : "Swimlane"}
                </button>
              )}
              {toolsetKey === "stateDiagram" && (
                <>
                  <div className="dropdown-wrap">
                    <button
                      className={`date-toggle-btn${stateDropdown === "view" ? " active" : ""}`}
                      onClick={() => toggleStateDropdown("view")}
                    >
                      View &#x25BE;
                    </button>
                    <div className={`dropdown-menu${stateDropdown === "view" ? " open" : ""}`}>
                      <button className="dropdown-item" onClick={() => { setCode((prev) => toggleStateDiagramDirection(prev, "LR")); setStateDropdown(null); }}>
                        <span className="dropdown-item-check">{stateDiagramData.direction === "LR" ? "\u2713" : ""}</span>Left to Right
                      </button>
                      <button className="dropdown-item" onClick={() => { setCode((prev) => toggleStateDiagramDirection(prev, "TB")); setStateDropdown(null); }}>
                        <span className="dropdown-item-check">{stateDiagramData.direction === "TB" ? "\u2713" : ""}</span>Top to Bottom
                      </button>
                    </div>
                  </div>
                  <button
                    className="date-toggle-btn"
                    onClick={() => {
                      const id = generateStateId(stateDiagramData.states);
                      setCode((prev) => addStateDiagramState(prev, { id, label: id }));
                      setRenderMessage(`Added state "${id}"`);
                    }}
                  >
                    + State
                  </button>
                  <div className="dropdown-wrap">
                    <button
                      className={`date-toggle-btn${stateDropdown === "xstate" ? " active" : ""}`}
                      onClick={() => toggleStateDropdown("xstate")}
                    >
                      XState &#x25BE;
                    </button>
                    <div className={`dropdown-menu${stateDropdown === "xstate" ? " open" : ""}`}>
                      <button className="dropdown-item" onClick={() => {
                        const json = window.prompt("Paste XState machine JSON");
                        if (!json) return;
                        try {
                          const config = JSON.parse(json);
                          const mermaidCode = xstateToMermaid(config);
                          setCode(mermaidCode);
                          setRenderMessage("Imported XState machine");
                        } catch (e) {
                          setRenderMessage("Invalid JSON: " + e.message);
                        }
                        setStateDropdown(null);
                      }}>
                        Import XState JSON
                      </button>
                      <button className="dropdown-item" onClick={() => {
                        const xstateConfig = mermaidToXState(code);
                        const jsonStr = JSON.stringify(xstateConfig, null, 2);
                        navigator.clipboard.writeText(jsonStr).then(
                          () => setRenderMessage("XState JSON copied to clipboard"),
                          () => setRenderMessage("XState JSON exported (clipboard unavailable)")
                        );
                        setStateDropdown(null);
                      }}>
                        Export XState JSON
                      </button>
                    </div>
                  </div>
                </>
              )}
              Click, right-click, and drag to edit
            </span>
            <span className="mobile-preview-tip mobile-only">Tap bars to edit</span>
          </div>
          <iframe
            ref={iframeRef}
            title="Mermaid preview"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
            className="preview-frame"
          />
          {showChainView && toolsetKey === "gantt" && criticalPathLabels.length > 0 && (
            <div className="chain-view-panel">
              <div className="chain-view-header">
                <span className="chain-view-title">Critical Path</span>
                <button className="chain-view-close" onClick={() => setShowChainView(false)} title="Close">&times;</button>
              </div>
              <div className="chain-view-body">
                {criticalPathLabels.map((label, idx) => (
                  <div key={label} className="chain-view-node">
                    <div
                      className="chain-view-card"
                      onClick={() => {
                        setSelectedElement({ label, id: "", elementType: "node" });
                        setHighlightLine(getMatchingLine(code, label));
                      }}
                      title={label}
                    >
                      {label}
                    </div>
                    {idx < criticalPathLabels.length - 1 && (
                      <div className="chain-view-arrow">&darr;</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="zoom-controls">
            <button title="Zoom out" onClick={() => {
              if (toolsetKey === "gantt") {
                setGanttZoom((prev) => Math.max(0.2, +(prev - 0.2).toFixed(1)));
              } else {
                const frame = iframeRef.current;
                if (frame?.contentWindow) {
                  frame.contentWindow.postMessage({ channel: CHANNEL, type: "zoom:set", payload: { delta: -0.1 } }, "*");
                }
              }
            }}>-</button>
            <span className="zoom-pct">{toolsetKey === "gantt" ? Math.round(ganttZoom * 100) + "%" : Math.round(zoomLevel * 100) + "%"}</span>
            <button title="Zoom in" onClick={() => {
              if (toolsetKey === "gantt") {
                setGanttZoom((prev) => Math.min(4, +(prev + 0.2).toFixed(1)));
              } else {
                const frame = iframeRef.current;
                if (frame?.contentWindow) {
                  frame.contentWindow.postMessage({ channel: CHANNEL, type: "zoom:set", payload: { delta: 0.1 } }, "*");
                }
              }
            }}>+</button>
            <button title="Reset zoom" onClick={() => {
              if (toolsetKey === "gantt") {
                setGanttZoom(1.0);
              }
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
            <button key={tool.label} className="tool-btn" onClick={() => {
              if (tool.action === "er:import-sql") {
                setSqlImportOpen(true);
              } else if (tool.action === "er:export-sql") {
                const ddl = erDiagramToSql(code);
                if (ddl) {
                  setSqlExportContent(ddl);
                } else {
                  setRenderMessage("No entities to export");
                }
              } else if (tool.snippet) {
                insertSnippet(tool.snippet);
              }
            }}>
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
                  Category / phase
                  <select
                    value={ganttDraft.section}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, section: e.target.value }))}
                  >
                    <option value="">Unsectioned (Tasks)</option>
                    {ganttSectionOptions.map((section) => (
                      <option key={section} value={section}>
                        {section}
                      </option>
                    ))}
                  </select>
                </label>
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
                <label>Assignee</label>
                <AssigneeTagInput
                  value={ganttDraft.assignee}
                  onChange={(val) => setGanttDraft((prev) => ({ ...prev, assignee: val }))}
                  suggestions={allAssignees}
                />
                <label>
                  Link
                  <input
                    type="url"
                    value={ganttDraft.link}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, link: e.target.value }))}
                    placeholder="https://example.com/task"
                  />
                </label>
                <label>
                  Progress
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={ganttDraft.progress || 0}
                      onChange={(e) => setGanttDraft((prev) => ({ ...prev, progress: e.target.value }))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, minWidth: "36px", textAlign: "right" }}>
                      {ganttDraft.progress ? ganttDraft.progress + "%" : "--"}
                    </span>
                  </div>
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

                <div className="milestone-toggle-row">
                  <label className="milestone-toggle-label">
                    <input
                      type="checkbox"
                      checked={ganttDraft.isMilestone}
                      onChange={(e) => setGanttDraft((prev) => ({ ...prev, isMilestone: e.target.checked }))}
                    />
                    <span className="milestone-diamond" />
                    Milestone
                  </label>
                </div>

                <label>Assignee</label>
                <AssigneeTagInput
                  value={ganttDraft.assignee}
                  onChange={(val) => setGanttDraft((prev) => ({ ...prev, assignee: val }))}
                  suggestions={allAssignees}
                />

                <label>
                  Link
                  <input
                    type="url"
                    value={ganttDraft.link}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, link: e.target.value }))}
                    placeholder="https://example.com/task"
                  />
                </label>

                <label>
                  Category / phase
                  <select
                    value={ganttDraft.section}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, section: e.target.value }))}
                  >
                    <option value="">Unsectioned (Tasks)</option>
                    {ganttSectionOptions.map((section) => (
                      <option key={section} value={section}>
                        {section}
                      </option>
                    ))}
                  </select>
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
                  Depends on
                  <div className="dep-picker">
                    {ganttDraft.dependsOn.map((depId, depIdx) => {
                      const depTask = ganttTasks.find((t) => (t.idToken || "").toLowerCase() === depId.toLowerCase() || (t.label || "").toLowerCase() === depId.toLowerCase());
                      return (
                        <span className="dep-pill" key={`${depId}-${depIdx}`}>
                          {depTask ? depTask.label : depId}
                          <button
                            type="button"
                            onClick={() => {
                              console.log("[DEP-DEBUG] X clicked", { depId, locked: ganttDraftLockedRef.current });
                              setGanttDraft((prev) => {
                              console.log("[DEP-DEBUG] X updater running", { prevDeps: prev.dependsOn, removing: depId });
                              const idx = prev.dependsOn.indexOf(depId);
                              if (idx < 0) return prev;
                              const next = [...prev.dependsOn];
                              next.splice(idx, 1);
                              console.log("[DEP-DEBUG] X result", { newDeps: next });
                              return { ...prev, dependsOn: next };
                            });
                            }}
                          >
                            &times;
                          </button>
                        </span>
                      );
                    })}
                    {(() => {
                      const currentLabel = task?.label || contextMenu.label;
                      const available = ganttTasks.filter((t) => !t.isVertMarker && t.label !== currentLabel && !ganttDraft.dependsOn.includes(t.idToken || t.label));
                      return (
                        <div className="dep-search-wrap">
                          <input
                            className="dep-search-input"
                            type="text"
                            placeholder="Search tasks..."
                            value={ganttDraft._depSearch || ""}
                            onChange={(e) => setGanttDraft((prev) => ({ ...prev, _depSearch: e.target.value }))}
                            onFocus={() => setGanttDraft((prev) => ({ ...prev, _depOpen: true }))}
                            onBlur={() => setTimeout(() => setGanttDraft((prev) => ({ ...prev, _depOpen: false })), 150)}
                          />
                          {ganttDraft._depOpen && (() => {
                            const query = (ganttDraft._depSearch || "").toLowerCase();
                            const filtered = query ? available.filter((t) => t.label.toLowerCase().includes(query) || (t.idToken || "").toLowerCase().includes(query)) : available;
                            if (!filtered.length) return <div className="dep-dropdown"><div className="dep-dropdown-empty">No matching tasks</div></div>;
                            return (
                              <div className="dep-dropdown">
                                {filtered.map((t) => {
                                  const id = t.idToken || t.label;
                                  return (
                                    <button
                                      key={id}
                                      type="button"
                                      className="dep-dropdown-item"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        setGanttDraft((prev) => ({
                                          ...prev,
                                          dependsOn: prev.dependsOn.includes(id) ? prev.dependsOn : [...prev.dependsOn, id],
                                          _depSearch: "",
                                          _depOpen: false,
                                        }));
                                      }}
                                    >
                                      {t.label}{t.idToken && t.idToken !== t.label ? <span className="dep-dropdown-id"> ({t.idToken})</span> : ""}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </div>
                </label>

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

                <label>
                  Progress
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={ganttDraft.progress || 0}
                      onChange={(e) => setGanttDraft((prev) => ({ ...prev, progress: e.target.value }))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, minWidth: "36px", textAlign: "right" }}>
                      {ganttDraft.progress ? ganttDraft.progress + "%" : "--"}
                    </span>
                  </div>
                </label>
              </div>

              <div className="task-modal-actions">
                <button
                  className="soft-btn danger push-left"
                  onClick={() => {
                    handleDeleteGanttTask(task?.label || contextMenu.label);
                    setContextMenu(null);
                  }}
                >
                  Delete
                </button>
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

      {/* ── Gantt Delete Confirmation Dialog ──────────── */}
      {ganttDeleteConfirm && (() => {
        const { task, dependents, directDependents } = ganttDeleteConfirm;
        return (
          <div className="modal-backdrop" onClick={() => setGanttDeleteConfirm(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
              <h2>Delete Task</h2>
              <p style={{ margin: "0 0 12px", fontSize: "0.88rem", lineHeight: 1.5 }}>
                <strong>{task.label}</strong> has {dependents.length === 1 ? "1 task" : `${dependents.length} tasks`} in its dependency chain:
              </p>
              <ul style={{ margin: "0 0 16px", paddingLeft: 20, fontSize: "0.85rem", lineHeight: 1.6 }}>
                {dependents.map((d) => {
                  const isDirect = directDependents.some((dd) => dd.label === d.label);
                  return (
                    <li key={d.label}>
                      {d.label}
                      {isDirect && <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}> (direct)</span>}
                    </li>
                  );
                })}
              </ul>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button
                  className="soft-btn"
                  onClick={() => setGanttDeleteConfirm(null)}
                >
                  Cancel
                </button>
                <button
                  className="soft-btn danger"
                  onClick={() => {
                    handleDeleteGanttTask(task.label, "deleteAll");
                    setContextMenu(null);
                  }}
                >
                  Delete All ({dependents.length + 1})
                </button>
                <button
                  className="soft-btn primary"
                  onClick={() => {
                    handleDeleteGanttTask(task.label, "taskOnly");
                    setContextMenu(null);
                  }}
                >
                  Delete Task Only
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
                {toolsetKey === "sequenceDiagram" && (
                  <label>
                    Type
                    <select
                      value={nodeEditModal.participantType || "participant"}
                      onChange={(e) => setNodeEditModal((prev) => ({ ...prev, participantType: e.target.value }))}
                    >
                      <option value="participant">Participant (box)</option>
                      <option value="actor">Actor (stick figure)</option>
                    </select>
                  </label>
                )}
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
                  commitSnapshotNow();
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
                  commitSnapshotNow();
                  if (isFlowchart) {
                    // Recombine label + description with <br> tags
                    let combinedLabel = nodeEditModal.label || "";
                    if (nodeEditModal.description) {
                      combinedLabel += "<br>" + nodeEditModal.description.split("\n").join("<br>");
                    }
                    const updates = { label: combinedLabel };
                    setCode((prev) => updateFlowchartNode(prev, nodeEditModal.nodeId, updates));
                  } else if (adapter?.updateNode) {
                    setCode((prev) =>
                      adapter.updateNode(prev, nodeEditModal.nodeId, {
                        label: nodeEditModal.label,
                        attributes: nodeEditModal.attributes,
                        newName: nodeEditModal.label,
                        participantType: nodeEditModal.participantType,
                      })
                    );
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
                commitSnapshotNow();
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
        const seqArrowTypes = [
          { value: "->>", label: "Sync (solid)" },
          { value: "-->>", label: "Async (dashed)" },
          { value: "->", label: "Solid open" },
          { value: "-->", label: "Dashed open" },
          { value: "-x", label: "Lost (solid)" },
          { value: "--x", label: "Lost (dashed)" },
          { value: "-)", label: "Async (solid)" },
          { value: "--)", label: "Async (dashed)" },
        ];
        const isSeq = toolsetKey === "sequenceDiagram";
        const adapter = getDiagramAdapter(toolsetKey);
        return (
          <div className="modal-backdrop" onClick={() => setNodeEditModal(null)}>
            <div className="node-edit-modal" onClick={(e) => e.stopPropagation()}>
              <div className="task-modal-header">
                <h2>{isSeq ? "Edit Message" : "Edit Edge"}</h2>
                <button className="drawer-close-btn" onClick={() => setNodeEditModal(null)}>&times;</button>
              </div>
              <div className="task-modal-body">
                <label>
                  Label
                  <input
                    value={nodeEditModal.label}
                    onChange={(e) => setNodeEditModal((prev) => ({ ...prev, label: e.target.value }))}
                    placeholder={isSeq ? "e.g. HTTP GET /users..." : "e.g. Yes, No..."}
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
                {isSeq && (
                  <>
                    <label>Arrow Type</label>
                    <div className="arrow-type-grid">
                      {seqArrowTypes.map(({ value, label }) => (
                        <button
                          key={value}
                          className={`arrow-type-btn ${nodeEditModal.arrowType === value ? "active" : ""}`}
                          onClick={() => setNodeEditModal((prev) => ({ ...prev, arrowType: value }))}
                        >
                          <code style={{ fontSize: 11 }}>{value}</code>
                          <span style={{ fontSize: 10, opacity: 0.7 }}>{label}</span>
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
                  commitSnapshotNow();
                  if (isSeq && nodeEditModal.messageIndex !== undefined) {
                    setCode((prev) => removeSequenceMessageByIndex(prev, nodeEditModal.messageIndex));
                    setRenderMessage("Deleted message");
                  } else if (toolsetKey === "flowchart") {
                    setCode((prev) => removeFlowchartEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget));
                    setPositionOverrides({});
                    setRenderMessage(`Deleted edge ${nodeEditModal.edgeSource} --> ${nodeEditModal.edgeTarget}`);
                  } else if (adapter?.removeEdge) {
                    setCode((prev) => adapter.removeEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget));
                    setRenderMessage(`Deleted edge ${nodeEditModal.edgeSource} -> ${nodeEditModal.edgeTarget}`);
                  } else {
                    setRenderMessage("Edge delete is not supported for this diagram type");
                  }
                  setNodeEditModal(null);
                }}>
                  Delete
                </button>
                <button className="soft-btn primary" onClick={() => {
                  commitSnapshotNow();
                  const updates = {};
                  if (nodeEditModal.label !== undefined) updates.label = nodeEditModal.label;
                  if (nodeEditModal.arrowType) updates.arrowType = nodeEditModal.arrowType;
                  if (isSeq && nodeEditModal.messageIndex !== undefined) {
                    setCode((prev) => updateSequenceMessageByIndex(prev, nodeEditModal.messageIndex, updates));
                    setRenderMessage("Updated message");
                  } else if (toolsetKey === "flowchart") {
                    setCode((prev) => updateFlowchartEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget, updates));
                    setRenderMessage("Updated edge");
                  } else if (adapter?.updateEdge) {
                    setCode((prev) => adapter.updateEdge(prev, nodeEditModal.edgeSource, nodeEditModal.edgeTarget, updates));
                    setRenderMessage("Updated edge");
                  } else {
                    setRenderMessage("Edge update is not supported for this diagram type");
                  }
                  setNodeEditModal(null);
                }}>
                  Apply
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── SQL Import Modal ─────────────────────────────── */}
      {sqlImportOpen && (
        <div className="modal-backdrop" onClick={() => { setSqlImportOpen(false); setSqlImportValue(""); }}>
          <div className="node-edit-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-header">
              <h2>Import SQL</h2>
              <button className="drawer-close-btn" onClick={() => { setSqlImportOpen(false); setSqlImportValue(""); }}>&times;</button>
            </div>
            <div className="task-modal-body">
              <label>
                Paste CREATE TABLE statements
                <textarea
                  className="task-notes-input"
                  value={sqlImportValue}
                  onChange={(e) => setSqlImportValue(e.target.value)}
                  placeholder={"CREATE TABLE users (\n  id INT PRIMARY KEY,\n  name VARCHAR(100),\n  email VARCHAR(255) UNIQUE\n);\n\nCREATE TABLE orders (\n  id INT PRIMARY KEY,\n  user_id INT REFERENCES users(id),\n  total DECIMAL(10,2)\n);"}
                  rows={12}
                  autoFocus
                  style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 12 }}
                />
              </label>
            </div>
            <div className="task-modal-actions">
              <button className="soft-btn" onClick={() => { setSqlImportOpen(false); setSqlImportValue(""); }}>Cancel</button>
              <button className="soft-btn primary" onClick={() => {
                const result = sqlToErDiagram(sqlImportValue);
                if (result) {
                  setCode(result);
                  setPositionOverrides({});
                  setRenderMessage("Imported SQL as ER diagram");
                } else {
                  setRenderMessage("No CREATE TABLE statements found");
                }
                setSqlImportOpen(false);
                setSqlImportValue("");
              }}>
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SQL Export Modal ──────────────────────────────── */}
      {sqlExportContent && (
        <div className="modal-backdrop" onClick={() => setSqlExportContent(null)}>
          <div className="node-edit-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-header">
              <h2>Export as SQL (PostgreSQL)</h2>
              <button className="drawer-close-btn" onClick={() => setSqlExportContent(null)}>&times;</button>
            </div>
            <div className="task-modal-body">
              <textarea
                className="task-notes-input"
                value={sqlExportContent}
                readOnly
                rows={16}
                style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 12 }}
                onClick={(e) => e.target.select()}
              />
            </div>
            <div className="task-modal-actions">
              <button className="soft-btn" onClick={() => setSqlExportContent(null)}>Close</button>
              <button className="soft-btn primary" onClick={() => {
                navigator.clipboard.writeText(sqlExportContent).then(() => {
                  setRenderMessage("SQL copied to clipboard");
                  setSqlExportContent(null);
                });
              }}>
                Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Message Creation Modal (Sequence) ───────────── */}
      {messageCreationForm && (() => {
        const seqArrows = [
          { value: "->>",  label: "Sync (solid)" },
          { value: "-->>", label: "Async (dashed)" },
          { value: "->",   label: "Solid open" },
          { value: "-->",  label: "Dashed open" },
          { value: "-x",   label: "Lost (solid)" },
          { value: "--x",  label: "Lost (dashed)" },
          { value: "-)",   label: "Async open (solid)" },
          { value: "--)",  label: "Async open (dashed)" },
        ];
        return (
          <div className="modal-backdrop" onClick={() => setMessageCreationForm(null)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
              <h3>Add Message</h3>
              <div style={{ marginBottom: 12, fontSize: 13, color: "var(--text-secondary)" }}>
                {messageCreationForm.source} → {messageCreationForm.target}
              </div>
              <label>
                Label
                <input
                  type="text"
                  value={messageCreationForm.text}
                  onChange={(e) => setMessageCreationForm((prev) => ({ ...prev, text: e.target.value }))}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setCode((prev) => addSequenceMessage(prev, {
                        source: messageCreationForm.source,
                        target: messageCreationForm.target,
                        text: messageCreationForm.text,
                        arrowType: messageCreationForm.arrowType,
                      }));
                      setRenderMessage(`Added message ${messageCreationForm.source} → ${messageCreationForm.target}`);
                      setMessageCreationForm(null);
                    }
                  }}
                />
              </label>
              <label style={{ marginTop: 8 }}>Arrow type</label>
              <div className="arrow-type-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 4 }}>
                {seqArrows.map((a) => (
                  <button
                    key={a.value}
                    className={`soft-btn${messageCreationForm.arrowType === a.value ? " primary" : ""}`}
                    style={{ fontSize: 12, padding: "4px 8px", textAlign: "left" }}
                    onClick={() => setMessageCreationForm((prev) => ({ ...prev, arrowType: a.value }))}
                  >
                    <code style={{ marginRight: 4 }}>{a.value}</code> {a.label}
                  </button>
                ))}
              </div>
              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button className="soft-btn" onClick={() => setMessageCreationForm(null)}>Cancel</button>
                <button className="soft-btn primary" onClick={() => {
                  setCode((prev) => addSequenceMessage(prev, {
                    source: messageCreationForm.source,
                    target: messageCreationForm.target,
                    text: messageCreationForm.text,
                    arrowType: messageCreationForm.arrowType,
                  }));
                  setRenderMessage(`Added message ${messageCreationForm.source} → ${messageCreationForm.target}`);
                  setMessageCreationForm(null);
                }}>
                  Add
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
        const isMulti = !!(styleToolbar.multiNodeIds && styleToolbar.multiNodeIds.length > 1);
        const toolbarHeight = 40;
        const gap = 8;
        let top = styleToolbar.y - toolbarHeight - gap;
        if (top < 8) top = styleToolbar.yBottom + gap;
        const left = styleToolbar.x;
        const classDefs = isFlowchart ? parseClassDefs(code) : [];

        const applyStyleToSelection = (patch) => {
          if (isMulti) {
            commitSnapshotNow();
            for (const nid of styleToolbar.multiNodeIds) applyToolbarStyle(nid, patch);
          } else {
            applyToolbarStyle(styleToolbar.nodeId, patch);
          }
        };

        return (
          <div
            className="style-toolbar"
            style={{ top, left, transform: "translateX(-50%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Multi-select count */}
            {isMulti && (
              <span className="style-toolbar-count" title={styleToolbar.multiNodeIds.length + " nodes selected"}>
                {styleToolbar.multiNodeIds.length}
              </span>
            )}
            {/* Edit (hidden for multi-select) */}
            {!isMulti && <button
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
            </button>}

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
                    commitSnapshotNow();
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
              title={isMulti ? `Delete ${styleToolbar.multiNodeIds.length} nodes` : "Delete node"}
              onClick={() => {
                commitSnapshotNow();
                if (isMulti && isFlowchart) {
                  setCode((prev) => {
                    let c = prev;
                    for (const nid of styleToolbar.multiNodeIds) c = removeFlowchartNode(c, nid);
                    return c;
                  });
                  setPositionOverrides({});
                  setRenderMessage(`Deleted ${styleToolbar.multiNodeIds.length} nodes`);
                  setSelectedNodeIds(new Set());
                  setSelectedElement(null);
                } else {
                  const adapter = getDiagramAdapter(toolsetKey);
                  if (isFlowchart) {
                    setCode((prev) => removeFlowchartNode(prev, styleToolbar.nodeId));
                  } else if (adapter?.removeNode) {
                    setCode((prev) => adapter.removeNode(prev, styleToolbar.nodeId));
                  }
                  setPositionOverrides({});
                  setRenderMessage(`Deleted "${styleToolbar.nodeId}"`);
                }
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
                      onClick={() => applyStyleToSelection({ fill: color })}
                    />
                  ))}
                </div>
                {existingStyle.fill && (
                  <button className="style-toolbar-clear" onClick={() => applyStyleToSelection({ fill: null })}>
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
                            applyStyleToSelection(patch);
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
                      onClick={() => applyStyleToSelection({ stroke: color })}
                    />
                  ))}
                </div>
                {existingStyle.stroke && (
                  <button className="style-toolbar-clear" onClick={() => applyStyleToSelection({ stroke: null })}>
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
                      onClick={() => applyStyleToSelection({ strokeStyle: value })}
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
                      onClick={() => applyStyleToSelection({ textColor: color })}
                    />
                  ))}
                </div>
                {existingStyle.textColor && (
                  <button className="style-toolbar-clear" onClick={() => applyStyleToSelection({ textColor: null })}>
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
                    commitSnapshotNow();
                    const newId = generateNodeId(flowchartData.nodes);
                    setCode((prev) => addFlowchartNode(prev, { id: newId, label: "New Node", shape: "rect" }));
                    setPositionOverrides({});
                    setRenderMessage(`Added node "${newId}"`);
                    setContextMenu(null);
                  }}>
                    Add node
                  </button>
                  <button className="context-menu-item" onClick={() => {
                    commitSnapshotNow();
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
                  commitSnapshotNow();
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
              {isFlowchart && selectedNodeIds.size > 1 && (
                <button className="context-menu-item" onClick={() => {
                  const label = window.prompt("Subgraph name");
                  if (label && label.trim()) {
                    commitSnapshotNow();
                    setCode((prev) => createSubgraph(prev, [...selectedNodeIds], label.trim()));
                    setPositionOverrides({});
                    setSelectedNodeIds(new Set());
                    setRenderMessage(`Grouped ${selectedNodeIds.size} nodes into "${label.trim()}"`);
                  }
                  setContextMenu(null);
                }}>
                  Group into subgraph
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

      {/* ── Subgraph Context Menu ────────────────────────── */}
      {contextMenu?.type === "subgraph" && (
        <div className="context-menu-backdrop" onClick={() => setContextMenu(null)}>
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="context-menu-item" onClick={() => {
              const newLabel = window.prompt("Rename subgraph", contextMenu.label);
              if (newLabel && newLabel.trim() && newLabel.trim() !== contextMenu.label) {
                commitSnapshotNow();
                setCode((prev) => renameSubgraph(prev, contextMenu.subgraphId, newLabel.trim()));
                setRenderMessage(`Renamed subgraph to "${newLabel.trim()}"`);
              }
              setContextMenu(null);
            }}>
              Rename
            </button>
            <button className="context-menu-item" onClick={() => {
              commitSnapshotNow();
              setCode((prev) => removeSubgraph(prev, contextMenu.subgraphId));
              setPositionOverrides({});
              setRenderMessage(`Ungrouped "${contextMenu.label}"`);
              setContextMenu(null);
            }}>
              Ungroup (keep nodes)
            </button>
          </div>
        </div>
      )}

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
                { shape: "double-circle", label: "Double Circle", icon: "((( )))" },
                { shape: "hexagon", label: "Hexagon", icon: "{{ }}" },
                { shape: "subroutine", label: "Subroutine", icon: "[[ ]]" },
                { shape: "cylinder", label: "Cylinder", icon: "[( )]" },
                { shape: "parallelogram", label: "Lean Right", icon: "[/ /]" },
                { shape: "parallelogram-alt", label: "Lean Left", icon: "[\\ \\]" },
                { shape: "trapezoid", label: "Trapezoid", icon: "[/ \\]" },
                { shape: "trapezoid-alt", label: "Trapezoid Alt", icon: "[\\ /]" },
                { shape: "asymmetric", label: "Asymmetric", icon: "> ]" },
                { shape: "document", label: "Document", icon: "doc" },
                { shape: "cloud", label: "Cloud", icon: "cloud" },
                { shape: "triangle", label: "Triangle", icon: "tri" },
                { shape: "flag", label: "Flag", icon: "flag" },
                { shape: "delay", label: "Delay", icon: "delay" },
                { shape: "lined-rect", label: "Lined Rect", icon: "lin" },
                { shape: "stacked-rect", label: "Multi-Process", icon: "procs" },
                { shape: "documents", label: "Multi-Doc", icon: "docs" },
                { shape: "text-block", label: "Text Block", icon: "text" },
              ].map(({ shape, label, icon }) => (
                <button
                  key={shape}
                  className="shape-btn"
                  onClick={() => {
                    commitSnapshotNow();
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
                commitSnapshotNow();
                setCode((prev) => updateFlowchartEdge(prev, edgeLabelEdit.source, edgeLabelEdit.target, { label: edgeLabelEdit.label }));
                setRenderMessage(`Updated edge label`);
                setEdgeLabelEdit(null);
              }}>Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Transition Label Modal (State Diagram) ────── */}
      {transitionLabelModal && (
        <div className="modal-backdrop" onClick={() => setTransitionLabelModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>New Transition</h2>
            <p style={{ margin: "0 0 12px", color: "#64748b", fontSize: 13 }}>
              {transitionLabelModal.sourceId} &rarr; {transitionLabelModal.targetId}
            </p>
            <label>
              Event name
              <input
                value={transitionLabelModal.label || ""}
                onChange={(e) => setTransitionLabelModal((prev) => ({ ...prev, label: e.target.value }))}
                placeholder="e.g. click, submit, timeout..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const { sourceId, targetId, label } = transitionLabelModal;
                    setCode((prev) => addStateDiagramTransition(prev, { source: sourceId, target: targetId, label: label || "" }));
                    setRenderMessage(`Added transition ${sourceId} \u2192 ${targetId}${label ? " : " + label : ""}`);
                    setTransitionLabelModal(null);
                  }
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setTransitionLabelModal(null)}>Cancel</button>
              <button className="soft-btn primary" onClick={() => {
                const { sourceId, targetId, label } = transitionLabelModal;
                setCode((prev) => addStateDiagramTransition(prev, { source: sourceId, target: targetId, label: label || "" }));
                setRenderMessage(`Added transition ${sourceId} \u2192 ${targetId}${label ? " : " + label : ""}`);
                setTransitionLabelModal(null);
              }}>Add Transition</button>
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
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
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
                      config: mermaidRenderConfig,
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

      {/* ── Save Dialog ────────────────────────────────── */}
      {saveDialogOpen && (
        <div className="modal-overlay" onClick={() => setSaveDialogOpen(false)}>
          <div className="modal save-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Save Local Diagram</h3>
            <p style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 0 }}>
              This saves to your browser only. Use "Save to Cloud" for Firebase autosave.
            </p>
            <input
              type="text"
              className="modal-input"
              placeholder="Diagram name..."
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveDiagram(); }}
              autoFocus
            />
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setSaveDialogOpen(false)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleSaveDiagram}>Save</button>
            </div>
            {savedDiagrams.length > 0 && (
              <div className="saved-list">
                <h4>Saved Diagrams</h4>
                {savedDiagrams.map((d) => (
                  <div key={d.name} className="saved-item">
                    <button className="saved-item-name" onClick={() => { handleLoadDiagram(d); setSaveDialogOpen(false); }}>
                      {d.name}
                    </button>
                    <span className="saved-item-date">{new Date(d.updatedAt).toLocaleDateString()}</span>
                    <button className="saved-item-delete" title="Delete" onClick={() => handleDeleteDiagram(d.name)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Share Dialog ───────────────────────────────── */}
      {shareDialogOpen && flowId && (
        <ShareDialog flowId={flowId} onClose={() => setShareDialogOpen(false)} />
      )}

      {/* ── Comment Panel ──────────────────────────────── */}
      {commentPanelOpen && flowId && (
        <CommentPanel
          flowId={flowId}
          allowAnonymous={!currentUser && hasPublicCommentAccess}
          onClose={() => setCommentPanelOpen(false)}
        />
      )}

      {/* ── Version History Panel ──────────────────────── */}
      {versionPanelOpen && flowId && (
        <VersionHistoryPanel
          flowId={flowId}
          currentCode={code}
          onRestore={(restoredCode, restoredType, restoredTabs) => {
            if (restoredTabs && restoredTabs.length > 0) {
              setDiagramTabs(restoredTabs);
              setActiveTabId(restoredTabs[0].id);
              setCode(restoredTabs[0].code);
            } else {
              setDiagramTabs([{ id: "tab-0", label: "Main", code: restoredCode }]);
              setActiveTabId("tab-0");
              setCode(restoredCode);
            }
            clearHistory();
            if (restoredType) setDiagramType(restoredType);
            setVersionPanelOpen(false);
            setRenderMessage("Version restored");
          }}
          onClose={() => setVersionPanelOpen(false)}
        />
      )}

      {/* ── Resource Load Panel ─────────────────────────── */}
      {resourcePanelOpen && toolsetKey === "gantt" && (
        <ResourceLoadPanel
          tasks={resolvedGanttTasks}
          onClose={() => setResourcePanelOpen(false)}
        />
      )}

      {/* ── Notion Sync Panel ──────────────────────────── */}
      {ENABLE_NOTION_INTEGRATION && notionSyncOpen && (
        <div className="modal-overlay" onClick={() => setNotionSyncOpen(false)}>
          <div className="modal save-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Notion Gantt Sync</h3>
            <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 12 }}>
              Sync your Gantt chart with a Notion database. Keys are loaded from your{" "}
              <button
                className="auth-link"
                style={{ fontSize: 12 }}
                onClick={() => navigate("/settings")}
              >Settings</button>
              {" "}— or override below for this session.
            </p>
            <div className="settings-field" style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 500 }}>Database ID</label>
              <input
                className="modal-input"
                placeholder="Notion Database ID"
                value={notionDbId}
                onChange={(e) => setNotionDbId(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label style={{ fontSize: 12, fontWeight: 500 }}>Integration Token</label>
              <input
                className="modal-input"
                placeholder="ntn_..."
                value={notionToken}
                onChange={(e) => setNotionToken(e.target.value)}
                type="password"
              />
            </div>
            {!notionToken && (
              <p style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
                No token configured.{" "}
                <button className="auth-link" style={{ fontSize: 11 }} onClick={() => navigate("/settings")}>
                  Add one in Settings
                </button>
              </p>
            )}
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="soft-btn" onClick={handleNotionImport} disabled={!notionToken || !notionDbId}>
                Import from Notion
              </button>
              <button className="soft-btn primary" onClick={handleNotionSync} disabled={!notionToken || !notionDbId}>
                Export to Notion
              </button>
              <button className="soft-btn" onClick={handleCopyNotionPayload} disabled={!notionDbId}>
                Copy payload
              </button>
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 12 }}>
              Note: Direct Notion API calls require a server proxy due to CORS.
              If proxy sync fails, payloads are copied so you can send them from your own server.
            </p>
          </div>
        </div>
      )}

      {/* ── AI Generate Modal ────────────────────────── */}
      {aiModalOpen && (
        <div className="modal-overlay" onClick={() => !aiLoading && setAiModalOpen(false)}>
          <div className="modal save-modal ai-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Create with AI</h3>
            <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 12 }}>
              Describe your project and we'll generate a Mermaid diagram for you.
            </p>

            <div className="settings-field" style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 500 }}>Chart type</label>
              <select
                className="modal-input"
                value={aiChartType}
                onChange={(e) => setAiChartType(e.target.value)}
                disabled={aiLoading}
                style={{ padding: "6px 10px" }}
              >
                <option value="gantt">Gantt Chart</option>
                <option value="flowchart">Flowchart</option>
                <option value="sequenceDiagram">Sequence Diagram</option>
                <option value="erDiagram">ER Diagram</option>
                <option value="classDiagram">Class Diagram</option>
                <option value="stateDiagram">State Diagram</option>
                <option value="mindmap">Mindmap</option>
                <option value="timeline">Timeline</option>
                <option value="pie">Pie Chart</option>
                <option value="journey">User Journey</option>
              </select>
            </div>

            <div className="settings-field">
              <label style={{ fontSize: 12, fontWeight: 500 }}>Describe your project</label>
              <textarea
                className="modal-input ai-context-input"
                placeholder={"e.g. A 3-month product launch plan with design, development,\nQA, and marketing phases. Team of 5 people. Launch date is June 15."}
                value={aiContext}
                onChange={(e) => setAiContext(e.target.value)}
                disabled={aiLoading}
                rows={6}
                style={{ resize: "vertical", minHeight: 100 }}
              />
            </div>

            {aiError && (
              <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{aiError}</p>
            )}

            {aiLoading && (
              <p style={{ fontSize: 13, color: "var(--accent)", marginTop: 12 }}>
                Generating your diagram...
              </p>
            )}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button
                className="soft-btn"
                onClick={() => { setAiModalOpen(false); setAiError(""); }}
                disabled={aiLoading}
              >
                Cancel
              </button>
              <button
                className="soft-btn primary"
                onClick={handleAiGenerate}
                disabled={aiLoading || !aiContext.trim()}
              >
                {aiLoading ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {aiPreviewOpen && aiPreview && (
        <div className="modal-overlay" onClick={handleAiPreviewReject}>
          <div className="modal save-modal ai-preview-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{aiPreview.title}</h3>
            {aiPreview.summary && (
              <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 12 }}>
                {aiPreview.summary}
              </p>
            )}

            <div className="settings-field">
              <label style={{ fontSize: 12, fontWeight: 500 }}>Generated code</label>
              <pre className="ai-preview-code">
                {aiPreview.code}
              </pre>
            </div>

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="soft-btn" onClick={handleAiPreviewReject}>
                Reject
              </button>
              <button className="soft-btn primary" onClick={handleAiPreviewAccept}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {convertModalOpen && (
        <div className="modal-overlay" onClick={() => !convertLoading && setConvertModalOpen(false)}>
          <div className="modal save-modal ai-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Convert Diagram</h3>
            <p style={{ fontSize: 12, color: "var(--ink-muted)", marginBottom: 12 }}>
              Convert your current {diagramType || "diagram"} to a different chart type.
            </p>

            <div className="settings-field" style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 500 }}>Current type</label>
              <input
                className="modal-input"
                value={diagramType || "unknown"}
                disabled
                style={{ padding: "6px 10px", opacity: 0.7 }}
              />
            </div>

            <div className="settings-field" style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 500 }}>Convert to</label>
              <select
                className="modal-input"
                value={convertTargetType}
                onChange={(e) => setConvertTargetType(e.target.value)}
                disabled={convertLoading}
                style={{ padding: "6px 10px" }}
              >
                <option value="gantt">Gantt Chart</option>
                <option value="flowchart">Flowchart</option>
                <option value="sequenceDiagram">Sequence Diagram</option>
                <option value="erDiagram">ER Diagram</option>
                <option value="classDiagram">Class Diagram</option>
                <option value="stateDiagram">State Diagram</option>
                <option value="mindmap">Mindmap</option>
                <option value="timeline">Timeline</option>
                <option value="pie">Pie Chart</option>
                <option value="journey">User Journey</option>
              </select>
            </div>

            <div className="settings-field">
              <label style={{ fontSize: 12, fontWeight: 500 }}>Code preview</label>
              <pre
                style={{
                  fontSize: 11,
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  padding: 10,
                  maxHeight: 120,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: "var(--ink-soft)",
                }}
              >
                {code.length > 500 ? code.slice(0, 500) + "\n..." : code}
              </pre>
            </div>

            {convertError && (
              <p style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{convertError}</p>
            )}

            {convertLoading && (
              <p style={{ fontSize: 13, color: "var(--accent)", marginTop: 12 }}>
                Converting your diagram...
              </p>
            )}

            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button
                className="soft-btn"
                onClick={() => { setConvertModalOpen(false); setConvertError(""); }}
                disabled={convertLoading}
              >
                Cancel
              </button>
              <button
                className="soft-btn primary"
                onClick={handleAiConvert}
                disabled={convertLoading || !code.trim()}
              >
                {convertLoading ? "Converting..." : "Convert"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
