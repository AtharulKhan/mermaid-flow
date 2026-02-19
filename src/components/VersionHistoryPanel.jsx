import { useState, useEffect } from "react";
import { formatFirestoreError, getFlowVersions } from "../firebase/firestore";

function computeDiff(oldStr, newStr) {
  const oldLines = (oldStr || "").split("\n");
  const newLines = (newStr || "").split("\n");

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const hunks = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      hunks.unshift({ type: "equal", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      hunks.unshift({ type: "add", text: newLines[j - 1] });
      j--;
    } else {
      hunks.unshift({ type: "remove", text: oldLines[i - 1] });
      i--;
    }
  }
  return hunks;
}

function DiffView({ fromCode, toCode }) {
  const hunks = computeDiff(fromCode, toCode);
  const hasChanges = hunks.some((h) => h.type !== "equal");

  if (!hasChanges) {
    return <p className="diff-no-changes">No changes from current version</p>;
  }

  // Collapse long equal runs, show context of 3 lines around changes
  const CONTEXT = 3;
  const visible = new Array(hunks.length).fill(false);
  hunks.forEach((h, idx) => {
    if (h.type !== "equal") {
      for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(hunks.length - 1, idx + CONTEXT); k++) {
        visible[k] = true;
      }
    }
  });

  const rows = [];
  let addLine = 0;
  let removeLine = 0;
  let skipping = false;

  hunks.forEach((h, idx) => {
    if (h.type === "add") addLine++;
    else if (h.type === "remove") removeLine++;
    else { addLine++; removeLine++; }

    if (!visible[idx]) {
      if (!skipping) {
        skipping = true;
        rows.push(<div key={`skip-${idx}`} className="diff-skip">...</div>);
      }
      return;
    }
    skipping = false;

    rows.push(
      <div key={idx} className={`diff-line diff-${h.type}`}>
        <span className="diff-sign">
          {h.type === "add" ? "+" : h.type === "remove" ? "-" : " "}
        </span>
        <span className="diff-text">{h.text || " "}</span>
      </div>
    );
  });

  return <div className="diff-view">{rows}</div>;
}

export default function VersionHistoryPanel({ flowId, currentCode, onRestore, onClose }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [diffVersionId, setDiffVersionId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const v = await getFlowVersions(flowId);
        if (!cancelled) setVersions(v);
      } catch (err) {
        if (!cancelled) {
          const message = formatFirestoreError(err);
          console.error("[VersionHistory] load failed", { flowId, message, err });
          setError(`Version history failed to load: ${message}`);
          setVersions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  const timeAgo = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  const previewCode = (code) => {
    if (!code) return "";
    const lines = code.split("\n").slice(0, 3);
    return lines.join("\n");
  };

  return (
    <div className="version-panel">
      <div className="version-panel-header">
        <h3>Version History</h3>
        <button className="saved-item-delete" onClick={onClose}>×</button>
      </div>

      <div className="version-list">
        {loading && <p className="version-empty">Loading...</p>}
        {!loading && error && <p className="version-empty">{error}</p>}
        {!loading && !error && versions.length === 0 && (
          <p className="version-empty">No previous versions yet</p>
        )}
        {versions.map((v) => {
          const isCurrent = v.code === currentCode;
          const tabCount = v.tabs ? v.tabs.length : 1;
          const isDiffOpen = diffVersionId === v.id;
          return (
            <div key={v.id} className="version-item">
              <div className="version-meta">
                <span>{timeAgo(v.createdAt)}</span>
                <span className="version-type">
                  {v.diagramType || "diagram"}
                  {tabCount > 1 ? ` · ${tabCount} tabs` : ""}
                </span>
              </div>
              <div className="version-preview">{previewCode(v.code)}</div>
              <div className="version-actions">
                {isCurrent ? (
                  <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Current</span>
                ) : (
                  <button
                    className="version-restore-btn"
                    onClick={() => onRestore(v.code, v.diagramType, v.tabs || null)}
                  >
                    Restore
                  </button>
                )}
                <button
                  className={`version-diff-btn${isDiffOpen ? " active" : ""}`}
                  onClick={() => setDiffVersionId(isDiffOpen ? null : v.id)}
                  title={isDiffOpen ? "Hide diff" : "Compare with current"}
                >
                  {isDiffOpen ? "Hide diff" : "Diff"}
                </button>
              </div>
              {isDiffOpen && (
                <div className="version-diff-container">
                  <p className="diff-legend">
                    <span className="diff-legend-add">+ added</span>
                    <span className="diff-legend-remove">− removed</span>
                    <span className="diff-legend-label">vs. current editor</span>
                  </p>
                  <DiffView fromCode={currentCode} toCode={v.code} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
