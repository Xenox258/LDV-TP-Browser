import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "/styles.css";

type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  isZip: boolean;
  indexPath?: string | null;
  children: TreeNode[];
};

let currentTree: TreeNode | null = null;
let selectedPath: string | null = null;
const expandedPaths = new Set<string>();
let isSidebarCollapsed = false;
let isViewerFullscreen = false;
let isScanning = false;
let currentRootPath: string | null = null;
let isReadOnlyTree = false;
let draggedNodePath: string | null = null;
let editingPath: string | null = null;
let creatingInParentPath: string | null = null;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("#app introuvable");
}

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">TP Browser</div>
      <div class="topbar-actions">
        <button id="import-folder-btn" class="btn">Importer un dossier</button>
        <button id="import-zip-btn" class="btn">Importer un zip</button>
        <button id="toggle-fullscreen-btn" class="btn">Plein écran</button>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-header">
  <span>Fichiers</span>
    <div class="sidebar-actions">
  <button id="create-folder-btn" class="icon-btn" title="Créer un dossier">＋</button>
  <button id="open-folder-btn" class="icon-btn" title="Ouvrir le dossier">📂</button>
  <button id="rename-entry-btn" class="icon-btn" title="Renommer">✎</button>
  <button id="delete-entry-btn" class="icon-btn" title="Supprimer">🗑</button>
  <button id="toggle-sidebar-btn" class="icon-btn icon-collapse" title="Masquer l’arborescence">◀</button>
</div>
  </div>
        <div id="tree-root" class="tree-root"></div>
      </aside>

      <section class="viewer">
        <div class="viewer-hover-zone">
          <button id="exit-fullscreen-btn" class="exit-fullscreen-btn" title="Quitter le plein écran">
            ✕
          </button>
        </div>
        <div id="viewer-content" class="viewer-content">
          <div class="empty-state">
            Sélectionne un dossier ou un zip via “Importer”, puis clique sur un élément dans l’arborescence.
          </div>
        </div>
      </section>
    </div>
    <button id="expand-sidebar-btn" class="expand-sidebar-btn" title="Afficher l’arborescence">
      ▶
    </button>
  </div>
`;

const folderBtn = document.querySelector<HTMLButtonElement>("#import-folder-btn");
const zipBtn = document.querySelector<HTMLButtonElement>("#import-zip-btn");
const openFolderBtn = document.querySelector<HTMLButtonElement>("#open-folder-btn");
const toggleSidebarBtn = document.querySelector<HTMLButtonElement>("#toggle-sidebar-btn");
const expandSidebarBtn = document.querySelector<HTMLButtonElement>("#expand-sidebar-btn");
const toggleFullscreenBtn = document.querySelector<HTMLButtonElement>("#toggle-fullscreen-btn");
const treeRoot = document.querySelector<HTMLDivElement>("#tree-root");
const viewerContent = document.querySelector<HTMLDivElement>("#viewer-content");
const shell = document.querySelector<HTMLDivElement>(".shell");
const createFolderBtn = document.querySelector<HTMLButtonElement>("#create-folder-btn");
const renameEntryBtn = document.querySelector<HTMLButtonElement>("#rename-entry-btn");
const deleteEntryBtn = document.querySelector<HTMLButtonElement>("#delete-entry-btn");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setViewerHtml(html: string) {
  if (!viewerContent) return;
  viewerContent.innerHTML = html;
}

function setViewerEmbedded(isEmbedded: boolean) {
  if (!viewerContent) return;
  viewerContent.classList.toggle("viewer-embedded", isEmbedded);
}

function renderDetails(node: TreeNode) {
  const kind = node.isDir ? "Dossier" : node.isZip ? "Archive ZIP" : "Fichier";
  setViewerEmbedded(false);
  setViewerHtml(`
    <div class="details-card">
      <h2>${escapeHtml(node.name)}</h2>
      <div class="details-grid">
        <div class="label">Type</div>
        <div>${escapeHtml(kind)}</div>

        <div class="label">Chemin</div>
        <div class="mono">${escapeHtml(node.path)}</div>

        <div class="label">Index détecté</div>
        <div>${escapeHtml(node.indexPath ?? "Aucun")}</div>

        <div class="label">Enfants</div>
        <div>${node.children.length}</div>
      </div>
    </div>
  `);
}

function renderFolderHint() {
  setViewerEmbedded(false);
  setViewerHtml(`
    <div class="empty-state">
      Double-clique sur un dossier pour replier ou déplier son contenu.
    </div>
  `);
}

function renderZipResolveSpinner() {
  setViewerEmbedded(false);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Préparation de l’aperçu…</p>
    </div>
  `);
}

function renderImportSpinner() {
  setViewerEmbedded(false);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Import en cours…</p>
    </div>
  `);
}

function setScanUi(isActive: boolean) {
  isScanning = isActive;
  folderBtn?.toggleAttribute("disabled", isActive);
  zipBtn?.toggleAttribute("disabled", isActive);
  updateActionButtonsState();
}

function renderScanSpinner() {
  setViewerEmbedded(false);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Scan en cours…</p>
      <button id="cancel-scan-btn" class="btn ghost">Annuler</button>
    </div>
  `);

  const cancelBtn = document.querySelector<HTMLButtonElement>("#cancel-scan-btn");
  cancelBtn?.addEventListener("click", async () => {
    await invoke("cancel_scan");
    setScanUi(false);
    setViewerHtml(`
      <div class="empty-state">
        Scan annulé.
      </div>
    `);
  });
}

async function renderEmbeddedPreview(indexPath: string) {
  let previewUrl: string;

  try {
    previewUrl = await invoke<string>("prepare_preview", { indexPath });
  } catch (error) {
    setViewerEmbedded(false);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `);
    return;
  }

  setViewerEmbedded(true);
  setViewerHtml(`
    <iframe class="embedded-frame" src="${previewUrl}"></iframe>
  `);
}

function renderEmbeddedPreviewUrl(previewUrl: string) {
  setViewerEmbedded(true);
  setViewerHtml(`
    <iframe class="embedded-frame" src="${previewUrl}"></iframe>
  `);
}

async function onNodeClick(node: TreeNode) {
  selectedPath = node.path;
  renderTree();
  if (node.isZip && !node.indexPath) {
    renderZipResolveSpinner();
    try {
      const previewUrl = await invoke<string | null>("resolve_zip_index", {
        zipPath: node.path,
      });
      if (previewUrl) {
        renderEmbeddedPreviewUrl(previewUrl);
        return;
      }
      renderDetails(node);
    } catch (error) {
      setViewerEmbedded(false);
      setViewerHtml(`
        <div class="error-state">
          <strong>Erreur</strong>
          <pre>${escapeHtml(String(error))}</pre>
        </div>
      `);
    }
    return;
  }

  if (node.indexPath) {
    await renderEmbeddedPreview(node.indexPath);
  } else if (!node.isDir) {
    renderDetails(node);
  } else {
    renderFolderHint();
  }
}

function updateNodeIndexPath(targetPath: string, indexPath: string) {
  if (!currentTree) return;

  const stack: TreeNode[] = [currentTree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === targetPath) {
      node.indexPath = indexPath;
      return;
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
}

function toggleNodeExpansion(node: TreeNode) {
  if (!node.isDir) return;
  if (expandedPaths.has(node.path)) {
    expandedPaths.delete(node.path);
  } else {
    expandedPaths.add(node.path);
  }
  renderTree();
}

function isZipTreeRoot(node: TreeNode | null): boolean {
  return Boolean(node?.isZip);
}

function updateActionButtonsState() {
  const disabled = isScanning || isReadOnlyTree || !currentTree;

  createFolderBtn?.toggleAttribute("disabled", disabled);
  renameEntryBtn?.toggleAttribute("disabled", disabled);
  deleteEntryBtn?.toggleAttribute("disabled", disabled);

  if (createFolderBtn) {
    createFolderBtn.title = isReadOnlyTree
      ? "Action indisponible sur un zip"
      : "Créer un dossier";
  }

  if (renameEntryBtn) {
    renameEntryBtn.title = isReadOnlyTree
      ? "Action indisponible sur un zip"
      : "Renommer";
  }

  if (deleteEntryBtn) {
    deleteEntryBtn.title = isReadOnlyTree
      ? "Action indisponible sur un zip"
      : "Supprimer";
  }

  const canImportZip = Boolean(currentRootPath) && !isScanning && !isReadOnlyTree;
  zipBtn?.toggleAttribute("disabled", !canImportZip);
  if (zipBtn) {
    zipBtn.title = canImportZip
      ? "Importer un zip dans le dossier courant"
      : "Importe d'abord un dossier pour ajouter des zips";
  }

  const canOpenFolder = Boolean(currentRootPath) && !isScanning;
  openFolderBtn?.toggleAttribute("disabled", !canOpenFolder);
  if (openFolderBtn) {
    openFolderBtn.title = canOpenFolder
      ? "Ouvrir le dossier dans l'explorateur"
      : "Importe d'abord un dossier";
  }
}

function isAncestorPath(ancestorPath: string, targetPath: string): boolean {
  if (ancestorPath === targetPath) return true;

  const normalizedAncestor = ancestorPath.endsWith("/") || ancestorPath.endsWith("\\")
    ? ancestorPath
    : `${ancestorPath}/`;

  return targetPath.startsWith(normalizedAncestor) || targetPath.startsWith(`${ancestorPath}\\`);
}

async function handleInternalDrop(sourcePath: string, destinationDir: string) {
  if (isReadOnlyTree) {
    alert("Déplacement impossible : l’arborescence chargée provient d’un zip.");
    return;
  }

  if (sourcePath === destinationDir) {
    return;
  }

  const sourceNode = findNodeByPath(sourcePath);
  const destinationNode = findNodeByPath(destinationDir);

  if (!sourceNode || !destinationNode || !destinationNode.isDir) {
    return;
  }

  if (sourceNode.path === currentTree?.path) {
    alert("Impossible de déplacer le dossier racine.");
    return;
  }

  if (sourceNode.isDir && isAncestorPath(sourceNode.path, destinationNode.path)) {
    alert("Impossible de déplacer un dossier dans lui-même ou dans un de ses sous-dossiers.");
    return;
  }

  try {
    await invoke("move_entry", {
      sourcePath,
      destinationDir,
    });

    expandedPaths.add(destinationDir);
    selectedPath = null;
    await refreshTree();
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
  }
}

function createDragGhost(label: string): HTMLDivElement {
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.style.position = "fixed";
  ghost.style.top = "-1000px";
  ghost.style.left = "-1000px";
  ghost.style.pointerEvents = "none";
  ghost.style.padding = "6px 10px";
  ghost.style.borderRadius = "8px";
  ghost.style.background = "rgba(20, 20, 24, 0.92)";
  ghost.style.border = "1px solid rgba(255,255,255,0.12)";
  ghost.style.color = "#fff";
  ghost.style.fontSize = "12px";
  ghost.style.lineHeight = "1.2";
  ghost.style.fontFamily = "inherit";
  ghost.style.whiteSpace = "nowrap";
  ghost.style.maxWidth = "220px";
  ghost.style.overflow = "hidden";
  ghost.style.textOverflow = "ellipsis";
  ghost.style.zIndex = "9999";
  document.body.appendChild(ghost);
  return ghost;
}

function cancelInlineEditing() {
  editingPath = null;
  creatingInParentPath = null;
  renderTree();
}

async function submitRename(nodePath: string, newName: string) {
  const trimmed = newName.trim();
  const node = findNodeByPath(nodePath);

  if (!node) {
    cancelInlineEditing();
    return;
  }

  if (!trimmed || trimmed === node.name) {
    cancelInlineEditing();
    return;
  }

  try {
    await invoke("rename_entry", {
      path: node.path,
      newName: trimmed,
    });
    editingPath = null;
    await refreshTree();
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
    renderTree();
  }
}

async function submitCreate(parentPath: string, name: string) {
  const trimmed = name.trim();

  if (!trimmed) {
    cancelInlineEditing();
    return;
  }

  try {
    await invoke("create_folder", {
      parentPath,
      name: trimmed,
    });
    creatingInParentPath = null;
    expandedPaths.add(parentPath);
    await refreshTree();
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
    renderTree();
  }
}

function attachInlineInputBehavior(
  input: HTMLInputElement,
  onSubmit: (value: string) => Promise<void> | void,
  onCancel: () => void
) {
  let handled = false;

  const submit = async () => {
    if (handled) return;
    handled = true;
    await onSubmit(input.value);
  };

  const cancel = () => {
    if (handled) return;
    handled = true;
    onCancel();
  };

  input.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });

  input.addEventListener("blur", () => {
    void submit();
  });

  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function createTreeNodeElement(node: TreeNode): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "tree-node";

  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row";
  const canDrag = !isReadOnlyTree && node.path !== currentTree?.path && editingPath !== node.path;
  row.draggable = canDrag;

  if (selectedPath === node.path) {
    row.classList.add("selected");
  }

  const isExpanded = expandedPaths.has(node.path);
  const arrow = node.isDir
    ? `<span class="arrow ${isExpanded ? "expanded" : ""}">▶</span>`
    : `<span class="arrow-spacer"></span>`;

  const icon = node.isDir ? "📁" : node.isZip ? "🗜️" : "📄";

  const isEditingThisNode = editingPath === node.path;

row.innerHTML = `
  ${arrow}
  <span class="tree-icon">${icon}</span>
  ${
    isEditingThisNode
      ? `<input class="tree-inline-input" value="${escapeHtml(node.name)}" />`
      : `<span class="tree-label">${escapeHtml(node.name)}</span>`
  }
`;

if (isEditingThisNode) {
  const input = row.querySelector<HTMLInputElement>(".tree-inline-input");
  if (input) {
    attachInlineInputBehavior(
      input,
      async (value) => {
        await submitRename(node.path, value);
      },
      () => {
        cancelInlineEditing();
      }
    );
  }
}

  row.addEventListener("click", (event) => {
  if (editingPath === node.path) {
    event.preventDefault();
    return;
  }
  void onNodeClick(node);
});

row.addEventListener("dblclick", (event) => {
  if (editingPath === node.path) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  toggleNodeExpansion(node);
});

  row.addEventListener("dragstart", (event) => {
  if (!canDrag || isReadOnlyTree) {
    event.preventDefault();
    return;
  }

  draggedNodePath = node.path;
  row.classList.add("dragging");

  event.dataTransfer?.setData("text/plain", node.path);
  event.dataTransfer?.setData("application/x-tp-browser-node", node.path);

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";

    const ghost = createDragGhost(node.name);
    event.dataTransfer.setDragImage(ghost, 12, 12);

    requestAnimationFrame(() => {
      ghost.remove();
    });
  }
});

row.addEventListener("dragend", () => {
  draggedNodePath = null;
  row.classList.remove("dragging");
  row.classList.remove("drop-target");
});

if (node.isDir && !isReadOnlyTree) {
  row.addEventListener("dragover", (event) => {
    const sourcePath =
      event.dataTransfer?.getData("application/x-tp-browser-node") ||
      draggedNodePath;

    if (!sourcePath || sourcePath === node.path) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    row.classList.add("drop-target");
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
  });

  row.addEventListener("drop", async (event) => {
    row.classList.remove("drop-target");

    const sourcePath =
      event.dataTransfer?.getData("application/x-tp-browser-node") ||
      draggedNodePath;

    if (!sourcePath) {
      return;
    }

    event.preventDefault();
    draggedNodePath = null;
    await handleInternalDrop(sourcePath, node.path);
  });
}
  li.appendChild(row);

  if (node.children.length > 0) {
    const childrenWrap = document.createElement("div");
    childrenWrap.className = `tree-children-wrap ${isExpanded ? "expanded" : ""}`;

    const childrenInner = document.createElement("div");
    childrenInner.className = "tree-children-inner";

    const ul = document.createElement("ul");
    ul.className = "tree-children";

    for (const child of node.children) {
      ul.appendChild(createTreeNodeElement(child));
    }
    if (creatingInParentPath === node.path) {
  const ghostLi = document.createElement("li");
  ghostLi.className = "tree-node";

  const ghostRow = document.createElement("div");
  ghostRow.className = "tree-row tree-row-creating";
  ghostRow.innerHTML = `
    <span class="arrow-spacer"></span>
    <span class="tree-icon">📁</span>
    <input class="tree-inline-input" placeholder="Nouveau dossier" />
  `;

  ghostLi.appendChild(ghostRow);
  ul.appendChild(ghostLi);

  requestAnimationFrame(() => {
    const input = ghostRow.querySelector<HTMLInputElement>(".tree-inline-input");
    if (!input) return;

    attachInlineInputBehavior(
      input,
      async (value) => {
        await submitCreate(node.path, value);
      },
      () => {
        cancelInlineEditing();
      }
    );
  });
}

    childrenInner.appendChild(ul);
    childrenWrap.appendChild(childrenInner);
    li.appendChild(childrenWrap);
  }

  return li;
}

createFolderBtn?.addEventListener("click", async () => {
  if (isReadOnlyTree) {
    alert("Création impossible : l’arborescence chargée provient d’un zip.");
    return;
  }

  const node = getSelectedNode();
  const parentPath = node
    ? (node.isDir ? node.path : currentTree?.path)
    : currentTree?.path;

  if (!parentPath) {
    alert("Aucun dossier parent disponible.");
    return;
  }

  editingPath = null;
  creatingInParentPath = parentPath;
  expandedPaths.add(parentPath);
  renderTree();
});

renameEntryBtn?.addEventListener("click", () => {
  if (isReadOnlyTree) {
    alert("Renommage impossible : l’arborescence chargée provient d’un zip.");
    return;
  }

  const node = getSelectedNode();
  if (!node) return;

  if (node.path === currentTree?.path) {
    alert("Renommage du dossier racine non autorisé.");
    return;
  }

  creatingInParentPath = null;
  editingPath = node.path;
  renderTree();
});

deleteEntryBtn?.addEventListener("click", async () => {
  if (isReadOnlyTree) {
    alert("Suppression impossible : l’arborescence chargée provient d’un zip.");
    return;
  }

  const node = getSelectedNode();
  if (!node) return;

  if (node.path === currentTree?.path) {
    alert("Suppression du dossier racine non autorisée.");
    return;
  }

  const confirmed = window.confirm(
    `Supprimer ${node.isDir ? "le dossier" : "le fichier"} "${node.name}" ?`
  );
  if (!confirmed) return;

  try {
    await invoke("delete_entry", {
      path: node.path,
    });
    selectedPath = currentTree?.path ?? null;
    await refreshTree();
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
  }
});

function renderTree() {
  if (!treeRoot) return;

  treeRoot.innerHTML = "";

  if (!currentTree) {
    treeRoot.innerHTML = `<div class="empty-tree">Aucun dossier chargé.</div>`;
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "tree";
  ul.appendChild(createTreeNodeElement(currentTree));

  treeRoot.appendChild(ul);
}

function setViewerFullscreenState(nextValue: boolean) {
  isViewerFullscreen = nextValue;
  shell?.classList.toggle("viewer-fullscreen", isViewerFullscreen);

  if (toggleFullscreenBtn) {
    toggleFullscreenBtn.textContent = isViewerFullscreen
      ? "Quitter le plein écran"
      : "Plein écran";
  }
}
function findNodeByPath(path: string): TreeNode | null {
  if (!currentTree) return null;

  const stack: TreeNode[] = [currentTree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === path) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }

  return null;
}

async function refreshTree() {
  if (!currentRootPath) return;

  const previousSelectedPath = selectedPath;
  const previousExpanded = new Set(expandedPaths);

  const tree = await invoke<TreeNode>("scan_source", { path: currentRootPath });
  currentTree = tree;
  isReadOnlyTree = isZipTreeRoot(tree);
  updateActionButtonsState();

  expandedPaths.clear();
  for (const path of previousExpanded) {
    expandedPaths.add(path);
  }
  expandedPaths.add(tree.path);

  if (previousSelectedPath) {
    const selectedNode = findNodeByPathInTree(tree, previousSelectedPath);
    selectedPath = selectedNode ? previousSelectedPath : tree.path;
  } else {
    selectedPath = tree.path;
  }

  renderTree();

  const selectedNode = selectedPath ? findNodeByPath(selectedPath) : null;
  if (selectedNode?.indexPath) {
    await renderEmbeddedPreview(selectedNode.indexPath);
  } else if (selectedNode) {
    renderDetails(selectedNode);
  } else {
    renderFolderHint();
  }
}

function findNodeByPathInTree(root: TreeNode, path: string): TreeNode | null {
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === path) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return null;
}

function getSelectedNode(): TreeNode | null {
  if (!selectedPath) return null;
  return findNodeByPath(selectedPath);
}

async function scanPath(path: string) {
  setScanUi(true);
  renderScanSpinner();

  try {
    const tree = await invoke<TreeNode>("scan_source", { path });

    currentRootPath = path;
    currentTree = tree;
    isReadOnlyTree = isZipTreeRoot(tree);
    selectedPath = tree.path;

    expandedPaths.clear();
    expandedPaths.add(tree.path);

    setScanUi(false);
    updateActionButtonsState();
    renderTree();

    if (tree.indexPath) {
      await renderEmbeddedPreview(tree.indexPath);
    } else if (!tree.isDir) {
      renderDetails(tree);
    } else {
      renderFolderHint();
    }
  } catch (error) {
    setScanUi(false);

    if (String(error).includes("Scan annulé")) {
      setViewerHtml(`
        <div class="empty-state">
          Scan annulé.
        </div>
      `);
      return;
    }

    setViewerEmbedded(false);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `);
  }
}

folderBtn?.addEventListener("click", async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choisir un dossier",
  });

  if (typeof selected === "string") {
    await scanPath(selected);
  }
});

zipBtn?.addEventListener("click", async () => {
  if (!currentRootPath) {
    alert("Importe d'abord un dossier pour ajouter des zips.");
    return;
  }
  if (isReadOnlyTree) {
    alert("Import impossible : l’arborescence chargée provient d’un zip.");
    return;
  }
  const selected = await open({
    directory: false,
    multiple: false,
    title: "Choisir un zip",
    filters: [
      {
        name: "ZIP",
        extensions: ["zip"],
      },
    ],
  });

  if (typeof selected === "string") {
    setScanUi(true);
    renderImportSpinner();
    try {
      await invoke("import_zip", {
        zipPath: selected,
        destinationDir: currentRootPath,
      });
      await refreshTree();
    } catch (error) {
      setViewerEmbedded(false);
      setViewerHtml(`
        <div class="error-state">
          <strong>Erreur</strong>
          <pre>${escapeHtml(String(error))}</pre>
        </div>
      `);
    } finally {
      setScanUi(false);
    }
  }
});

openFolderBtn?.addEventListener("click", async () => {
  if (!currentRootPath) {
    alert("Importe d'abord un dossier.");
    return;
  }
  try {
    await invoke("open_in_explorer", { path: currentRootPath });
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
  }
});

toggleSidebarBtn?.addEventListener("click", () => {
  isSidebarCollapsed = !isSidebarCollapsed;
  shell?.classList.toggle("sidebar-collapsed", isSidebarCollapsed);
  if (toggleSidebarBtn) {
    toggleSidebarBtn.textContent = isSidebarCollapsed ? "▶" : "◀";
    toggleSidebarBtn.title = isSidebarCollapsed
      ? "Afficher l’arborescence"
      : "Masquer l’arborescence";
  }
  expandSidebarBtn?.classList.toggle("visible", isSidebarCollapsed);
});

toggleFullscreenBtn?.addEventListener("click", () => {
  setViewerFullscreenState(!isViewerFullscreen);
});

const exitFullscreenBtn = document.querySelector<HTMLButtonElement>(
  "#exit-fullscreen-btn"
);

exitFullscreenBtn?.addEventListener("click", () => {
  setViewerFullscreenState(false);
});

expandSidebarBtn?.addEventListener("click", () => {
  isSidebarCollapsed = false;
  shell?.classList.remove("sidebar-collapsed");
  expandSidebarBtn.classList.remove("visible");
  if (toggleSidebarBtn) {
    toggleSidebarBtn.textContent = "◀";
    toggleSidebarBtn.title = "Masquer l’arborescence";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isViewerFullscreen) {
    event.preventDefault();
    setViewerFullscreenState(false);
  }
});

updateActionButtonsState();
renderTree();