import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DragDropEvent } from "@tauri-apps/api/window";
import lyceeLogo from "./assets/LOGO_LYCEE-VIMEU_00-659MO.png";
import "/styles.css";

type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  isZip: boolean;
  indexPath?: string | null;
  children: TreeNode[];
};

type SavedSource = {
  path: string;
  tree: TreeNode;
};

type SidebarDropTarget = {
  type: "into" | "before" | "after";
  path: string;
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
let pointerDrag:
  | {
      sourcePath: string;
      sourceRow: HTMLElement;
      startX: number;
      startY: number;
      active: boolean;
      ghost: HTMLDivElement | null;
      target: SidebarDropTarget | null;
    }
  | null = null;
let suppressNextTreeClick = false;
let editingPath: string | null = null;
let creatingInParentPath: string | null = null;
let isAuthenticated = false;
let isExportingStudentArchive = false;
let lastSourceSnapshot: string | null = null;
let isCheckingSourceChanges = false;
let viewerRequestId = 0;

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("#app introuvable");
}

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">TP Browser</div>
      <div class="topbar-actions">
        <button id="auth-btn" class="btn ghost">Se connecter</button>
        <button id="account-btn" class="btn ghost is-hidden">Compte</button>
        <button id="import-folder-btn" class="btn is-hidden">Importer un dossier</button>
        <button id="import-zip-btn" class="btn is-hidden">Importer un zip</button>
        <button id="export-student-btn" class="btn is-hidden">Exporter version élève</button>
        <button id="toggle-fullscreen-btn" class="btn">Plein écran</button>
      </div>
    </header>

    <div class="layout">
      <aside class="sidebar">
        <div class="sidebar-header">
  <span>Fichiers</span>
    <div class="sidebar-actions">
  <button id="open-folder-btn" class="icon-btn" title="Ouvrir le dossier">📂</button>
  <button id="create-folder-btn" class="icon-btn" title="Créer un dossier">＋</button>
  <button id="rename-entry-btn" class="icon-btn" title="Renommer">✎</button>
  <button id="delete-entry-btn" class="icon-btn" title="Supprimer">🗑</button>
  <button id="forget-source-btn" class="icon-btn" title="Oublier le dossier TP">x</button>
  <button id="toggle-sidebar-btn" class="icon-btn icon-collapse" title="Masquer l’arborescence">◀</button>
</div>
  </div>
        <div id="tree-root" class="tree-root"></div>
        <div class="sidebar-logo">
          <img src="${lyceeLogo}" alt="Lycee du Vimeu" />
        </div>
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

  <div id="auth-modal" class="modal is-hidden" role="dialog" aria-modal="true">
  <div class="modal-backdrop" data-modal-close="true"></div>
  <div class="modal-card" role="document">
    <h2 id="auth-title">Connexion admin</h2>
    <p id="auth-subtitle" class="modal-subtitle">
      Entre l'identifiant et le mot de passe pour gérer les dossiers TP.
    </p>

    <div id="auth-login-section">
      <form id="auth-form" class="modal-form">
        <label class="modal-field">
          <span>Identifiant</span>
          <input id="auth-username" type="text" autocomplete="username" required />
        </label>

        <label class="modal-field">
          <span>Mot de passe</span>
          <input id="auth-password" type="password" autocomplete="current-password" required />
        </label>

        <div class="modal-helper-row">
          <button type="button" id="forgot-password-btn" class="link-btn">
            Mot de passe oublié ?
          </button>
        </div>

        <div id="auth-error" class="modal-error is-hidden">
          Identifiant ou mot de passe incorrect.
        </div>

        <div class="modal-actions">
          <button type="button" id="auth-cancel" class="btn ghost">Annuler</button>
          <button type="submit" class="btn">Se connecter</button>
        </div>
      </form>
    </div>

    <div id="auth-reset" class="modal-section is-hidden">
      <form id="reset-form" class="modal-form">
        <label class="modal-field">
          <span>Email du compte</span>
          <input id="reset-email" type="email" autocomplete="email" required />
        </label>

        <div id="reset-send-status" class="modal-hint is-hidden"></div>

        <div class="modal-actions">
          <button type="button" id="back-to-login-btn" class="btn ghost">Retour</button>
          <button type="button" id="send-reset-btn" class="btn">Envoyer le lien</button>
        </div>

        <label class="modal-field">
          <span>Code de reinitialisation</span>
          <input id="reset-token" type="text" autocomplete="one-time-code" />
        </label>

        <label class="modal-field">
          <span>Nouveau mot de passe</span>
          <input id="reset-password" type="password" autocomplete="new-password" />
        </label>

        <label class="modal-field">
          <span>Confirmer le mot de passe</span>
          <input id="reset-password-confirm" type="password" autocomplete="new-password" />
        </label>

        <div id="reset-apply-status" class="modal-hint is-hidden"></div>

        <div class="modal-actions">
          <button type="button" id="reset-password-btn" class="btn">Modifier le mot de passe</button>
        </div>
      </form>
    </div>
  </div>
</div>

  <div id="account-modal" class="modal is-hidden" role="dialog" aria-modal="true">
    <div class="modal-backdrop" data-modal-close="account"></div>
    <div class="modal-card" role="document">
      <h2>Compte admin</h2>
      <p class="modal-subtitle">Gere l'identifiant, l'email et le mot de passe.</p>
      <form id="account-form" class="modal-form">
        <label class="modal-field">
          <span>Identifiant</span>
          <input id="account-username" type="text" autocomplete="username" required />
        </label>
        <label class="modal-field">
          <span>Email</span>
          <input id="account-email" type="email" autocomplete="email" required />
        </label>
        <div id="account-save-status" class="modal-hint is-hidden"></div>
        <div class="modal-actions">
          <button type="button" id="account-cancel" class="btn ghost">Annuler</button>
          <button type="submit" class="btn">Enregistrer</button>
        </div>
      </form>

    </div>
  </div>
`;

const folderBtn = document.querySelector<HTMLButtonElement>("#import-folder-btn");
const zipBtn = document.querySelector<HTMLButtonElement>("#import-zip-btn");
const authBtn = document.querySelector<HTMLButtonElement>("#auth-btn");
const accountBtn = document.querySelector<HTMLButtonElement>("#account-btn");
const exportStudentBtn = document.querySelector<HTMLButtonElement>("#export-student-btn");
const openFolderBtn = document.querySelector<HTMLButtonElement>("#open-folder-btn");
const toggleSidebarBtn = document.querySelector<HTMLButtonElement>("#toggle-sidebar-btn");
const expandSidebarBtn = document.querySelector<HTMLButtonElement>("#expand-sidebar-btn");
const toggleFullscreenBtn = document.querySelector<HTMLButtonElement>("#toggle-fullscreen-btn");
const authModal = document.querySelector<HTMLDivElement>("#auth-modal");
const accountModal = document.querySelector<HTMLDivElement>("#account-modal");
const authForm = document.querySelector<HTMLFormElement>("#auth-form");
const authCancel = document.querySelector<HTMLButtonElement>("#auth-cancel");
const authUsername = document.querySelector<HTMLInputElement>("#auth-username");
const authPassword = document.querySelector<HTMLInputElement>("#auth-password");
const authError = document.querySelector<HTMLDivElement>("#auth-error");
const forgotPasswordBtn = document.querySelector<HTMLButtonElement>("#forgot-password-btn");
const authResetSection = document.querySelector<HTMLDivElement>("#auth-reset");
const accountForm = document.querySelector<HTMLFormElement>("#account-form");
const accountCancel = document.querySelector<HTMLButtonElement>("#account-cancel");
const accountUsername = document.querySelector<HTMLInputElement>("#account-username");
const accountEmail = document.querySelector<HTMLInputElement>("#account-email");
const accountSaveStatus = document.querySelector<HTMLDivElement>("#account-save-status");
const sendResetBtn = document.querySelector<HTMLButtonElement>("#send-reset-btn");
const resetSendStatus = document.querySelector<HTMLDivElement>("#reset-send-status");
const resetEmailInput = document.querySelector<HTMLInputElement>("#reset-email");
const resetTokenInput = document.querySelector<HTMLInputElement>("#reset-token");
const resetPasswordInput = document.querySelector<HTMLInputElement>("#reset-password");
const resetPasswordConfirmInput = document.querySelector<HTMLInputElement>("#reset-password-confirm");
const resetPasswordBtn = document.querySelector<HTMLButtonElement>("#reset-password-btn");
const resetApplyStatus = document.querySelector<HTMLDivElement>("#reset-apply-status");
const treeRoot = document.querySelector<HTMLDivElement>("#tree-root");
const viewerContent = document.querySelector<HTMLDivElement>("#viewer-content");
const shell = document.querySelector<HTMLDivElement>(".shell");
const createFolderBtn = document.querySelector<HTMLButtonElement>("#create-folder-btn");
const renameEntryBtn = document.querySelector<HTMLButtonElement>("#rename-entry-btn");
const deleteEntryBtn = document.querySelector<HTMLButtonElement>("#delete-entry-btn");
const forgetSourceBtn = document.querySelector<HTMLButtonElement>("#forget-source-btn");
const authLoginSection = document.querySelector<HTMLDivElement>("#auth-login-section");
const authTitle = document.querySelector<HTMLHeadingElement>("#auth-title");
const authSubtitle = document.querySelector<HTMLParagraphElement>("#auth-subtitle");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function beginViewerRequest(): number {
  viewerRequestId += 1;
  return viewerRequestId;
}

function setViewerHtml(html: string, requestId?: number) {
  if (!viewerContent) return;
  if (requestId && requestId !== viewerRequestId) return;
  viewerContent.innerHTML = html;
}

function setViewerEmbedded(isEmbedded: boolean, requestId?: number) {
  if (!viewerContent) return;
  if (requestId && requestId !== viewerRequestId) return;
  viewerContent.classList.toggle("viewer-embedded", isEmbedded);
}

function toggleHidden(element: HTMLElement | null, hidden: boolean) {
  if (!element) return;
  element.classList.toggle("is-hidden", hidden);
}

function setAuthenticated(nextValue: boolean) {
  isAuthenticated = nextValue;

  if (authBtn) {
    authBtn.textContent = isAuthenticated ? "Se déconnecter" : "Se connecter";
  }

  const hideManagement = !isAuthenticated;
  toggleHidden(accountBtn, hideManagement);
  toggleHidden(folderBtn, hideManagement);
  toggleHidden(zipBtn, hideManagement);
  toggleHidden(exportStudentBtn, hideManagement);
  toggleHidden(openFolderBtn, hideManagement);
  toggleHidden(createFolderBtn, hideManagement);
  toggleHidden(renameEntryBtn, hideManagement);
  toggleHidden(deleteEntryBtn, hideManagement);
  toggleHidden(forgetSourceBtn, hideManagement);

  if (!isAuthenticated) {
    closeAccountModal();
  }

  updateActionButtonsState();
}

function openAuthModal() {
  if (!authModal) return;

  toggleHidden(authModal, false);
  toggleHidden(authError, true);
  toggleHidden(authLoginSection, false);
  toggleHidden(authResetSection, true);

  if (authTitle) authTitle.textContent = "Connexion admin";
  if (authSubtitle) {
    authSubtitle.textContent = "Entre l'identifiant et le mot de passe pour gérer les dossiers TP.";
  }

  clearModalHint(resetSendStatus);
  clearModalHint(resetApplyStatus);

  if (authUsername) authUsername.value = "";
  if (authPassword) authPassword.value = "";
  if (resetEmailInput) resetEmailInput.value = "";
  if (resetTokenInput) resetTokenInput.value = "";
  if (resetPasswordInput) resetPasswordInput.value = "";
  if (resetPasswordConfirmInput) resetPasswordConfirmInput.value = "";

  requestAnimationFrame(() => authUsername?.focus());
}

function closeAuthModal() {
  if (!authModal) return;

  toggleHidden(authModal, true);
  toggleHidden(authError, true);
  toggleHidden(authLoginSection, false);
  toggleHidden(authResetSection, true);

  if (authTitle) authTitle.textContent = "Connexion admin";
  if (authSubtitle) {
    authSubtitle.textContent = "Entre l'identifiant et le mot de passe pour gérer les dossiers TP.";
  }
}

function showAuthError(message: string) {
  if (!authError) return;
  authError.textContent = message;
  toggleHidden(authError, false);
}

function setModalHint(element: HTMLElement | null, message: string) {
  if (!element) return;
  element.textContent = message;
  toggleHidden(element, false);
}

function clearModalHint(element: HTMLElement | null) {
  if (!element) return;
  element.textContent = "";
  toggleHidden(element, true);
}

async function openAccountModal(prefillToken?: string) {
  if (!accountModal) return;
  if (!isAuthenticated) return;

  toggleHidden(accountModal, false);
  clearModalHint(accountSaveStatus);
  clearModalHint(resetSendStatus);
  clearModalHint(resetApplyStatus);

  try {
    const profile = await invoke<{ username: string; email: string }>(
      "get_account_profile"
    );
    if (accountUsername) accountUsername.value = profile.username;
    if (accountEmail) accountEmail.value = profile.email;
  } catch (error) {
    setModalHint(accountSaveStatus, `Erreur: ${String(error)}`);
  }
}

async function openAuthReset(prefillToken?: string) {
  if (!authModal) return;
  toggleHidden(authModal, false);
  toggleHidden(authError, true);
  toggleHidden(authLoginSection, true);
  toggleHidden(authResetSection, false);
  clearModalHint(resetSendStatus);
  clearModalHint(resetApplyStatus);

  if (authTitle) authTitle.textContent = "Reinitialiser le mot de passe";
  if (authSubtitle) {
    authSubtitle.textContent = "Demande un lien de reinitialisation puis definis ton nouveau mot de passe.";
  }

  if (prefillToken && resetTokenInput) {
    resetTokenInput.value = prefillToken;
  }

  try {
    const profile = await invoke<{ email: string }>("get_account_profile");
    if (resetEmailInput && !resetEmailInput.value) {
      resetEmailInput.value = profile.email;
    }
  } catch (error) {
    setModalHint(resetSendStatus, `Erreur: ${String(error)}`);
  }
}

function closeAccountModal() {
  if (!accountModal) return;
  toggleHidden(accountModal, true);
}

async function loginWithCredentials(username: string, password: string) {
  try {
    const success = await invoke<boolean>("login", { username, password });
    if (!success) {
      showAuthError("Identifiant ou mot de passe incorrect.");
      return;
    }
    setAuthenticated(true);
    closeAuthModal();
  } catch (error) {
    showAuthError(String(error));
  }
}

async function logout() {
  try {
    await invoke("logout");
    setAuthenticated(false);
  } catch (error) {
    alert(`Erreur: ${String(error)}`);
  }
}

function renderDetails(node: TreeNode, requestId?: number) {
  const kind = node.isDir ? "Dossier" : node.isZip ? "Archive ZIP" : "Fichier";
  setViewerEmbedded(false, requestId);
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
  `, requestId);
}

function renderFolderHint(requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="empty-state">
      Double-clique sur un dossier pour replier ou déplier son contenu.
    </div>
  `, requestId);
}

function renderZipResolveSpinner(requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Préparation de l’aperçu…</p>
    </div>
  `, requestId);
}

function renderImportSpinner(requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Import en cours…</p>
    </div>
  `, requestId);
}

function renderExportSpinner(requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Export élève en cours...</p>
    </div>
  `, requestId);
}

function renderExportSuccess(exportPath: string, requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="scan-state">
      <strong>Export réussi</strong>
      <p>L'archive élève a été créée.</p>
      <pre>${escapeHtml(exportPath)}</pre>
      <button id="open-export-folder-btn" class="btn">Ouvrir le dossier</button>
    </div>
  `, requestId);

  const openExportFolderBtn = document.querySelector<HTMLButtonElement>(
    "#open-export-folder-btn"
  );
  openExportFolderBtn?.addEventListener("click", async () => {
    try {
      await invoke("open_parent_folder", { path: exportPath });
    } catch (error) {
      alert(`Erreur: ${String(error)}`);
    }
  });
}

function setScanUi(isActive: boolean) {
  isScanning = isActive;
  folderBtn?.toggleAttribute("disabled", isActive);
  zipBtn?.toggleAttribute("disabled", isActive);
  updateActionButtonsState();
}

function renderScanSpinner(requestId?: number) {
  setViewerEmbedded(false, requestId);
  setViewerHtml(`
    <div class="scan-state">
      <div class="spinner"></div>
      <p>Scan en cours…</p>
      <button id="cancel-scan-btn" class="btn ghost">Annuler</button>
    </div>
  `, requestId);

  const cancelBtn = document.querySelector<HTMLButtonElement>("#cancel-scan-btn");
  cancelBtn?.addEventListener("click", async () => {
    await invoke("cancel_scan");
    setScanUi(false);
    setViewerHtml(`
      <div class="empty-state">
        Scan annulé.
      </div>
    `, requestId);
  });
}

async function renderEmbeddedPreview(indexPath: string, requestId?: number) {
  let previewUrl: string;

  try {
    const isWindows = navigator.userAgent.toLowerCase().includes("windows");
    previewUrl = await invoke<string>(
      isWindows ? "prepare_preview_http" : "prepare_preview",
      { indexPath }
    );
  } catch (error) {
    setViewerEmbedded(false, requestId);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `, requestId);
    return;
  }

  setViewerEmbedded(true, requestId);
  setViewerHtml(`
    <iframe class="embedded-frame" src="${previewUrl}"></iframe>
  `, requestId);
}

function renderEmbeddedPreviewUrl(previewUrl: string, requestId?: number) {
  setViewerEmbedded(true, requestId);
  setViewerHtml(`
    <iframe class="embedded-frame" src="${previewUrl}"></iframe>
  `, requestId);
}

async function onNodeClick(node: TreeNode) {
  const requestId = beginViewerRequest();
  selectedPath = node.path;
  renderTree();
  if (node.isZip && !node.indexPath) {
    renderZipResolveSpinner(requestId);
    try {
      const previewUrl = await invoke<string | null>("resolve_zip_index", {
        zipPath: node.path,
      });
      if (previewUrl) {
        renderEmbeddedPreviewUrl(previewUrl, requestId);
        return;
      }
      renderDetails(node, requestId);
    } catch (error) {
      setViewerEmbedded(false, requestId);
      setViewerHtml(`
        <div class="error-state">
          <strong>Erreur</strong>
          <pre>${escapeHtml(String(error))}</pre>
        </div>
      `, requestId);
    }
    return;
  }

  if (node.indexPath) {
    await renderEmbeddedPreview(node.indexPath, requestId);
  } else if (!node.isDir) {
    renderDetails(node, requestId);
  } else {
    renderFolderHint(requestId);
  }

  await updateSourceSnapshot();
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
  const disabled = isScanning || isReadOnlyTree || !currentTree || !isAuthenticated;

  createFolderBtn?.toggleAttribute("disabled", disabled);
  renameEntryBtn?.toggleAttribute("disabled", disabled);
  deleteEntryBtn?.toggleAttribute("disabled", disabled);
  forgetSourceBtn?.toggleAttribute("disabled", isScanning || !currentRootPath || !isAuthenticated);

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

  if (forgetSourceBtn) {
    forgetSourceBtn.title = currentRootPath
      ? "Oublier le dossier TP"
      : "Aucun dossier TP defini";
  }

  folderBtn?.toggleAttribute("disabled", isScanning || !isAuthenticated);
  if (folderBtn) {
    folderBtn.title = isAuthenticated
      ? "Importer un dossier"
      : "Connecte-toi pour importer un dossier";
  }

  const canImportZip =
    Boolean(currentRootPath) && !isScanning && !isReadOnlyTree && isAuthenticated;
  zipBtn?.toggleAttribute("disabled", !canImportZip);
  if (zipBtn) {
    if (!isAuthenticated) {
      zipBtn.title = "Connecte-toi pour importer un zip";
    } else {
      zipBtn.title = canImportZip
        ? "Importer un zip dans le dossier courant"
        : "Importe d'abord un dossier pour ajouter des zips";
    }
  }

  const canExportStudent =
    Boolean(currentRootPath) &&
    !isScanning &&
    !isExportingStudentArchive &&
    !isReadOnlyTree &&
    isAuthenticated;
  exportStudentBtn?.toggleAttribute("disabled", !canExportStudent);
  if (exportStudentBtn) {
    if (!isAuthenticated) {
      exportStudentBtn.title = "Connecte-toi pour exporter";
    } else {
      exportStudentBtn.title = canExportStudent
        ? "Créer une archive élève a cote du dossier TP"
        : "Importe un dossier TP pour exporter";
    }
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

function getParentNode(childPath: string): TreeNode | null {
  if (!currentTree || currentTree.path === childPath) return null;

  const stack: TreeNode[] = [currentTree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    if (node.children.some((child) => child.path === childPath)) {
      return node;
    }

    for (const child of node.children) {
      if (child.isDir) {
        stack.push(child);
      }
    }
  }

  return null;
}

function getSiblingNamesWithMove(
  parent: TreeNode,
  sourceName: string,
  targetName: string,
  position: "before" | "after"
): string[] {
  const names = parent.children
    .map((child) => child.name)
    .filter((name) => name !== sourceName);

  const targetIndex = names.indexOf(targetName);
  if (targetIndex === -1) {
    return [...names, sourceName];
  }

  names.splice(position === "before" ? targetIndex : targetIndex + 1, 0, sourceName);
  return names;
}

async function saveSidebarOrder(parentPath: string, childNames: string[]) {
  await invoke("save_sidebar_order", {
    parentPath,
    childNames,
  });
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

async function handleSidebarDrop(sourcePath: string, target: SidebarDropTarget) {
  if (target.type === "into") {
    await handleInternalDrop(sourcePath, target.path);
    return;
  }

  if (isReadOnlyTree) {
    alert("RÃ©organisation impossible : lâ€™arborescence chargÃ©e provient dâ€™un zip.");
    return;
  }

  const sourceNode = findNodeByPath(sourcePath);
  const targetNode = findNodeByPath(target.path);
  const targetParent = getParentNode(target.path);

  if (!sourceNode || !targetNode || !targetParent) {
    return;
  }

  if (sourceNode.path === currentTree?.path) {
    alert("Impossible de dÃ©placer le dossier racine.");
    return;
  }

  const sourceParent = getParentNode(sourcePath);
  if (!sourceParent) {
    return;
  }

  if (sourceParent.path !== targetParent.path) {
    try {
      const childNames = getSiblingNamesWithMove(
        targetParent,
        sourceNode.name,
        targetNode.name,
        target.type
      );
      await invoke("move_entry", {
        sourcePath,
        destinationDir: targetParent.path,
      });
      await saveSidebarOrder(targetParent.path, childNames);
      expandedPaths.add(targetParent.path);
      selectedPath = null;
      await refreshTree();
      return;
    } catch (error) {
      alert(`Erreur: ${String(error)}`);
      return;
    }
  }

  if (sourceNode.path === targetNode.path) {
    return;
  }

  try {
    const childNames = getSiblingNamesWithMove(
      targetParent,
      sourceNode.name,
      targetNode.name,
      target.type
    );
    await saveSidebarOrder(targetParent.path, childNames);
    selectedPath = sourceNode.path;
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

function moveDragGhost(ghost: HTMLDivElement, clientX: number, clientY: number) {
  ghost.style.left = `${clientX + 12}px`;
  ghost.style.top = `${clientY + 12}px`;
}

function findDropTargetAt(clientX: number, clientY: number): SidebarDropTarget | null {
  const element = document.elementFromPoint(clientX, clientY);
  const sidebarElement = element?.closest(".sidebar");

  if (!sidebarElement || isReadOnlyTree || !isAuthenticated) {
    return null;
  }

  const row = element?.closest<HTMLElement>(".tree-row[data-node-path]");
  const rowPath = row?.dataset.nodePath;

  if (row && rowPath) {
    const node = findNodeByPath(rowPath);
    if (!node) return null;

    const rect = row.getBoundingClientRect();
    const offsetY = clientY - rect.top;
    const edgeSize = Math.min(12, rect.height * 0.35);

    if (offsetY <= edgeSize) {
      return { type: "before", path: node.path };
    }

    if (offsetY >= rect.height - edgeSize) {
      return { type: "after", path: node.path };
    }

    if (node.isDir) {
      return { type: "into", path: node.path };
    }
  }

  return currentTree ? { type: "into", path: currentTree.path } : null;
}

function clearDropTarget() {
  document
    .querySelectorAll<HTMLElement>(".tree-row.drop-target, .tree-row.drop-before, .tree-row.drop-after")
    .forEach((row) => row.classList.remove("drop-target", "drop-before", "drop-after"));
}

function markDropTarget(target: SidebarDropTarget | null) {
  clearDropTarget();
  if (!target) return;

  const row = document.querySelector<HTMLElement>(
    `.tree-row[data-node-path="${CSS.escape(target.path)}"]`
  );
  row?.classList.add(
    target.type === "before"
      ? "drop-before"
      : target.type === "after"
        ? "drop-after"
        : "drop-target"
  );
}

function canUseDropTarget(sourcePath: string, target: SidebarDropTarget | null): target is SidebarDropTarget {
  if (!target || sourcePath === target.path) return false;

  const sourceNode = findNodeByPath(sourcePath);
  const targetNode = findNodeByPath(target.path);

  if (!sourceNode || !targetNode) return false;
  if (sourceNode.path === currentTree?.path) return false;

  if (target.type === "into") {
    if (!targetNode.isDir) return false;
    if (sourceNode.isDir && isAncestorPath(sourceNode.path, targetNode.path)) return false;
  } else if (!getParentNode(targetNode.path)) {
    return false;
  }

  return true;
}

function updatePointerDropTarget(clientX: number, clientY: number) {
  if (!pointerDrag) return;

  const target = findDropTargetAt(clientX, clientY);
  pointerDrag.target = canUseDropTarget(pointerDrag.sourcePath, target)
    ? target
    : null;
  markDropTarget(pointerDrag.target);
}

function cleanupPointerDrag() {
  draggedNodePath = null;
  clearDropTarget();

  if (!pointerDrag) return;

  pointerDrag.sourceRow.classList.remove("dragging");
  pointerDrag.ghost?.remove();
  pointerDrag = null;
}

async function importExternalPaths(paths: string[], destinationDir: string) {
  if (isReadOnlyTree) {
    alert("Import impossible : l'arborescence chargee provient d'un zip.");
    return;
  }

  if (!isAuthenticated) {
    alert("Connecte-toi pour ajouter des fichiers.");
    return;
  }

  if (!currentRootPath) {
    alert("Importe d'abord un dossier.");
    return;
  }

  if (paths.length === 0) return;

  setScanUi(true);
  const requestId = beginViewerRequest();
  renderImportSpinner(requestId);
  try {
    await invoke("import_entries", {
      sourcePaths: paths,
      destinationDir,
    });
    expandedPaths.add(destinationDir);
    await refreshTree();
  } catch (error) {
    setViewerEmbedded(false, requestId);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `, requestId);
  } finally {
    setScanUi(false);
  }
}

function toClientPosition(position: { x: number; y: number }) {
  const scale = window.devicePixelRatio || 1;
  return {
    x: position.x / scale,
    y: position.y / scale,
  };
}

function handleNativeDragDropEvent(payload: DragDropEvent) {
  if (payload.type === "leave") {
    clearDropTarget();
    return;
  }

  const position = toClientPosition(payload.position);
  const target = findDropTargetAt(position.x, position.y);
  const destinationPath = target?.type === "into" ? target.path : getParentNode(target?.path ?? "")?.path;

  if (payload.type === "drop") {
    clearDropTarget();
    if (destinationPath) {
      void importExternalPaths(payload.paths, destinationPath);
    }
    return;
  }

  markDropTarget(destinationPath ? { type: "into", path: destinationPath } : null);
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
  const canDrag =
    isAuthenticated &&
    !isReadOnlyTree &&
    node.path !== currentTree?.path &&
    editingPath !== node.path;
  row.draggable = false;
  row.dataset.nodePath = node.path;

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
  if (suppressNextTreeClick) {
    suppressNextTreeClick = false;
    event.preventDefault();
    return;
  }
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

row.addEventListener("pointerdown", (event) => {
  if (
    !canDrag ||
    event.button !== 0 ||
    editingPath === node.path ||
    event.target instanceof HTMLInputElement
  ) {
    return;
  }

  pointerDrag = {
    sourcePath: node.path,
    sourceRow: row,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    ghost: null,
    target: null,
  };
  row.setPointerCapture(event.pointerId);
});

row.addEventListener("pointermove", (event) => {
  if (!pointerDrag || pointerDrag.sourcePath !== node.path) return;

  const distance = Math.hypot(
    event.clientX - pointerDrag.startX,
    event.clientY - pointerDrag.startY
  );

  if (!pointerDrag.active && distance < 6) {
    return;
  }

  event.preventDefault();

  if (!pointerDrag.active) {
    pointerDrag.active = true;
    draggedNodePath = node.path;
    row.classList.add("dragging");
    pointerDrag.ghost = createDragGhost(node.name);
    suppressNextTreeClick = true;
  }

  if (pointerDrag.ghost) {
    moveDragGhost(pointerDrag.ghost, event.clientX, event.clientY);
  }
  updatePointerDropTarget(event.clientX, event.clientY);
});

row.addEventListener("pointerup", (event) => {
  if (!pointerDrag || pointerDrag.sourcePath !== node.path) return;

  const target = pointerDrag.target;
  const wasActive = pointerDrag.active;
  cleanupPointerDrag();

  if (wasActive) {
    event.preventDefault();
    suppressNextTreeClick = true;
    if (target) {
      void handleSidebarDrop(node.path, target);
    }
  }
});

row.addEventListener("pointercancel", () => {
  if (pointerDrag?.sourcePath === node.path) {
    cleanupPointerDrag();
  }
});

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
  if (!isAuthenticated) {
    alert("Connecte-toi pour gérer les fichiers.");
    return;
  }
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
  if (!isAuthenticated) {
    alert("Connecte-toi pour gérer les fichiers.");
    return;
  }
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

async function deleteSelectedEntry() {
  if (!isAuthenticated) {
    alert("Connecte-toi pour gérer les fichiers.");
    return;
  }
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
}

deleteEntryBtn?.addEventListener("click", () => {
  void deleteSelectedEntry();
});

forgetSourceBtn?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    alert("Connecte-toi pour oublier le dossier TP.");
    return;
  }
  if (!currentRootPath) return;

  const confirmed = window.confirm(
    "Oublier le dossier TP actuel ? Les fichiers ne seront pas supprimes."
  );
  if (!confirmed) return;

  try {
    await invoke("forget_saved_source");
    currentRootPath = null;
    currentTree = null;
    selectedPath = null;
    isReadOnlyTree = false;
    expandedPaths.clear();
    editingPath = null;
    creatingInParentPath = null;
    renderTree();
    updateActionButtonsState();
    setViewerEmbedded(false);
    setViewerHtml(`
      <div class="empty-state">
        Aucun dossier TP defini. Connecte-toi en admin puis importe un dossier.
      </div>
    `);
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

async function setViewerFullscreenState(nextValue: boolean) {
  try {
    await getCurrentWindow().setFullscreen(nextValue);
  } catch (error) {
    console.error("Impossible de changer le plein ecran natif:", error);
  }

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

const backToLoginBtn = document.querySelector<HTMLButtonElement>("#back-to-login-btn");

backToLoginBtn?.addEventListener("click", () => {
  toggleHidden(authLoginSection, false);
  toggleHidden(authResetSection, true);

  if (authTitle) authTitle.textContent = "Connexion admin";
  if (authSubtitle) {
    authSubtitle.textContent = "Entre l'identifiant et le mot de passe pour gérer les dossiers TP.";
  }

  requestAnimationFrame(() => authUsername?.focus());
});

async function refreshTree() {
  if (!currentRootPath) return;

  const previousSelectedPath = selectedPath;
  const previousExpanded = new Set(expandedPaths);

  const tree = await invoke<TreeNode>("rescan_current_source");
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
  const requestId = beginViewerRequest();
  if (selectedNode?.indexPath) {
    await renderEmbeddedPreview(selectedNode.indexPath, requestId);
  } else if (selectedNode) {
    renderDetails(selectedNode, requestId);
  } else {
    renderFolderHint(requestId);
  }

  await updateSourceSnapshot();
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

async function applyLoadedTree(path: string, tree: TreeNode, requestId?: number) {
  currentRootPath = path;
  currentTree = tree;
  isReadOnlyTree = isZipTreeRoot(tree);
  lastSourceSnapshot = null;
  selectedPath = tree.path;

  expandedPaths.clear();
  expandedPaths.add(tree.path);

  setScanUi(false);
  updateActionButtonsState();
  renderTree();

  if (tree.indexPath) {
    await renderEmbeddedPreview(tree.indexPath, requestId);
  } else if (!tree.isDir) {
    renderDetails(tree, requestId);
  } else {
    renderFolderHint(requestId);
  }

  await updateSourceSnapshot();
}

async function loadSavedSource() {
  const requestId = beginViewerRequest();
  setScanUi(true);
  renderScanSpinner(requestId);

  try {
    const saved = await invoke<SavedSource | null>("load_saved_source");
    if (!saved) {
      setScanUi(false);
      setViewerEmbedded(false, requestId);
      setViewerHtml(`
        <div class="empty-state">
          Aucun dossier TP defini. Connecte-toi en admin puis importe un dossier.
        </div>
      `, requestId);
      return;
    }

    await applyLoadedTree(saved.path, saved.tree, requestId);
  } catch (error) {
    setScanUi(false);
    setViewerEmbedded(false, requestId);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `, requestId);
  }
}

async function scanPath(path: string) {
  const requestId = beginViewerRequest();
  setScanUi(true);
  renderScanSpinner(requestId);

  try {
    const tree = await invoke<TreeNode>("scan_source", { path });
    await applyLoadedTree(path, tree, requestId);
  } catch (error) {
    setScanUi(false);

    if (String(error).includes("Scan annulé")) {
      setViewerHtml(`
        <div class="empty-state">
          Scan annulé.
        </div>
      `, requestId);
      return;
    }

    setViewerEmbedded(false, requestId);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `, requestId);
  }
}

async function updateSourceSnapshot() {
  if (!currentRootPath || isReadOnlyTree) {
    lastSourceSnapshot = null;
    return;
  }

  try {
    lastSourceSnapshot = await invoke<string>("get_source_snapshot");
  } catch (error) {
    console.error("Snapshot dossier TP impossible:", error);
  }
}

async function checkSourceChanges() {
  if (
    !currentRootPath ||
    isReadOnlyTree ||
    isScanning ||
    isExportingStudentArchive ||
    isCheckingSourceChanges
  ) {
    return;
  }

  isCheckingSourceChanges = true;
  try {
    const snapshot = await invoke<string>("get_source_snapshot");
    if (lastSourceSnapshot === null) {
      lastSourceSnapshot = snapshot;
      return;
    }

    if (snapshot !== lastSourceSnapshot) {
      lastSourceSnapshot = snapshot;
      await refreshTree();
      await updateSourceSnapshot();
    }
  } catch (error) {
    console.error("Verification des changements impossible:", error);
  } finally {
    isCheckingSourceChanges = false;
  }
}

folderBtn?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    alert("Connecte-toi pour importer un dossier.");
    return;
  }
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
  if (!isAuthenticated) {
    alert("Connecte-toi pour importer un zip.");
    return;
  }
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
    const requestId = beginViewerRequest();
    renderImportSpinner(requestId);
    try {
      await invoke("import_zip", {
        zipPath: selected,
        destinationDir: currentRootPath,
      });
      await refreshTree();
    } catch (error) {
      setViewerEmbedded(false, requestId);
      setViewerHtml(`
        <div class="error-state">
          <strong>Erreur</strong>
          <pre>${escapeHtml(String(error))}</pre>
        </div>
      `, requestId);
    } finally {
      setScanUi(false);
    }
  }
});

void getCurrentWindow()
  .onDragDropEvent((event) => {
    handleNativeDragDropEvent(event.payload);
  })
  .catch((error) => {
    console.error("Impossible d'initialiser le depot de fichiers:", error);
  });

treeRoot?.addEventListener("dragstart", (event) => {
  event.preventDefault();
});

exportStudentBtn?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    alert("Connecte-toi pour exporter.");
    return;
  }
  if (!currentRootPath || isReadOnlyTree) {
    alert("Importe un dossier TP pour exporter.");
    return;
  }

  const requestId = beginViewerRequest();
  isExportingStudentArchive = true;
  updateActionButtonsState();
  exportStudentBtn.textContent = "Export...";
  renderExportSpinner(requestId);

  try {
    const exportPath = await invoke<string>("export_for_students");
    renderExportSuccess(exportPath, requestId);
  } catch (error) {
    setViewerEmbedded(false, requestId);
    setViewerHtml(`
      <div class="error-state">
        <strong>Erreur export</strong>
        <pre>${escapeHtml(String(error))}</pre>
      </div>
    `, requestId);
  } finally {
    isExportingStudentArchive = false;
    exportStudentBtn.textContent = "Exporter élève";
    updateActionButtonsState();
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
  void setViewerFullscreenState(!isViewerFullscreen);
});

authBtn?.addEventListener("click", () => {
  if (isAuthenticated) {
    void logout();
  } else {
    openAuthModal();
  }
});

accountBtn?.addEventListener("click", () => {
  void openAccountModal();
});

authCancel?.addEventListener("click", () => {
  closeAuthModal();
});

forgotPasswordBtn?.addEventListener("click", () => {
  toggleHidden(authError, true);
  toggleHidden(authLoginSection, true);
  toggleHidden(authResetSection, false);

  if (authTitle) authTitle.textContent = "Réinitialiser le mot de passe";
  if (authSubtitle) {
    authSubtitle.textContent = "Demande un lien de réinitialisation puis définis ton nouveau mot de passe.";
  }

  clearModalHint(resetSendStatus);
  clearModalHint(resetApplyStatus);
  requestAnimationFrame(() => resetEmailInput?.focus());
});

accountCancel?.addEventListener("click", () => {
  closeAccountModal();
});

authModal?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.dataset.modalClose === "true") {
    closeAuthModal();
  }
});

accountModal?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.dataset.modalClose === "account") {
    closeAccountModal();
  }
});

authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = authUsername?.value.trim() ?? "";
  const password = authPassword?.value ?? "";
  toggleHidden(authError, true);
  await loginWithCredentials(username, password);
});

accountForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearModalHint(accountSaveStatus);

  const username = accountUsername?.value.trim() ?? "";
  const email = accountEmail?.value.trim() ?? "";

  try {
    await invoke("update_account_profile", { username, email });
    setModalHint(accountSaveStatus, "Compte mis a jour.");
  } catch (error) {
    setModalHint(accountSaveStatus, `Erreur: ${String(error)}`);
  }
});

sendResetBtn?.addEventListener("click", async () => {
  clearModalHint(resetSendStatus);
  const email = resetEmailInput?.value.trim() ?? "";
  try {
    await invoke("request_password_reset", { email });
    setModalHint(resetSendStatus, "Lien envoyé. Vérifie ta boîte mail.");
  } catch (error) {
    setModalHint(resetSendStatus, `Erreur : ${String(error)}`);
  }
});

resetPasswordBtn?.addEventListener("click", async () => {
  clearModalHint(resetApplyStatus);

  const token = resetTokenInput?.value.trim() ?? "";
  const password = resetPasswordInput?.value ?? "";
  const confirm = resetPasswordConfirmInput?.value ?? "";

  if (!token) {
    setModalHint(resetApplyStatus, "Code requis.");
    return;
  }
  if (!password || password !== confirm) {
    setModalHint(resetApplyStatus, "Les mots de passe ne correspondent pas.");
    return;
  }

  try {
    await invoke("reset_password_with_token", {
      token,
      newPassword: password,
    });
    toggleHidden(authLoginSection, false);
    toggleHidden(authResetSection, true);
    toggleHidden(authError, true);

    if (resetTokenInput) resetTokenInput.value = "";
    if (resetPasswordInput) resetPasswordInput.value = "";
    if (resetPasswordConfirmInput) resetPasswordConfirmInput.value = "";

    if (authTitle) authTitle.textContent = "Connexion admin";
    if (authSubtitle) {
      authSubtitle.textContent = "Mot de passe mis a jour. Connecte-toi avec ton nouveau mot de passe.";
    }
    if (authPassword) authPassword.value = "";

    requestAnimationFrame(() => authPassword?.focus());
  } catch (error) {
    setModalHint(resetApplyStatus, `Erreur: ${String(error)}`);
  }
});

const exitFullscreenBtn = document.querySelector<HTMLButtonElement>(
  "#exit-fullscreen-btn"
);

exitFullscreenBtn?.addEventListener("click", () => {
  void setViewerFullscreenState(false);
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
    void setViewerFullscreenState(false);
    return;
  }

  if (event.key !== "Delete") {
    return;
  }

  const target = event.target as HTMLElement | null;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    Boolean(target?.isContentEditable);
  const hasOpenModal =
    Boolean(authModal && !authModal.classList.contains("is-hidden")) ||
    Boolean(accountModal && !accountModal.classList.contains("is-hidden"));

  if (isTyping || hasOpenModal || editingPath || creatingInParentPath) {
    return;
  }

  event.preventDefault();
  void deleteSelectedEntry();
});

void listen<string>("reset_link", (event) => {
  const token = event.payload;
  void openAuthReset(token);
});

void invoke<string | null>("take_initial_reset_token").then((token) => {
  if (token) {
    void openAuthReset(token);
  }
});

window.setInterval(() => {
  void checkSourceChanges();
}, 2500);

updateActionButtonsState();
renderTree();
setAuthenticated(false);
void loadSavedSource();
