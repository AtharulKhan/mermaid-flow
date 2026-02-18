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
  getUserTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "../firebase/firestore";
import { DEFAULT_CODE } from "../diagramData";
import ConfirmDialog from "./ConfirmDialog";
import SaveTemplateDialog from "./SaveTemplateDialog";

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

  // Templates
  const [templates, setTemplates] = useState([]);
  const [templateCategory, setTemplateCategory] = useState("");
  const [saveTemplateFlow, setSaveTemplateFlow] = useState(null); // flow object when saving from card
  const [useTemplateDialog, setUseTemplateDialog] = useState(null); // template object when using
  const [useTemplateName, setUseTemplateName] = useState("");
  const [useTemplateProject, setUseTemplateProject] = useState("");
  const [useTemplateNewProject, setUseTemplateNewProject] = useState("");
  const [editTemplateDialog, setEditTemplateDialog] = useState(null); // template for editing details
  const [editTemplateName, setEditTemplateName] = useState("");
  const [editTemplateDesc, setEditTemplateDesc] = useState("");
  const [editTemplateTags, setEditTemplateTags] = useState("");
  const [editTemplateTabs, setEditTemplateTabs] = useState([]); // [{id, label, code}]
  const [editTemplateActiveTab, setEditTemplateActiveTab] = useState("");

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
    const [projectsResult, flowsResult, templatesResult] = await Promise.allSettled([
      getUserProjects(user.uid),
      getAllUserFlows(user.uid),
      getUserTemplates(user.uid),
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

    if (templatesResult.status === "fulfilled") {
      setTemplates(templatesResult.value);
    } else {
      logDashboardError("loadAll/getUserTemplates", templatesResult.reason, { uid: user.uid });
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

  // Group flows by projectId for project card previews
  const flowsByProject = useMemo(() => {
    const map = {};
    allFlows.forEach((f) => {
      if (f.projectId) {
        if (!map[f.projectId]) map[f.projectId] = [];
        map[f.projectId].push(f);
      }
    });
    return map;
  }, [allFlows]);

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
    } else if (type === "template") {
      await deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
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

  // Template handlers
  const handleDeleteTemplate = async (templateId) => {
    setDeleteConfirm({
      type: "template",
      id: templateId,
      message: "Delete this template permanently?",
    });
  };

  const handleUseTemplate = async () => {
    if (!useTemplateDialog) return;
    const t = useTemplateDialog;
    const name = useTemplateName.trim() || t.name || "Untitled";
    try {
      let projectId = useTemplateProject || null;
      // Create new project if user typed a name
      if (!projectId && useTemplateNewProject.trim()) {
        const proj = await createProject(user.uid, useTemplateNewProject.trim());
        setProjects((prev) => [proj, ...prev]);
        projectId = proj.id;
      }
      const flow = await createFlow(user.uid, {
        name,
        code: t.code || "",
        diagramType: t.diagramType || "flowchart",
        projectId,
        subprojectId: null,
        tags: [],
        ganttViewState: t.ganttViewState || null,
      });
      if (t.tabs && t.tabs.length > 0) {
        await updateFlow(flow.id, {
          tabs: t.tabs.map((tab) => ({ id: tab.id, label: tab.label, code: tab.code })),
          activeTabId: t.tabs[0]?.id || null,
        });
      }
      setUseTemplateDialog(null);
      setUseTemplateName("");
      setUseTemplateProject("");
      setUseTemplateNewProject("");
      navigate(`/editor/${flow.id}`);
    } catch (err) {
      logDashboardError("handleUseTemplate", err, { templateId: t.id });
    }
  };

  const handleEditTemplateSubmit = async () => {
    if (!editTemplateDialog) return;
    const parsedTags = editTemplateTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const mainCode = editTemplateTabs.length > 0 ? editTemplateTabs[0].code : editTemplateDialog.code;
    try {
      await updateTemplate(editTemplateDialog.id, {
        name: editTemplateName.trim() || "Untitled Template",
        description: editTemplateDesc.trim(),
        tags: parsedTags,
        code: mainCode,
        tabs: editTemplateTabs,
      });
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === editTemplateDialog.id
            ? { ...t, name: editTemplateName.trim() || "Untitled Template", description: editTemplateDesc.trim(), tags: parsedTags, code: mainCode, tabs: editTemplateTabs }
            : t
        )
      );
      setEditTemplateDialog(null);
    } catch (err) {
      logDashboardError("handleEditTemplate", err, { templateId: editTemplateDialog.id });
    }
  };

  // Filtered templates
  const filteredTemplates = useMemo(() => {
    let list = templates;
    if (templateCategory) {
      list = list.filter((t) => t.category === templateCategory);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.name?.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.category?.toLowerCase().includes(q) ||
          t.tags?.some((tag) => tag.toLowerCase().includes(q))
      );
    }
    return list;
  }, [templates, templateCategory, searchQuery]);

  // Template categories
  const templateCategories = useMemo(() => {
    const cats = new Set();
    templates.forEach((t) => { if (t.category) cats.add(t.category); });
    return [...cats].sort();
  }, [templates]);

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
              className={`dash-nav-item ${view === "templates" ? "active" : ""}`}
              onClick={() => { setView("templates"); setSelectedProject(null); setSelectedSubproject(null); }}
            >
              Templates
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
                placeholder={view === "projects" ? "Search projects..." : view === "templates" ? "Search templates..." : "Search flows, projects, tags..."}
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
                onSaveAsTemplate={(f) => setSaveTemplateFlow(f)}
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
                  const pFlows = flowsByProject[p.id] || [];
                  const previewFlows = pFlows.slice(0, 3);
                  const overflowCount = pFlows.length - 3;
                  return (
                    <div
                      key={p.id}
                      className="dash-project-card"
                      onClick={() => { setSelectedProject(p); setSelectedSubproject(null); setView("project-detail"); }}
                    >
                      <div className="dash-project-card-accent" />
                      <div className="dash-project-card-body">
                        <div className="dash-project-card-top">
                          <div className="dash-project-card-header">
                            <svg className="dash-project-card-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                            <h3>{p.name}</h3>
                          </div>
                          <button
                            className="dash-card-delete"
                            onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        </div>
                        {p.description && <p className="dash-project-desc">{p.description}</p>}

                        {/* Flow previews */}
                        {previewFlows.length > 0 ? (
                          <div className="dash-project-flows">
                            {previewFlows.map((f) => (
                              <button
                                key={f.id}
                                className="dash-project-flow-item"
                                onClick={(e) => { e.stopPropagation(); navigate(`/editor/${f.id}`); }}
                              >
                                <span className="dash-project-flow-icon">{getDiagramIcon(f.diagramType)}</span>
                                <span className="dash-project-flow-name">{f.name || "Untitled"}</span>
                                <svg className="dash-project-flow-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                              </button>
                            ))}
                            {overflowCount > 0 && (
                              <span className="dash-project-flow-more">+{overflowCount} more</span>
                            )}
                          </div>
                        ) : (
                          <div className="dash-project-flows-empty">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4"/><path d="M6.5 10v4"/><path d="M14 17.5h-4"/><path d="M17.5 14v-4"/></svg>
                            No flows yet
                          </div>
                        )}

                        <div className="dash-project-card-footer">
                          <span className="dash-project-stat">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
                            {pFlows.length} {pFlows.length === 1 ? "flow" : "flows"}
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
                onSaveAsTemplate={(f) => setSaveTemplateFlow(f)}
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

          {/* ── Templates View ──────────────────────────── */}
          {view === "templates" && (
            <>
              <div className="dash-section-header">
                <h2>My Templates</h2>
                <span className="dash-count">{filteredTemplates.length} {filteredTemplates.length === 1 ? "template" : "templates"}</span>
              </div>
              {templateCategories.length > 0 && (
                <div className="dash-filters">
                  <SearchableSelect
                    value={templateCategory}
                    onChange={setTemplateCategory}
                    placeholder="All Types"
                    options={templateCategories.map((c) => ({ value: c, label: formatDiagramType(c) }))}
                  />
                  {templateCategory && (
                    <button className="dash-filter-clear" onClick={() => setTemplateCategory("")}>
                      Clear filter
                    </button>
                  )}
                </div>
              )}
              {filteredTemplates.length === 0 ? (
                <div className="dash-empty">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4, marginBottom: 12 }}>
                    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v6"/>
                  </svg>
                  <p>No templates yet</p>
                  <p style={{ fontSize: 13, marginTop: 4 }}>Save a flow as a template from the editor or flow cards</p>
                </div>
              ) : (
                <div className="dash-flow-grid">
                  {filteredTemplates.map((t) => (
                    <div key={t.id} className="dash-flow-card template-card">
                      <MermaidThumb
                        thumbnailUrl={t.thumbnailUrl}
                        code={t.code}
                        diagramType={t.diagramType}
                        flowId={t.id}
                      />
                      <div className="dash-flow-card-top">
                        <span className="dash-flow-type-badge">
                          {getDiagramIcon(t.diagramType || t.category)}
                          {formatDiagramType(t.diagramType || t.category)}
                        </span>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="dash-card-action"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditTemplateDialog(t);
                              setEditTemplateName(t.name || "");
                              setEditTemplateDesc(t.description || "");
                              setEditTemplateTags((t.tags || []).join(", "));
                              const tabs = t.tabs && t.tabs.length > 0
                                ? t.tabs.map((tab) => ({ ...tab }))
                                : [{ id: "main", label: "Main", code: t.code || "" }];
                              setEditTemplateTabs(tabs);
                              setEditTemplateActiveTab(tabs[0].id);
                            }}
                            aria-label="Edit template"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                          </button>
                          <button
                            className="dash-card-delete"
                            onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(t.id); }}
                            aria-label="Delete template"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                          </button>
                        </div>
                      </div>
                      <h4 className="dash-flow-card-title">{t.name || "Untitled Template"}</h4>
                      {t.description && (
                        <p className="template-description">{t.description}</p>
                      )}
                      {t.tabs && t.tabs.length > 1 && (
                        <div className="dash-flow-tabs-info">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v6"/></svg>
                          <span>{t.tabs.length} tabs</span>
                        </div>
                      )}
                      {(t.tags || []).length > 0 && (
                        <div className="dash-flow-tags">
                          {t.tags.map((tag) => (
                            <span key={tag} className="dash-flow-tag">{tag}</span>
                          ))}
                        </div>
                      )}
                      <div className="dash-flow-card-footer">
                        <span className="dash-card-meta">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                          {formatDate(t.updatedAt)}
                        </span>
                        <button
                          className="template-use-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setUseTemplateDialog(t);
                            setUseTemplateName(t.name || "");
                            setUseTemplateProject("");
                            setUseTemplateNewProject("");
                          }}
                        >
                          Use Template
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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

      {/* ── Use Template Dialog ───────────────────────── */}
      {useTemplateDialog && (
        <div className="modal-backdrop" onClick={() => setUseTemplateDialog(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px" }}>Create Flow from Template</h3>
            <p style={{ margin: "0 0 12px", fontSize: "0.82rem", color: "var(--ink-soft)" }}>
              This will create a new flow from "{useTemplateDialog.name}".
            </p>
            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Flow Name
                <input
                  className="modal-input"
                  value={useTemplateName}
                  onChange={(e) => setUseTemplateName(e.target.value)}
                  placeholder="Flow name"
                  autoFocus
                  style={{ marginTop: 4 }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleUseTemplate(); }}
                />
              </label>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Project (optional)
                <select
                  className="modal-input"
                  value={useTemplateProject}
                  onChange={(e) => { setUseTemplateProject(e.target.value); if (e.target.value) setUseTemplateNewProject(""); }}
                  style={{ marginTop: 4 }}
                >
                  <option value="">No Project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              {!useTemplateProject && (
                <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                  Or create new project
                  <input
                    className="modal-input"
                    value={useTemplateNewProject}
                    onChange={(e) => setUseTemplateNewProject(e.target.value)}
                    placeholder="New project name..."
                    style={{ marginTop: 4 }}
                    onKeyDown={(e) => { if (e.key === "Enter") handleUseTemplate(); }}
                  />
                </label>
              )}
            </div>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setUseTemplateDialog(null)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleUseTemplate}>Create Flow</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Template Dialog ─────────────────────── */}
      {editTemplateDialog && (
        <div className="modal-backdrop" onClick={() => setEditTemplateDialog(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h3 style={{ margin: "0 0 12px" }}>Edit Template</h3>
            <div style={{ display: "grid", gap: 12 }}>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Name
                <input
                  className="modal-input"
                  value={editTemplateName}
                  onChange={(e) => setEditTemplateName(e.target.value)}
                  placeholder="Template name"
                  autoFocus
                  style={{ marginTop: 4 }}
                />
              </label>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Description
                <textarea
                  className="modal-input"
                  value={editTemplateDesc}
                  onChange={(e) => setEditTemplateDesc(e.target.value)}
                  placeholder="What is this template for?"
                  rows={2}
                  style={{ marginTop: 4, resize: "vertical", fontFamily: "inherit" }}
                />
              </label>
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)" }}>
                Tags
                <input
                  className="modal-input"
                  value={editTemplateTags}
                  onChange={(e) => setEditTemplateTags(e.target.value)}
                  placeholder="e.g. onboarding, sprint (comma-separated)"
                  style={{ marginTop: 4 }}
                />
              </label>
              <div>
                <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--ink-soft)", display: "block", marginBottom: 4 }}>
                  Code
                </span>
                {editTemplateTabs.length > 1 && (
                  <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                    {editTemplateTabs.map((tab) => (
                      <button
                        key={tab.id}
                        className={`soft-btn small${editTemplateActiveTab === tab.id ? " primary" : ""}`}
                        onClick={() => setEditTemplateActiveTab(tab.id)}
                        style={{ fontSize: "0.78rem", padding: "3px 10px" }}
                      >
                        {tab.label || "Tab"}
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  className="modal-input"
                  value={editTemplateTabs.find((tab) => tab.id === editTemplateActiveTab)?.code || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setEditTemplateTabs((prev) =>
                      prev.map((tab) =>
                        tab.id === editTemplateActiveTab ? { ...tab, code: val } : tab
                      )
                    );
                  }}
                  rows={10}
                  style={{ marginTop: 0, resize: "vertical", fontFamily: "monospace", fontSize: "0.82rem", lineHeight: 1.5, tabSize: 2 }}
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="soft-btn" onClick={() => setEditTemplateDialog(null)}>Cancel</button>
              <button className="soft-btn primary" onClick={handleEditTemplateSubmit}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save as Template Dialog (from flow card) ──── */}
      <SaveTemplateDialog
        open={!!saveTemplateFlow}
        onClose={() => setSaveTemplateFlow(null)}
        existingTemplates={templates}
        defaultName={saveTemplateFlow?.name || ""}
        diagramType={saveTemplateFlow?.diagramType || "flowchart"}
        onSave={async ({ name, description, tags }) => {
          if (!saveTemplateFlow) return;
          const f = saveTemplateFlow;
          await createTemplate(user.uid, {
            name,
            description,
            category: f.diagramType || "flowchart",
            code: f.code || "",
            diagramType: f.diagramType || "flowchart",
            tabs: (f.tabs || []).map((tab) => ({ id: tab.id, label: tab.label, code: tab.code })),
            tags,
            ganttViewState: f.ganttViewState || null,
          });
          const updated = await getUserTemplates(user.uid);
          setTemplates(updated);
        }}
        onUpdate={async (templateId) => {
          if (!saveTemplateFlow) return;
          const f = saveTemplateFlow;
          await updateTemplate(templateId, {
            code: f.code || "",
            diagramType: f.diagramType || "flowchart",
            category: f.diagramType || "flowchart",
            tabs: (f.tabs || []).map((tab) => ({ id: tab.id, label: tab.label, code: tab.code })),
            ganttViewState: f.ganttViewState || null,
          });
          const updated = await getUserTemplates(user.uid);
          setTemplates(updated);
        }}
      />

      {/* ── Delete Confirmation Dialog ──────────────────── */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title={
          deleteConfirm?.type === "project" ? "Delete Project" :
          deleteConfirm?.type === "subproject" ? "Delete Subproject" :
          deleteConfirm?.type === "template" ? "Delete Template" :
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
  onSaveAsTemplate,
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
                {onSaveAsTemplate && (
                  <button
                    className="dash-card-action"
                    onClick={(e) => { e.stopPropagation(); onSaveAsTemplate(f); }}
                    aria-label="Save as template"
                    title="Save as template"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 3v6"/></svg>
                  </button>
                )}
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
