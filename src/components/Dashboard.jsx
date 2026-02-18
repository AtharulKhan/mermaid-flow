import { useEffect, useState, useMemo, useCallback, useRef } from "react";
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
import ConfirmDialog from "./ConfirmDialog";

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
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { type, id, message }
  const [filterProject, setFilterProject] = useState(""); // projectId or ""
  const [filterType, setFilterType] = useState(""); // diagramType or ""
  const [moveFlow, setMoveFlow] = useState(null); // { flowId, step: "project"|"subproject", projectId, subs }
  const [moveSearch, setMoveSearch] = useState("");
  const [moveNewName, setMoveNewName] = useState("");

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

  // All unique diagram types
  const allDiagramTypes = useMemo(() => {
    const types = new Set();
    allFlows.forEach((f) => { if (f.diagramType) types.add(f.diagramType); });
    return [...types].sort();
  }, [allFlows]);

  // Project lookup for search
  const projectMap = useMemo(() => {
    const map = {};
    projects.forEach((p) => { map[p.id] = p; });
    return map;
  }, [projects]);

  // Filtered flows
  const filteredFlows = useMemo(() => {
    let list = view === "project-detail" ? projectFlows : allFlows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (f) =>
          f.name?.toLowerCase().includes(q) ||
          f.diagramType?.toLowerCase().includes(q) ||
          f.tags?.some((t) => t.toLowerCase().includes(q)) ||
          (f.projectId && projectMap[f.projectId]?.name?.toLowerCase().includes(q))
      );
    }
    if (filterTag) {
      list = list.filter((f) => f.tags?.includes(filterTag));
    }
    if (filterProject && view === "all") {
      if (filterProject === "__none__") {
        list = list.filter((f) => !f.projectId);
      } else {
        list = list.filter((f) => f.projectId === filterProject);
      }
    }
    if (filterType && view === "all") {
      list = list.filter((f) => f.diagramType === filterType);
    }
    return list;
  }, [view, allFlows, projectFlows, searchQuery, filterTag, filterProject, filterType]);

  // Filtered projects for projects view
  const filteredProjects = useMemo(() => {
    if (!searchQuery) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    );
  }, [projects, searchQuery]);

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
    setDeleteConfirm({
      type: "project",
      id: projectId,
      message: "Delete this project? Flows will be unlinked but not deleted.",
    });
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
    setDeleteConfirm({
      type: "subproject",
      id: subId,
      message: "Delete this subproject? Flows will be unlinked.",
    });
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
    setDeleteConfirm({
      type: "flow",
      id: flowId,
      message: "Delete this flow permanently?",
    });
  };

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    const { type, id } = deleteConfirm;
    setDeleteConfirm(null);
    if (type === "project") {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (selectedProject?.id === id) {
        setSelectedProject(null);
        setView("projects");
      }
    } else if (type === "subproject") {
      await deleteSubproject(selectedProject.id, id);
      setSubprojects((prev) => prev.filter((s) => s.id !== id));
      if (selectedSubproject?.id === id) setSelectedSubproject(null);
    } else if (type === "flow") {
      await deleteFlow(id);
      setAllFlows((prev) => prev.filter((f) => f.id !== id));
      setProjectFlows((prev) => prev.filter((f) => f.id !== id));
    }
  }, [deleteConfirm, selectedProject, selectedSubproject]);

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

  const handleMoveToProject = async (flowId, projectId, subprojectId = null) => {
    try {
      await updateFlow(flowId, { projectId, subprojectId });
      const updater = (f) =>
        f.id === flowId ? { ...f, projectId, subprojectId } : f;
      setAllFlows((prev) => prev.map(updater));
      setProjectFlows((prev) => prev.map(updater));
      setMoveFlow(null);
      setMoveSearch("");
      setMoveNewName("");
    } catch (err) {
      logDashboardError("handleMoveToProject", err, { flowId, projectId });
    }
  };

  const handleMovePickProject = async (projectId) => {
    if (!projectId) {
      // "No Project" — unassign
      handleMoveToProject(moveFlow.flowId, null, null);
      return;
    }
    // Load subprojects for this project
    try {
      const subs = await getSubprojects(projectId);
      if (subs.length > 0) {
        setMoveFlow((prev) => ({ ...prev, step: "subproject", projectId, subs }));
        setMoveSearch("");
      } else {
        handleMoveToProject(moveFlow.flowId, projectId, null);
      }
    } catch {
      handleMoveToProject(moveFlow.flowId, projectId, null);
    }
  };

  const handleMoveCreateProject = async () => {
    if (!moveNewName.trim()) return;
    const proj = await createProject(user.uid, moveNewName.trim());
    setProjects((prev) => [proj, ...prev]);
    setMoveNewName("");
    handleMoveToProject(moveFlow.flowId, proj.id, null);
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
            <div className="dash-search-wrap">
              <svg className="dash-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                type="text"
                placeholder={view === "projects" ? "Search projects..." : "Search flows, projects, tags..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="dash-search-input"
              />
              {searchQuery && (
                <button className="dash-search-clear" onClick={() => setSearchQuery("")} aria-label="Clear search">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              )}
            </div>
          </div>

          {/* ── All Flows View ─────────────────────────── */}
          {view === "all" && (
            <>
              <div className="dash-section-header">
                <h2>All Flows</h2>
                <span className="dash-count">{filteredFlows.length} {filteredFlows.length === 1 ? "flow" : "flows"}</span>
              </div>
              {/* Filters */}
              <div className="dash-filters">
                <SearchableSelect
                  value={filterProject}
                  onChange={setFilterProject}
                  placeholder="All Projects"
                  options={[
                    { value: "__none__", label: "No Project" },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                />
                <SearchableSelect
                  value={filterType}
                  onChange={setFilterType}
                  placeholder="All Types"
                  options={allDiagramTypes.map((t) => ({ value: t, label: formatDiagramType(t) }))}
                />
                {allTags.length > 0 && (
                  <SearchableSelect
                    value={filterTag}
                    onChange={setFilterTag}
                    placeholder="All Tags"
                    options={allTags.map((t) => ({ value: t, label: t }))}
                  />
                )}
                {(filterProject || filterType || filterTag) && (
                  <button
                    className="dash-filter-clear"
                    onClick={() => { setFilterProject(""); setFilterType(""); setFilterTag(""); }}
                  >
                    Clear filters
                  </button>
                )}
              </div>
              <FlowGrid
                flows={filteredFlows}
                projects={projects}
                navigate={navigate}
                formatDate={formatDate}
                onDelete={handleDeleteFlow}
                onMove={(id) => { setMoveFlow({ flowId: id, step: "project" }); setMoveSearch(""); setMoveNewName(""); }}
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
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="dash-count">{filteredProjects.length} {filteredProjects.length === 1 ? "project" : "projects"}</span>
                  <button className="soft-btn small" onClick={() => setShowNewProject(true)}>
                    + New Project
                  </button>
                </div>
              </div>
              {filteredProjects.length === 0 && searchQuery ? (
                <div className="dash-empty">
                  <p>No projects matching "{searchQuery}"</p>
                </div>
              ) : (
              <div className="dash-project-grid">
                {filteredProjects.map((p) => {
                  const flowCount = allFlows.filter((f) => f.projectId === p.id).length;
                  return (
                    <div
                      key={p.id}
                      className="dash-project-card"
                      onClick={() => { setSelectedProject(p); setSelectedSubproject(null); setView("project-detail"); }}
                    >
                      <div className="dash-project-card-accent" />
                      <div className="dash-project-card-body">
                        <div className="dash-project-card-top">
                          <h3>{p.name}</h3>
                          <button
                            className="dash-card-delete"
                            onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        </div>
                        {p.description && <p className="dash-project-desc">{p.description}</p>}
                        <div className="dash-project-card-footer">
                          <span className="dash-project-stat">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                            {flowCount} {flowCount === 1 ? "flow" : "flows"}
                          </span>
                          <span className="dash-card-meta">{formatDate(p.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
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
                projects={projects}
                navigate={navigate}
                formatDate={formatDate}
                onDelete={handleDeleteFlow}
                onMove={(id) => { setMoveFlow({ flowId: id, step: "project" }); setMoveSearch(""); setMoveNewName(""); }}
                onAddTag={(id) => { setShowTagInput(id); setNewTag(""); }}
                onRemoveTag={handleRemoveTag}
                showTagInput={showTagInput}
                newTag={newTag}
                setNewTag={setNewTag}
                onSubmitTag={handleAddTag}
                onCancelTag={() => setShowTagInput(null)}
                hideProject
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

      {/* ── Move to Project Dialog ────────────────────────── */}
      {moveFlow && (
        <div className="modal-backdrop" onClick={() => { setMoveFlow(null); setMoveSearch(""); setMoveNewName(""); }}>
          <div className="modal-card" style={{ maxWidth: 400, width: "90%" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px" }}>
              {moveFlow.step === "subproject" ? "Select Subproject" : "Move to Project"}
            </h3>
            <input
              className="modal-input"
              placeholder={moveFlow.step === "subproject" ? "Search subprojects..." : "Search projects..."}
              value={moveSearch}
              onChange={(e) => setMoveSearch(e.target.value)}
              autoFocus
            />
            <div className="dash-move-list">
              {moveFlow.step === "project" ? (
                <>
                  <button
                    className="dash-move-item"
                    onClick={() => handleMovePickProject(null)}
                  >
                    <span style={{ color: "var(--ink-muted)" }}>No Project</span>
                  </button>
                  {projects
                    .filter((p) => !moveSearch || p.name.toLowerCase().includes(moveSearch.toLowerCase()))
                    .map((p) => (
                      <button
                        key={p.id}
                        className="dash-move-item"
                        onClick={() => handleMovePickProject(p.id)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        {p.name}
                      </button>
                    ))
                  }
                  <div className="dash-move-create">
                    <input
                      className="modal-input"
                      placeholder="New project name..."
                      value={moveNewName}
                      onChange={(e) => setMoveNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleMoveCreateProject()}
                    />
                    {moveNewName.trim() && (
                      <button className="soft-btn primary small" onClick={handleMoveCreateProject}>
                        Create
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <button
                    className="dash-move-item"
                    onClick={() => handleMoveToProject(moveFlow.flowId, moveFlow.projectId, null)}
                  >
                    <span style={{ color: "var(--ink-muted)" }}>No Subproject</span>
                  </button>
                  {(moveFlow.subs || [])
                    .filter((s) => !moveSearch || s.name.toLowerCase().includes(moveSearch.toLowerCase()))
                    .map((s) => (
                      <button
                        key={s.id}
                        className="dash-move-item"
                        onClick={() => handleMoveToProject(moveFlow.flowId, moveFlow.projectId, s.id)}
                      >
                        {s.name}
                      </button>
                    ))
                  }
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => { setMoveFlow(null); setMoveSearch(""); setMoveNewName(""); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Dialog ──────────────────── */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title={
          deleteConfirm?.type === "project" ? "Delete Project" :
          deleteConfirm?.type === "subproject" ? "Delete Subproject" :
          "Delete Flow"
        }
        message={deleteConfirm?.message || ""}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

/* ── Diagram type icons ───────────────────────────────── */
const DIAGRAM_ICONS = {
  flowchart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4"/><path d="M6.5 10v4"/><path d="M14 17.5h-4"/><path d="M17.5 14v-4"/>
    </svg>
  ),
  "flowchart-v2": (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4"/><path d="M6.5 10v4"/><path d="M14 17.5h-4"/><path d="M17.5 14v-4"/>
    </svg>
  ),
  gantt: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="14" height="4" rx="1"/><rect x="5" y="10" width="12" height="4" rx="1"/><rect x="7" y="16" width="8" height="4" rx="1"/>
    </svg>
  ),
  sequence: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="3" x2="6" y2="21"/><line x1="18" y1="3" x2="18" y2="21"/><line x1="6" y1="9" x2="18" y2="9"/><polyline points="15 6 18 9 15 12"/>
    </svg>
  ),
  state: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  er: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="8" height="6" rx="1"/><rect x="14" y="3" width="8" height="6" rx="1"/><rect x="8" y="15" width="8" height="6" rx="1"/><line x1="6" y1="9" x2="12" y2="15"/><line x1="18" y1="9" x2="12" y2="15"/>
    </svg>
  ),
  pie: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>
    </svg>
  ),
};

function getDiagramIcon(type) {
  if (!type) return DIAGRAM_ICONS.flowchart;
  const key = type.toLowerCase().replace(/\s+/g, "-");
  return DIAGRAM_ICONS[key] || DIAGRAM_ICONS.flowchart;
}

function formatDiagramType(type) {
  if (!type) return "Diagram";
  return type.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── Flow Grid Sub-component ──────────────────────────── */
function FlowGrid({
  flows,
  projects = [],
  navigate,
  formatDate,
  onDelete,
  onMove,
  onAddTag,
  onRemoveTag,
  showTagInput,
  newTag,
  setNewTag,
  onSubmitTag,
  onCancelTag,
  hideProject = false,
}) {
  const projectMap = useMemo(() => {
    const map = {};
    projects.forEach((p) => { map[p.id] = p; });
    return map;
  }, [projects]);

  if (flows.length === 0) {
    return (
      <div className="dash-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 12 }}>
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4"/><path d="M6.5 10v4"/><path d="M14 17.5h-4"/><path d="M17.5 14v-4"/>
        </svg>
        <p>No flows yet</p>
        <p style={{ fontSize: 13, marginTop: 4 }}>Create one to get started</p>
      </div>
    );
  }

  return (
    <div className="dash-flow-grid">
      {flows.map((f) => {
        const project = !hideProject && f.projectId ? projectMap[f.projectId] : null;
        return (
          <div
            key={f.id}
            className="dash-flow-card"
            onClick={() => navigate(`/editor/${f.id}`)}
          >
            <MermaidThumb
              thumbnailUrl={f.thumbnailUrl}
              code={f.code}
              diagramType={f.diagramType}
              flowId={f.id}
            />
            <div className="dash-flow-card-top">
              <span className="dash-flow-type-badge">
                {getDiagramIcon(f.diagramType)}
                {formatDiagramType(f.diagramType)}
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className="dash-card-action"
                  onClick={(e) => { e.stopPropagation(); onMove(f.id); }}
                  aria-label="Move to project"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                </button>
                <button
                  className="dash-card-delete"
                  onClick={(e) => { e.stopPropagation(); onDelete(f.id); }}
                  aria-label="Delete flow"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
            <h4 className="dash-flow-card-title">{f.name || "Untitled"}</h4>
            {project && (
              <span className="dash-flow-project-badge">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                {project.name}
              </span>
            )}
            {f.tabs && f.tabs.length > 1 && (
              <div className="dash-flow-tabs-info">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v6"/></svg>
                <span>{f.tabs.length} tabs</span>
                <span className="dash-flow-tab-names">
                  {f.tabs.map((t) => t.label).join(", ")}
                </span>
              </div>
            )}
            <div className="dash-flow-tags" onClick={(e) => e.stopPropagation()}>
              {(f.tags || []).map((t) => (
                <span key={t} className="dash-flow-tag">
                  {t}
                  <button onClick={() => onRemoveTag(f.id, t)} aria-label={`Remove tag ${t}`}>×</button>
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
                <button className="dash-tag-add" onClick={() => onAddTag(f.id)} aria-label="Add tag">
                  +
                </button>
              )}
            </div>
            <div className="dash-flow-card-footer">
              <span className="dash-card-meta">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                {formatDate(f.updatedAt)}
              </span>
              <svg className="dash-flow-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Searchable Select Component ──────────────────────── */
function SearchableSelect({ value, onChange, placeholder, options }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
    const handleClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const handleKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const currentLabel = value
    ? options.find((o) => o.value === value)?.label || value
    : placeholder;

  return (
    <div className="dash-ss-wrap" ref={wrapRef}>
      <button
        className={`dash-filter-select${value ? " active" : ""}`}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {currentLabel}
      </button>
      {open && (
        <div className="dash-ss-dropdown">
          <div className="dash-ss-search">
            <input
              ref={inputRef}
              placeholder="Search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="dash-ss-options">
            <button
              className={`dash-ss-option${!value ? " active" : ""}`}
              onClick={() => { onChange(""); setOpen(false); }}
            >
              {placeholder}
            </button>
            {filtered.map((o) => (
              <button
                key={o.value}
                className={`dash-ss-option${value === o.value ? " active" : ""}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {o.label}
              </button>
            ))}
            {filtered.length === 0 && query && (
              <div className="dash-ss-empty">No matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Mermaid Thumbnail Component ─────────────────────── */
let mermaidInstance = null;
let mermaidLoading = false;
const mermaidQueue = [];

function loadMermaid() {
  if (mermaidInstance) return Promise.resolve(mermaidInstance);
  if (mermaidLoading) {
    return new Promise((resolve) => mermaidQueue.push(resolve));
  }
  mermaidLoading = true;
  return import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs").then(
    (mod) => {
      mermaidInstance = mod.default;
      mermaidInstance.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "loose",
        fontFamily: "sans-serif",
        fontSize: 12,
      });
      mermaidQueue.forEach((cb) => cb(mermaidInstance));
      mermaidQueue.length = 0;
      return mermaidInstance;
    }
  );
}

let thumbCounter = 0;

function MermaidThumb({ thumbnailUrl, code, diagramType, flowId }) {
  const containerRef = useRef(null);
  const [svgHtml, setSvgHtml] = useState("");
  const [failed, setFailed] = useState(false);
  const rendered = useRef(false);

  useEffect(() => {
    if (thumbnailUrl || !code || rendered.current) return;
    rendered.current = true;

    let cancelled = false;
    loadMermaid().then(async (mermaid) => {
      if (cancelled) return;
      const id = `mthumb-${flowId}-${thumbCounter++}`;
      const offscreen = document.createElement("div");
      offscreen.style.cssText = "position:absolute;left:-9999px;top:-9999px;";
      document.body.appendChild(offscreen);
      try {
        const { svg } = await mermaid.render(id, code, offscreen);
        if (!cancelled) setSvgHtml(svg);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        offscreen.remove();
      }
    });
    return () => { cancelled = true; };
  }, [thumbnailUrl, code, flowId]);

  if (thumbnailUrl) {
    return (
      <div className="dash-flow-thumb">
        <img src={thumbnailUrl} alt="" loading="lazy" draggable="false" />
      </div>
    );
  }

  if (svgHtml) {
    return (
      <div
        className="dash-flow-thumb dash-flow-thumb-rendered"
        ref={containerRef}
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
    );
  }

  return (
    <div className="dash-flow-thumb dash-flow-thumb-empty">
      {failed ? getDiagramIcon(diagramType) : (
        <div className="dash-flow-thumb-loading" />
      )}
    </div>
  );
}
