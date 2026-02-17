import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../firebase/AuthContext";
import logoSvg from "../assets/logo.svg";
import { logOut } from "../firebase/auth";
import { getStoredTheme, cycleTheme, THEME_LABELS, IconSun, IconMoon, IconMonitor } from "../themeUtils";
import {
  getUserProjects,
  createProject,
  deleteProject,
  getSubprojects,
  createSubproject,
  deleteSubproject,
  getAllUserFlows,
  getUserFlows,
  createFlow,
  deleteFlow,
  updateFlow,
  addFlowTag,
  removeFlowTag,
  formatFirestoreError,
} from "../firebase/firestore";
import { DEFAULT_CODE } from "../diagramData";

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Data
  const [projects, setProjects] = useState([]);
  const [allFlows, setAllFlows] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [subprojects, setSubprojects] = useState([]);
  const [selectedSubproject, setSelectedSubproject] = useState(null);
  const [projectFlows, setProjectFlows] = useState([]);

  // Theme
  const [themeMode, setThemeMode] = useState(getStoredTheme);

  // UI state
  const [view, setView] = useState("all"); // "all" | "projects" | "project-detail"
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewSubproject, setShowNewSubproject] = useState(false);
  const [showNewFlow, setShowNewFlow] = useState(false);
  const [showTagInput, setShowTagInput] = useState(null); // flowId
  const [newTag, setNewTag] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newSubprojectName, setNewSubprojectName] = useState("");
  const [newFlowName, setNewFlowName] = useState("");
  const [loadError, setLoadError] = useState("");

  const logDashboardError = (operation, err, context = {}) => {
    console.error(`[Dashboard] ${operation} failed`, {
      error: formatFirestoreError(err),
      code: err?.code || "unknown",
      context,
    });
  };

  // Load data
  useEffect(() => {
    if (!user) return;
    loadAll();
  }, [user]);

  const loadAll = async () => {
    setLoading(true);
    setLoadError("");
    const [projectsResult, flowsResult] = await Promise.allSettled([
      getUserProjects(user.uid),
      getAllUserFlows(user.uid),
    ]);

    if (projectsResult.status === "fulfilled") {
      setProjects(projectsResult.value);
    } else {
      logDashboardError("loadAll/getUserProjects", projectsResult.reason, { uid: user.uid });
      setLoadError(`Projects load failed: ${formatFirestoreError(projectsResult.reason)}`);
    }

    if (flowsResult.status === "fulfilled") {
      setAllFlows(flowsResult.value);
    } else {
      logDashboardError("loadAll/getAllUserFlows", flowsResult.reason, { uid: user.uid });
      const flowsError = `Flows load failed: ${formatFirestoreError(flowsResult.reason)}`;
      setLoadError((prev) => (prev ? `${prev} | ${flowsError}` : flowsError));
    }

    setLoading(false);
  };

  // Load project detail
  useEffect(() => {
    if (!selectedProject || !user) return;
    (async () => {
      const [subsResult, flowsResult] = await Promise.allSettled([
        getSubprojects(selectedProject.id),
        getUserFlows(user.uid, {
          projectId: selectedProject.id,
          subprojectId: selectedSubproject?.id,
        }),
      ]);

      if (subsResult.status === "fulfilled") {
        setSubprojects(subsResult.value);
      } else {
        logDashboardError("projectDetail/getSubprojects", subsResult.reason, {
          projectId: selectedProject.id,
        });
      }

      if (flowsResult.status === "fulfilled") {
        setProjectFlows(flowsResult.value);
      } else {
        logDashboardError("projectDetail/getUserFlows", flowsResult.reason, {
          uid: user.uid,
          projectId: selectedProject.id,
          subprojectId: selectedSubproject?.id || null,
        });
      }
    })();
  }, [selectedProject, selectedSubproject, user]);

  // All unique tags across flows
  const allTags = useMemo(() => {
    const tags = new Set();
    allFlows.forEach((f) => f.tags?.forEach((t) => tags.add(t)));
    return [...tags].sort();
  }, [allFlows]);

  // Filtered flows
  const filteredFlows = useMemo(() => {
    let list = view === "project-detail" ? projectFlows : allFlows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (f) =>
          f.name?.toLowerCase().includes(q) ||
          f.diagramType?.toLowerCase().includes(q) ||
          f.tags?.some((t) => t.toLowerCase().includes(q))
      );
    }
    if (filterTag) {
      list = list.filter((f) => f.tags?.includes(filterTag));
    }
    return list;
  }, [view, allFlows, projectFlows, searchQuery, filterTag]);

  // Handlers
  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    const proj = await createProject(user.uid, newProjectName.trim(), newProjectDesc.trim());
    setProjects((prev) => [proj, ...prev]);
    setNewProjectName("");
    setNewProjectDesc("");
    setShowNewProject(false);
  };

  const handleDeleteProject = async (projectId) => {
    if (!window.confirm("Delete this project? Flows will be unlinked but not deleted.")) return;
    await deleteProject(projectId);
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    if (selectedProject?.id === projectId) {
      setSelectedProject(null);
      setView("projects");
    }
  };

  const handleCreateSubproject = async () => {
    if (!selectedProject || !newSubprojectName.trim()) return;
    const sub = await createSubproject(selectedProject.id, newSubprojectName.trim());
    setSubprojects((prev) => [sub, ...prev]);
    setNewSubprojectName("");
    setShowNewSubproject(false);
  };

  const handleDeleteSubproject = async (subId) => {
    if (!selectedProject) return;
    if (!window.confirm("Delete this subproject? Flows will be unlinked.")) return;
    await deleteSubproject(selectedProject.id, subId);
    setSubprojects((prev) => prev.filter((s) => s.id !== subId));
    if (selectedSubproject?.id === subId) setSelectedSubproject(null);
  };

  const handleCreateFlow = async () => {
    const name = newFlowName.trim() || "Untitled";
    try {
      const flow = await createFlow(user.uid, {
        name,
        code: DEFAULT_CODE,
        diagramType: "flowchart",
        projectId: selectedProject?.id || null,
        subprojectId: selectedSubproject?.id || null,
        tags: [],
      });
      setNewFlowName("");
      setShowNewFlow(false);
      setLoadError("");
      navigate(`/editor/${flow.id}`);
    } catch (err) {
      logDashboardError("handleCreateFlow/createFlow", err, {
        uid: user.uid,
        projectId: selectedProject?.id || null,
        subprojectId: selectedSubproject?.id || null,
      });
      setLoadError(`Create flow failed: ${formatFirestoreError(err)}`);
    }
  };

  const handleDeleteFlow = async (flowId) => {
    if (!window.confirm("Delete this flow permanently?")) return;
    await deleteFlow(flowId);
    setAllFlows((prev) => prev.filter((f) => f.id !== flowId));
    setProjectFlows((prev) => prev.filter((f) => f.id !== flowId));
  };

  const handleAddTag = async (flowId) => {
    if (!newTag.trim()) return;
    await addFlowTag(flowId, newTag.trim());
    const tag = newTag.trim();
    setAllFlows((prev) =>
      prev.map((f) =>
        f.id === flowId ? { ...f, tags: [...(f.tags || []), tag] } : f
      )
    );
    setProjectFlows((prev) =>
      prev.map((f) =>
        f.id === flowId ? { ...f, tags: [...(f.tags || []), tag] } : f
      )
    );
    setNewTag("");
    setShowTagInput(null);
  };

  const handleRemoveTag = async (flowId, tag) => {
    await removeFlowTag(flowId, tag);
    setAllFlows((prev) =>
      prev.map((f) =>
        f.id === flowId ? { ...f, tags: (f.tags || []).filter((t) => t !== tag) } : f
      )
    );
    setProjectFlows((prev) =>
      prev.map((f) =>
        f.id === flowId ? { ...f, tags: (f.tags || []).filter((t) => t !== tag) } : f
      )
    );
  };

  const formatDate = (ts) => {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  if (loading) {
    return (
      <div className="dash-loading">
        <img src={logoSvg} alt="MF" className="brand-mark" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      {/* ── Top Bar ────────────────────────────────────── */}
      <header className="dash-header">
        <div className="brand">
          <img src={logoSvg} alt="MF" className="brand-mark" />
          <h1>Mermaid Flow</h1>
        </div>
        <div className="dash-header-actions">
          <button
            className="icon-btn"
            title={THEME_LABELS[themeMode]}
            onClick={() => setThemeMode(cycleTheme())}
          >
            {themeMode === "dark" ? <IconMoon /> : themeMode === "light" ? <IconSun /> : <IconMonitor />}
          </button>
          <span className="dash-user">{user.displayName || user.email}</span>
          <button className="soft-btn small" onClick={() => logOut()}>
            Sign Out
          </button>
        </div>
      </header>

      <div className="dash-body">
        {/* ── Sidebar ──────────────────────────────────── */}
        <aside className="dash-sidebar">
          <nav className="dash-nav">
            <button
              className={`dash-nav-item ${view === "all" ? "active" : ""}`}
              onClick={() => { setView("all"); setSelectedProject(null); setSelectedSubproject(null); }}
            >
              All Flows
            </button>
            <button
              className={`dash-nav-item ${view === "projects" || view === "project-detail" ? "active" : ""}`}
              onClick={() => { setView("projects"); setSelectedProject(null); setSelectedSubproject(null); }}
            >
              Projects
            </button>
            <button
              className="dash-nav-item"
              onClick={() => navigate("/settings")}
            >
              Settings
            </button>
          </nav>

          {/* Tag filter */}
          {allTags.length > 0 && (
            <div className="dash-tags-section">
              <h4>Tags</h4>
              <div className="dash-tag-list">
                <button
                  className={`dash-tag ${!filterTag ? "active" : ""}`}
                  onClick={() => setFilterTag("")}
                >
                  All
                </button>
                {allTags.map((t) => (
                  <button
                    key={t}
                    className={`dash-tag ${filterTag === t ? "active" : ""}`}
                    onClick={() => setFilterTag(filterTag === t ? "" : t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="dash-sidebar-bottom">
            <button className="soft-btn primary full-width" onClick={() => setShowNewFlow(true)}>
              + New Flow
            </button>
          </div>
        </aside>

        {/* ── Main Content ─────────────────────────────── */}
        <main className="dash-main">
          {loadError && (
            <div className="auth-error" style={{ marginBottom: 10 }}>
              {loadError}
            </div>
          )}

          {/* Search */}
          <div className="dash-search-bar">
            <input
              type="text"
              placeholder="Search flows..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="dash-search-input"
            />
          </div>

          {/* ── All Flows View ─────────────────────────── */}
          {view === "all" && (
            <>
              <div className="dash-section-header">
                <h2>All Flows</h2>
                <span className="dash-count">{filteredFlows.length} flows</span>
              </div>
              <FlowGrid
                flows={filteredFlows}
                navigate={navigate}
                formatDate={formatDate}
                onDelete={handleDeleteFlow}
                onAddTag={(id) => { setShowTagInput(id); setNewTag(""); }}
                onRemoveTag={handleRemoveTag}
                showTagInput={showTagInput}
                newTag={newTag}
                setNewTag={setNewTag}
                onSubmitTag={handleAddTag}
                onCancelTag={() => setShowTagInput(null)}
              />
            </>
          )}

          {/* ── Projects View ──────────────────────────── */}
          {view === "projects" && (
            <>
              <div className="dash-section-header">
                <h2>Projects</h2>
                <button className="soft-btn small" onClick={() => setShowNewProject(true)}>
                  + New Project
                </button>
              </div>
              <div className="dash-project-grid">
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className="dash-project-card"
                    onClick={() => { setSelectedProject(p); setSelectedSubproject(null); setView("project-detail"); }}
                  >
                    <h3>{p.name}</h3>
                    {p.description && <p>{p.description}</p>}
                    <span className="dash-card-meta">{formatDate(p.createdAt)}</span>
                    <button
                      className="dash-card-delete"
                      onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Project Detail View ────────────────────── */}
          {view === "project-detail" && selectedProject && (
            <>
              <div className="dash-breadcrumb">
                <button className="dash-breadcrumb-link" onClick={() => { setView("projects"); setSelectedProject(null); }}>
                  Projects
                </button>
                <span className="dash-breadcrumb-sep">/</span>
                <span>{selectedProject.name}</span>
                {selectedSubproject && (
                  <>
                    <span className="dash-breadcrumb-sep">/</span>
                    <span>{selectedSubproject.name}</span>
                  </>
                )}
              </div>

              {/* Subprojects */}
              <div className="dash-section-header">
                <h3>Subprojects</h3>
                <button className="soft-btn small" onClick={() => setShowNewSubproject(true)}>
                  + Add
                </button>
              </div>
              <div className="dash-subproject-list">
                <button
                  className={`dash-subproject-chip ${!selectedSubproject ? "active" : ""}`}
                  onClick={() => setSelectedSubproject(null)}
                >
                  All
                </button>
                {subprojects.map((s) => (
                  <div key={s.id} className="dash-subproject-chip-wrap">
                    <button
                      className={`dash-subproject-chip ${selectedSubproject?.id === s.id ? "active" : ""}`}
                      onClick={() => setSelectedSubproject(s)}
                    >
                      {s.name}
                    </button>
                    <button
                      className="dash-chip-delete"
                      onClick={() => handleDeleteSubproject(s.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Flows in project */}
              <div className="dash-section-header">
                <h3>Flows</h3>
                <button className="soft-btn small" onClick={() => setShowNewFlow(true)}>
                  + New Flow
                </button>
              </div>
              <FlowGrid
                flows={filteredFlows}
                navigate={navigate}
                formatDate={formatDate}
                onDelete={handleDeleteFlow}
                onAddTag={(id) => { setShowTagInput(id); setNewTag(""); }}
                onRemoveTag={handleRemoveTag}
                showTagInput={showTagInput}
                newTag={newTag}
                setNewTag={setNewTag}
                onSubmitTag={handleAddTag}
                onCancelTag={() => setShowTagInput(null)}
              />
            </>
          )}
        </main>
      </div>

      {/* ── New Project Dialog ─────────────────────────── */}
      {showNewProject && (
        <div className="modal-overlay" onClick={() => setShowNewProject(false)}>
          <div className="modal save-modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Project</h3>
            <input
              className="modal-input"
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateProject()}
              autoFocus
            />
            <input
              className="modal-input"
              placeholder="Description (optional)"
              value={newProjectDesc}
              onChange={(e) => setNewProjectDesc(e.target.value)}
              style={{ marginTop: 8 }}
            />
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setShowNewProject(false)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleCreateProject}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Subproject Dialog ──────────────────────── */}
      {showNewSubproject && (
        <div className="modal-overlay" onClick={() => setShowNewSubproject(false)}>
          <div className="modal save-modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Subproject</h3>
            <input
              className="modal-input"
              placeholder="Subproject name"
              value={newSubprojectName}
              onChange={(e) => setNewSubprojectName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateSubproject()}
              autoFocus
            />
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setShowNewSubproject(false)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleCreateSubproject}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Flow Dialog ────────────────────────────── */}
      {showNewFlow && (
        <div className="modal-overlay" onClick={() => setShowNewFlow(false)}>
          <div className="modal save-modal" onClick={(e) => e.stopPropagation()}>
            <h3>New Flow</h3>
            <input
              className="modal-input"
              placeholder="Flow name"
              value={newFlowName}
              onChange={(e) => setNewFlowName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateFlow()}
              autoFocus
            />
            {selectedProject && (
              <p style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 8 }}>
                In: {selectedProject.name}{selectedSubproject ? ` / ${selectedSubproject.name}` : ""}
              </p>
            )}
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setShowNewFlow(false)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleCreateFlow}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Flow Grid Sub-component ──────────────────────────── */
function FlowGrid({
  flows,
  navigate,
  formatDate,
  onDelete,
  onAddTag,
  onRemoveTag,
  showTagInput,
  newTag,
  setNewTag,
  onSubmitTag,
  onCancelTag,
}) {
  if (flows.length === 0) {
    return <div className="dash-empty">No flows yet. Create one to get started.</div>;
  }

  return (
    <div className="dash-flow-grid">
      {flows.map((f) => (
        <div
          key={f.id}
          className="dash-flow-card"
          onClick={() => navigate(`/editor/${f.id}`)}
        >
          <div className="dash-flow-card-header">
            <h4>{f.name || "Untitled"}</h4>
            <button
              className="dash-card-delete"
              onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
            >
              ×
            </button>
          </div>
          <span className="dash-flow-type">{f.diagramType || "diagram"}</span>
          <div className="dash-flow-tags" onClick={(e) => e.stopPropagation()}>
            {(f.tags || []).map((t) => (
              <span key={t} className="dash-flow-tag">
                {t}
                <button onClick={() => onRemoveTag(f.id, t)}>×</button>
              </span>
            ))}
            {showTagInput === f.id ? (
              <span className="dash-tag-input-wrap">
                <input
                  className="dash-tag-input"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmitTag(f.id);
                    if (e.key === "Escape") onCancelTag();
                  }}
                  placeholder="tag"
                  autoFocus
                />
              </span>
            ) : (
              <button className="dash-tag-add" onClick={() => onAddTag(f.id)}>
                +
              </button>
            )}
          </div>
          <span className="dash-card-meta">{formatDate(f.updatedAt)}</span>
        </div>
      ))}
    </div>
  );
}
