import { useState, useEffect, useRef } from "react";

export default function PromptDialog({
  open,
  title = "Input",
  placeholder = "",
  defaultValue = "",
  confirmLabel = "OK",
  onConfirm,
  onCancel,
  multiline = false,
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const handleSubmit = () => {
    onConfirm(value);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px" }}>{title}</h3>
        {multiline ? (
          <textarea
            ref={inputRef}
            className="modal-input"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: "0.82rem" }}
          />
        ) : (
          <input
            ref={inputRef}
            className="modal-input"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        )}
        <div className="modal-actions">
          <button className="soft-btn" onClick={onCancel}>Cancel</button>
          <button className="soft-btn primary" onClick={handleSubmit}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
