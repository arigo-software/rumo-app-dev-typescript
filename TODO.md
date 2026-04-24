# rumo-app-dev Plugin — TODO

## Offen

- [ ] **Doku: Deploy to Controller** — Beschreibung korrigieren: Deploy passiert automatisch durch das Plugin selbst (kompilierte Daten → Controller), nicht SFTP-Plugin
- [ ] **Doku: App in Projekteditor einfügen** — beschreiben wie eine neue App in den Projekteditor eingefügt wird
- [ ] **Plugin: DTS + tsconfig auf Steuerung speichern** — `.d.ts` Dateien und `tsconfig.json` auf dem Controller ablegen (nicht nur lokal)
- [ ] **Plugin: tsconfig hochladen** — beim Deploy auch `tsconfig.json` auf den Controller hochladen (implementieren)
- [ ] **Doku + Plugin: neuer Subscription Manager** — ersetzt `autil.Subscriptions` (alt bleibt deprecated); in arigo-app-framework.md beschreiben + in Boilerplate-Code einfügen
- [ ] **Doku: Installationsbeschreibung anpassen** — arigo-app-development.md: Installationsschritte für das Plugin aktualisieren
- [ ] **Plugin: ESLint** — ESLint-Konfiguration für Rumo-App-Projekte einrichten/mitliefern
- [ ] **Sammeln läuft noch** — Simon sammelt weitere Punkte zu arigo-app-development.md

## Wenn alle Todos erledigt: Release 1.0

- [ ] **Version auf 1.0.0 setzen** (oder 1.x.x)
- [ ] **Versionshistorie im README bereinigen** — alte Pre-1.0 Einträge entfernen, History beginnt bei v1.0.0

- [ ] **Plugin: KI-Anweisungen für VS Code** — beim Init Project automatisch `.github/copilot-instructions.md` ins Projektverzeichnis schreiben mit Beschreibung wie Rumo-Apps programmiert werden (AppDefinition, AppInstance, Hooks, Typen etc.) — unterstützt Copilot/Cursor/etc. beim App-Development

## Später / Future Release

- [ ] **Plugin: Device Schema Editor** — Editor für Device Schemas im Plugin integrieren
- [ ] **Plugin: App automatisch in Projekteditor einfügen** — beim Erstellen einer neuen App diese automatisch in den Projekteditor eintragen

## Erledigt

- [x] `type/` → `controller/type/` im Workspace (v0.31.0)
- [x] README + arigo-app-development.md angepasst
- [x] Falsche Command Palette Commands entfernt (Rumo: Build, Deploy, Attach Debugger)
- [x] Deploy/Debug Workflow korrekt dokumentiert (SFTP-Plugin + Standard VS Code Debug)
