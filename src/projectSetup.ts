import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ControllerConfigWithPassword } from './controllerManager';

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
    },
    include: ['src'],
    exclude: ['build', 'web', 'static', 'node_modules'],
}, null, 2);

const GITIGNORE_ENTRIES = [
    'build/',
    'node_modules/',
    'src/**/*.d.ts',
    '.vscode/sftp.json',
];

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
        ];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`RumoAppDev: Created directory ${dir}`);
            }
        }
    }

    // ── tsconfig.json ────────────────────────────────────────────────────────

    public ensureTsConfig(workspaceRoot: string, silent = false): void {
        const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
        if (!fs.existsSync(tsconfigPath)) {
            fs.writeFileSync(tsconfigPath, TSCONFIG_CONTENT, 'utf8');
            if (!silent) {
                vscode.window.showInformationMessage('RumoAppDev: tsconfig.json generated.');
            }
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
    public generateSftpJson(
        workspaceRoot: string,
        controller: ControllerConfigWithPassword
    ): void {
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
            context: 'type/',
            watcher: {
                files: 'type/*',
                autoUpload: false,
                autoDelete: false,
            },
            uploadOnSave: true,
        };

        const sftpPath = path.join(vscodeDir, 'sftp.json');
        fs.writeFileSync(sftpPath, JSON.stringify(sftpConfig, null, 2), 'utf8');
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

    // ── Silent Auto-Init (called at extension startup) ────────────────────────

    /**
     * Silently ensures the basic project structure exists.
     * Does NOT prompt the user, does NOT generate sftp.json.
     * Called on every extension activation for any workspace.
     */
    public async silentInit(workspaceRoot: string): Promise<void> {
        this.ensureDirectories(workspaceRoot);
        this.ensureTsConfig(workspaceRoot, true);
        this.ensureGitIgnore(workspaceRoot, true);
    }

    // ── Full Project Setup (used by initProject wizard and switchController) ──

    /**
     * Sets up all project files for the given controller.
     * Generates sftp.json, extensions.json, updates launch.json.
     */
    public async setupProjectFiles(
        workspaceRoot: string,
        controller: ControllerConfigWithPassword,
        silent = false
    ): Promise<void> {
        this.ensureDirectories(workspaceRoot);
        this.ensureTsConfig(workspaceRoot, silent);
        this.ensureGitIgnore(workspaceRoot, silent);
        this.generateSftpJson(workspaceRoot, controller);
        this.ensureExtensionsJson(workspaceRoot, silent);
    }
}
