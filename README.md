
## Description de l'app

TP Browser est un lecteur de TP Scenari conçu pour une utilisation au lycée du Vimeu. L'application Tauri permet de parcourir un dossier de TP, d'afficher une arborescence de fichiers et de prévisualiser les contenus HTML via un aperçu intégré. Elle propose un mode lecture seule pour consulter les fichiers déjà chargés (Vue Eleve), et un mode admin (authentification pour Prof) pour importer des dossiers/zips et gérer les fichiers (création, renommage, suppression, déplacement).

## Connexion admin (fichier .env)

L'accès aux actions de gestion (import/CRUD) se fait via un compte admin défini dans un fichier `.env` local.

1. Copie le fichier `.env.example` en `.env`.
2. Renseigne `ADMIN_USERNAME`.
3. Génère un hash Argon2 pour le mot de passe et colle-le dans `ADMIN_PASSWORD_HASH`.

Un petit utilitaire est fourni pour générer le hash : `src-tauri/src/bin/hash_password.rs`.

> ⚠️ Le fichier `.env` est ignoré par git et reste local.

## Changer le mot de passe admin

Pour changer le mot de passe :

1. Génère un nouveau hash Argon2 avec l'utilitaire fourni.
2. Mets à jour `ADMIN_PASSWORD_HASH` dans le fichier `.env`.

Exemple (commande à lancer depuis `src-tauri`) :

```bash
cargo run --bin hash_password -- "nouveau_mot_de_passe"
```

Copie la valeur affichée dans `ADMIN_PASSWORD_HASH` du `.env`. Le changement est pris en compte au prochain lancement de l'app.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
