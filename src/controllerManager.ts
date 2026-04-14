import * as vscode from 'vscode';

export interface ControllerConfig {
    name: string;
    host: string;
    sshPort: number;
    httpsPort: number;
    username: string;
    password: string;
}

export class ControllerManager {
    private static readonly CONFIG_KEY = 'rumoAppDev';

    /**
     * Returns all configured controllers from VS Code workspace/user settings.
     */
    public getControllers(): ControllerConfig[] {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const raw = config.get<ControllerConfig[]>('controllers') ?? [];
        return raw.map(c => ({
            name: c.name,
            host: c.host,
            sshPort: c.sshPort ?? 22,
            httpsPort: c.httpsPort ?? 443,
            username: c.username,
            password: c.password,
        }));
    }

    /**
     * Returns the currently active controller, or undefined if none is set.
     */
    public getActiveController(): ControllerConfig | undefined {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const activeName = config.get<string>('activeController') ?? '';
        if (!activeName) {
            return undefined;
        }
        return this.getControllers().find(c => c.name === activeName);
    }

    /**
     * Sets the active controller by name (in workspace settings).
     */
    public async setActiveController(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        await config.update('activeController', name, vscode.ConfigurationTarget.Workspace);
    }

    /**
     * Adds a new controller to the workspace settings.
     */
    public async addController(controller: ControllerConfig): Promise<void> {
        const config = vscode.workspace.getConfiguration(ControllerManager.CONFIG_KEY);
        const existing = this.getControllers();
        const updated = [...existing.filter(c => c.name !== controller.name), controller];
        await config.update('controllers', updated, vscode.ConfigurationTarget.Workspace);
    }

    /**
     * Interactive prompt to add a new controller via VS Code input boxes.
     * Returns the new controller config, or undefined if the user cancelled.
     */
    public async promptAddController(): Promise<ControllerConfig | undefined> {
        const name = await vscode.window.showInputBox({
            prompt: 'Controller name (e.g. "My Rumo Controller")',
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

        return {
            name,
            host,
            sshPort: parseInt(sshPortStr, 10) || 22,
            httpsPort: parseInt(httpsPortStr, 10) || 443,
            username,
            password,
        };
    }

    /**
     * Interactive QuickPick to select a controller from the list.
     * Returns the selected controller name, or undefined if the user cancelled.
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

        const active = this.getActiveController();
        const items: vscode.QuickPickItem[] = controllers.map(c => ({
            label: c.name,
            description: `${c.host}:${c.sshPort}`,
            detail: c.name === active?.name ? '$(check) Active' : undefined,
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
