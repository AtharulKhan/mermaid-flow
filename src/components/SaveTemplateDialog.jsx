import { useState, useEffect } from "react";

export default function SaveTemplateDialog({
  open,
  onClose,
  onSave,
  onUpdate,
  existingTemplates = [],
  defaultName = "",
  diagramType = "flowchart",
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [mode, setMode] = useState("new"); // "new" | "update"
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDescription("");
      setTags("");
      setMode("new");
      setSelectedTemplateId("");
      setSaving(false);
    }
  }, [open, defaultName]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (mode === "update" && selectedTemplateId) {
        await onUpdate(selectedTemplateId);
      } else {
        const parsedTags = tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        await onSave({ name: name.trim() || "Untitled Template", description: description.trim(), tags: parsedTags });
      }
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const formatType = (t) =>
    t ? t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Diagram";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 style={{ margin: "0 0 16px" }}>Save as Template</h3>

        {existingTemplates.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button
              className={`soft-btn small${mode === "new" ? " primary" : ""}`}
              onClick={() => setMode("new")}
            >
              Create New
            </button>
            <button
              className={`soft-btn small${mode === "update" ? " primary" : ""}`}
              onClick={() => setMode("update")}
            >
              Update Existing
            </button>
          </div>
        )}

        {mode === "update" ? (
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
              Select template to update
              <select
                className="modal-input"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                style={{ marginTop: 4 }}
              >
                <option value="">Choose a template...</option>
                {existingTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--ink-muted)" }}>
              This will replace the template's code and tabs with the current page content.
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
              Name
              <input
                className="modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                autoFocus
                style={{ marginTop: 4 }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              />
            </label>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
              Description
              <textarea
                className="modal-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this template for?"
                rows={3}
                style={{ marginTop: 4, resize: "vertical", fontFamily: "inherit" }}
              />
            </label>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
              Category
              <span
                className="dash-flow-type-badge"
                style={{ marginTop: 4, width: "fit-content" }}
              >
                {formatType(diagramType)}
              </span>
            </label>
            <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
              Tags
              <input
                className="modal-input"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. onboarding, sprint, seo (comma-separated)"
                style={{ marginTop: 4 }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              />
            </label>
          </div>
        )}

        <div className="modal-actions">
          <button className="soft-btn" onClick={onClose}>Cancel</button>
          <button
            className="soft-btn primary"
            onClick={handleSubmit}
            disabled={saving || (mode === "update" && !selectedTemplateId)}
          >
            {saving ? "Saving..." : mode === "update" ? "Update Template" : "Save Template"}
          </button>
        </div>
      </div>
    </div>
  );
}
