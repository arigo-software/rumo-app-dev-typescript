import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ControllerManager } from './controllerManager';
import { SftpSync } from './sftpSync';
import { TypeDownloader } from './typeDownloader';
import { ProjectSetup } from './projectSetup';
import { DebugConfig } from './debugConfig';
import { StatusBar } from './statusBar';

// ── State ──────────────────────────────────────────────────────────────────────

let controllerManager: ControllerManager;
let sftpSync: SftpSync;
let typeDownloader: TypeDownloader;
let projectSetup: ProjectSetup;
let debugConfig: DebugConfig;
let statusBar: StatusBar;

/** Workspace-state key for caching the last known controller version. */
const VERSION_CACHE_KEY = 'rumoAppDev.cachedVersion';

// ── Activation ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('RumoAppDev: Extension activating…');

    controllerManager = new ControllerManager();
    sftpSync = new SftpSync();
    typeDownloader = new TypeDownloader();
    projectSetup = new ProjectSetup();
    debugConfig = new DebugConfig();
    statusBar = new StatusBar();

    context.subscriptions.push(statusBar);
    context.subscriptions.push(sftpSync);

    // Register all commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rumo-app-dev.uploadAllFiles', () =>
            cmdUploadAllFiles()
        ),
        vscode.commands.registerCommand('rumo-app-dev.downloadTypeDefs', () =>
            cmdDownloadTypeDefs(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev.switchController', () =>
            cmdSwitchController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev.addController', () =>
            cmdAddController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev.initProject', () =>
            cmdInitProject()
        ),
    );

    // Watch for settings changes (controller list / active controller)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('rumoAppDev')) {
                await onControllerConfigChanged(context);
            }
        })
    );

    // Set up file watcher for build/type/
    setupBuildWatcher(context);

    // Perform initial setup
    await initialSetup(context);

    console.log('RumoAppDev: Extension activated.');
}

export function deactivate(): void {
    sftpSync.dispose();
}

// ── Initial Setup ──────────────────────────────────────────────────────────────

async function initialSetup(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    // Always auto-init project structure (silently, does not overwrite existing files)
    await projectSetup.initProject(workspaceRoot, true);

    const controller = controllerManager.getActiveController();
    statusBar.update(controller?.name);

    if (!controller) { return; }

    // Connect SFTP
    try {
        await sftpSync.setController(controller);
    } catch {
        // Will retry on next upload attempt
    }

    // Download type definitions if version changed (or not yet cached)
    await maybeDownloadTypeDefs(context, controller);

    // Update launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);
}

async function onControllerConfigChanged(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const controller = controllerManager.getActiveController();
    statusBar.update(controller?.name);

    // Reconnect SFTP with new controller
    try {
        await sftpSync.setController(controller);
    } catch {
        // non-fatal
    }

    if (!controller) { return; }

    // Re-download type defs for new controller (if version changed)
    await maybeDownloadTypeDefs(context, controller);

    // Refresh launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);
}

/**
 * Downloads type definitions only when the controller version has changed since last download.
 */
async function maybeDownloadTypeDefs(
    context: vscode.ExtensionContext,
    controller: { name: string; host: string; sshPort: number; httpsPort: number; username: string; password: string }
): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const version = await typeDownloader.fetchControllerVersion(controller);
    const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
    const cachedVersion = context.workspaceState.get<string>(cacheKey);

    if (version && version === cachedVersion) {
        console.log(`RumoAppDev: Type defs up-to-date (version ${version}), skipping download.`);
        return;
    }

    try {
        await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        if (version) {
            await context.workspaceState.update(cacheKey, version);
        }
    } catch {
        // Error already shown by typeDownloader
    }
}

// ── File Watcher for build/type/ ──────────────────────────────────────────────

function setupBuildWatcher(context: vscode.ExtensionContext): void {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const pattern = new vscode.RelativePattern(
        workspaceRoot,
        'build/type/**/*.{js,js.map}'
    );

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const changeTimeouts = new Map<string, NodeJS.Timeout>();

    const scheduleUpload = (uri: vscode.Uri) => {
        const key = uri.fsPath;
        if (changeTimeouts.has(key)) {
            clearTimeout(changeTimeouts.get(key)!);
        }
        changeTimeouts.set(key, setTimeout(async () => {
            changeTimeouts.delete(key);
            // Only upload if the file still exists
            if (!fs.existsSync(uri.fsPath)) { return; }
            await sftpSync.uploadFile(uri.fsPath, workspaceRoot);
        }, 800));
    };

    watcher.onDidChange(scheduleUpload);
    watcher.onDidCreate(scheduleUpload);

    context.subscriptions.push(watcher);
}

// ── Command Implementations ────────────────────────────────────────────────────

async function cmdUploadAllFiles(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    try {
        await sftpSync.uploadAllFiles(workspaceRoot);
    } catch (err) {
        vscode.window.showErrorMessage(`RumoAppDev: Upload failed: ${(err as Error).message}`);
    }
}

async function cmdDownloadTypeDefs(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const controller = controllerManager.getActiveController();
    if (!controller) {
        vscode.window.showWarningMessage('RumoAppDev: No active controller configured.');
        return;
    }

    try {
        await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        // Update version cache
        const version = await typeDownloader.fetchControllerVersion(controller);
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    } catch {
        // Error already shown
    }
}

async function cmdSwitchController(context: vscode.ExtensionContext): Promise<void> {
    const selected = await controllerManager.promptSwitchController();
    if (!selected) { return; }

    if (selected === '__ADD_NEW__') {
        await cmdAddController(context);
        return;
    }

    await controllerManager.setActiveController(selected);
    // onDidChangeConfiguration will fire and handle the rest
}

async function cmdAddController(context: vscode.ExtensionContext): Promise<void> {
    const controller = await controllerManager.promptAddController();
    if (!controller) { return; }

    await controllerManager.addController(controller);
    await controllerManager.setActiveController(controller.name);
    // onDidChangeConfiguration will fire and handle the rest
}

async function cmdInitProject(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }
    await projectSetup.initProject(workspaceRoot, false);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('RumoAppDev: No workspace folder open.');
        return undefined;
    }
    return folders[0].uri.fsPath;
}

/**
 * Resolves the absolute path to the local tsconfig-generated path
 * (for tsc --watch task provider, if needed later).
 */
export function getTsconfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, 'tsconfig.json');
}
