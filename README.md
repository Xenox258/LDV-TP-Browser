# TP Browser

TP Browser est une application Tauri pour consulter, organiser et distribuer des TP HTML/Scenari. Elle est pensée pour un usage au lycee du Vimeu : un enseignant importe et gere les dossiers TP, puis exporte une version eleve contenant l'application et les TP dans une archive zip.

## Fonctionnalites

- Lecture integree des TP HTML avec iframe.
- Arborescence de fichiers dans la sidebar.
- Mode plein ecran pour la zone de preview.
- Connexion admin pour proteger les actions de gestion.
- Import d'un dossier TP ou ajout d'archives zip.
- Creation, renommage, suppression et deplacement d'elements.
- Reorganisation manuelle des elements dans la sidebar par glisser-deposer.
- Detection automatique des changements dans le dossier TP.
- Export "version eleve" : cree un zip contenant l'executable et le dossier TP.
- Recuperation de mot de passe admin par lien/token, si l'email est configure.

## Prerequis

- Node.js
- Rust
- Tauri v2
- Windows recommande pour l'usage cible actuel

Installation des dependances :

```bash
npm install
```

## Configuration admin

Copie `.env.example` vers `.env`, puis adapte les valeurs :

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH="hash_argon2"
ADMIN_EMAIL="mail@example.com"
RESEND_API_KEY="re_xxx"
RESEND_FROM="TP Browser <no-reply@example.com>"
RESET_LINK_BASE_URL="https://example.com/reset.html"
```

Le fichier `.env` reste local et ne doit pas etre versionne.

Pour generer un hash Argon2 :

```bash
cd src-tauri
cargo run --bin hash_password -- "nouveau_mot_de_passe"
```

Copie la valeur affichee dans `ADMIN_PASSWORD_HASH`.

## Lancement en developpement

Interface web seule :

```bash
npm run dev
```

Application Tauri :

```bash
npm run dev:tauri
```

Build frontend :

```bash
npm run build
```

Verification Rust :

```bash
cd src-tauri
cargo check
```

Build de l'application :

```bash
npm run tauri -- build
```

## Utilisation admin

1. Lance l'application.
2. Clique sur `Se connecter`.
3. Importe un dossier TP avec `Importer un dossier`.
4. Utilise la sidebar pour ouvrir les TP.
5. Gere les fichiers avec les boutons de la sidebar.

Les actions de gestion sont masquees tant que l'utilisateur n'est pas connecte.

## Sidebar

- Clique sur un element pour l'afficher.
- Double-clique sur un dossier pour le replier/deplier.
- Glisse un element sur le centre d'un dossier pour le deplacer dedans.
- Glisse un element sur le haut ou le bas d'une ligne pour le placer avant/apres.
- L'ordre manuel est sauvegarde dans la configuration locale de l'application.

L'application surveille le dossier TP courant. Si un TP est ajoute, modifie ou supprime depuis l'explorateur Windows, l'arborescence se met a jour automatiquement.

## Export version eleve

Le bouton `Exporter version eleve` est disponible en mode admin lorsqu'un dossier TP est charge.

L'export cree une archive zip a cote du dossier TP, par exemple :

```text
C:\Users\...\Documents\TP_export_eleves.zip
```

Le zip contient :

- l'executable de l'application ;
- le dossier TP complet.

Quand l'export est termine, un message de succes apparait avec le chemin de l'archive et un bouton pour ouvrir le dossier parent.

## Recuperation de mot de passe

Le flux de recuperation utilise :

- `ADMIN_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM`
- `RESET_LINK_BASE_URL`

`web/reset.html` peut etre heberge sur un domaine public. Il transmet ensuite le token a l'application via le lien profond :

```text
tp-browser://reset?token=...
```

## Structure utile

```text
src/
  main.ts          Interface et logique frontend
  styles.css       Styles de l'application
  assets/          Logo et assets frontend

src-tauri/
  src/lib.rs       Commandes Tauri, scan, export, auth
  src/bin/         Utilitaires, dont hash_password
  tauri.conf.json  Configuration Tauri

web/
  reset.html       Page web de reinitialisation
```

## Notes

- Les zips importes sont consultables, mais leur arborescence est traitee en lecture seule.
- L'export eleve est prevu pour un dossier TP, pas pour une archive zip deja chargee.
- Les chemins et l'ordre manuel sont stockes dans les donnees locales de l'application.
