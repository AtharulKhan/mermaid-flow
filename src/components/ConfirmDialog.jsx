import { useEffect } from "react";

export default function ConfirmDialog({
  open,
  title = "Confirm",
  message,
  confirmLabel = "Delete",
  confirmVariant = "danger",
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
        <p style={{ margin: "0 0 16px", fontSize: "0.88rem", lineHeight: 1.5, color: "var(--ink-soft)" }}>
          {message}
        </p>
        <div className="modal-actions">
          <button className="soft-btn" onClick={onCancel}>Cancel</button>
          <button className={`soft-btn ${confirmVariant}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
