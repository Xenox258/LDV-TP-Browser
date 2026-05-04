use argon2::{Argon2, PasswordHash, PasswordVerifier};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use zip::ZipArchive;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    is_zip: bool,
    index_path: Option<String>,
    children: Vec<TreeNode>,
}

struct PreviewRoots(Mutex<HashMap<String, PathBuf>>);
struct ScanState(Arc<AtomicBool>);
struct ZipCacheState(Mutex<HashMap<String, ZipCacheEntry>>);
struct CurrentRootState(Mutex<Option<PathBuf>>);
struct AuthState(Mutex<bool>);

struct ZipCacheEntry {
    root: PathBuf,
    index_relative: Option<String>,
}

fn get_admin_username() -> Result<String, String> {
    env::var("ADMIN_USERNAME").map_err(|_| {
        "ADMIN_USERNAME manquant dans le fichier .env".to_string()
    })
}

fn get_admin_password_hash() -> Result<String, String> {
    env::var("ADMIN_PASSWORD_HASH").map_err(|_| {
        "ADMIN_PASSWORD_HASH manquant dans le fichier .env".to_string()
    })
}

fn new_preview_id() -> Result<String, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    Ok(format!("preview-{}", timestamp))
}

fn encode_asset_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn resolve_case_insensitive(root: &Path, relative: &str) -> Option<PathBuf> {
    let mut current = root.to_path_buf();

    for segment in relative.split('/') {
        if segment.is_empty() {
            continue;
        }

        let entries = fs::read_dir(&current).ok()?;
        let mut found = None;

        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.eq_ignore_ascii_case(segment) {
                    found = Some(entry.path());
                    break;
                }
            }
        }

        match found {
            Some(path) => current = path,
            None => return None,
        }
    }

    Some(current)
}

fn set_current_root(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let root = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .ok_or_else(|| "Impossible de déterminer le dossier racine".to_string())?
            .to_path_buf()
    };

    let canonical = root
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre la racine: {}", e))?;

    let state = app.state::<CurrentRootState>();
    let mut current = state
        .0
        .lock()
        .map_err(|_| "État racine verrouillé".to_string())?;

    *current = Some(canonical);
    Ok(())
}

fn get_current_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<CurrentRootState>();
    let current = state
        .0
        .lock()
        .map_err(|_| "État racine verrouillé".to_string())?;

    current
        .clone()
        .ok_or_else(|| "Aucune racine active. Importe d'abord un dossier ou un zip.".to_string())
}

fn ensure_authenticated(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AuthState>();
    let authenticated = state
        .0
        .lock()
        .map_err(|_| "État authentification verrouillé".to_string())?;

    if *authenticated {
        Ok(())
    } else {
        Err("Opération réservée: connecte-toi d'abord".to_string())
    }
}

fn ensure_in_root(app: &tauri::AppHandle, path: &Path) -> Result<PathBuf, String> {
    let root = get_current_root(app)?;
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre la racine: {}", e))?;

    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre le chemin: {}", e))?;

    if !canonical.starts_with(&root_canonical) {
        return Err("Opération refusée: chemin hors de la racine active".to_string());
    }

    Ok(canonical)
}

fn ensure_target_in_root(app: &tauri::AppHandle, path: &Path) -> Result<PathBuf, String> {
    let root = get_current_root(app)?;
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre la racine: {}", e))?;

    let parent = path
        .parent()
        .ok_or_else(|| "Chemin cible invalide".to_string())?;

    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre le dossier cible: {}", e))?;

    if !parent_canonical.starts_with(&root_canonical) {
        return Err("Opération refusée: destination hors de la racine active".to_string());
    }

    Ok(path.to_path_buf())
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Le nom ne peut pas être vide".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Le nom ne doit pas contenir de séparateur de chemin".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Nom invalide".to_string());
    }
    Ok(())
}

fn is_subpath(parent: &Path, child: &Path) -> bool {
    if parent == child {
        return true;
    }

    child.starts_with(parent)
}

#[tauri::command]
async fn scan_source(app: tauri::AppHandle, path: String) -> Result<TreeNode, String> {
    ensure_authenticated(&app)?;
    let cancel_flag = app.state::<ScanState>().0.clone();
    cancel_flag.store(false, Ordering::Relaxed);

    let root_path = PathBuf::from(&path);
    if !root_path.exists() {
        return Err(format!("Le chemin n'existe pas: {:?}", path));
    }

    set_current_root(&app, &root_path)?;

    tauri::async_runtime::spawn_blocking(move || {
        println!("RAW PATH = {:?}", path);

        let input = PathBuf::from(&path);
        println!("PATHBUF = {:?}", input);
        println!("EXISTS = {}", input.exists());
        println!("IS_DIR = {}", input.is_dir());

        if !input.exists() {
            return Err(format!("Le chemin n'existe pas: {:?}", path));
        }

        if input.is_dir() {
            build_dir_tree(&input, &cancel_flag)
        } else if is_zip_path(&input) {
            build_zip_tree(&input, &cancel_flag)
        } else {
            Err(format!("Le chemin n'est ni dossier ni zip: {:?}", path))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn prepare_preview(app: tauri::AppHandle, index_path: String) -> Result<String, String> {
    let path = PathBuf::from(&index_path);

    if !path.exists() {
        return Err(format!("Le fichier n'existe pas: {}", index_path));
    }

    if !path.is_file() {
        return Err("Le chemin doit pointer vers un fichier".into());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Impossible de trouver le dossier parent".to_string())?
        .to_path_buf();

    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Nom de fichier invalide".to_string())?;

    let preview_id = new_preview_id()?;

    let state = app.state::<PreviewRoots>();
    let mut roots = state
        .0
        .lock()
        .map_err(|_| "État de preview verrouillé".to_string())?;

    roots.insert(preview_id.clone(), parent);

    Ok(format!(
        "asset://localhost/{}/{}",
        preview_id,
        urlencoding::encode(filename)
    ))
}

#[tauri::command]
fn open_preview(app: tauri::AppHandle, index_path: String) -> Result<(), String> {
    let path = PathBuf::from(&index_path);

    if !path.exists() {
        return Err(format!("Le fichier n'existe pas: {}", index_path));
    }

    if !path.is_file() {
        return Err("Le chemin doit pointer vers un fichier".into());
    }

    let url = Url::from_file_path(&path).map_err(|_| "Chemin de fichier invalide".to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let label = format!("preview-{}", timestamp);

    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("Aperçu TP")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn cancel_scan(app: tauri::AppHandle) {
    let cancel_flag = app.state::<ScanState>().0.clone();
    cancel_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn login(app: tauri::AppHandle, username: String, password: String) -> Result<bool, String> {
    let expected_username = get_admin_username()?;
    if username != expected_username {
        return Ok(false);
    }

    let hash = get_admin_password_hash()?;
    let parsed = PasswordHash::new(&hash)
        .map_err(|_| "Hash de mot de passe invalide".to_string())?;

    if Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
    {
        let state = app.state::<AuthState>();
        let mut auth = state
            .0
            .lock()
            .map_err(|_| "État authentification verrouillé".to_string())?;
        *auth = true;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn logout(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AuthState>();
    let mut auth = state
        .0
        .lock()
        .map_err(|_| "État authentification verrouillé".to_string())?;

    *auth = false;
    Ok(())
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("Le dossier n'existe pas".to_string());
    }
    if !target.is_dir() {
        return Err("Le chemin doit être un dossier".to_string());
    }

    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|e| format!("Ouverture impossible: {}", e))
}

#[tauri::command]
fn import_zip(app: tauri::AppHandle, zip_path: String, destination_dir: String) -> Result<String, String> {
    ensure_authenticated(&app)?;
    let source = PathBuf::from(zip_path);
    if !source.exists() {
        return Err("Le fichier zip n'existe pas".to_string());
    }
    if !source.is_file() || !is_zip_path(&source) {
        return Err("Le fichier doit être un .zip".to_string());
    }

    let destination = PathBuf::from(destination_dir);
    let destination = ensure_in_root(&app, &destination)?;

    if !destination.is_dir() {
        return Err("La destination doit être un dossier".to_string());
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| "Nom de fichier invalide".to_string())?;

    let target = destination.join(file_name);
    let target = ensure_target_in_root(&app, &target)?;

    if target.exists() {
        return Err("Un fichier avec le même nom existe déjà".to_string());
    }

    fs::copy(&source, &target).map_err(|e| format!("Import impossible: {}", e))?;

    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(app: tauri::AppHandle, parent_path: String, name: String) -> Result<(), String> {
    ensure_authenticated(&app)?;
    validate_entry_name(&name)?;

    let parent = PathBuf::from(parent_path);
    let parent = ensure_in_root(&app, &parent)?;

    if !parent.is_dir() {
        return Err("Le dossier parent doit être un répertoire".to_string());
    }

    let target = parent.join(name.trim());
    let target = ensure_target_in_root(&app, &target)?;

    if target.exists() {
        return Err("Un élément avec ce nom existe déjà".to_string());
    }

    fs::create_dir(&target).map_err(|e| format!("Création impossible: {}", e))?;
    Ok(())
}

#[tauri::command]
fn rename_entry(app: tauri::AppHandle, path: String, new_name: String) -> Result<(), String> {
    ensure_authenticated(&app)?;
    validate_entry_name(&new_name)?;

    let source = PathBuf::from(path);
    let source = ensure_in_root(&app, &source)?;

    let parent = source
        .parent()
        .ok_or_else(|| "Impossible de trouver le dossier parent".to_string())?;

    let mut resolved_name = new_name.trim().to_string();
    if source.is_file() {
        let new_path = Path::new(&resolved_name);
        if new_path.extension().is_none() {
            if let Some(ext) = source.extension().and_then(|e| e.to_str()) {
                if !ext.is_empty() {
                    resolved_name = format!("{}.{}", resolved_name, ext);
                }
            }
        }
    }

    let target = parent.join(resolved_name);
    let target = ensure_target_in_root(&app, &target)?;

    if target.exists() {
        return Err("Un élément avec ce nom existe déjà".to_string());
    }

    fs::rename(&source, &target).map_err(|e| format!("Renommage impossible: {}", e))?;
    Ok(())
}

#[tauri::command]
fn delete_entry(app: tauri::AppHandle, path: String) -> Result<(), String> {
    ensure_authenticated(&app)?;
    let target = PathBuf::from(path);
    let target = ensure_in_root(&app, &target)?;

    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("Suppression impossible: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("Suppression impossible: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn move_entry(
    app: tauri::AppHandle,
    source_path: String,
    destination_dir: String,
) -> Result<(), String> {
    ensure_authenticated(&app)?;
    let root = get_current_root(&app)?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("Impossible de résoudre la racine: {}", e))?;

    let source = PathBuf::from(source_path);
    let source = ensure_in_root(&app, &source)?;

    let destination = PathBuf::from(destination_dir);
    let destination = ensure_in_root(&app, &destination)?;

    if source == root {
        return Err("Impossible de déplacer le dossier racine".to_string());
    }

    if !destination.is_dir() {
        return Err("La destination doit être un dossier".to_string());
    }

    if source == destination {
        return Err("La source et la destination sont identiques".to_string());
    }

    if source.is_dir() && is_subpath(&source, &destination) {
        return Err("Impossible de déplacer un dossier dans lui-même ou un sous-dossier".to_string());
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| "Nom de source invalide".to_string())?;

    let target = destination.join(file_name);
    let target = ensure_target_in_root(&app, &target)?;

    if target.exists() {
        return Err("Un élément avec le même nom existe déjà dans la destination".to_string());
    }

    fs::rename(&source, &target).map_err(|e| format!("Déplacement impossible: {}", e))?;
    Ok(())
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false)
}

fn check_cancel(cancel_flag: &AtomicBool) -> Result<(), String> {
    if cancel_flag.load(Ordering::Relaxed) {
        Err("Scan annulé".to_string())
    } else {
        Ok(())
    }
}

fn build_dir_tree(path: &Path, cancel_flag: &AtomicBool) -> Result<TreeNode, String> {
    check_cancel(cancel_flag)?;
    let name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("root"))
        .to_string();

    let mut children = Vec::new();

    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in entries {
        check_cancel(cancel_flag)?;
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        if metadata.is_dir() {
            children.push(build_dir_tree(&entry_path, cancel_flag)?);
        } else {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_zip = is_zip_path(&entry_path);

            children.push(TreeNode {
                name: file_name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: false,
                is_zip,
                index_path: None,
                children: Vec::new(),
            });
        }
    }

    children.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let mut node = TreeNode {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        is_zip: false,
        index_path: find_index_html(path),
        children,
    };

    set_index_paths_from_children(&mut node);
    Ok(node)
}


#[tauri::command]
async fn resolve_zip_index(
    app: tauri::AppHandle,
    zip_path: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(cache) = app.state::<ZipCacheState>().0.lock() {
            if let Some(entry) = cache.get(&zip_path) {
                let preview_id = new_preview_id()?;

                let state = app.state::<PreviewRoots>();
                let mut roots = state
                    .0
                    .lock()
                    .map_err(|_| "État de preview verrouillé".to_string())?;

                roots.insert(preview_id.clone(), entry.root.clone());

                return Ok(entry.index_relative.as_ref().map(|relative| {
                    format!(
                        "asset://localhost/{}/{}",
                        preview_id,
                        encode_asset_path(relative)
                    )
                }));
            }
        }

        let path = PathBuf::from(&zip_path);
        if !path.exists() {
            return Err("Le fichier zip n'existe pas".to_string());
        }
        if !is_zip_path(&path) {
            return Err("Le fichier doit être un .zip".to_string());
        }

        let cancel_flag = AtomicBool::new(false);
        let extract_root = extract_zip_to_temp(&path, &cancel_flag)?;
        let index_path = match find_index_html_recursive(&extract_root, &cancel_flag) {
            Some(path) => PathBuf::from(path),
            None => return Ok(None),
        };

        let relative = index_path
            .strip_prefix(&extract_root)
            .map_err(|_| "Index introuvable dans l'archive".to_string())?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");

        let entry = ZipCacheEntry {
            root: extract_root.clone(),
            index_relative: Some(relative_str.clone()),
        };

        if let Ok(mut cache) = app.state::<ZipCacheState>().0.lock() {
            cache.insert(zip_path, entry);
        }

        let preview_id = new_preview_id()?;

        let state = app.state::<PreviewRoots>();
        let mut roots = state
            .0
            .lock()
            .map_err(|_| "État de preview verrouillé".to_string())?;

        roots.insert(preview_id.clone(), extract_root);

        Ok(Some(format!(
            "asset://localhost/{}/{}",
            preview_id,
            encode_asset_path(&relative_str)
        )))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_zip_tree(path: &Path, cancel_flag: &AtomicBool) -> Result<TreeNode, String> {
    check_cancel(cancel_flag)?;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let root_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("archive.zip")
        .to_string();

    let extract_root = extract_zip_to_temp(path, cancel_flag)?;
    let mut extracted_index_path: Option<String> = None;

    let mut root = TreeNode {
        name: root_name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        is_zip: true,
        index_path: None,
        children: Vec::new(),
    };

    for i in 0..archive.len() {
        check_cancel(cancel_flag)?;
        let file = archive.by_index(i).map_err(|e| e.to_string())?;
        let zip_entry_name = file.name().replace('\\', "/");

        if !is_safe_zip_entry(&zip_entry_name) {
            continue;
        }

        insert_zip_entry(&mut root, &zip_entry_name);

        if extracted_index_path.is_none() && is_index_html_name(&zip_entry_name) {
            let index_path = extract_root.join(&zip_entry_name);
            extracted_index_path = Some(index_path.to_string_lossy().to_string());
        }
    }

    check_cancel(cancel_flag)?;
    root.index_path = extracted_index_path.or_else(|| find_index_html_recursive(&extract_root, cancel_flag));
    set_index_paths_from_children(&mut root);
    sort_tree(&mut root);
    Ok(root)
}

fn insert_zip_entry(root: &mut TreeNode, entry_path: &str) {
    let parts: Vec<&str> = entry_path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return;
    }

    let mut current = root;

    for (idx, part) in parts.iter().enumerate() {
        let is_last = idx == parts.len() - 1;
        let should_be_dir = !is_last || entry_path.ends_with('/');

        if let Some(pos) = current.children.iter().position(|c| c.name == *part) {
            current = &mut current.children[pos];
        } else {
            current.children.push(TreeNode {
                name: (*part).to_string(),
                path: if current.path.is_empty() {
                    (*part).to_string()
                } else {
                    format!("{}/{}", current.path, part)
                },
                is_dir: should_be_dir,
                is_zip: false,
                index_path: None,
                children: Vec::new(),
            });

            let last = current.children.len() - 1;
            current = &mut current.children[last];
        }
    }
}

fn sort_tree(node: &mut TreeNode) {
    node.children.iter_mut().for_each(sort_tree);
    node.children.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn find_index_html(path: &Path) -> Option<String> {
    let index_path = path.join("index.html");
    if index_path.is_file() {
        Some(index_path.to_string_lossy().to_string())
    } else {
        None
    }
}

fn find_index_html_recursive(path: &Path, cancel_flag: &AtomicBool) -> Option<String> {
    if cancel_flag.load(Ordering::Relaxed) {
        return None;
    }
    if let Some(index) = find_index_html(path) {
        return Some(index);
    }

    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        if cancel_flag.load(Ordering::Relaxed) {
            return None;
        }
        let entry_path = entry.path();
        if entry_path.is_dir() {
            if let Some(index) = find_index_html_recursive(&entry_path, cancel_flag) {
                return Some(index);
            }
        }
    }

    None
}

fn is_index_html_name(name: &str) -> bool {
    name.to_lowercase().ends_with("index.html") || name.to_lowercase().ends_with("index.htm")
}

fn is_safe_zip_entry(name: &str) -> bool {
    !name.starts_with('/') && !name.contains("..")
}

fn extract_zip_to_temp(zip_path: &Path, cancel_flag: &AtomicBool) -> Result<PathBuf, String> {
    let base_dir = std::env::temp_dir().join("tp-browser-zips");
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let stem = zip_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("archive");

    let target_dir = base_dir.join(format!("{}-{}", stem, timestamp));
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        check_cancel(cancel_flag)?;
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let entry_name = file.name().replace('\\', "/");

        if !is_safe_zip_entry(&entry_name) {
            continue;
        }

        let outpath = target_dir.join(&entry_name);

        if file.is_dir() {
            fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }

            let mut outfile = File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    Ok(target_dir)
}

fn set_index_paths_from_children(node: &mut TreeNode) {
    if node.is_dir {
        if node.index_path.is_none() {
            if let Some(child) = node.children.iter().find(|child| {
                !child.is_dir && child.name.eq_ignore_ascii_case("index.html")
            }) {
                node.index_path = Some(child.path.clone());
            }
        }

        for child in node.children.iter_mut() {
            set_index_paths_from_children(child);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if dotenvy::dotenv().is_err() {
        if let Ok(current) = env::current_dir() {
            let mut cursor = Some(current.as_path());
            while let Some(path) = cursor {
                let candidate = path.join(".env");
                if dotenvy::from_path(&candidate).is_ok() {
                    break;
                }
                cursor = path.parent();
            }
        }
    }
    tauri::Builder::default()
    .manage(PreviewRoots(Mutex::new(HashMap::new())))
    .manage(ScanState(Arc::new(AtomicBool::new(false))))
    .manage(CurrentRootState(Mutex::new(None)))
    .manage(ZipCacheState(Mutex::new(HashMap::new())))
    .manage(AuthState(Mutex::new(false)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
    scan_source,
    open_preview,
    prepare_preview,
    cancel_scan,
    open_in_explorer,
    resolve_zip_index,
    import_zip,
    login,
    logout,
    create_folder,
    rename_entry,
    delete_entry,
    move_entry
])
        // Ajoute ceci pour servir les fichiers locaux
        .register_uri_scheme_protocol("asset", |app, request| {
    use tauri::http::header::CONTENT_TYPE;
    use tauri::http::Response;

    let decoded_path = urlencoding::decode(request.uri().path())
        .map(|p| p.to_string())
        .unwrap_or_default();

    let trimmed = decoded_path.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');

    let preview_id = match parts.next() {
        Some(id) if !id.is_empty() => id,
        _ => {
            return Response::builder()
                .status(400)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(b"Missing preview id".to_vec())
                .unwrap();
        }
    };

    let relative_path = match parts.next() {
        Some(path) if !path.is_empty() => path,
        _ => {
            return Response::builder()
                .status(400)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(b"Missing relative path".to_vec())
                .unwrap();
        }
    };

    let root = {
        let state = app.app_handle().state::<PreviewRoots>();
        let roots = match state.0.lock() {
            Ok(roots) => roots,
            Err(_) => {
                return Response::builder()
                    .status(500)
                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(b"Preview state lock error".to_vec())
                    .unwrap();
            }
        };

        match roots.get(preview_id) {
            Some(root) => root.clone(),
            None => {
                return Response::builder()
                    .status(404)
                    .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                    .body(b"Preview root not found".to_vec())
                    .unwrap();
            }
        }
    };

    let mut resolved_path = root.join(relative_path);

    if !resolved_path.exists() {
        if let Some(found) = resolve_case_insensitive(&root, relative_path) {
            resolved_path = found;
        }
    }

    let root_canonical = root.canonicalize().ok();
    let resolved_canonical = resolved_path.canonicalize().ok();

    if let (Some(root_can), Some(resolved_can)) = (root_canonical, resolved_canonical) {
        if !resolved_can.starts_with(&root_can) {
            return Response::builder()
                .status(403)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .body(b"Forbidden".to_vec())
                .unwrap();
        }
    }

    if resolved_path.is_dir() {
        resolved_path = resolved_path.join("index.html");
    }

    let path_lower = resolved_path.to_string_lossy().to_lowercase();

    match std::fs::read(&resolved_path) {
        Ok(bytes) => {
            let content_type = if path_lower.ends_with(".html") || path_lower.ends_with(".htm") {
                "text/html; charset=utf-8"
            } else if path_lower.ends_with(".css") {
                "text/css; charset=utf-8"
            } else if path_lower.ends_with(".js") {
                "text/javascript; charset=utf-8"
            } else if path_lower.ends_with(".png") {
                "image/png"
            } else if path_lower.ends_with(".jpg") || path_lower.ends_with(".jpeg") {
                "image/jpeg"
            } else if path_lower.ends_with(".svg") {
                "image/svg+xml"
            } else if path_lower.ends_with(".gif") {
                "image/gif"
            } else if path_lower.ends_with(".webp") {
                "image/webp"
            } else if path_lower.ends_with(".ico") {
                "image/x-icon"
            } else if path_lower.ends_with(".json") {
                "application/json"
            } else if path_lower.ends_with(".wasm") {
                "application/wasm"
            } else if path_lower.ends_with(".glb") {
                "model/gltf-binary"
            } else if path_lower.ends_with(".gltf") {
                "model/gltf+json"
            } else if path_lower.ends_with(".bin") {
                "application/octet-stream"
            } else if path_lower.ends_with(".woff") {
                "font/woff"
            } else if path_lower.ends_with(".woff2") {
                "font/woff2"
            } else if path_lower.ends_with(".ttf") {
                "font/ttf"
            } else if path_lower.ends_with(".otf") {
                "font/otf"
            } else if path_lower.ends_with(".mp4") {
                "video/mp4"
            } else if path_lower.ends_with(".webm") {
                "video/webm"
            } else if path_lower.ends_with(".mp3") {
                "audio/mpeg"
            } else if path_lower.ends_with(".pdf") {
                "application/pdf"
            } else {
                "application/octet-stream"
            };

            Response::builder()
                .status(200)
                .header(CONTENT_TYPE, content_type)
                .body(bytes)
                .unwrap()
        }
        Err(_) => Response::builder()
            .status(404)
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(b"Not found".to_vec())
            .unwrap(),
    }
})
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}