import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Client from 'ssh2-sftp-client';
import * as tar from 'tar';
import * as lzma from 'lzma-native';
import { ControllerConfigWithPassword } from './controllerManager';

const REMOTE_DTS_ARCHIVE = '/ts/data.tar.xz';
const LOCAL_DTS_DIR = 'src';

export class TypeDownloader {
    /**
     * Downloads the type definitions archive from the controller,
     * extracts the `types/` folder into `src/`, and returns the
     * tsconfig.json from the archive root (to be used as build base).
     *
     * Archive layout (after extraction into a temp dir):
     *   tsconfig.json        ← compiler settings from the controller build
     *   types/               ← .d.ts files + node_modules/@types
     *     lib/
     *     common/
     *     node_modules/
     *
     * @param controller      Active controller configuration
     * @param workspaceRoot   Absolute path to the workspace root
     * @returns               Parsed tsconfig compilerOptions from the archive, or undefined on failure
     */
    public async downloadTypeDefs(
        controller: ControllerConfigWithPassword,
        workspaceRoot: string
    ): Promise<Record<string, unknown> | undefined> {
        const localSrcDir = path.join(workspaceRoot, LOCAL_DTS_DIR);

        // Ensure local src/ directory exists
        if (!fs.existsSync(localSrcDir)) {
            fs.mkdirSync(localSrcDir, { recursive: true });
        }

        const sftp = new Client();
        const tmpFile = path.join(os.tmpdir(), `rumo-dts-${Date.now()}.tar.xz`);
        const tmpExtractDir = path.join(os.tmpdir(), `rumo-dts-extract-${Date.now()}`);
        fs.mkdirSync(tmpExtractDir, { recursive: true });

        try {
            await sftp.connect({
                host: controller.host,
                port: controller.sshPort,
                username: controller.username,
                password: controller.password,
            });

            // Check if the archive exists on the controller
            try {
                await sftp.stat(REMOTE_DTS_ARCHIVE);
            } catch {
                vscode.window.showErrorMessage(
                    `RumoAppDev: Controller "${controller.name}": Firmware version is too old and not supported by this plugin. ` +
                    `Please update the controller firmware to use TypeScript development.`
                );
                return undefined;
            }

            let archiveTsConfig: Record<string, unknown> | undefined;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `RumoAppDev: Downloading type definitions from ${controller.name}…`,
                    cancellable: false,
                },
                async () => {
                    // Download archive
                    await sftp.get(REMOTE_DTS_ARCHIVE, tmpFile);

                    // Extract into temp dir
                    await new Promise<void>((resolve, reject) => {
                        const input = fs.createReadStream(tmpFile);
                        const decompressor = lzma.createDecompressor();
                        const extract = tar.x({ cwd: tmpExtractDir });
                        extract.on('finish', resolve);
                        extract.on('error', reject);
                        decompressor.on('error', reject);
                        input.pipe(decompressor).pipe(extract as unknown as NodeJS.WritableStream);
                    });

                    // Read tsconfig.json from archive root
                    const archiveTsConfigPath = path.join(tmpExtractDir, 'tsconfig.json');
                    if (fs.existsSync(archiveTsConfigPath)) {
                        try {
                            archiveTsConfig = JSON.parse(fs.readFileSync(archiveTsConfigPath, 'utf8'));
                        } catch {
                            console.warn('RumoAppDev: Could not parse tsconfig.json from archive');
                        }
                    }

                    // Clear existing .d.ts files and node_modules from src/
                    this.deleteExistingDtsFiles(localSrcDir);
                    const srcNodeModules = path.join(localSrcDir, 'node_modules');
                    if (fs.existsSync(srcNodeModules)) {
                        fs.rmSync(srcNodeModules, { recursive: true, force: true });
                    }

                    // Copy types/ content into src/
                    const extractedTypesDir = path.join(tmpExtractDir, 'types');
                    if (fs.existsSync(extractedTypesDir)) {
                        this.copyDirRecursive(extractedTypesDir, localSrcDir);
                    } else {
                        console.warn('RumoAppDev: No types/ folder found in archive');
                    }
                }
            );

            vscode.window.showInformationMessage(
                `RumoAppDev: Type definitions downloaded from ${controller.name}.`
            );

            return archiveTsConfig;
        } catch (err) {
            vscode.window.showErrorMessage(
                `RumoAppDev: Failed to download type definitions: ${(err as Error).message}`
            );
            throw err;
        } finally {
            try { await sftp.end(); } catch { /* ignore */ }
            try { if (fs.existsSync(tmpFile)) { fs.unlinkSync(tmpFile); } } catch { /* ignore */ }
            try { if (fs.existsSync(tmpExtractDir)) { fs.rmSync(tmpExtractDir, { recursive: true, force: true }); } } catch { /* ignore */ }
        }
    }

    /**
     * Recursively copies a directory.
     */
    private copyDirRecursive(src: string, dest: string): void {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                this.copyDirRecursive(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    /**
     * Recursively deletes all .d.ts files in a local directory.
     */
    private deleteExistingDtsFiles(localPath: string): void {
        if (!fs.existsSync(localPath)) { return; }
        for (const entry of fs.readdirSync(localPath, { withFileTypes: true })) {
            const entryPath = path.join(localPath, entry.name);
            if (entry.isDirectory() && entry.name !== 'node_modules') {
                this.deleteExistingDtsFiles(entryPath);
            } else if (entry.name.endsWith('.d.ts')) {
                fs.unlinkSync(entryPath);
                console.log(`RumoAppDev: Deleted old type def ${entryPath}`);
            }
        }
    }

    /**
     * Fetches the firmware version string from the controller via HTTPS.
     * Returns undefined on failure.
     */
    public async fetchControllerVersion(controller: ControllerConfigWithPassword): Promise<string | undefined> {
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
