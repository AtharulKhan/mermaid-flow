import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";
import { findTaskByLabel, parseGanttTasks, shiftIsoDate, updateGanttTask } from "./ganttUtils";

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
      #error {
        margin-top: 12px;
        font-size: 13px;
        color: #7e1f34;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="canvas"></div>
      <div id="error"></div>
    </div>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

      let selected = null;
      let dragState = null;
      let suppressClick = false;
      let currentDiagramType = "";
      const canvas = document.getElementById("canvas");
      const error = document.getElementById("error");

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
              const texts = Array.from(parent.querySelectorAll("text.taskText"));
              const idx = rects.filter(r => /\\btask\\b/.test(r.className?.baseVal || "")).indexOf(target);
              if (idx >= 0 && idx < texts.length) {
                textNode = texts[idx];
              }
            }
          }

          if (!textNode && target.nodeName === "text" && /\\btaskText\\b/.test(cls)) {
            // User clicked the label text directly
            textNode = target;
          }
        }

        // Non-Gantt fallback
        if (!textNode) {
          textNode = group.querySelector("text") || target.closest("text");
        }

        const label = textNode?.textContent?.trim() || target.getAttribute("id") || target.nodeName;
        const rect = target.getBBox ? target.getBBox() : null;
        return {
          id: target.id || group.id || "",
          className: group.className?.baseVal || target.className?.baseVal || "",
          label,
          nodeName: target.nodeName,
          barWidth: rect?.width || 0,
        };
      };

      const isGanttTaskTarget = (target) => {
        if (!target) return false;
        if (!currentDiagramType.toLowerCase().includes("gantt")) return false;
        const cls = target.className?.baseVal || "";
        if (!/task/i.test(cls)) return false;
        return target.nodeName === "rect" || target.nodeName === "g";
      };

      const wireSelection = (svg) => {
        const clearDrag = () => {
          if (!dragState) return;
          if (dragState.node) {
            dragState.node.removeAttribute("transform");
            dragState.node.style.cursor = "";
          }
          dragState = null;
          suppressClick = false;
        };

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
          const dragNode = target.closest("g") || target;
          if (!dragNode) return;

          dragState = {
            target,
            node: dragNode,
            startX: event.clientX,
            startY: event.clientY,
            deltaX: 0,
            deltaY: 0,
            ganttTask: isGanttTaskTarget(target),
          };
          dragNode.style.cursor = "grabbing";
        });

        svg.addEventListener("pointermove", (event) => {
          if (!dragState) return;
          dragState.deltaX = event.clientX - dragState.startX;
          dragState.deltaY = event.clientY - dragState.startY;
          if (Math.abs(dragState.deltaX) > 3 || Math.abs(dragState.deltaY) > 3) {
            suppressClick = true;
          }
          dragState.node.setAttribute(
            "transform",
            "translate(" + dragState.deltaX + " " + dragState.deltaY + ")"
          );
        });

        svg.addEventListener("pointerup", () => {
          if (!dragState) return;
          const threshold = Math.abs(dragState.deltaX) + Math.abs(dragState.deltaY);
          const payload = {
            ...extractInfo(dragState.target),
            deltaX: dragState.deltaX,
            deltaY: dragState.deltaY,
            isGanttTask: dragState.ganttTask,
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

      window.addEventListener("message", async (event) => {
        const data = event.data;
        if (!data || data.channel !== "${CHANNEL}" || data.type !== "render") return;

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
  const [ganttDraft, setGanttDraft] = useState({ label: "", startDate: "", duration: "" });

  // UI state
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presentMode, setPresentMode] = useState(false);
  const [editorWidth, setEditorWidth] = useState(30);

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
      setGanttDraft({ label: "", startDate: "", duration: "" });
      return;
    }
    setGanttDraft({
      label: selectedGanttTask.label || "",
      startDate: selectedGanttTask.startDate || "",
      duration: selectedGanttTask.durationToken || "",
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
        setRenderMessage("Context target selected");
        setDrawerOpen(true);
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

        const nextDate = shiftIsoDate(task.startDate, dayShift);
        setCode((prev) => updateGanttTask(prev, task, { startDate: nextDate }));
        setRenderMessage(`Updated "${task.label}" start date to ${nextDate}`);
        setHighlightLine(task.lineIndex + 1);
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [code, ganttTasks]);

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
        if (presentMode) { setPresentMode(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (drawerOpen) { setDrawerOpen(false); return; }
        if (exportMenuOpen) { setExportMenuOpen(false); return; }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [presentMode, settingsOpen, drawerOpen, exportMenuOpen]);

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
    const nextDuration = ganttDraft.duration.trim();
    const updated = updateGanttTask(code, selectedGanttTask, {
      label: nextLabel,
      startDate: nextStartDate || selectedGanttTask.startDate,
      duration: nextDuration || selectedGanttTask.durationToken,
    });

    setCode(updated);
    setRenderMessage("Gantt task updated");
    setHighlightLine(selectedGanttTask.lineIndex + 1);
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
            <span>Click, right-click, and drag to edit</span>
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
          <h2>Quick Tools</h2>
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

        {/* Selection Inspector */}
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

        {/* Gantt Task Editor */}
        {toolsetKey === "gantt" && (
          <div className="property-card">
            <h3>Gantt Task Editor</h3>
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
                  Duration (e.g. 3d, 2w)
                  <input
                    value={ganttDraft.duration}
                    onChange={(e) => setGanttDraft((prev) => ({ ...prev, duration: e.target.value }))}
                  />
                </label>
                <button className="soft-btn full" onClick={applyGanttTaskPatch}>
                  Apply task update
                </button>
              </>
            ) : (
              <p className="muted">Select a Gantt task from preview first.</p>
            )}
          </div>
        )}

        {/* Starter Templates */}
        <div className="property-card">
          <h3>Templates</h3>
          <label>
            Diagram type
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ width: "100%" }}>
              {DIAGRAM_LIBRARY.map((diagram) => (
                <option key={diagram.id} value={diagram.id}>
                  {diagram.label}
                </option>
              ))}
            </select>
          </label>
          <button className="soft-btn full" onClick={replaceWithTemplate}>
            Load template
          </button>
        </div>
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
