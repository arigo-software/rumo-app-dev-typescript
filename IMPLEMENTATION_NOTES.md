# IMPLEMENTATION_NOTES.md — Rumo App Dev VS Code Extension

## Übersicht

VS Code Plugin für die TypeScript App-Entwicklung auf ARIGO Rumo-Steuerungen.

- **Repository:** [arigo-software/rumo-app-dev-typescript](https://github.com/arigo-software/rumo-app-dev-typescript)
- **Releases:** [GitHub Releases](https://github.com/arigo-software/rumo-app-dev-typescript/releases) (aktuelle `.vsix` zum Download)
- **Kompiliert sauber:** Ja (`tsc` exit 0, keine Fehler/Warnings)

---

## Dateistruktur

```
rumo-app-dev/
├── src/
│   ├── extension.ts          # Haupt-Einstiegspunkt, Commands, Aktivierungslogik
│   ├── controllerManager.ts  # Steuerungsverwaltung: Settings + SecretStorage + rumo.config.json
│   ├── sftpSync.ts           # SFTP-Upload (ssh2-sftp-client) mit Auto-Reconnect
│   ├── typeDownloader.ts     # d.ts-Download via SFTP + Versions-Abfrage per HTTPS
│   ├── projectSetup.ts       # Projektdateien erzeugen (sftp.json, tsconfig, .gitignore, ...)
│   ├── debugConfig.ts        # launch.json generieren/aktualisieren
│   ├── statusBar.ts          # Status Bar Item (unten links)
│   └── test/
│       └── extension.test.ts
├── resources/
│   └── icon.png
├── package.json
├── tsconfig.json
└── .vscodeignore
```

---

## Implementierte Features (nach Refaktoring v2)

### 1. Globale Steuerungsverwaltung (`controllerManager.ts`)

**User Settings (global, kein Passwort):**
```json
{
  "rumoAppDev.controllers": [
    { "name": "Büro", "host": "192.168.1.100", "sshPort": 22, "httpsPort": 443, "username": "admin" }
  ]
}
```

**SecretStorage:** Passwörter unter Key `rumoAppDev.password.<controllername>`

- `savePassword(name, password)` → `context.secrets.store(...)`
- `getPassword(name)` → `context.secrets.get(...)`
- `getActiveControllerWithPassword(workspaceRoot)` → kombiniert Settings + SecretStorage
- `promptAddController()`: Passwort via `showInputBox({ password: true })`, dann in SecretStorage
- `promptSwitchController()`: QuickPick aus globalen Settings (kein Passwort sichtbar)
- `addController()`: speichert in **Global** Settings (kein Passwort)

### 2. Lokale Projekt-Konfiguration

`rumo.config.json` im Projekt-Root:
```json
{ "activeController": "Büro" }
```
- Nur der Name der aktiven Steuerung — commitbar (kein Passwort)
- Gelesen/geschrieben von `ControllerManager.getActiveControllerName()` / `setActiveControllerName()`
- File Watcher: Plugin aktiviert sich, wenn die Datei angelegt wird

### 3. Plugin-Aktivierung nur bei Rumo-Projekt

In `extension.ts`:
- Beim Start: prüfe ob `rumo.config.json` vorhanden
- **Ja** → SFTP-Sync aktivieren, d.ts prüfen/downloaden, Status Bar mit Controller-Name
- **Nein** → Status Bar zeigt "No Rumo project" + Hinweis auf `initProject`, kein Auto-Setup
- File Watcher auf `rumo.config.json` → bei Anlegen aktiviert sich das Plugin automatisch

### 4. SFTP-Plugin Integration

**package.json:**
```json
{ "extensionDependencies": ["Natizyskunk.sftp"] }
```

**`projectSetup.generateSftpJson()`** erzeugt `.vscode/sftp.json`:
```json
{
  "name": "<controller-name>",
  "host": "<host>",
  "protocol": "sftp",
  "port": 22,
  "username": "<username>",
  "password": "<password>",
  "remotePath": "/type/",
  "context": "type/",
  "watcher": { "files": "type/*", "autoUpload": false, "autoDelete": false },
  "uploadOnSave": true
}
```
- Passwort aus SecretStorage zur Laufzeit gelesen
- `sftp.json` ist in `.gitignore` (Passwort im Klartext für SFTP-Plugin-Kompatibilität)

### 5. Initialize Project Wizard (`rumo-app-dev.initProject`)

1. Prüfe ob `rumo.config.json` vorhanden → Warnung + Bestätigung
2. Steuerung auswählen (QuickPick) oder neu anlegen
3. Legt an: `src/type/`, `build/type/`, `tsconfig.json`, `.gitignore`, `rumo.config.json`,
   `.vscode/sftp.json`, `.vscode/launch.json`, `.vscode/extensions.json`
4. d.ts Download starten
5. SFTP-Verbindung aufbauen
6. Erfolgsmeldung

### 6. Steuerungswechsel (`rumo-app-dev.switchController`)

1. QuickPick aus globalen Steuerungen
2. `rumo.config.json` aktualisieren
3. `.vscode/sftp.json` aktualisieren (Passwort aus SecretStorage)
4. `.vscode/launch.json` aktualisieren
5. d.ts neu downloaden
6. Status Bar aktualisieren
7. SFTP-Verbindung neu aufbauen

### 7. Restliche Features (unverändert)

- **SFTP Auto-Upload** (`sftpSync.ts`): File Watcher auf `build/type/`, Debounce 800ms, Auto-Reconnect
- **d.ts Download** (`typeDownloader.ts`): SFTP von `/user/dts/`, Versions-Caching im workspaceState
- **Debug-Konfiguration** (`debugConfig.ts`): `launch.json` mit versionsabhängigem `remoteRoot`
- **Status Bar** (`statusBar.ts`): `$(server) <Name>` / `$(server) No controller` / `$(server) No Rumo project`

---

## Automatische Abläufe

### Beim Plugin-Start (Workspace mit `rumo.config.json`)
1. `projectSetup.silentInit()` — Verzeichnisse, tsconfig, .gitignore still
2. Aktive Steuerung aus `rumo.config.json` + Settings laden (Passwort aus SecretStorage)
3. Status Bar aktualisieren
4. SFTP-Verbindung herstellen
5. Controller-Version per HTTPS abfragen
6. Wenn Version != gecachte Version → d.ts Download
7. `launch.json` aktualisieren

### Beim Plugin-Start (Workspace ohne `rumo.config.json`)
1. Status Bar: "No Rumo project" mit `initProject`-Klick-Aktion
2. Kein SFTP, kein d.ts Download

### Bei `rumo.config.json`-Änderung oder VS Code Settings-Änderung
→ Schritt 2–7 wiederholen

---

## Design-Entscheidungen

- **SecretStorage für Passwörter**: Kein Klartext in VS Code Settings (global oder workspace)
- **rumo.config.json ist commitbar**: Nur der Controller-Name, keine Credentials
- **Zwei SFTP-Mechanismen**: `SftpSync` (intern, ssh2-sftp-client) für Auto-Upload bei Dateiänderung;
  SFTP-Plugin (Natizyskunk.sftp) für manuelle Sync-Aktionen via `.vscode/sftp.json`
- **extensionDependencies**: Stellt sicher, dass das SFTP-Plugin mitinstalliert wird
- **Bedingtes Aktivieren**: Kein Lärm in Workspaces ohne `rumo.config.json`
- **Global vs. Workspace Settings**: Controller-Liste global (geräteweit), aktiver Controller lokal

---

## Build

```bash
cd /home/agent/.openclaw/workspace/projects/rumo-app-dev
npm install
npm run compile   # → out/
```

Keine Compiler-Fehler oder Warnungen.
