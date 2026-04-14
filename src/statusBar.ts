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
     * Shows the active controller name.
     */
    public update(controllerName: string | undefined): void {
        if (controllerName) {
            this.item.text = `$(server) ${controllerName}`;
            this.item.backgroundColor = undefined;
            this.item.command = 'rumo-app-dev.switchController';
            this.item.tooltip = 'Click to switch Rumo controller';
        } else {
            this.item.text = '$(server) No controller';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.item.command = 'rumo-app-dev.switchController';
            this.item.tooltip = 'No controller selected — click to select';
        }
    }

    /**
     * Shows "No project" state when rumo.config.json is not present.
     */
    public updateNoProject(): void {
        this.item.text = '$(server) No Rumo project';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.item.command = 'rumo-app-dev.initProject';
        this.item.tooltip = 'No Rumo project — click to initialize';
    }

    public dispose(): void {
        this.item.dispose();
    }
}
