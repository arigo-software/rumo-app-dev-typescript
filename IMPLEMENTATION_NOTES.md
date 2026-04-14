# IMPLEMENTATION_NOTES.md — Rumo App Dev VS Code Extension

## Übersicht

Vollständig implementiertes VS Code Plugin für die TypeScript App-Entwicklung auf ARIGO Rumo-Steuerungen.

- **Plugin-Verzeichnis:** `/home/agent/.openclaw/workspace/projects/rumo-app-dev/`
- **Basis (Referenz-Code):** `/home/agent/.openclaw/workspace/projects/arigo-vscode-plugin-src/rumo-app-dev-main/`
- **Kompiliert sauber:** Ja (`tsc` exit 0, keine Fehler/Warnings)

---

## Dateistruktur

```
rumo-app-dev/
├── src/
│   ├── extension.ts          # Haupt-Einstiegspunkt, Command-Registrierung, Wiring
│   ├── controllerManager.ts  # Steuerungsverwaltung (Settings lesen/schreiben, QuickPick/InputBox)
│   ├── sftpSync.ts           # SFTP-Upload mit Auto-Reconnect
│   ├── typeDownloader.ts     # d.ts-Download via SFTP + Versions-Abfrage per HTTPS
│   ├── projectSetup.ts       # tsconfig.json + .gitignore + Verzeichnisse anlegen
│   ├── debugConfig.ts        # launch.json generieren/aktualisieren
│   ├── statusBar.ts          # Status Bar Item (unten links)
│   └── test/
│       └── extension.test.ts # Minimal-Test-Suite
├── resources/
│   └── icon.png              # Kopiert vom Quell-Plugin
├── package.json
├── tsconfig.json             # Für den Plugin-Code selbst (target ES2022, module Node16)
└── .vscodeignore
```

---

## Implementierte Features

### 1. Steuerungsverwaltung (`controllerManager.ts`)
- Liest/schreibt `rumoAppDev.controllers` und `rumoAppDev.activeController` aus VS Code Workspace Settings
- `promptSwitchController()`: QuickPick mit allen Steuerungen + "Add new"
- `promptAddController()`: Sequentielle InputBox-Abfragen (Name, Host, SSH-Port, HTTPS-Port, Username, Password)

### 2. Auto-Setup (`projectSetup.ts`)
Wird beim Aktivieren **still** (ohne Meldungen) ausgeführt, wenn Dateien bereits vorhanden:
- Legt `src/type/`, `build/type/`, `types/` an (falls nicht vorhanden)
- Generiert `tsconfig.json` mit den vorgegebenen Compiler-Optionen (nur wenn nicht vorhanden)
- Ergänzt `.gitignore` um fehlende Einträge

### 3. d.ts Download (`typeDownloader.ts`)
- SFTP-Download von `/user/dts/` (rekursiv) → `types/` im Workspace
- Versionsprüfung via HTTPS GET `https://<host>:<httpsPort>/~/dev/0/fb/Setup/dp/version/dat/value`
  - Basic Auth, `rejectUnauthorized: false`
- Version wird in `workspaceState` gecacht (Key: `rumoAppDev.cachedVersion.<controllerName>`)
- Download nur bei Versionsänderung (automatisch) oder per Command (immer)
- VS Code Progress-Notification während Download

### 4. SFTP Upload (`sftpSync.ts`)
- Konfiguration kommt **aus VS Code Settings** (`rumoAppDev.controllers`), nicht aus `sftp.json`
- File Watcher auf `build/type/**/*.{js,js.map}` (VS Code `createFileSystemWatcher`)
- Debounce 800ms vor Upload (verhindert mehrfache Uploads bei schnellen Saves)
- `uploadAllFiles()`: alle `.js`/`.js.map` aus `build/type/` mit Progress-Notification
- Remote-Ziel: `/type/<relative-path>` (spiegelt Unterverzeichnisstruktur)
- Auto-Reconnect: bis zu 3 Versuche mit 3s Delay

### 5. Debug-Konfiguration (`debugConfig.ts`)
Generiert/aktualisiert `.vscode/launch.json`:
- `remoteRoot`: `/usr/lib/arigo/rumo/rumo_<VERSION>`
- `sourceMapPathOverrides`: `/usr/lib/arigo/rumo/rumo_<VERSION>/type/*` → `${workspaceFolder}/src/type/*`
- Behält bestehende Konfigurationen (anderer Name) bei, ersetzt nur den Eintrag mit gleichem Namen

### 6. Status Bar (`statusBar.ts`)
- Zeigt `$(server) <Controller-Name>` oder `$(server) No controller`
- Gelber Hintergrund wenn keine Steuerung konfiguriert
- Klick → `rumo-app-dev.switchController`

### 7. Commands
| Command | Titel |
|---------|-------|
| `rumo-app-dev.uploadAllFiles` | RumoAppDev: Upload All JavaScript Files |
| `rumo-app-dev.downloadTypeDefs` | RumoAppDev: Download Type Definitions |
| `rumo-app-dev.switchController` | RumoAppDev: Switch Controller |
| `rumo-app-dev.addController` | RumoAppDev: Add Controller |
| `rumo-app-dev.initProject` | RumoAppDev: Initialize Project |

---

## Automatische Abläufe beim Plugin-Start

1. Auto-Setup (Verzeichnisse, tsconfig, .gitignore) — still
2. Aktive Steuerung aus Settings laden
3. Status Bar aktualisieren
4. SFTP-Verbindung herstellen
5. Controller-Version per HTTPS abfragen
6. Wenn Version != gecachte Version → d.ts Download
7. `launch.json` aktualisieren

Bei **Steuerungswechsel** (Settings-Änderung) wird Schritt 3–7 wiederholt.

---

## Wichtige Design-Entscheidungen

- **Keine sftp.json**: SFTP-Konfiguration kommt ausschließlich aus VS Code Settings
- **typeRoots in tsconfig**: `./types` vor `./node_modules/@types` — d.ts files werden automatisch von TypeScript gefunden
- **Version-Caching pro Controller-Name**: `workspaceState` (persistent, Workspace-spezifisch)
- **Debounce beim File Watch**: 800ms verhindert Upload-Sturmfluten beim `tsc --watch`
- **Strict TypeScript für Plugin-Code**: `"strict": true` in Plugin-eigenem `tsconfig.json`
- **rejectUnauthorized: false**: Für selbstsignierte Zertifikate auf der Steuerung

---

## Bekannte Einschränkungen / TODOs

- **tsc --watch Task**: Nicht als VS Code Task Provider registriert (kann der Nutzer manuell über das Terminal starten oder in `.vscode/tasks.json` konfigurieren)
- **Password im Klartext**: VS Code Settings speichern das Passwort im Klartext. Für Produktion wäre SecretStorage (VS Code 1.80+) besser — aber das sprengt den aktuellen Scope
- **Tests**: Nur Minimal-Test vorhanden (kein Workspace vorhanden in CI-Umgebung)

---

## Build

```bash
cd /home/agent/.openclaw/workspace/projects/rumo-app-dev
npm install
npm run compile   # → out/
```

Keine Compiler-Fehler oder Warnungen.
