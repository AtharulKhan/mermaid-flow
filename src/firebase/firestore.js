import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  writeBatch,
  limit,
} from "firebase/firestore";
import { db, auth } from "./config";

function normalizeFirestoreError(err) {
  return {
    code: err?.code || "unknown",
    message: err?.message || String(err),
    name: err?.name || "Error",
  };
}

export function formatFirestoreError(err) {
  const details = normalizeFirestoreError(err);
  return `${details.code}: ${details.message}`;
}

function logFirestoreError(operation, err, context = {}) {
  const details = normalizeFirestoreError(err);
  const payload = {
    operation,
    ...details,
    context,
    timestamp: new Date().toISOString(),
  };
  console.error("[Firestore]", payload);
  if (typeof window !== "undefined") {
    window.__MF_FIRESTORE_ERRORS__ = window.__MF_FIRESTORE_ERRORS__ || [];
    window.__MF_FIRESTORE_ERRORS__.push(payload);
  }
}

async function runFirestoreOperation(operation, context, fn) {
  try {
    return await fn();
  } catch (err) {
    logFirestoreError(operation, err, context);
    throw err;
  }
}

// ── Firestore Schema ─────────────────────────────────
//
// users/{uid}
//   - uid, email, displayName, photoURL, createdAt
//
// projects/{projectId}
//   - name, description, ownerId, createdAt, updatedAt
//   - members: { [uid]: "owner" | "edit" | "comment" | "read" }
//   - memberUids: string[]  ← flat array for querying
//   - tags: string[]
//
// projects/{projectId}/subprojects/{subprojectId}
//   - name, description, createdAt, updatedAt
//   - tags: string[]
//
// flows/{flowId}
//   - name, code (mermaid), diagramType, ownerId
//   - projectId (nullable), subprojectId (nullable)
//   - tags: string[], createdAt, updatedAt
//   - sharing: { [uid]: "edit" | "comment" | "read" }
//   - sharedWith: string[]  ← flat array for querying
//   - publicAccess: null | "read" | "comment" | "edit"
//   - thumbnailUrl (optional, stored in Firebase Storage)
//
// flows/{flowId}/comments/{commentId}
//   - authorId, authorName, text, createdAt
//
// templates/{templateId}
//   - name, description, category, code (mermaid), diagramType
//   - tabs: [{ id, label, code }], ganttViewState (nullable)
//   - ownerId, thumbnailUrl (nullable), tags: string[]
//   - createdAt, updatedAt
//
// users/{uid}/settings/integrations
//   - notion: { apiKey, defaultDatabaseId }
//   - (extensible for future integrations)
//
// ──────────────────────────────────────────────────────

// ── Helper: chunk array for batched deletes ──────────

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ── Projects ──────────────────────────────────────────

export async function createProject(ownerId, name, description = "") {
  return runFirestoreOperation("createProject", { ownerId, name }, async () => {
    const ref = await addDoc(collection(db, "projects"), {
      name,
      description,
      ownerId,
      members: { [ownerId]: "owner" },
      memberUids: [ownerId],
      tags: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { id: ref.id, name, description, ownerId, members: { [ownerId]: "owner" }, memberUids: [ownerId], tags: [] };
  });
}

export async function getProject(projectId) {
  const snap = await getDoc(doc(db, "projects", projectId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getUserProjects(uid) {
  return runFirestoreOperation("getUserProjects", { uid }, async () => {
    const q = query(
      collection(db, "projects"),
      where("memberUids", "array-contains", uid),
      orderBy("updatedAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
}

export async function updateProject(projectId, updates) {
  await updateDoc(doc(db, "projects", projectId), {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteProject(projectId) {
  // Delete subprojects in batches of 499 (+ 1 for the project doc)
  const subSnap = await getDocs(collection(db, "projects", projectId, "subprojects"));
  const allDocs = [...subSnap.docs.map((d) => d.ref), doc(db, "projects", projectId)];
  const chunks = chunkArray(allDocs, 499);
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  // Unlink flows owned by current user (don't delete them)
  const uid = auth.currentUser?.uid;
  if (uid) {
    const flowsQ = query(collection(db, "flows"), where("projectId", "==", projectId), where("ownerId", "==", uid));
    const flowSnap = await getDocs(flowsQ);
    for (const d of flowSnap.docs) {
      await updateDoc(d.ref, { projectId: null, subprojectId: null });
    }
  }
}

export async function addProjectMember(projectId, uid, role) {
  await updateDoc(doc(db, "projects", projectId), {
    [`members.${uid}`]: role,
    memberUids: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

export async function removeProjectMember(projectId, uid) {
  const proj = await getProject(projectId);
  if (!proj) return;
  const members = { ...proj.members };
  delete members[uid];
  await updateDoc(doc(db, "projects", projectId), {
    members,
    memberUids: arrayRemove(uid),
    updatedAt: serverTimestamp(),
  });
}

// ── Subprojects ───────────────────────────────────────

export async function createSubproject(projectId, name, description = "") {
  const ref = await addDoc(collection(db, "projects", projectId, "subprojects"), {
    name,
    description,
    tags: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return { id: ref.id, name, description, tags: [] };
}

export async function getSubprojects(projectId) {
  const q = query(
    collection(db, "projects", projectId, "subprojects"),
    orderBy("updatedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function updateSubproject(projectId, subprojectId, updates) {
  await updateDoc(doc(db, "projects", projectId, "subprojects", subprojectId), {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteSubproject(projectId, subprojectId) {
  await deleteDoc(doc(db, "projects", projectId, "subprojects", subprojectId));
  // Unlink flows owned by current user
  const uid = auth.currentUser?.uid;
  if (uid) {
    const flowsQ = query(
      collection(db, "flows"),
      where("projectId", "==", projectId),
      where("subprojectId", "==", subprojectId),
      where("ownerId", "==", uid)
    );
    const snap = await getDocs(flowsQ);
    for (const d of snap.docs) {
      await updateDoc(d.ref, { subprojectId: null });
    }
  }
}

// ── Flows ─────────────────────────────────────────────

export async function createFlow(ownerId, { name, code, diagramType, projectId, subprojectId, tags, ganttViewState }) {
  return runFirestoreOperation("createFlow", { ownerId, name, projectId, subprojectId }, async () => {
    const ref = await addDoc(collection(db, "flows"), {
      name: name || "Untitled",
      code: code || "",
      diagramType: diagramType || "flowchart",
      ownerId,
      projectId: projectId || null,
      subprojectId: subprojectId || null,
      tags: tags || [],
      sharing: { [ownerId]: "edit" },
      sharedWith: [ownerId],
      publicAccess: null,
      thumbnailUrl: null,
      ganttViewState: ganttViewState || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return {
      id: ref.id,
      name,
      code,
      diagramType,
      ownerId,
      projectId,
      subprojectId,
      tags: tags || [],
      ganttViewState: ganttViewState || null,
    };
  });
}

export async function getFlow(flowId) {
  return runFirestoreOperation("getFlow", { flowId }, async () => {
    const snap = await getDoc(doc(db, "flows", flowId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  });
}

export async function getUserFlows(uid, { projectId, subprojectId, tag, limitCount } = {}) {
  return runFirestoreOperation(
    "getUserFlows",
    { uid, projectId: projectId || null, subprojectId: subprojectId || null, tag: tag || null, limitCount: limitCount || null },
    async () => {
      const constraints = [orderBy("updatedAt", "desc")];

      if (projectId && subprojectId) {
        constraints.unshift(
          where("projectId", "==", projectId),
          where("subprojectId", "==", subprojectId)
        );
      } else if (projectId) {
        constraints.unshift(where("projectId", "==", projectId));
      }

      // Pull both owned and shared flows for project/subproject views.
      const [ownedSnap, sharedSnap] = await Promise.all([
        getDocs(query(collection(db, "flows"), where("ownerId", "==", uid), ...constraints)),
        getDocs(query(collection(db, "flows"), where("sharedWith", "array-contains", uid), ...constraints)),
      ]);

      const byId = new Map();
      ownedSnap.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));
      sharedSnap.docs.forEach((d) => byId.set(d.id, { id: d.id, ...d.data() }));

      let results = [...byId.values()];

      // Client-side tag filter.
      if (tag) {
        results = results.filter((f) => f.tags?.includes(tag));
      }

      results.sort((a, b) => {
        const aTime = a.updatedAt?.toMillis?.() || 0;
        const bTime = b.updatedAt?.toMillis?.() || 0;
        return bTime - aTime;
      });

      if (limitCount) {
        results = results.slice(0, limitCount);
      }

      return results;
    }
  );
}

export async function getSharedFlows(uid) {
  return runFirestoreOperation("getSharedFlows", { uid }, async () => {
    const q = query(
      collection(db, "flows"),
      where("sharedWith", "array-contains", uid),
      orderBy("updatedAt", "desc")
    );
    const snap = await getDocs(q);
    // Exclude flows owned by the user (they appear in sharedWith too)
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((f) => f.ownerId !== uid);
  });
}

export async function getAllUserFlows(uid) {
  return runFirestoreOperation("getAllUserFlows", { uid }, async () => {
    // Get owned flows
    const ownedQ = query(
      collection(db, "flows"),
      where("ownerId", "==", uid),
      orderBy("updatedAt", "desc")
    );
    const ownedSnap = await getDocs(ownedQ);
    const owned = ownedSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Get shared flows
    const shared = await getSharedFlows(uid);

    // Merge and sort by updatedAt descending
    return [...owned, ...shared].sort((a, b) => {
      const aTime = a.updatedAt?.toMillis?.() || 0;
      const bTime = b.updatedAt?.toMillis?.() || 0;
      return bTime - aTime;
    });
  });
}

export async function updateFlow(flowId, updates) {
  return runFirestoreOperation("updateFlow", { flowId, updateKeys: Object.keys(updates || {}) }, async () => {
    await updateDoc(doc(db, "flows", flowId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function setFlowBaseline(flowId, baselineCode) {
  return runFirestoreOperation("setFlowBaseline", { flowId }, async () => {
    await updateDoc(doc(db, "flows", flowId), {
      baselineCode,
      baselineSetAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function clearFlowBaseline(flowId) {
  return runFirestoreOperation("clearFlowBaseline", { flowId }, async () => {
    await updateDoc(doc(db, "flows", flowId), {
      baselineCode: null,
      baselineSetAt: null,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function deleteFlow(flowId) {
  // Delete comments and versions subcollections in batches
  const [commentsSnap, versionsSnap] = await Promise.all([
    getDocs(collection(db, "flows", flowId, "comments")),
    getDocs(collection(db, "flows", flowId, "versions")),
  ]);
  const allDocs = [
    ...commentsSnap.docs.map((d) => d.ref),
    ...versionsSnap.docs.map((d) => d.ref),
    doc(db, "flows", flowId),
  ];
  const chunks = chunkArray(allDocs, 499);
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

// ── Flow Versions ─────────────────────────────────────

const MAX_VERSIONS = 10;

export async function saveFlowVersion(flowId, { code, diagramType, tabs }) {
  return runFirestoreOperation(
    "saveFlowVersion",
    { flowId, diagramType, codeLength: code?.length || 0 },
    async () => {
      // Dedup: skip if latest version has identical code
      const latestQ = query(
        collection(db, "flows", flowId, "versions"),
        orderBy("createdAt", "desc"),
        limit(1)
      );
      const latestSnap = await getDocs(latestQ);
      if (!latestSnap.empty && latestSnap.docs[0].data().code === code) {
        return null;
      }

      // Create new version (includes all tabs if present)
      const versionData = {
        code,
        diagramType,
        createdAt: serverTimestamp(),
      };
      if (tabs && tabs.length > 0) {
        versionData.tabs = tabs.map((t) => ({ id: t.id, label: t.label, code: t.code }));
      }
      const ref = await addDoc(collection(db, "flows", flowId, "versions"), versionData);

      // Enforce cap: delete versions beyond MAX_VERSIONS
      const allQ = query(
        collection(db, "flows", flowId, "versions"),
        orderBy("createdAt", "desc")
      );
      const allSnap = await getDocs(allQ);
      if (allSnap.size > MAX_VERSIONS) {
        const toDelete = allSnap.docs.slice(MAX_VERSIONS);
        const batch = writeBatch(db);
        toDelete.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      return ref.id;
    }
  );
}

export async function getFlowVersions(flowId) {
  return runFirestoreOperation("getFlowVersions", { flowId }, async () => {
    const q = query(
      collection(db, "flows", flowId, "versions"),
      orderBy("createdAt", "desc")
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
}

// ── Flow Sharing ──────────────────────────────────────

export async function shareFlow(flowId, uid, role) {
  await updateDoc(doc(db, "flows", flowId), {
    [`sharing.${uid}`]: role,
    sharedWith: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

export async function unshareFlow(flowId, uid) {
  const flow = await getFlow(flowId);
  if (!flow) return;
  const sharing = { ...flow.sharing };
  delete sharing[uid];
  await updateDoc(doc(db, "flows", flowId), {
    sharing,
    sharedWith: arrayRemove(uid),
    updatedAt: serverTimestamp(),
  });
}

export async function setFlowPublicAccess(flowId, access) {
  await updateDoc(doc(db, "flows", flowId), {
    publicAccess: access, // null | "read" | "comment" | "edit"
    updatedAt: serverTimestamp(),
  });
}

// ── Flow Tags ─────────────────────────────────────────

export async function addFlowTag(flowId, tag) {
  await updateDoc(doc(db, "flows", flowId), {
    tags: arrayUnion(tag),
    updatedAt: serverTimestamp(),
  });
}

export async function removeFlowTag(flowId, tag) {
  await updateDoc(doc(db, "flows", flowId), {
    tags: arrayRemove(tag),
    updatedAt: serverTimestamp(),
  });
}

// ── Comments ──────────────────────────────────────────

export async function addComment(flowId, authorId, authorName, text) {
  const ref = await addDoc(collection(db, "flows", flowId, "comments"), {
    authorId,
    authorName,
    text,
    createdAt: serverTimestamp(),
  });
  return { id: ref.id, authorId, authorName, text };
}

export async function getComments(flowId) {
  const q = query(
    collection(db, "flows", flowId, "comments"),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function deleteComment(flowId, commentId) {
  await deleteDoc(doc(db, "flows", flowId, "comments", commentId));
}

// ── User lookup (for sharing) ─────────────────────────

export async function getUserByEmail(email) {
  const q = query(collection(db, "users"), where("email", "==", email));
  const snap = await getDocs(q);
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// ── User Settings (per-user API keys etc.) ────────────

const SETTINGS_DOC = "integrations";

export async function getUserSettings(uid) {
  const snap = await getDoc(doc(db, "users", uid, "settings", SETTINGS_DOC));
  return snap.exists() ? snap.data() : {};
}

export async function updateUserSettings(uid, settings) {
  await setDoc(
    doc(db, "users", uid, "settings", SETTINGS_DOC),
    settings,
    { merge: true }
  );
}

// ── Templates ────────────────────────────────────────

export async function createTemplate(ownerId, { name, description, category, code, diagramType, tabs, tags, ganttViewState }) {
  return runFirestoreOperation("createTemplate", { ownerId, name }, async () => {
    const ref = await addDoc(collection(db, "templates"), {
      name: name || "Untitled Template",
      description: description || "",
      category: category || "flowchart",
      code: code || "",
      diagramType: diagramType || "flowchart",
      tabs: tabs || [],
      ganttViewState: ganttViewState || null,
      ownerId,
      thumbnailUrl: null,
      tags: tags || [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { id: ref.id, name, description, category, code, diagramType, tabs: tabs || [], tags: tags || [], ownerId, ganttViewState: ganttViewState || null };
  });
}

export async function getTemplate(templateId) {
  return runFirestoreOperation("getTemplate", { templateId }, async () => {
    const snap = await getDoc(doc(db, "templates", templateId));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  });
}

export async function getUserTemplates(uid, { category } = {}) {
  return runFirestoreOperation("getUserTemplates", { uid, category: category || null }, async () => {
    const constraints = [where("ownerId", "==", uid)];
    if (category) {
      constraints.push(where("category", "==", category));
    }
    constraints.push(orderBy("updatedAt", "desc"));
    const q = query(collection(db, "templates"), ...constraints);
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
}

export async function updateTemplate(templateId, updates) {
  return runFirestoreOperation("updateTemplate", { templateId, updateKeys: Object.keys(updates || {}) }, async () => {
    await updateDoc(doc(db, "templates", templateId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function deleteTemplate(templateId) {
  return runFirestoreOperation("deleteTemplate", { templateId }, async () => {
    await deleteDoc(doc(db, "templates", templateId));
  });
}
