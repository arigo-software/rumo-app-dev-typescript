import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TextEncoder } from 'util';
import { execSync } from 'child_process';
import { ControllerConfigWithPassword } from './controllerManager';

// ── Versioned rumo-app-instructions ────────────────────────────────────────
// Bump COPILOT_INSTRUCTIONS_VERSION whenever the content changes.
// The plugin will update the file in user projects if the version is outdated.
// File: .github/rumo-app-instructions.md (separate from user's copilot-instructions.md)
const COPILOT_INSTRUCTIONS_VERSION = '1';
const COPILOT_INSTRUCTIONS_VERSION_MARKER = `<!-- rumo-app-dev-instructions-version: ${COPILOT_INSTRUCTIONS_VERSION} -->`;
const RUMO_INSTRUCTIONS_FILENAME = 'rumo-app-instructions.md';
const CURSOR_RULES_FILENAME = 'rumo-app.md'; // written to .cursor/rules/

// Read the bundled rumo-app-instructions.md from the extension's resources folder
function getBundledCopilotInstructions(context: vscode.ExtensionContext): string {
    const resourcePath = path.join(context.extensionPath, 'resources', 'copilot-instructions.md');
    if (fs.existsSync(resourcePath)) {
        return fs.readFileSync(resourcePath, 'utf8');
    }
    return '';
}

// ── Templates ──────────────────────────────────────────────────────────────────

const TSCONFIG_CONTENT = JSON.stringify({
    compilerOptions: {
        target: 'ES2021',
        module: 'CommonJS',
        skipLibCheck: true,
        lib: ['es2021'],
        allowJs: false,
        sourceMap: true,
        baseUrl: 'src',
        ignoreDeprecations: '6.0',
        rootDir: 'src',
        outDir: 'build',
        esModuleInterop: true,
        importHelpers: true,
        forceConsistentCasingInFileNames: false,
        allowUnreachableCode: false,
        noEmitOnError: false,
        // typeRoots: both src/node_modules/@types (downloaded from controller)
        // and node_modules/@types (local devDependencies) are checked.
        // This makes @types/node and other ambient types available without imports.
        typeRoots: ['src/node_modules/@types', 'node_modules/@types'],
    },
    include: ['src'],
    exclude: ['build', 'web', 'static', 'node_modules'],
}, null, 2);

const GITIGNORE_ENTRIES = [
    'build/',
    'node_modules/',
    'src/**/*.d.ts',
    'src/node_modules/',   // downloaded from controller (version-specific)
    '.vscode/sftp.json',
];

const PACKAGE_JSON_CONTENT = JSON.stringify({
    name: 'rumo-app',
    version: '1.0.0',
    private: true,
    scripts: {
        build: 'tsc -p tsconfig.json',
        watch: 'tsc -p tsconfig.json --watch',
    },
    devDependencies: {
        typescript: '^5.0.0',
    },
}, null, 2);

const EXTENSIONS_JSON = JSON.stringify({
    recommendations: [
        'Natizyskunk.sftp',
    ],
}, null, 2);

// ── ProjectSetup ──────────────────────────────────────────────────────────────

export class ProjectSetup {

    // ── Directories ──────────────────────────────────────────────────────────

    public ensureDirectories(workspaceRoot: string): void {
        const dirs = [
            path.join(workspaceRoot, 'src', 'type'),
            path.join(workspaceRoot, 'build', 'type'),
            path.join(workspaceRoot, 'controller', 'type'),
        ];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`RumoAppDev: Created directory ${dir}`);
            }
        }
    }

    // ── package.json ─────────────────────────────────────────────────────────

    public async ensurePackageJson(workspaceRoot: string, silent = false): Promise<void> {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) { return; }

        fs.writeFileSync(pkgPath, PACKAGE_JSON_CONTENT, 'utf8');
        if (!silent) {
            vscode.window.showInformationMessage('RumoAppDev: package.json generated.');
        }

        // Run npm install to get typescript (and tsc) into node_modules
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'RumoAppDev: Installing TypeScript (npm install)…',
                cancellable: false,
            },
            async () => {
                try {
                    execSync('npm install', { cwd: workspaceRoot, stdio: 'ignore' });
                    if (!silent) {
                        vscode.window.showInformationMessage('RumoAppDev: TypeScript installed.');
                    }
                } catch (err) {
                    vscode.window.showErrorMessage(
                        `RumoAppDev: npm install failed: ${(err as Error).message}. Run "npm install" manually.`
                    );
                }
            }
        );
    }

    // ── tsconfig.json ────────────────────────────────────────────────────────

    /**
     * Writes tsconfig.json.
     *
     * If `archiveTsConfig` is provided (from the downloaded archive), it is used as the
     * base and the project-specific fields are merged on top.
     * Otherwise falls back to the built-in default template.
     *
     * Project-specific fields always set: baseUrl, rootDir, outDir, sourceMap, include, exclude
     */
    public ensureTsConfig(
        workspaceRoot: string,
        silent = false,
        archiveTsConfig?: Record<string, unknown>
    ): void {
        const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');

        let tsconfig: Record<string, unknown>;

        if (archiveTsConfig) {
            // Use archive tsconfig as base, merge project-specific fields on top
            const baseCompilerOptions = (archiveTsConfig['compilerOptions'] as Record<string, unknown>) ?? {};
            tsconfig = {
                ...archiveTsConfig,
                compilerOptions: {
                    ...baseCompilerOptions,
                    baseUrl: 'src',
                    rootDir: 'src',
                    outDir: 'build',
                    sourceMap: true,
                },
                include: ['src'],
                exclude: ['build', 'web', 'static', 'node_modules'],
            };
        } else {
            // Fallback: built-in default
            tsconfig = JSON.parse(TSCONFIG_CONTENT);
        }

        fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf8');
        if (!silent) {
            vscode.window.showInformationMessage('RumoAppDev: tsconfig.json generated.');
        }
    }

    // ── .gitignore ────────────────────────────────────────────────────────────

    public ensureGitIgnore(workspaceRoot: string, silent = false): void {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        let existing = '';

        if (fs.existsSync(gitignorePath)) {
            existing = fs.readFileSync(gitignorePath, 'utf8');
        }

        const lines = existing.split('\n').map(l => l.trim());
        const missingEntries = GITIGNORE_ENTRIES.filter(
            entry => !lines.includes(entry.trim())
        );

        if (missingEntries.length > 0) {
            const addition =
                (existing && !existing.endsWith('\n') ? '\n' : '') +
                missingEntries.join('\n') + '\n';
            fs.writeFileSync(gitignorePath, existing + addition, 'utf8');
            if (!silent) {
                vscode.window.showInformationMessage('RumoAppDev: .gitignore updated.');
            }
        }
    }

    // ── .vscode/sftp.json ─────────────────────────────────────────────────────

    /**
     * Generates (or overwrites) .vscode/sftp.json using the given controller credentials.
     * The password is written in plain text as required by the SFTP plugin.
     * This file must be listed in .gitignore!
     */
    public async generateSftpJson(
        workspaceRoot: string,
        controller: ControllerConfigWithPassword
    ): Promise<void> {
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }

        const sftpConfig = {
            name: controller.name,
            host: controller.host,
            protocol: 'sftp',
            port: controller.sshPort,
            username: controller.username,
            password: controller.password,
            remotePath: '/type/',
            context: 'controller/type/',
            watcher: {
                files: 'controller/type/*',
                autoUpload: false,
                autoDelete: false,
            },
            uploadOnSave: true,
        };

        const sftpPath = path.join(vscodeDir, 'sftp.json');
        const content = JSON.stringify(sftpConfig, null, 2);

        const uri = vscode.Uri.file(sftpPath);

        // Open the document first (before writing to disk) so VS Code tracks it
        let doc = await vscode.workspace.openTextDocument(uri).then(d => d, () => null as vscode.TextDocument | null);

        // Write file to disk
        fs.writeFileSync(sftpPath, content, 'utf8');

        // Apply the new content as an edit so VS Code marks the document dirty,
        // then save — this triggers onDidSaveTextDocument which the SFTP plugin uses
        // to reload its config (same as pressing Ctrl+S manually).
        if (!doc) {
            doc = await vscode.workspace.openTextDocument(uri);
        }
        const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        await editor.edit(editBuilder => {
            const fullRange = new vscode.Range(
                doc!.lineAt(0).range.start,
                doc!.lineAt(doc!.lineCount - 1).range.end
            );
            editBuilder.replace(fullRange, content);
        });
        await doc.save();

        console.log(`RumoAppDev: Generated .vscode/sftp.json for controller "${controller.name}"`);
    }

    // ── .vscode/extensions.json ───────────────────────────────────────────────

    public ensureExtensionsJson(workspaceRoot: string, silent = false): void {
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }

        const extensionsPath = path.join(vscodeDir, 'extensions.json');
        if (!fs.existsSync(extensionsPath)) {
            fs.writeFileSync(extensionsPath, EXTENSIONS_JSON, 'utf8');
            if (!silent) {
                vscode.window.showInformationMessage('RumoAppDev: .vscode/extensions.json created.');
            }
        } else {
            // Merge recommendation if not already present
            try {
                const raw = fs.readFileSync(extensionsPath, 'utf8');
                const existing = JSON.parse(raw) as { recommendations?: string[] };
                const recs: string[] = existing.recommendations ?? [];
                if (!recs.includes('Natizyskunk.sftp')) {
                    recs.push('Natizyskunk.sftp');
                    existing.recommendations = recs;
                    fs.writeFileSync(extensionsPath, JSON.stringify(existing, null, 2), 'utf8');
                }
            } catch {
                // If parse fails, overwrite
                fs.writeFileSync(extensionsPath, EXTENSIONS_JSON, 'utf8');
            }
        }
    }

    // ── .github/rumo-app-instructions.md ────────────────────────────────

    /**
     * Writes (or updates) .github/rumo-app-instructions.md in the user's project.
     * Uses a separate file so it doesn't conflict with the user's own copilot-instructions.md.
     * Copilot reads all .md files in .github/ automatically.
     * Only overwrites if the version marker indicates an outdated version.
     */
    public ensureCopilotInstructions(workspaceRoot: string, context: vscode.ExtensionContext, silent = false): void {
        const githubDir = path.join(workspaceRoot, '.github');
        const targetPath = path.join(githubDir, RUMO_INSTRUCTIONS_FILENAME);

        const bundledContent = getBundledCopilotInstructions(context);
        if (!bundledContent) { return; } // no bundled file — skip

        const bundledWithMarker = `${COPILOT_INSTRUCTIONS_VERSION_MARKER}\n${bundledContent}`;

        // Check existing version
        if (fs.existsSync(targetPath)) {
            const existing = fs.readFileSync(targetPath, 'utf8');
            const match = existing.match(/<!-- rumo-app-dev-instructions-version: (\d+) -->/);
            if (match) {
                const existingVersion = parseInt(match[1], 10);
                const currentVersion = parseInt(COPILOT_INSTRUCTIONS_VERSION, 10);
                if (existingVersion >= currentVersion) {
                    return; // already up to date
                }
                // Outdated — update
                if (!silent) {
                    vscode.window.showInformationMessage(
                        `RumoAppDev: Updating .github/${RUMO_INSTRUCTIONS_FILENAME} (v${existingVersion} → v${currentVersion})`
                    );
                }
            }
            // No version marker — don't overwrite (user-managed file)
            else {
                return;
            }
        }

        // Write new file
        if (!fs.existsSync(githubDir)) {
            fs.mkdirSync(githubDir, { recursive: true });
        }
        fs.writeFileSync(targetPath, bundledWithMarker, 'utf8');
        if (!silent) {
            vscode.window.showInformationMessage(`RumoAppDev: .github/${RUMO_INSTRUCTIONS_FILENAME} written.`);
        }

        // Also write to .cursor/rules/ for Cursor AI support
        this.ensureCursorRules(workspaceRoot, bundledWithMarker, silent);
    }

    /**
     * Writes (or updates) .cursor/rules/rumo-app.md for Cursor AI.
     * Uses the same versioned content as the Copilot instructions.
     */
    private ensureCursorRules(workspaceRoot: string, contentWithMarker: string, silent = false): void {
        const cursorRulesDir = path.join(workspaceRoot, '.cursor', 'rules');
        const targetPath = path.join(cursorRulesDir, CURSOR_RULES_FILENAME);

        // Check existing version
        if (fs.existsSync(targetPath)) {
            const existing = fs.readFileSync(targetPath, 'utf8');
            const match = existing.match(/<!-- rumo-app-dev-instructions-version: (\d+) -->/);
            if (match) {
                const existingVersion = parseInt(match[1], 10);
                const currentVersion = parseInt(COPILOT_INSTRUCTIONS_VERSION, 10);
                if (existingVersion >= currentVersion) { return; }
            } else {
                return; // user-managed file
            }
        }

        if (!fs.existsSync(cursorRulesDir)) {
            fs.mkdirSync(cursorRulesDir, { recursive: true });
        }
        fs.writeFileSync(targetPath, contentWithMarker, 'utf8');
        if (!silent) {
            vscode.window.showInformationMessage(`RumoAppDev: .cursor/rules/${CURSOR_RULES_FILENAME} written.`);
        }
    }

    // ── Silent Auto-Init (called at extension startup) ────────────────────────

    /**
     * Silently ensures the basic project structure exists.
     * Does NOT prompt the user, does NOT generate sftp.json.
     * Called on every extension activation for any workspace.
     */
    public async silentInit(workspaceRoot: string, context?: vscode.ExtensionContext): Promise<void> {
        this.ensureDirectories(workspaceRoot);
        this.ensureTsConfig(workspaceRoot, true);
        this.ensureGitIgnore(workspaceRoot, true);
        await this.ensurePackageJson(workspaceRoot, true);
        if (context) {
            this.ensureCopilotInstructions(workspaceRoot, context, true);
        }
    }

    // ── Full Project Setup (used by initProject wizard and switchController) ──

    /**
     * Sets up all project files for the given controller.
     * Generates sftp.json, extensions.json, updates launch.json.
     */
    public async setupProjectFiles(
        workspaceRoot: string,
        controller: ControllerConfigWithPassword,
        silent = false,
        archiveTsConfig?: Record<string, unknown>,
        context?: vscode.ExtensionContext
    ): Promise<void> {
        this.ensureDirectories(workspaceRoot);
        await this.ensurePackageJson(workspaceRoot, silent);
        this.ensureTsConfig(workspaceRoot, silent, archiveTsConfig);
        this.ensureGitIgnore(workspaceRoot, silent);
        await this.generateSftpJson(workspaceRoot, controller);
        this.ensureExtensionsJson(workspaceRoot, silent);
        if (context) {
            this.ensureCopilotInstructions(workspaceRoot, context, silent);
        }
    }
}
