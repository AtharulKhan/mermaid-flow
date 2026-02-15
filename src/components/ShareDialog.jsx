import { useState, useEffect } from "react";
import { useAuth } from "../firebase/AuthContext";
import {
  getFlow,
  shareFlow,
  unshareFlow,
  setFlowPublicAccess,
  getUserByEmail,
} from "../firebase/firestore";

export default function ShareDialog({ flowId, onClose }) {
  const { user } = useAuth();
  const [flow, setFlow] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("read");
  const [publicAccess, setPublicAccess] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const f = await getFlow(flowId);
      if (f) {
        setFlow(f);
        setPublicAccess(f.publicAccess || null);
      }
      setLoading(false);
    })();
  }, [flowId]);

  const handleShare = async () => {
    setError("");
    setMessage("");
    if (!email.trim()) return;

    const target = await getUserByEmail(email.trim());
    if (!target) {
      setError("No user found with that email");
      return;
    }
    if (target.uid === user.uid) {
      setError("You can't share with yourself");
      return;
    }

    await shareFlow(flowId, target.uid, role);
    setFlow((prev) => ({
      ...prev,
      sharing: { ...prev.sharing, [target.uid]: role },
    }));
    setEmail("");
    setMessage(`Shared with ${email.trim()} as ${role}`);
  };

  const handleUnshare = async (uid) => {
    await unshareFlow(flowId, uid);
    setFlow((prev) => {
      const sharing = { ...prev.sharing };
      delete sharing[uid];
      return { ...prev, sharing };
    });
  };

  const handlePublicAccess = async (access) => {
    const value = access === "none" ? null : access;
    await setFlowPublicAccess(flowId, value);
    setPublicAccess(value);
  };

  const copyShareLink = () => {
    const url = `${window.location.origin}/flow/${flowId}`;
    navigator.clipboard.writeText(url);
    setMessage("Link copied");
  };

  if (loading) return null;
  if (!flow) return null;

  const sharedUsers = Object.entries(flow.sharing || {}).filter(
    ([uid]) => uid !== user.uid
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal save-modal share-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Share "{flow.name}"</h3>

        {/* Invite by email */}
        <div className="share-invite">
          <input
            type="email"
            className="modal-input"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleShare()}
          />
          <select
            className="share-role-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="read">Read</option>
            <option value="comment">Comment</option>
            <option value="edit">Edit</option>
          </select>
          <button className="soft-btn primary" onClick={handleShare}>
            Share
          </button>
        </div>

        {error && <div className="auth-error">{error}</div>}
        {message && <div className="auth-message">{message}</div>}

        {/* Shared users list */}
        {sharedUsers.length > 0 && (
          <div className="share-users">
            <h4>People with access</h4>
            {sharedUsers.map(([uid, userRole]) => (
              <div key={uid} className="share-user-row">
                <span className="share-user-id">{uid}</span>
                <span className="share-user-role">{userRole}</span>
                <button
                  className="saved-item-delete"
                  onClick={() => handleUnshare(uid)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Public access */}
        <div className="share-public">
          <h4>Public access</h4>
          <select
            className="share-role-select full-width"
            value={publicAccess || "none"}
            onChange={(e) => handlePublicAccess(e.target.value)}
          >
            <option value="none">Private — only shared users</option>
            <option value="read">Anyone with link can view</option>
            <option value="comment">Signed-in users with link can comment</option>
            <option value="edit">Signed-in users with link can edit</option>
          </select>
        </div>

        {/* Copy link */}
        <div className="share-link-row">
          <button className="soft-btn full-width" onClick={copyShareLink}>
            Copy link
          </button>
        </div>

        <div className="modal-actions">
          <button className="soft-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
