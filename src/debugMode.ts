import * as vscode from 'vscode';
import * as https from 'https';
import { ControllerConfigWithPassword } from './controllerManager';

type DebugStartMode = 'none' | 'inspect' | 'inspect-brk';

export class DebugMode {
    /**
     * Sets the debug mode on the controller via REST API.
     * Requires Basic Auth with controller credentials.
     */
    public async setDebugMode(
        controller: ControllerConfigWithPassword,
        mode: DebugStartMode
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const auth = Buffer.from(`${controller.username}:${controller.password}`).toString('base64');

            const options = {
                hostname: controller.host,
                port: controller.httpsPort,
                path: '/~/ws/0/dev/0/fb/develop/dp/nodeDebug/dat/value',
                method: 'PUT',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json',
                },
                rejectUnauthorized: false,
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200 || res.statusCode === 204) {
                        resolve();
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(JSON.stringify(mode));
            req.end();
        });
    }

    /**
     * Quick action to toggle debug mode.
     * Shows a quickpick to select between 'none', 'inspect', 'inspect-brk'.
     */
    public async toggleDebugMode(controller: ControllerConfigWithPassword): Promise<void> {
        const modes: DebugStartMode[] = ['none', 'inspect', 'inspect-brk'];
        const selected = await vscode.window.showQuickPick(modes, {
            placeHolder: 'Select debug mode',
            canPickMany: false,
        });

        if (!selected) { return; }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `RumoAppDev: Setting debug mode to "${selected}"…`,
                    cancellable: false,
                },
                async () => {
                    await this.setDebugMode(controller, selected as DebugStartMode);
                }
            );

            let message = `Debug mode set to "${selected}".`;
            if (selected === 'none') {
                message += ' System will restart.';
            } else {
                message += ' Node Inspector listening on port 9229.';
            }
            vscode.window.showInformationMessage(`RumoAppDev: ${message}`);
        } catch (err) {
            vscode.window.showErrorMessage(
                `RumoAppDev: Failed to set debug mode: ${(err as Error).message}`
            );
        }
    }
}
