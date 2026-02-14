import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_LIBRARY, DEFAULT_CODE, classifyDiagramType } from "./diagramData";

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
        background: #eef6f8;
        font-family: "Manrope", system-ui, sans-serif;
      }
      body {
        background-image:
          radial-gradient(circle at 15px 15px, rgba(122, 180, 196, 0.21) 2px, transparent 2.5px),
          radial-gradient(circle at 15px 15px, rgba(122, 180, 196, 0.13) 1px, transparent 1.5px);
        background-size: 38px 38px, 38px 38px;
      }
      #wrap {
        width: 100%;
        height: 100%;
        overflow: auto;
        padding: 20px;
        box-sizing: border-box;
      }
      #canvas {
        min-height: 100%;
        border-radius: 16px;
        border: 2px solid #b8d7df;
        background: #f7fdffcc;
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
        const textNode = group.querySelector("text") || target.closest("text");
        const label = textNode?.textContent?.trim() || target.getAttribute("id") || target.nodeName;
        return {
          id: group.id || target.id || "",
          className: group.className?.baseVal || target.className?.baseVal || "",
          label,
          nodeName: target.nodeName,
        };
      };

      const wireSelection = (svg) => {
        svg.addEventListener("click", (event) => {
          const target = event.target;
          if (!target || target.nodeName === "svg") return;

          const group = target.closest("g");
          if (selected) selected.classList.remove("mf-selected");
          if (group) {
            group.classList.add("mf-selected");
            selected = group;
          }

          send("element:selected", extractInfo(target));
        });
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

function App() {
  const iframeRef = useRef(null);
  const editorRef = useRef(null);
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

  const srcDoc = useMemo(() => getIframeSrcDoc(), []);
  const lineCount = code.split("\n").length;
  const toolsetKey = classifyDiagramType(diagramType);
  const activeTemplate = DIAGRAM_LIBRARY.find((entry) => entry.id === templateId);
  const quickTools =
    DIAGRAM_LIBRARY.find((entry) => entry.id === toolsetKey)?.quickTools ||
    DIAGRAM_LIBRARY.find((entry) => entry.id === "flowchart")?.quickTools ||
    [];

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

  useEffect(() => {
    if (!autoRender) return;
    const handle = window.setTimeout(postRender, 360);
    return () => window.clearTimeout(handle);
  }, [code, autoRender, theme, securityLevel, renderer]);

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
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [code]);

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

  const replaceWithTemplate = () => {
    if (!activeTemplate?.starter) return;
    setCode(activeTemplate.starter);
    setSelectedElement(null);
    setHighlightLine(null);
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

  return (
    <main className="app-shell">
      <header className="top-strip">
        <div className="brand">
          <div className="brand-mark">MF</div>
          <div>
            <h1>Mermaid Flow</h1>
            <p>Visual-first Mermaid editor with source-safe patching</p>
          </div>
        </div>
        <div className="toolbar">
          <button className="soft-btn" onClick={postRender}>
            Render
          </button>
          <button className="soft-btn" onClick={copyCode}>
            Copy code
          </button>
          <button className="soft-btn" onClick={copyEmbed}>
            Copy iframe embed
          </button>
          <button className="soft-btn" onClick={downloadSvg}>
            SVG
          </button>
          <button className="soft-btn" onClick={downloadPng}>
            PNG
          </button>
        </div>
      </header>

      <section className="control-row">
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
          Security
          <select value={securityLevel} onChange={(e) => setSecurityLevel(e.target.value)}>
            <option value="strict">strict</option>
            <option value="sandbox">sandbox</option>
            <option value="loose">loose (for click callbacks)</option>
          </select>
        </label>
        <label>
          Layout
          <select value={renderer} onChange={(e) => setRenderer(e.target.value)}>
            <option value="dagre">dagre</option>
            <option value="elk">elk</option>
          </select>
        </label>
        <label className="auto-toggle">
          <input type="checkbox" checked={autoRender} onChange={(e) => setAutoRender(e.target.checked)} />
          Auto-render
        </label>
        <label>
          Starter
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {DIAGRAM_LIBRARY.map((diagram) => (
              <option key={diagram.id} value={diagram.id}>
                {diagram.label}
              </option>
            ))}
          </select>
        </label>
        <button className="soft-btn" onClick={replaceWithTemplate}>
          Load starter
        </button>
      </section>

      <section className="workspace">
        <article className="editor-panel">
          <div className="panel-header">
            <h2>Code</h2>
            <span>{lineCount} lines</span>
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
            <p>Detected: {diagramType || "unknown"}</p>
            <p className={`status-${renderStatus}`}>{renderMessage}</p>
          </div>
        </article>

        <article className="preview-panel">
          <div className="panel-header">
            <h2>Preview</h2>
            <span>Click shapes to patch labels</span>
          </div>
          <iframe
            ref={iframeRef}
            title="Mermaid preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            className="preview-frame"
          />
        </article>

        <aside className="tools-panel">
          <div className="panel-header">
            <h2>Quick Tools</h2>
            <span>{toolsetKey}</span>
          </div>
          <div className="tool-grid">
            {quickTools.map((tool) => (
              <button key={tool.label} className="tool-btn" onClick={() => insertSnippet(tool.snippet)}>
                {tool.label}
              </button>
            ))}
          </div>

          <div className="property-card">
            <h3>Selection</h3>
            {selectedElement ? (
              <>
                <p>
                  <strong>Label:</strong> {selectedElement.label}
                </p>
                <p>
                  <strong>ID:</strong> {selectedElement.id || "n/a"}
                </p>
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

          <div className="property-card">
            <h3>Supported Types</h3>
            <ul>
              {DIAGRAM_LIBRARY.map((item) => (
                <li key={item.id}>
                  <code>{item.keyword}</code> - {item.label}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
