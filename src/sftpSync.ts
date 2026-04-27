import * as vscode from 'vscode';
import Client from 'ssh2-sftp-client';
import * as fs from 'fs';
import * as path from 'path';
import { ControllerConfigWithPassword } from './controllerManager';

const BUILD_TYPE_DIR = 'build/type';
const REMOTE_TYPE_ROOT = '/type';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class SftpSync {
    private sftp: Client;
    private controller: ControllerConfigWithPassword | undefined;
    private connected = false;
    private connecting = false;
    private reconnectAttempts = 0;

    constructor() {
        this.sftp = new Client();
        this.sftp.on('error', (err) => {
            console.error('RumoAppDev SFTP error:', err.message);
            this.connected = false;
        });
    }

    /**
     * Updates the active controller config and resets the SFTP connection.
     */
    public async setController(controller: ControllerConfigWithPassword | undefined): Promise<void> {
        if (this.connected) {
            try { await this.sftp.end(); } catch { /* ignore */ }
            this.connected = false;
        }
        this.controller = controller;
        this.reconnectAttempts = 0;

        if (controller) {
            await this.connect();
        }
    }

    public async connect(): Promise<void> {
        if (!this.controller || this.connecting) { return; }
        this.connecting = true;
        try {
            // Re-create client to avoid stale state
            this.sftp = new Client();
            this.sftp.on('error', (err) => {
                console.error('RumoAppDev SFTP error:', err.message);
                this.connected = false;
            });

            await this.sftp.connect({
                host: this.controller.host,
                port: this.controller.sshPort,
                username: this.controller.username,
                password: this.controller.password,
            });
            this.connected = true;
            this.reconnectAttempts = 0;
            console.log(`RumoAppDev: SFTP connected to ${this.controller.host}`);
        } catch (err) {
            this.connected = false;
            console.error(`RumoAppDev: SFTP connect failed: ${(err as Error).message}`);
            throw err;
        } finally {
            this.connecting = false;
        }
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public async reconnect(): Promise<void> {
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            vscode.window.showErrorMessage(
                `RumoAppDev: SFTP reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts.`
            );
            return;
        }
        this.reconnectAttempts++;
        await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
        try {
            await this.connect();
        } catch {
            // Will be retried next time
        }
    }

    private async ensureConnected(): Promise<boolean> {
        if (this.connected) { return true; }
        if (!this.controller) { return false; }
        await this.reconnect();
        return this.connected;
    }

    private async ensureRemoteDirectory(remotePath: string): Promise<void> {
        const remoteDir = path.posix.dirname(remotePath);
        try {
            const exists = await this.sftp.exists(remoteDir);
            if (!exists) {
                await this.sftp.mkdir(remoteDir, true);
            }
        } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes('No SFTP connection') || msg.includes('Connection lost')) {
                this.connected = false;
                if (await this.ensureConnected()) {
                    await this.ensureRemoteDirectory(remotePath);
                }
            } else {
                throw err;
            }
        }
    }

    /**
     * Uploads a single local file (from build/type/) to the remote /type/ directory.
     */
    public async uploadFile(localPath: string, workspaceRoot: string): Promise<void> {
        // Silently skip when offline or no controller configured
        if (!this.controller || !this.controller.host) { return; }

        if (!await this.ensureConnected()) {
            vscode.window.showWarningMessage('RumoAppDev: Not connected to SFTP — cannot upload file.');
            return;
        }

        const buildTypeDir = path.join(workspaceRoot, BUILD_TYPE_DIR);
        const relativePath = path.relative(buildTypeDir, localPath);
        // Use posix separators for the remote path
        const remotePath = path.posix.join(REMOTE_TYPE_ROOT, relativePath.split(path.sep).join('/'));

        try {
            await this.ensureRemoteDirectory(remotePath);
            await this.sftp.put(localPath, remotePath);
            console.log(`RumoAppDev: Uploaded ${localPath} → ${remotePath}`);
        } catch (err) {
            const msg = (err as Error).message;
            if (msg.includes('No SFTP connection') || msg.includes('Connection lost')) {
                this.connected = false;
                if (await this.ensureConnected()) {
                    await this.uploadFile(localPath, workspaceRoot);
                }
            } else {
                vscode.window.showErrorMessage(`RumoAppDev: Upload error: ${msg}`);
                throw err;
            }
        }
    }

    /**
     * Uploads all .js and .js.map files from build/type/ to the remote /type/ directory.
     */
    public async uploadAllFiles(workspaceRoot: string): Promise<void> {
        // Silently skip when offline or no controller configured
        if (!this.controller || !this.controller.host) { return; }

        if (!await this.ensureConnected()) {
            vscode.window.showWarningMessage('RumoAppDev: Not connected to SFTP — cannot upload files.');
            return;
        }

        const buildTypeDir = path.join(workspaceRoot, BUILD_TYPE_DIR);
        if (!fs.existsSync(buildTypeDir)) {
            vscode.window.showWarningMessage(`RumoAppDev: Build directory not found: ${buildTypeDir}`);
            return;
        }

        const files = this.collectFiles(buildTypeDir, ['.js', '.js.map']);
        if (files.length === 0) {
            vscode.window.showInformationMessage('RumoAppDev: No compiled files found to upload.');
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `RumoAppDev: Uploading to ${this.controller?.host}…`,
                cancellable: false,
            },
            async (progress) => {
                let done = 0;
                for (const file of files) {
                    const shortName = path.relative(path.join(workspaceRoot, BUILD_TYPE_DIR), file);
                    progress.report({
                        increment: (1 / files.length) * 100,
                        message: shortName,
                    });
                    await this.uploadFile(file, workspaceRoot);
                    done++;
                }
            }
        );

        vscode.window.showInformationMessage(`RumoAppDev: Uploaded ${files.length} file(s) to ${this.controller?.host}.`);
    }

    private collectFiles(dir: string, exts: string[]): string[] {
        const result: string[] = [];
        if (!fs.existsSync(dir)) { return result; }

        for (const entry of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                result.push(...this.collectFiles(fullPath, exts));
            } else if (exts.some(ext => fullPath.endsWith(ext))) {
                result.push(fullPath);
            }
        }
        return result;
    }

    public dispose(): void {
        try { this.sftp.end(); } catch { /* ignore */ }
        this.connected = false;
    }
}
