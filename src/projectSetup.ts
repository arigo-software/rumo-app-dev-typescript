import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const TSCONFIG_CONTENT = JSON.stringify({
    compilerOptions: {
        target: 'ES2021',
        module: 'CommonJS',
        skipLibCheck: true,
        lib: ['es2021'],
        allowJs: false,
        sourceMap: true,
        baseUrl: 'src',
        rootDir: 'src',
        outDir: 'build',
        esModuleInterop: true,
        importHelpers: true,
        forceConsistentCasingInFileNames: false,
        noImplicitThis: true,
        strictFunctionTypes: true,
        strictNullChecks: false,
        noPropertyAccessFromIndexSignature: false,
        allowUnreachableCode: false,
    },
    include: ['src'],
    exclude: ['build', 'web', 'static', 'node_modules'],
}, null, 2);

const GITIGNORE_ENTRIES = [
    'build/',
    'node_modules/',
    'src/**/*.d.ts',
];

export class ProjectSetup {
    /**
     * Runs the full project initialisation:
     * - Creates required directories
     * - Generates tsconfig.json (if absent)
     * - Generates / updates .gitignore
     */
    public async initProject(workspaceRoot: string, silent = false): Promise<void> {
        this.ensureDirectories(workspaceRoot);
        this.ensureTsConfig(workspaceRoot, silent);
        this.ensureGitIgnore(workspaceRoot, silent);

        if (!silent) {
            vscode.window.showInformationMessage('RumoAppDev: Project initialised successfully.');
        }
    }

    private ensureDirectories(workspaceRoot: string): void {
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

    private ensureTsConfig(workspaceRoot: string, silent: boolean): void {
        const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
        if (!fs.existsSync(tsconfigPath)) {
            fs.writeFileSync(tsconfigPath, TSCONFIG_CONTENT, 'utf8');
            if (!silent) {
                vscode.window.showInformationMessage('RumoAppDev: tsconfig.json generated.');
            }
        }
    }

    private ensureGitIgnore(workspaceRoot: string, silent: boolean): void {
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        let existing = '';

        if (fs.existsSync(gitignorePath)) {
            existing = fs.readFileSync(gitignorePath, 'utf8');
        }

        const missingEntries = GITIGNORE_ENTRIES.filter(entry => {
            // Check if the entry is already present (as a full line)
            const lines = existing.split('\n').map(l => l.trim());
            return !lines.includes(entry.trim());
        });

        if (missingEntries.length > 0) {
            const addition = (existing && !existing.endsWith('\n') ? '\n' : '')
                + missingEntries.join('\n') + '\n';
            fs.writeFileSync(gitignorePath, existing + addition, 'utf8');
            if (!silent) {
                vscode.window.showInformationMessage('RumoAppDev: .gitignore updated.');
            }
        }
    }
}
