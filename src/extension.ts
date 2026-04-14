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

/** workspaceState key prefix for caching controller version. */
const VERSION_CACHE_KEY = 'rumoAppDev.cachedVersion';

// ── Activation ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('RumoAppDev: Extension activating…');

    controllerManager = new ControllerManager(context);
    sftpSync = new SftpSync();
    typeDownloader = new TypeDownloader();
    projectSetup = new ProjectSetup();
    debugConfig = new DebugConfig();
    statusBar = new StatusBar();

    context.subscriptions.push(statusBar);
    context.subscriptions.push(sftpSync);

    // Register commands
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
            cmdInitProject(context)
        ),
    );

    // Watch for VS Code settings changes (controller list in global settings)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('rumoAppDev')) {
                await onControllerConfigChanged(context);
            }
        })
    );

    // Watch for rumo.config.json creation / deletion
    setupRumoConfigWatcher(context);

    // Set up file watcher for build/type/
    setupBuildWatcher(context);

    // Perform initial activation
    await initialActivation(context);

    console.log('RumoAppDev: Extension activated.');
}

export function deactivate(): void {
    sftpSync.dispose();
}

// ── Initial Activation ─────────────────────────────────────────────────────────

async function initialActivation(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    if (!controllerManager.isRumoProject(workspaceRoot)) {
        // No rumo.config.json → not a Rumo project, show hint in status bar
        statusBar.updateNoProject();
        console.log('RumoAppDev: No rumo.config.json found — waiting for project initialisation.');
        return;
    }

    await activateForProject(context, workspaceRoot);
}

async function activateForProject(
    context: vscode.ExtensionContext,
    workspaceRoot: string
): Promise<void> {
    // Silent structure setup
    await projectSetup.silentInit(workspaceRoot);

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
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
    if (!workspaceRoot || !controllerManager.isRumoProject(workspaceRoot)) { return; }

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    statusBar.update(controller?.name);

    // Reconnect SFTP
    try {
        await sftpSync.setController(controller);
    } catch {
        // non-fatal
    }

    if (!controller) { return; }

    await maybeDownloadTypeDefs(context, controller);

    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);
}

// ── rumo.config.json Watcher ──────────────────────────────────────────────────

function setupRumoConfigWatcher(context: vscode.ExtensionContext): void {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const pattern = new vscode.RelativePattern(workspaceRoot, 'rumo.config.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate(async () => {
        console.log('RumoAppDev: rumo.config.json created — activating for project.');
        await activateForProject(context, workspaceRoot);
    });

    watcher.onDidChange(async () => {
        await onControllerConfigChanged(context);
    });

    watcher.onDidDelete(() => {
        statusBar.updateNoProject();
        sftpSync.setController(undefined).catch(() => { /* ignore */ });
    });

    context.subscriptions.push(watcher);
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

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    if (!controller) {
        vscode.window.showWarningMessage('RumoAppDev: No active controller configured.');
        return;
    }

    try {
        await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
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
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    if (!controllerManager.isRumoProject(workspaceRoot)) {
        const init = await vscode.window.showWarningMessage(
            'RumoAppDev: This workspace is not a Rumo project. Would you like to initialize it?',
            'Initialize Project', 'Cancel'
        );
        if (init === 'Initialize Project') {
            await cmdInitProject(context);
        }
        return;
    }

    const selected = await controllerManager.promptSwitchController();
    if (!selected) { return; }

    if (selected === '__ADD_NEW__') {
        await cmdAddController(context);
        return;
    }

    await performControllerSwitch(context, workspaceRoot, selected);
}

async function cmdAddController(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const controller = await controllerManager.promptAddController();
    if (!controller) { return; }

    // If this is a Rumo project, also switch to the new controller
    if (controllerManager.isRumoProject(workspaceRoot)) {
        await performControllerSwitch(context, workspaceRoot, controller.name);
    }
}

/**
 * Initialize Project Wizard — creates all project files, picks a controller.
 */
async function cmdInitProject(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    // Step 1: Warn if rumo.config.json already exists
    if (controllerManager.isRumoProject(workspaceRoot)) {
        const confirm = await vscode.window.showWarningMessage(
            'RumoAppDev: This workspace is already a Rumo project. Re-initialize and overwrite configuration?',
            'Yes, Re-initialize', 'Cancel'
        );
        if (confirm !== 'Yes, Re-initialize') { return; }
    }

    // Step 2: Select or create a controller
    let controllerName: string | undefined;
    const existingControllers = controllerManager.getControllers();

    if (existingControllers.length > 0) {
        const choice = await controllerManager.promptSwitchController();
        if (!choice) { return; }

        if (choice === '__ADD_NEW__') {
            const newCtrl = await controllerManager.promptAddController();
            if (!newCtrl) { return; }
            controllerName = newCtrl.name;
        } else {
            controllerName = choice;
        }
    } else {
        // No controllers configured at all — add one now
        vscode.window.showInformationMessage(
            'RumoAppDev: No controllers configured. Please add a controller first.'
        );
        const newCtrl = await controllerManager.promptAddController();
        if (!newCtrl) { return; }
        controllerName = newCtrl.name;
    }

    // Retrieve full controller config with password
    const controller = await controllerManager.getActiveControllerWithPassword(
        workspaceRoot
    ).then(async (c) => {
        // If different controller was just set, build manually
        if (c?.name === controllerName) { return c; }
        const base = controllerManager.getControllers().find(x => x.name === controllerName);
        if (!base) { return undefined; }
        const password = (await controllerManager.getPassword(base.name)) ?? '';
        return { ...base, password };
    });

    if (!controller) {
        vscode.window.showErrorMessage('RumoAppDev: Could not resolve controller configuration.');
        return;
    }

    // Step 3: Create project files
    await projectSetup.setupProjectFiles(workspaceRoot, controller, false);

    // Write rumo.config.json (activeController)
    controllerManager.setActiveControllerName(workspaceRoot, controllerName!);

    // Write launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

    // Step 4: Start d.ts download
    try {
        await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    } catch {
        // Error already shown
    }

    // Connect SFTP
    try {
        await sftpSync.setController(controller);
    } catch {
        // non-fatal
    }

    statusBar.update(controller.name);

    // Step 5: Success
    vscode.window.showInformationMessage(
        `RumoAppDev: Project initialized for controller "${controller.name}".`
    );
}

// ── Switch Controller Helper ──────────────────────────────────────────────────

/**
 * Performs a full controller switch:
 * 1. Updates rumo.config.json
 * 2. Regenerates .vscode/sftp.json
 * 3. Updates .vscode/launch.json
 * 4. Re-downloads d.ts
 * 5. Updates status bar
 * 6. Reconnects SFTP
 */
async function performControllerSwitch(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    controllerName: string
): Promise<void> {
    // 1. Update rumo.config.json
    controllerManager.setActiveControllerName(workspaceRoot, controllerName);

    // Get full controller with password
    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    if (!controller) {
        vscode.window.showErrorMessage(`RumoAppDev: Controller "${controllerName}" not found in settings.`);
        return;
    }

    // 2. Regenerate .vscode/sftp.json
    projectSetup.generateSftpJson(workspaceRoot, controller);

    // 3. Update .vscode/launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

    // 4. Re-download d.ts
    try {
        await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    } catch {
        // Error already shown
    }

    // 5. Update status bar
    statusBar.update(controller.name);

    // 6. Reconnect SFTP
    try {
        await sftpSync.setController(controller);
    } catch {
        // non-fatal
    }

    vscode.window.showInformationMessage(
        `RumoAppDev: Switched to controller "${controller.name}".`
    );
}

// ── Version Download Helper ───────────────────────────────────────────────────

async function maybeDownloadTypeDefs(
    context: vscode.ExtensionContext,
    controller: import('./controllerManager').ControllerConfigWithPassword
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('RumoAppDev: No workspace folder open.');
        return undefined;
    }
    return folders[0].uri.fsPath;
}

export function getTsconfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, 'tsconfig.json');
}
