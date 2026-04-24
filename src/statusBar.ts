import * as vscode from 'vscode';

export class StatusBar {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.tooltip = 'Click to switch Rumo controller';
        this.updateNoProject();
        this.item.show();
    }

    /**
     * Shows the active controller name with connection status.
     */
    public update(controllerName: string | undefined): void {
        if (controllerName) {
            this.item.text = `$(server) ${controllerName}`;
            this.item.backgroundColor = undefined;
            this.item.command = 'rumo-app-dev-typescript.switchController';
            this.item.tooltip = 'Click to switch Rumo controller';
        } else {
            this.item.text = '$(server) No controller';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.item.command = 'rumo-app-dev-typescript.switchController';
            this.item.tooltip = 'No controller selected — click to select';
        }
    }

    /**
     * Shows connected state (green checkmark).
     */
    public setConnected(controllerName: string): void {
        this.item.text = `$(check) ${controllerName}`;
        this.item.backgroundColor = undefined;
        this.item.command = 'rumo-app-dev-typescript.switchController';
        this.item.tooltip = `Connected to ${controllerName} — click to switch`;
    }

    /**
     * Shows disconnected / unreachable state.
     */
    public setDisconnected(controllerName: string): void {
        this.item.text = `$(warning) ${controllerName} (offline)`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.item.command = 'rumo-app-dev-typescript.switchController';
        this.item.tooltip = `Cannot reach ${controllerName} — click to switch`;
    }

    /**
     * Shows a transient status message (e.g. uploading, restarting).
     */
    public setStatus(controllerName: string, message: string): void {
        this.item.text = `$(sync~spin) ${controllerName}: ${message}`;
        this.item.backgroundColor = undefined;
        this.item.tooltip = message;
    }

    /**
     * Shows "No project" state when rumo.config.json is not present.
     */
    public updateNoProject(): void {
        this.item.text = '$(server) No Rumo project';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.command = 'rumo-app-dev-typescript.initProject';
        this.item.tooltip = 'No Rumo project — click to initialize';
    }

    public dispose(): void {
        this.item.dispose();
    }
}
