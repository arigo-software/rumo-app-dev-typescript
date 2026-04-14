import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Client from 'ssh2-sftp-client';
import { ControllerConfig } from './controllerManager';

const REMOTE_DTS_PATH = '/user/dts';
const LOCAL_DTS_DIR = 'src';

export class TypeDownloader {
    /**
     * Downloads all .d.ts files from the controller's /user/dts/ directory
     * into the local types/ folder, replacing what's there.
     *
     * @param controller  Active controller configuration
     * @param workspaceRoot  Absolute path to the workspace root
     */
    public async downloadTypeDefs(
        controller: ControllerConfig,
        workspaceRoot: string
    ): Promise<void> {
        // d.ts files land in src/ — baseUrl: "src" makes bare imports resolve correctly.
        const localTypesDir = path.join(workspaceRoot, LOCAL_DTS_DIR);

        // Ensure local src/ directory exists
        if (!fs.existsSync(localTypesDir)) {
            fs.mkdirSync(localTypesDir, { recursive: true });
        }

        const sftp = new Client();
        try {
            await sftp.connect({
                host: controller.host,
                port: controller.sshPort,
                username: controller.username,
                password: controller.password,
            });

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `RumoAppDev: Downloading type definitions from ${controller.name}…`,
                    cancellable: false,
                },
                async () => {
                    await this.downloadDirectory(sftp, REMOTE_DTS_PATH, localTypesDir);
                }
            );

            vscode.window.showInformationMessage(
                `RumoAppDev: Type definitions downloaded from ${controller.name}.`
            );
        } catch (err) {
            vscode.window.showErrorMessage(
                `RumoAppDev: Failed to download type definitions: ${(err as Error).message}`
            );
            throw err;
        } finally {
            try { await sftp.end(); } catch { /* ignore */ }
        }
    }

    /**
     * Recursively downloads a remote directory to a local path.
     */
    private async downloadDirectory(
        sftp: Client,
        remotePath: string,
        localPath: string
    ): Promise<void> {
        // Ensure local directory exists
        if (!fs.existsSync(localPath)) {
            fs.mkdirSync(localPath, { recursive: true });
        }

        let entries: Client.FileInfo[];
        try {
            entries = await sftp.list(remotePath);
        } catch (err) {
            console.warn(`RumoAppDev: Could not list remote directory ${remotePath}: ${(err as Error).message}`);
            return;
        }

        for (const entry of entries) {
            const remoteEntryPath = `${remotePath}/${entry.name}`;
            const localEntryPath = path.join(localPath, entry.name);

            if (entry.type === 'd') {
                await this.downloadDirectory(sftp, remoteEntryPath, localEntryPath);
            } else {
                try {
                    await sftp.get(remoteEntryPath, localEntryPath);
                    console.log(`RumoAppDev: Downloaded ${remoteEntryPath} → ${localEntryPath}`);
                } catch (err) {
                    console.error(`RumoAppDev: Error downloading ${remoteEntryPath}: ${(err as Error).message}`);
                }
            }
        }
    }

    /**
     * Fetches the firmware version string from the controller via HTTPS.
     * Returns undefined on failure.
     */
    public async fetchControllerVersion(controller: ControllerConfig): Promise<string | undefined> {
        const https = await import('https');
        const url = `https://${controller.host}:${controller.httpsPort}/~/dev/0/fb/Setup/dp/version/dat/value`;

        return new Promise<string | undefined>((resolve) => {
            const auth = Buffer.from(`${controller.username}:${controller.password}`).toString('base64');
            const req = https.get(
                url,
                {
                    rejectUnauthorized: false,
                    headers: { Authorization: `Basic ${auth}` },
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => {
                        const text = data.trim();
                        console.log(`RumoAppDev: Controller version response: ${text}`);
                        resolve(text || undefined);
                    });
                }
            );
            req.on('error', (err: Error) => {
                console.warn(`RumoAppDev: Could not fetch controller version: ${err.message}`);
                resolve(undefined);
            });
            req.setTimeout(5000, () => {
                req.destroy();
                resolve(undefined);
            });
        });
    }
}
