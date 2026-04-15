import * as vscode from 'vscode';
import * as https from 'https';
import { ControllerConfigWithPassword } from './controllerManager';

type DebugStartMode = 'none' | 'inspect' | 'inspect-brk';

export class DebugMode {
    /**
     * Gets the current debug mode from the controller.
     */
    public async getDebugMode(controller: ControllerConfigWithPassword): Promise<string> {
        return new Promise((resolve, reject) => {
            const auth = Buffer.from(`${controller.username}:${controller.password}`).toString('base64');
            const req = https.request({
                hostname: controller.host,
                port: controller.httpsPort,
                path: '/~/ws/0/dev/0/fb/develop/dp/nodeDebug/dat/value',
                method: 'GET',
                headers: { 'Authorization': `Basic ${auth}` },
                rejectUnauthorized: false,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve(data.trim()); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

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
     * After setting, waits for the controller to come back online.
     */
    public async toggleDebugMode(controller: ControllerConfigWithPassword): Promise<void> {
        const items = [
            {
                label: 'none',
                description: 'Disable debug mode — controller will restart',
            },
            {
                label: 'inspect',
                description: 'Enable Node Inspector on port 9229 — attach with F5',
            },
            {
                label: 'inspect-brk',
                description: 'Break on first line — use for init() debugging (resume quickly!)',
            },
        ];
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select debug mode',
            canPickMany: false,
        });
        const selected = picked?.label as DebugStartMode | undefined;

        if (!selected) { return; }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `RumoAppDev: Setting debug mode to "${selected}" — restarting controller…`,
                    cancellable: false,
                },
                async (progress) => {
                    // Set the mode (controller will restart immediately)
                    await this.setDebugMode(controller, selected as DebugStartMode).catch(() => {
                        // socket hang up is expected — controller is restarting
                    });

                    // Wait for controller to go offline, then come back
                    progress.report({ message: 'Waiting for controller to restart…' });
                    await this.waitForControllerRestart(controller);

                    if (selected !== 'none') {
                        progress.report({ message: 'Controller online — Node Inspector ready on port 9229' });
                    } else {
                        progress.report({ message: 'Controller online' });
                    }
                }
            );

            let message = `Controller restarted. Debug mode: "${selected}".`;
            if (selected === 'inspect') {
                message += ' Attach with F5. ⚠️ If debugging init(), resume quickly — Rumo has an app-init timeout.';
            } else if (selected === 'inspect-brk') {
                message += ' Attach with F5 immediately — execution is paused on first line.';
            }
            vscode.window.showInformationMessage(`RumoAppDev: ${message}`);
        } catch (err) {
            vscode.window.showErrorMessage(
                `RumoAppDev: Failed to set debug mode: ${(err as Error).message}`
            );
        }
    }

    /**
     * Waits until the controller goes offline and comes back online.
     * Polls the HTTPS API every 2 seconds, timeout 60s.
     */
    private async waitForControllerRestart(
        controller: ControllerConfigWithPassword,
        timeoutMs = 60000
    ): Promise<void> {
        const start = Date.now();
        const poll = () => new Promise<boolean>(resolve => {
            const auth = Buffer.from(`${controller.username}:${controller.password}`).toString('base64');
            const req = https.request({
                hostname: controller.host,
                port: controller.httpsPort,
                path: '/~/ws/0/dev/0/fb/develop/dp/nodeDebug/dat/value',
                method: 'GET',
                headers: { 'Authorization': `Basic ${auth}` },
                rejectUnauthorized: false,
            }, (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(3000, () => { req.destroy(); resolve(false); });
            req.end();
        });

        // First wait until offline (or just proceed after short delay)
        await new Promise(r => setTimeout(r, 2000));

        // Then wait until online again
        while (Date.now() - start < timeoutMs) {
            if (await poll()) { return; }
            await new Promise(r => setTimeout(r, 2000));
        }
        throw new Error('Controller did not come back online within 60 seconds.');
    }
}
