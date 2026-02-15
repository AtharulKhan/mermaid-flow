import { useState, useEffect } from "react";
import { getFlowVersions } from "../firebase/firestore";

export default function VersionHistoryPanel({ flowId, currentCode, onRestore, onClose }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const v = await getFlowVersions(flowId);
      setVersions(v);
      setLoading(false);
    })();
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
        {!loading && versions.length === 0 && (
          <p className="version-empty">No previous versions yet</p>
        )}
        {versions.map((v) => {
          const isCurrent = v.code === currentCode;
          return (
            <div key={v.id} className="version-item">
              <div className="version-meta">
                <span>{timeAgo(v.createdAt)}</span>
                <span className="version-type">{v.diagramType || "diagram"}</span>
              </div>
              <div className="version-preview">{previewCode(v.code)}</div>
              {isCurrent ? (
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>Current</span>
              ) : (
                <button
                  className="version-restore-btn"
                  onClick={() => onRestore(v.code, v.diagramType)}
                >
                  Restore
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
