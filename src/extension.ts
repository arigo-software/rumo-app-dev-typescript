import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ControllerManager } from './controllerManager';
import { SftpSync } from './sftpSync';
import { TypeDownloader } from './typeDownloader';
import { ProjectSetup } from './projectSetup';
import { DebugConfig } from './debugConfig';
import { DebugMode } from './debugMode';
import { StatusBar } from './statusBar';

// ── State ──────────────────────────────────────────────────────────────────────

let controllerManager: ControllerManager;
let sftpSync: SftpSync;
let typeDownloader: TypeDownloader;
let projectSetup: ProjectSetup;
let debugConfig: DebugConfig;
let debugMode: DebugMode;
let statusBar: StatusBar;

/** workspaceState key prefix for caching controller version. */
const VERSION_CACHE_KEY = 'rumoAppDevTypescript.cachedVersion';

// ── Activation ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('RumoAppDev: Extension activating…');

    controllerManager = new ControllerManager(context);
    sftpSync = new SftpSync();
    typeDownloader = new TypeDownloader();
    projectSetup = new ProjectSetup();
    debugConfig = new DebugConfig();
    debugMode = new DebugMode();
    statusBar = new StatusBar();

    context.subscriptions.push(statusBar);
    context.subscriptions.push(sftpSync);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('rumo-app-dev-typescript.uploadAllFiles', () =>
            cmdUploadAllFiles()
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.downloadTypeDefs', () =>
            cmdDownloadTypeDefs(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.switchController', () =>
            cmdSwitchController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.addController', () =>
            cmdAddController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.initProject', () =>
            cmdInitProject(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.setDebugMode', () =>
            cmdSetDebugMode(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.editController', () =>
            cmdEditController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.deleteController', () =>
            cmdDeleteController(context)
        ),
        vscode.commands.registerCommand('rumo-app-dev-typescript.changePassword', () =>
            cmdChangePassword(context)
        ),
    );

    // Watch for new app files and insert boilerplate
    setupAppFileWatcher(context);

    // Watch for VS Code settings changes (controller list in global settings)
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('rumoAppDevTypescript')) {
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

    // Check for newer version on GitHub Releases (non-blocking)
    checkForUpdate(context);

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
    await projectSetup.silentInit(workspaceRoot, context);

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    statusBar.update(controller?.name);

    if (!controller) { return; }

    // Handle offline controller
    if (controllerManager.isOfflineController(controller.name)) {
        await sftpSync.setController(undefined);
        await maybeDownloadTypeDefs(context, controller);
        return;
    }

    // Connect SFTP
    try {
        await sftpSync.setController(controller);
        if (sftpSync.isConnected()) {
            statusBar.setConnected(controller.name);
        } else {
            statusBar.setDisconnected(controller.name);
        }
    } catch {
        statusBar.setDisconnected(controller.name);
    }

    // Download type definitions if version changed (or not yet cached)
    await maybeDownloadTypeDefs(context, controller);

    // Start periodic connection check
    startConnectionMonitor(controller);

    // Update launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);
}

async function onControllerConfigChanged(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot || !controllerManager.isRumoProject(workspaceRoot)) { return; }

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    statusBar.update(controller?.name);

    if (!controller) { return; }

    // Handle offline controller
    if (controllerManager.isOfflineController(controller.name)) {
        await sftpSync.setController(undefined);
        return;
    }

    // Reconnect SFTP with updated config
    try {
        await sftpSync.setController(controller);
        if (sftpSync.isConnected()) {
            statusBar.setConnected(controller.name);
        } else {
            statusBar.setDisconnected(controller.name);
        }
    } catch {
        statusBar.setDisconnected(controller.name);
    }

    // Regenerate sftp.json so SFTP plugin also uses the updated config
    await projectSetup.generateSftpJson(workspaceRoot, controller);

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

    // Batch uploads: collect changed files and upload together after a short delay
    let batchTimeout: NodeJS.Timeout | undefined;
    const pendingFiles = new Set<string>();

    const scheduleUpload = (uri: vscode.Uri) => {
        if (!fs.existsSync(uri.fsPath)) { return; }
        pendingFiles.add(uri.fsPath);

        if (batchTimeout) { clearTimeout(batchTimeout); }
        batchTimeout = setTimeout(async () => {
            batchTimeout = undefined;
            const files = [...pendingFiles];
            pendingFiles.clear();
            if (files.length === 0) { return; }

            const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
            if (controller) { statusBar.setStatus(controller.name, `uploading ${files.length} file(s)…`); }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `RumoAppDev: Uploading ${files.length} file(s)…`,
                cancellable: false,
            }, async (progress) => {
                let done = 0;
                for (const file of files) {
                    const shortName = path.relative(path.join(workspaceRoot, 'build', 'type'), file);
                    progress.report({ increment: (1 / files.length) * 100, message: shortName });
                    await sftpSync.uploadFile(file, workspaceRoot);
                    done++;
                }
            });

            if (controller) { statusBar.setConnected(controller.name); }
        }, 800);
    };

    watcher.onDidChange(scheduleUpload);
    watcher.onDidCreate(scheduleUpload);

    context.subscriptions.push(watcher);
}

// ── Command Implementations ────────────────────────────────────────────────────

async function cmdUploadAllFiles(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    if (controller) { statusBar.setStatus(controller.name, 'uploading…'); }

    try {
        await sftpSync.uploadAllFiles(workspaceRoot);
        if (controller) { statusBar.setConnected(controller.name); }
    } catch (err) {
        if (controller) { statusBar.setDisconnected(controller.name); }
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
async function cmdEditController(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();

    // Exclude the built-in Offline pseudo-controller from edit list
    const controllers = controllerManager.getControllers().filter(
        c => !controllerManager.isOfflineController(c.name)
    );
    if (controllers.length === 0) {
        vscode.window.showWarningMessage('RumoAppDev: No controllers configured.');
        return;
    }

    const items: vscode.QuickPickItem[] = controllers.map(c => ({
        label: c.name,
        description: `${c.host}:${c.sshPort}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a controller to edit',
    });
    if (!selected) { return; }

    const existing = controllers.find(c => c.name === selected.label);
    if (!existing) { return; }

    const updated = await controllerManager.promptEditController(existing);
    if (!updated) { return; }

    vscode.window.showInformationMessage(`RumoAppDev: Controller "${updated.name}" updated.`);

    // If this is a Rumo project and the edited controller is the active one, reconnect
    if (workspaceRoot && controllerManager.isRumoProject(workspaceRoot)) {
        const activeName = controllerManager.getActiveControllerName(workspaceRoot);
        if (activeName === updated.name || activeName === existing.name) {
            await performControllerSwitch(context, workspaceRoot, updated.name);
        }
    }
}

async function cmdDeleteController(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();

    const deletedName = await controllerManager.promptDeleteController();
    if (!deletedName) { return; }

    vscode.window.showInformationMessage(`RumoAppDev: Controller "${deletedName}" deleted.`);

    // If the deleted controller was the active one, update status bar
    if (workspaceRoot && controllerManager.isRumoProject(workspaceRoot)) {
        const activeName = controllerManager.getActiveControllerName(workspaceRoot);
        if (activeName === deletedName) {
            statusBar.update(undefined);
            // Optionally prompt to switch to another controller
            const remaining = controllerManager.getControllers();
            if (remaining.length > 0) {
                const switchNow = await vscode.window.showWarningMessage(
                    `Active controller "${deletedName}" was deleted. Switch to another?`,
                    'Switch', 'Later'
                );
                if (switchNow === 'Switch') {
                    await cmdSwitchController(context);
                }
            }
        }
    }
}

async function cmdChangePassword(context: vscode.ExtensionContext): Promise<void> {
    const controllers = controllerManager.getControllers();
    if (controllers.length === 0) {
        vscode.window.showWarningMessage('RumoAppDev: No controllers configured.');
        return;
    }

    const items: vscode.QuickPickItem[] = controllers.map(c => ({
        label: c.name,
        description: `${c.host}:${c.sshPort}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a controller to change password',
    });
    if (!selected) { return; }

    const newPassword = await vscode.window.showInputBox({
        prompt: `New password for "${selected.label}"`,
        password: true,
        ignoreFocusOut: true,
    });
    if (newPassword === undefined) { return; }

    await controllerManager.savePassword(selected.label, newPassword);
    vscode.window.showInformationMessage(`RumoAppDev: Password for "${selected.label}" updated.`);

    // Reconnect SFTP with new password if this is the active controller
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot && controllerManager.isRumoProject(workspaceRoot)) {
        const activeName = controllerManager.getActiveControllerName(workspaceRoot);
        if (activeName === selected.label) {
            await performControllerSwitch(context, workspaceRoot, selected.label);
        }
    }
}

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

    // Step 2: Create directories FIRST (before any network operations)
    projectSetup.ensureDirectories(workspaceRoot);

    // Step 3: Select or create a controller
    let controllerName: string | undefined;
    const choice = await controllerManager.promptSwitchController();
    if (!choice) { return; }

    if (choice === '__ADD_NEW__') {
        const newCtrl = await controllerManager.promptAddController();
        if (!newCtrl) { return; }
        controllerName = newCtrl.name;
    } else {
        controllerName = choice;
    }

    // Step 4: Write rumo.config.json (activeController)
    controllerManager.setActiveControllerName(workspaceRoot, controllerName!);

    // Step 5: Handle offline controller
    if (controllerManager.isOfflineController(controllerName!)) {
        const archiveTsConfig = await typeDownloader.extractDefaultTypeDefs(context, workspaceRoot);

        // Set up project files (no sftp.json for offline mode)
        await projectSetup.ensurePackageJson(workspaceRoot, false);
        projectSetup.ensureTsConfig(workspaceRoot, false, archiveTsConfig);
        projectSetup.ensureGitIgnore(workspaceRoot, false);
        projectSetup.ensureExtensionsJson(workspaceRoot, false);
        projectSetup.ensureCopilotInstructions(workspaceRoot, context, false);

        await sftpSync.setController(undefined);
        statusBar.update(controllerName!);

        vscode.window.showInformationMessage(
            'RumoAppDev: Project initialized in offline mode — using local type definitions.'
        );
        return;
    }

    // Retrieve full controller config with password
    const base = controllerManager.getControllers().find(x => x.name === controllerName);
    if (!base) {
        vscode.window.showErrorMessage('RumoAppDev: Could not resolve controller configuration.');
        return;
    }
    const password = (await controllerManager.getPassword(base.name)) ?? '';
    const controller = { ...base, password };

    // Step 6: Try to download d.ts from controller (silently falls back on failure)
    let archiveTsConfig: Record<string, unknown> | undefined;
    const version = await typeDownloader.fetchControllerVersion(controller);
    archiveTsConfig = await typeDownloader.downloadTypeDefs(controller, workspaceRoot);

    if (archiveTsConfig) {
        // Download succeeded — cache version
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    } else {
        // Controller unreachable — use bundled fallback if no types present yet
        const libDir = path.join(workspaceRoot, 'src', 'lib');
        if (!fs.existsSync(libDir)) {
            archiveTsConfig = await typeDownloader.extractDefaultTypeDefs(context, workspaceRoot);
        }
    }

    // Step 7: Create remaining project files
    await projectSetup.setupProjectFiles(workspaceRoot, controller, false, archiveTsConfig, context);

    // Write launch.json
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

    // Connect SFTP
    try {
        await sftpSync.setController(controller);
    } catch {
        // non-fatal
    }

    statusBar.update(controller.name);

    vscode.window.showInformationMessage(
        `RumoAppDev: Project initialized for controller "${controller.name}".`
    );
}

// ── Switch Controller Helper ──────────────────────────────────────────────────

/**
 * Performs a full controller switch:
 * 1. Updates rumo.config.json
 * 2. Handles offline mode or real controller flow
 * 3. Re-downloads/extracts d.ts as appropriate
 * 4. Updates status bar
 * 5. Reconnects or disconnects SFTP
 */
async function performControllerSwitch(
    context: vscode.ExtensionContext,
    workspaceRoot: string,
    controllerName: string
): Promise<void> {
    // 1. Update rumo.config.json
    controllerManager.setActiveControllerName(workspaceRoot, controllerName);

    // 2. Handle offline controller
    if (controllerManager.isOfflineController(controllerName)) {
        await sftpSync.setController(undefined);

        // Extract default type defs only if src/lib/ doesn’t exist yet
        const libDir = path.join(workspaceRoot, 'src', 'lib');
        if (!fs.existsSync(libDir)) {
            await typeDownloader.extractDefaultTypeDefs(context, workspaceRoot);
        }

        statusBar.update(controllerName);
        vscode.window.showInformationMessage(
            'RumoAppDev: Offline mode — using local type definitions.'
        );
        return;
    }

    // Get full controller with password
    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    if (!controller) {
        vscode.window.showErrorMessage(`RumoAppDev: Controller "${controllerName}" not found in settings.`);
        return;
    }

    // 3. Regenerate .vscode/sftp.json
    await projectSetup.generateSftpJson(workspaceRoot, controller);

    // 4. Update .vscode/launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

    // 5. Re-download d.ts + update tsconfig (returns undefined silently on failure)
    const archiveTsConfig = await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
    if (archiveTsConfig) {
        projectSetup.ensureTsConfig(workspaceRoot, true, archiveTsConfig);
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    }
    // If undefined (unreachable), keep existing src/ files silently

    // 6. Update status bar
    statusBar.update(controller.name);

    // 7. Reconnect SFTP
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

    // Handle offline controller
    if (controllerManager.isOfflineController(controller.name)) {
        const libDir = path.join(workspaceRoot, 'src', 'lib');
        if (!fs.existsSync(libDir)) {
            await typeDownloader.extractDefaultTypeDefs(context, workspaceRoot);
        }
        return;
    }

    const version = await typeDownloader.fetchControllerVersion(controller);
    const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
    const cachedVersion = context.workspaceState.get<string>(cacheKey);

    if (version && version === cachedVersion) {
        console.log(`RumoAppDev: Type defs up-to-date (version ${version}), skipping download.`);
        return;
    }

    const archiveTsConfig = await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
    if (archiveTsConfig && version) {
        await context.workspaceState.update(cacheKey, version);
    }
    // If undefined (failure), keep existing files silently
}

// ── Connection Monitor ──────────────────────────────────────────────────────

let _connectionMonitorTimer: NodeJS.Timeout | undefined;

function startConnectionMonitor(controller: import('./controllerManager').ControllerConfigWithPassword): void {
    // Clear any existing monitor
    if (_connectionMonitorTimer) {
        clearInterval(_connectionMonitorTimer);
    }

    _connectionMonitorTimer = setInterval(async () => {
        const https = await import('https');
        const reachable = await new Promise<boolean>(resolve => {
            const auth = Buffer.from(`${controller.username}:${controller.password}`).toString('base64');
            const req = https.default.request({
                hostname: controller.host,
                port: controller.httpsPort,
                path: '/~/ws/0/dev/0/fb/develop/dp/nodeDebug/dat/value',
                method: 'GET',
                headers: { 'Authorization': `Basic ${auth}` },
                rejectUnauthorized: false,
            }, res => { res.resume(); resolve(res.statusCode === 200); });
            req.on('error', () => resolve(false));
            req.setTimeout(3000, () => { req.destroy(); resolve(false); });
            req.end();
        });

        if (reachable) {
            statusBar.setConnected(controller.name);
        } else {
            statusBar.setDisconnected(controller.name);
        }
    }, 30000); // Check every 30 seconds
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

// ── Update Check ─────────────────────────────────────────────────────────────

async function checkForUpdate(context: vscode.ExtensionContext): Promise<void> {
    try {
        const currentVersion = context.extension.packageJSON.version as string;
        const GITHUB_REPO = 'arigo-software/rumo-app-dev-typescript';
        const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
        const DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;
        const LAST_CHECK_KEY = 'rumoAppDevTypescript.lastUpdateCheck';

        // Only check once per day
        const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
        const oneDayMs = 24 * 60 * 60 * 1000;
        if (Date.now() - lastCheck < oneDayMs) { return; }
        await context.globalState.update(LAST_CHECK_KEY, Date.now());

        const https = await import('https');
        const latestVersion = await new Promise<string>((resolve, reject) => {
            const req = https.get(
                RELEASES_URL,
                { headers: { 'User-Agent': 'rumo-app-dev-typescript-vscode' } },
                (res) => {
                    let data = '';
                    res.on('data', (chunk: Buffer) => data += chunk.toString());
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve((json.tag_name as string || '').replace(/^v/, ''));
                        } catch { reject(new Error('Parse error')); }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
        });

        if (!latestVersion) { return; }

        // Simple semver comparison (major.minor.patch)
        const toNum = (v: string) => v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);
        if (toNum(latestVersion) > toNum(currentVersion)) {
            const action = await vscode.window.showInformationMessage(
                `RumoAppDev: Update available — v${latestVersion} (current: v${currentVersion})`,
                'Download',
                'Dismiss'
            );
            if (action === 'Download') {
                vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
            }
        }
    } catch {
        // Silently ignore — network unavailable or API error
    }
}

// ── App File Watcher (boilerplate insertion) ─────────────────────────────────

const DEFAULT_APP_BOILERPLATE = `
// Import core app framework types and utilities
import { AppDefinition, AppHookResult, AppInstance, Request } from "lib/appDef";
import { callDpUpdate, getAsync, unpromisify } from 'lib/appUtil';
import _out from "lib/out";
import { RumoUrl } from "lib/rumoUrl";
import { SubscriptionManager } from "lib/subscriptionManager";

// Initialize logger for this app
const out = _out("MyApp");

/**
 * App instance interface defining all input, output, and internal properties.
 * Extends the base AppInstance with strongly-typed datapoints.
 */
interface MyAppInstance extends AppInstance<{
    //input
    in1: boolean; // Input datapoint that triggers updates
    //inputOutput

    //output
    out1: boolean; // Output mirrors the in1 input
    cpuUsage: number; // CPU usage percentage from system app
    freeMem: number; // Available free memory from system app

}> {
    //Definition of internal properties used in the app instance
    //best practice is to prefix them with _ to avoid name clashes with input/output properties
    _subscriptionManager: SubscriptionManager; // Manages subscriptions on database objects
    _id: any; // Unique identifier for this app instance
    _intervalId: NodeJS.Timeout; // Timer ID for periodic CPU polling
}


/**
 * Main app definition object that describes the app's lifecycle and datapoints.
 * This is the exported configuration that the framework uses to instantiate and manage the app.
 */
const appDef: AppDefinition = {
    // Define input datapoints with their types and persistence
    input: {
        in1: { type: "boolean", persistent: true, default: true } // Persistent boolean input with default value
    },
    // Define output datapoints (write-only from app perspective)
    output: {
        out1: "boolean", // Mirrors in1 value
        cpuUsage: "number", // System CPU usage
        freeMem: "number", // System free memory
    },
    createSync: function () {}, // Synchronous creation hook (empty)
    init: unpromisify(init), // Async initialization hook converted to callback function
    stop: unpromisify(cleanup), // Called when app stops
    delete: unpromisify(cleanup), // Called when app is deleted
    callback: true, // Enable async callback support
    callbackSync: true, // Enable synchronous callback support
};


/**
 * Cleanup function called when app stops or is deleted.
 * Releases resources including timers and datapoint subscriptions.
 */
async function cleanup(this: MyAppInstance): Promise<void> {
    // Stop the periodic CPU polling timer
    clearInterval(this._intervalId);
    // Close all active datapoint subscriptions
    this._subscriptionManager.close();
}

/**
 * Initialization function called when app instance is created.
 * Sets up subscriptions and periodic timers for monitoring system resources.
 */
async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    // Store the app instance ID from the request metadata
    this._id = request.body.meta.id;

    // Initialize subscription manager and subscribe to free memory datapoint
    // The subscription will automatically receive updates when the value changes
    this._subscriptionManager = new SubscriptionManager();
    const subscription = this._subscriptionManager.subscribe(new RumoUrl("/~/ws/0/dev/0/fb/Setup/dp/freeMem/dat/value"));
    subscription.on("update", onFreeMemUpdate(this));

    // Set up periodic timer to poll CPU usage every 2 seconds
    // callback() wraps the async function to work with the app framework
    this._intervalId = setInterval(this.callback(unpromisify(onTimeout)), 2000);
}

/**
 * Handler for free memory datapoint updates.
 * Returns a closure that updates the app's freeMem output when the subscribed datapoint changes.
 */
function onFreeMemUpdate(that: MyAppInstance) { return function( freeMem: number){
    // Use callbackSync to execute within the app's synchronous callback context
    that.callbackSync(function (this: MyAppInstance){
        // Update the output datapoint with new free memory value
        this.freeMem = freeMem;
        out.info("freeMem update", freeMem);
        // Return name of updated datapoint to notify framework
        return "freeMem";
    })();
};}

/**
 * Periodic timer callback that polls CPU usage.
 * Called every 2 seconds by the interval timer set up in init().
 */
async function onTimeout(this: MyAppInstance): Promise<AppHookResult> {
    // Fetch current CPU usage from system datapoint
    this.cpuUsage = (await getAsync("/~/ws/0/dev/0/fb/Setup/dp/cpuUsage/dat/value")).body;
    out.info("onTimeout cpuUsage", this.cpuUsage);
    // Return name of updated datapoint to notify framework
    return "cpuUsage";
}

// Define update handlers for input datapoints
// These functions are called when input values change
appDef.update = callDpUpdate(appDef, {
    in1: unpromisify(updateIn1), // Handler for in1 input changes
});

/**
 * Update handler called when in1 input datapoint changes.
 * Mirrors the input value to the out1 output datapoint.
 */
async function updateIn1(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    // Ignore updates coming from database initialization (only process real-time changes)
    if (request.fromDatabase) return false;
    // Mirror input to output
    this.out1 = this.in1;
    // Return name of updated datapoint
    return "out1";
}

//-------------------------------------------------------------------------------------------------
// Export the app definition for the framework to load
export = appDef;
`.trimStart();

const LOCAL_APP_BOILERPLATE = DEFAULT_APP_BOILERPLATE;

function setupAppFileWatcher(context: vscode.ExtensionContext): void {
    const insertBoilerplate = async (uri: vscode.Uri) => {
        try {
            await new Promise(r => setTimeout(r, 300));

            // Open document and check content via VS Code (not disk stat)
            const doc = await vscode.workspace.openTextDocument(uri);
            if (doc.getText().trim().length > 0) { return; }

            const isDefault = path.basename(uri.fsPath) === '_default.ts';
            const boilerplate = isDefault ? DEFAULT_APP_BOILERPLATE : LOCAL_APP_BOILERPLATE;

            // Insert via editor API so VS Code sees the change immediately
            const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(0, 0), boilerplate);
            });
            await doc.save();

            console.log(`RumoAppDev: Inserted boilerplate into ${uri.fsPath}`);
        } catch (err) {
            console.error(`RumoAppDev: Failed to insert boilerplate: ${(err as Error).message}`);
        }
    };

    const watcherDefault = vscode.workspace.createFileSystemWatcher('**/type/app/**/_default.ts');
    const watcherLocal = vscode.workspace.createFileSystemWatcher('**/type/app/**/local.ts');

    watcherDefault.onDidCreate(insertBoilerplate);
    watcherLocal.onDidCreate(insertBoilerplate);

    // Also trigger on document open — catches cases where watcher fires late
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (doc) => {
            const name = path.basename(doc.uri.fsPath);
            const inTypeDir = doc.uri.fsPath.includes(`${path.sep}type${path.sep}app${path.sep}`);
            if (name !== '_default.ts' && name !== 'local.ts') { return; }
            if (!inTypeDir) { return; }
            if (doc.getText().trim().length > 0) { return; }
            await insertBoilerplate(doc.uri);
        })
    );

    context.subscriptions.push(watcherDefault, watcherLocal);
}

// ── cmdSetDebugMode ───────────────────────────────────────────────────────────

async function cmdSetDebugMode(context: vscode.ExtensionContext): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const controller = await controllerManager.getActiveControllerWithPassword(workspaceRoot);
    if (!controller) {
        vscode.window.showWarningMessage('RumoAppDev: No active controller configured.');
        return;
    }

    await debugMode.toggleDebugMode(controller);
}
