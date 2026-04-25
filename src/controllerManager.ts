import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ── Interfaces ─────────────────────────────────────────────────────────────────

/** Controller configuration stored in global (user) VS Code settings — no password. */
export interface ControllerConfig {
    name: string;
    host: string;
    sshPort: number;
    httpsPort: number;
    username: string;
}

/** Full controller config including the password retrieved from SecretStorage. */
export interface ControllerConfigWithPassword extends ControllerConfig {
    password: string;
}

interface RumoProjectConfig {
    activeController: string;
}

// ── ControllerManager ──────────────────────────────────────────────────────────

export class ControllerManager {
    private static readonly CONFIG_KEY = 'rumoAppDevTypescript';
    private static readonly SECRET_PREFIX = 'rumoAppDevTypescript.password.';

    constructor(private readonly context: vscode.ExtensionContext) {}

    // ── SecretStorage ──────────────────────────────────────────────────────────

    public async savePassword(name: string, password: string): Promise<void> {
        await this.context.secrets.store(
            `${ControllerManager.SECRET_PREFIX}${name}`,
            password
        );
    }

    public async getPassword(name: string): Promise<string | undefined> {
        return this.context.secrets.get(
            `${ControllerManager.SECRET_PREFIX}${name}`
        );
    }

    // ── Global Controllers (User Settings) ────────────────────────────────────

    /**
     * Returns all controllers from global (user) VS Code settings.
     * Passwords are NOT included here; retrieve them via getPassword().
     */
    public getControllers(): ControllerConfig[] {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const raw = config.get<any[]>('controllers') ?? [];
        return raw.map(c => ({
            name: String(c.name ?? ''),
            host: String(c.host ?? ''),
            sshPort: Number(c.sshPort) || 22,
            httpsPort: Number(c.httpsPort) || 443,
            username: String(c.username ?? ''),
        }));
    }

    /**
     * Saves a controller to global (user) settings.
     * Password is NOT stored here — use savePassword() separately.
     */
    public async addController(controller: ControllerConfig): Promise<void> {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const existing = this.getControllers();
        const updated = [...existing.filter(c => c.name !== controller.name), controller];
        await config.update('controllers', updated, vscode.ConfigurationTarget.Global);
    }

    // ── Local Project Config (rumo.config.json) ───────────────────────────────

    /**
     * Returns the name of the active controller from rumo.config.json, or undefined.
     */
    public getActiveControllerName(workspaceRoot: string): string | undefined {
        const configPath = path.join(workspaceRoot, 'rumo.config.json');
        if (!fs.existsSync(configPath)) {
            return undefined;
        }
        try {
            const raw = fs.readFileSync(configPath, 'utf8');
            const cfg = JSON.parse(raw) as RumoProjectConfig;
            return cfg.activeController || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Writes the active controller name to rumo.config.json.
     */
    public setActiveControllerName(workspaceRoot: string, name: string): void {
        const configPath = path.join(workspaceRoot, 'rumo.config.json');
        const cfg: RumoProjectConfig = { activeController: name };
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }

    /**
     * Returns true if the workspace contains a rumo.config.json (= is a Rumo project).
     */
    public isRumoProject(workspaceRoot: string): boolean {
        return fs.existsSync(path.join(workspaceRoot, 'rumo.config.json'));
    }

    // ── Active Controller ──────────────────────────────────────────────────────

    /**
     * Returns the active controller config (without password) by reading rumo.config.json
     * and looking up the controller in global settings.
     */
    public getActiveController(workspaceRoot: string): ControllerConfig | undefined {
        const activeName = this.getActiveControllerName(workspaceRoot);
        if (!activeName) { return undefined; }
        return this.getControllers().find(c => c.name === activeName);
    }

    /**
     * Returns the active controller including its password from SecretStorage.
     */
    public async getActiveControllerWithPassword(
        workspaceRoot: string
    ): Promise<ControllerConfigWithPassword | undefined> {
        const controller = this.getActiveController(workspaceRoot);
        if (!controller) { return undefined; }
        const password = (await this.getPassword(controller.name)) ?? '';
        return { ...controller, password };
    }

    // ── Prompts ────────────────────────────────────────────────────────────────

    /**
     * Interactive wizard to add a new controller.
     * Saves credentials to global settings + SecretStorage.
     * Returns the full controller (including password), or undefined if cancelled.
     */
    public async promptAddController(): Promise<ControllerConfigWithPassword | undefined> {
        const name = await vscode.window.showInputBox({
            prompt: 'Controller name (e.g. "Büro")',
            ignoreFocusOut: true,
        });
        if (!name) { return undefined; }

        const host = await vscode.window.showInputBox({
            prompt: 'Controller IP address or hostname',
            ignoreFocusOut: true,
        });
        if (!host) { return undefined; }

        const sshPortStr = await vscode.window.showInputBox({
            prompt: 'SSH port',
            value: '22',
            ignoreFocusOut: true,
        });
        if (!sshPortStr) { return undefined; }

        const httpsPortStr = await vscode.window.showInputBox({
            prompt: 'HTTPS port (for version API)',
            value: '443',
            ignoreFocusOut: true,
        });
        if (!httpsPortStr) { return undefined; }

        const username = await vscode.window.showInputBox({
            prompt: 'SSH username',
            value: 'admin',
            ignoreFocusOut: true,
        });
        if (!username) { return undefined; }

        const password = await vscode.window.showInputBox({
            prompt: 'SSH password',
            password: true,
            ignoreFocusOut: true,
        });
        if (password === undefined) { return undefined; }

        const controller: ControllerConfig = {
            name,
            host,
            sshPort: parseInt(sshPortStr, 10) || 22,
            httpsPort: parseInt(httpsPortStr, 10) || 443,
            username,
        };

        // Save to global settings (no password)
        await this.addController(controller);

        // Save password to SecretStorage
        await this.savePassword(name, password);

        return { ...controller, password };
    }

    /**
     * Removes a controller from global settings and deletes its password from SecretStorage.
     */
    public async removeController(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const existing = this.getControllers();
        const updated = existing.filter(c => c.name !== name);
        await config.update('controllers', updated, vscode.ConfigurationTarget.Global);
        await this.context.secrets.delete(`${ControllerManager.SECRET_PREFIX}${name}`);
    }

    /**
     * Interactive wizard to edit an existing controller.
     * Pre-fills all fields with current values.
     * Returns the updated controller (including password), or undefined if cancelled.
     */
    public async promptEditController(existing: ControllerConfig): Promise<ControllerConfigWithPassword | undefined> {
        const currentPassword = (await this.getPassword(existing.name)) ?? '';

        const name = await vscode.window.showInputBox({
            prompt: 'Controller name',
            value: existing.name,
            ignoreFocusOut: true,
        });
        if (!name) { return undefined; }

        const host = await vscode.window.showInputBox({
            prompt: 'Controller IP address or hostname',
            value: existing.host,
            ignoreFocusOut: true,
        });
        if (!host) { return undefined; }

        const sshPortStr = await vscode.window.showInputBox({
            prompt: 'SSH port',
            value: String(existing.sshPort),
            ignoreFocusOut: true,
        });
        if (!sshPortStr) { return undefined; }

        const httpsPortStr = await vscode.window.showInputBox({
            prompt: 'HTTPS port (for version API)',
            value: String(existing.httpsPort),
            ignoreFocusOut: true,
        });
        if (!httpsPortStr) { return undefined; }

        const username = await vscode.window.showInputBox({
            prompt: 'SSH username',
            value: existing.username,
            ignoreFocusOut: true,
        });
        if (!username) { return undefined; }

        const password = await vscode.window.showInputBox({
            prompt: 'SSH password (leave empty to keep current)',
            password: true,
            ignoreFocusOut: true,
            placeHolder: currentPassword ? '(unchanged)' : '',
        });
        if (password === undefined) { return undefined; }

        const updatedController: ControllerConfig = {
            name,
            host,
            sshPort: parseInt(sshPortStr, 10) || 22,
            httpsPort: parseInt(httpsPortStr, 10) || 443,
            username,
        };

        // If name changed, remove old entry + old password
        if (name !== existing.name) {
            await this.removeController(existing.name);
        }

        await this.addController(updatedController);

        const finalPassword = password || currentPassword;
        await this.savePassword(name, finalPassword);

        return { ...updatedController, password: finalPassword };
    }

    /**
     * Interactive wizard to select and delete a controller.
     * Returns the deleted controller name, or undefined if cancelled.
     */
    public async promptDeleteController(): Promise<string | undefined> {
        const controllers = this.getControllers();
        if (controllers.length === 0) {
            vscode.window.showWarningMessage('No controllers configured.');
            return undefined;
        }

        const items: vscode.QuickPickItem[] = controllers.map(c => ({
            label: c.name,
            description: `${c.host}:${c.sshPort}`,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a controller to delete',
        });
        if (!selected) { return undefined; }

        const confirm = await vscode.window.showWarningMessage(
            `Delete controller "${selected.label}"? This cannot be undone.`,
            { modal: true },
            'Delete'
        );
        if (confirm !== 'Delete') { return undefined; }

        await this.removeController(selected.label);
        return selected.label;
    }

    /**
     * QuickPick to select a controller from the global settings list.
     * Returns the selected controller name, '__ADD_NEW__', or undefined if cancelled.
     */
    public async promptSwitchController(): Promise<string | undefined> {
        const controllers = this.getControllers();
        if (controllers.length === 0) {
            const addNew = await vscode.window.showWarningMessage(
                'No controllers configured. Would you like to add one?',
                'Add Controller', 'Cancel'
            );
            if (addNew === 'Add Controller') {
                return '__ADD_NEW__';
            }
            return undefined;
        }

        const items: vscode.QuickPickItem[] = controllers.map(c => ({
            label: c.name,
            description: `${c.host}:${c.sshPort}`,
        }));

        items.push({ label: '$(add) Add new controller...', description: '' });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Rumo controller',
        });

        if (!selected) { return undefined; }
        if (selected.label === '$(add) Add new controller...') {
            return '__ADD_NEW__';
        }
        return selected.label;
    }
}
