import * as vscode from 'vscode';

export class StatusBar {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = 'rumo-app-dev.switchController';
        this.item.tooltip = 'Click to switch Rumo controller';
        this.update(undefined);
        this.item.show();
    }

    /**
     * Updates the status bar with the active controller name (or a "no controller" indicator).
     */
    public update(controllerName: string | undefined): void {
        if (controllerName) {
            this.item.text = `$(server) ${controllerName}`;
            this.item.backgroundColor = undefined;
        } else {
            this.item.text = '$(server) No controller';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    public dispose(): void {
        this.item.dispose();
    }
}
