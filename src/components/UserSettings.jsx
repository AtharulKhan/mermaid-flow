import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../firebase/AuthContext";
import { logOut } from "../firebase/auth";
import { getUserSettings, updateUserSettings } from "../firebase/firestore";

export default function UserSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  // Notion settings
  const [notionApiKey, setNotionApiKey] = useState("");
  const [notionDbId, setNotionDbId] = useState("");

  // Load existing settings
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const settings = await getUserSettings(user.uid);
        setNotionApiKey(settings.notion?.apiKey || "");
        setNotionDbId(settings.notion?.defaultDatabaseId || "");
      } catch (err) {
        console.warn("Failed to load settings:", err);
      }
      setLoading(false);
    })();
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setMessage("");
    try {
      await updateUserSettings(user.uid, {
        notion: {
          apiKey: notionApiKey.trim(),
          defaultDatabaseId: notionDbId.trim(),
        },
      });
      setMessage("Settings saved");
    } catch (err) {
      setMessage("Failed to save: " + err.message);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="dash-loading">
        <div className="brand-mark">MF</div>
        <p>Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="brand">
          <div className="brand-mark">MF</div>
          <h1>Mermaid Flow</h1>
        </div>
        <div className="dash-header-actions">
          <span className="dash-user">{user?.displayName || user?.email}</span>
          <button className="soft-btn small" onClick={() => logOut()}>
            Sign Out
          </button>
        </div>
      </header>

      <div className="dash-body">
        <aside className="dash-sidebar">
          <nav className="dash-nav">
            <button className="dash-nav-item" onClick={() => navigate("/dashboard")}>
              Dashboard
            </button>
            <button className="dash-nav-item active">
              Settings
            </button>
          </nav>
        </aside>

        <main className="dash-main">
          <div className="settings-page">
            <h2>Settings</h2>
            <p className="settings-desc">
              Manage your integration API keys. These are stored securely in your
              account and are never shared with other users.
            </p>

            {/* ── Notion Integration ──────────────────────── */}
            <section className="settings-section">
              <h3>Notion Integration</h3>
              <p className="settings-section-desc">
                Connect your Notion workspace to sync Gantt charts with Notion databases.
                You need a Notion internal integration token — create one at{" "}
                <a
                  href="https://www.notion.so/my-integrations"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  notion.so/my-integrations
                </a>.
              </p>

              <div className="settings-field">
                <label htmlFor="notion-api-key">Notion Integration Token</label>
                <input
                  id="notion-api-key"
                  type="password"
                  className="settings-input"
                  placeholder="ntn_..."
                  value={notionApiKey}
                  onChange={(e) => setNotionApiKey(e.target.value)}
                />
                <span className="settings-hint">
                  Your internal integration token starting with ntn_
                </span>
              </div>

              <div className="settings-field">
                <label htmlFor="notion-db-id">Default Database ID</label>
                <input
                  id="notion-db-id"
                  type="text"
                  className="settings-input"
                  placeholder="abc123def456..."
                  value={notionDbId}
                  onChange={(e) => setNotionDbId(e.target.value)}
                />
                <span className="settings-hint">
                  The 32-character ID from your Notion database URL. Optional — you can
                  also enter it per-sync in the editor.
                </span>
              </div>
            </section>

            {/* ── Future integrations placeholder ─────────── */}
            <section className="settings-section">
              <h3>Other Integrations</h3>
              <p className="settings-section-desc">
                More integrations coming soon (Jira, Linear, GitHub, Slack).
              </p>
            </section>

            {/* ── Save ────────────────────────────────────── */}
            <div className="settings-actions">
              <button
                className="soft-btn primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save Settings"}
              </button>
              {message && (
                <span className={`settings-message ${message.startsWith("Failed") ? "error" : ""}`}>
                  {message}
                </span>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
