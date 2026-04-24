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

    // Step 3: Download d.ts + get archive tsconfig
    let archiveTsConfig: Record<string, unknown> | undefined;
    const version = await typeDownloader.fetchControllerVersion(controller);
    try {
        archiveTsConfig = await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        if (version) {
            const cacheKey = `${VERSION_CACHE_KEY}.${controller.name}`;
            await context.workspaceState.update(cacheKey, version);
        }
    } catch {
        // Error already shown, continue with fallback tsconfig
    }

    // Step 4: Create project files (tsconfig uses archive base if available)
    await projectSetup.setupProjectFiles(workspaceRoot, controller, false, archiveTsConfig);

    // Write rumo.config.json (activeController)
    controllerManager.setActiveControllerName(workspaceRoot, controllerName!);

    // Write launch.json
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

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
    await projectSetup.generateSftpJson(workspaceRoot, controller);

    // 3. Update .vscode/launch.json
    const version = await typeDownloader.fetchControllerVersion(controller);
    await debugConfig.updateLaunchJson(controller, workspaceRoot, version);

    // 4. Re-download d.ts + update tsconfig
    try {
        const archiveTsConfig = await typeDownloader.downloadTypeDefs(controller, workspaceRoot);
        if (archiveTsConfig) {
            projectSetup.ensureTsConfig(workspaceRoot, true, archiveTsConfig);
        }
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

// ── App File Watcher (boilerplate insertion) ─────────────────────────────────

const DEFAULT_APP_BOILERPLATE = `
import { AppDefinition, AppHookResult, AppInstance, Request } from "lib/appDef";
import { callDpUpdate, getAsync, unpromisify } from 'lib/appUtil';
import _out from "lib/out";
const out = _out("MyApp");

interface MyAppInstance extends AppInstance<{
    //input
    in1: boolean;
    //inputOutput

    //output
    out1: boolean;
    cpuUsage: number;

}> {
    //Definition of internal properties used in the app instance
    //best practice is to prefix them with _ to avoid name clashes with input/output properties
    _id: any;
    _intervalId: NodeJS.Timeout;
}


const appDef: AppDefinition = {
    input: {
        in1: { type: "boolean", persistent: true, default: true }
    },
    output: {
        out1: "boolean",
        cpuUsage: "number"
    },
    createSync: function () {},
    init: unpromisify(init),
    stop: unpromisify(cleanup),
    delete: unpromisify(cleanup),
    callback: true,
};


async function cleanup(this: MyAppInstance): Promise<void> {
    clearInterval(this._intervalId);
}

async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    this._id = request.body.meta.id;

    this._intervalId = setInterval(this.callback(unpromisify(onTimeout)), 2000);
}

async function onTimeout(this: MyAppInstance): Promise<AppHookResult> {
    this.cpuUsage = (await getAsync("/~/ws/0/dev/0/fb/Setup/dp/cpuUsage/dat/value")).body;
    out.info("onTimeout cpuUsage", this.cpuUsage);
    return "cpuUsage";
}

appDef.update = callDpUpdate(appDef, {
    in1: unpromisify(updateIn1),
});

async function updateIn1(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) return false;
    this.out1 = this.in1;
    return "out1";
}

//-------------------------------------------------------------------------------------------------
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
