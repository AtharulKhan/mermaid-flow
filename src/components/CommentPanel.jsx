import { useState, useEffect } from "react";
import { useAuth } from "../firebase/AuthContext";
import { getComments, addComment, deleteComment } from "../firebase/firestore";

const GUEST_NAME_KEY = "mermaid-flow-guest-name";

export default function CommentPanel({ flowId, allowAnonymous = false, onClose }) {
  const { user } = useAuth();
  const [comments, setComments] = useState([]);
  const [text, setText] = useState("");
  const [guestName, setGuestName] = useState(() => {
    try {
      return localStorage.getItem(GUEST_NAME_KEY) || "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const c = await getComments(flowId);
      setComments(c);
      setLoading(false);
    })();
  }, [flowId]);

  const handleSubmit = async () => {
    setError("");
    if (!text.trim()) return;

    const isAnonymous = !user;
    const authorName = isAnonymous
      ? guestName.trim()
      : (user.displayName || user.email || "User");

    if (isAnonymous && !allowAnonymous) {
      setError("Sign in required to comment on this flow.");
      return;
    }
    if (!authorName) {
      setError("Enter your name to post a comment.");
      return;
    }

    try {
      const c = await addComment(
        flowId,
        user?.uid || null,
        authorName,
        text.trim()
      );
      setComments((prev) => [
        { ...c, createdAt: { toDate: () => new Date() } },
        ...prev,
      ]);
      setText("");
      if (isAnonymous) {
        try {
          localStorage.setItem(GUEST_NAME_KEY, authorName);
        } catch {}
      }
    } catch (err) {
      setError(err.message || "Failed to post comment");
    }
  };

  const handleDelete = async (commentId) => {
    await deleteComment(flowId, commentId);
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  };

  const formatTime = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="comment-panel">
      <div className="comment-panel-header">
        <h3>Comments</h3>
        <button className="saved-item-delete" onClick={onClose}>×</button>
      </div>

      <div className="comment-input-row">
        {!user && allowAnonymous && (
          <input
            className="modal-input"
            style={{ marginBottom: 8 }}
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Your name"
          />
        )}
        <textarea
          className="comment-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a comment..."
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
          }}
        />
        <button className="soft-btn primary small" onClick={handleSubmit}>
          Post
        </button>
      </div>
      {error && <p className="comment-empty" style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="comment-list">
        {loading && <p className="comment-empty">Loading...</p>}
        {!loading && comments.length === 0 && (
          <p className="comment-empty">No comments yet</p>
        )}
        {comments.map((c) => (
          <div key={c.id} className="comment-item">
            <div className="comment-meta">
              <strong>{c.authorName}</strong>
              <span>{formatTime(c.createdAt)}</span>
              {c.authorId === user?.uid && (
                <button
                  className="saved-item-delete"
                  onClick={() => handleDelete(c.id)}
                >
                  ×
                </button>
              )}
            </div>
            <p className="comment-text">{c.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
