import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { ControllerConfigWithPassword } from './controllerManager';

// ── Types ──────────────────────────────────────────────────────────────────────

interface AppRegistration {
    namespace: string;
    group: string;
    singleton: boolean;
}

// ── REST helpers ───────────────────────────────────────────────────────────────

function rumoRequest(
    controller: ControllerConfigWithPassword,
    method: string,
    urlPath: string,
    body?: unknown
): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
        const options: https.RequestOptions = {
            hostname: controller.host,
            port: controller.httpsPort,
            path: urlPath,
            method,
            rejectUnauthorized: false,
            auth: `${controller.username}:${controller.password}`,
            headers: {
                'Content-Type': 'application/json',
                ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => (data += chunk.toString()));
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
        if (bodyStr) { req.write(bodyStr); }
        req.end();
    });
}

/** Check if a system rumo device for this namespace already exists on the controller. */
async function deviceExists(controller: ControllerConfigWithPassword, namespace: string): Promise<boolean> {
    try {
        const res = await rumoRequest(
            controller,
            'GET',
            `/~/type/dev/rumo/system/${namespace}/~/meta/label`
        );
        return res.statusCode === 200;
    } catch {
        return false;
    }
}

/** Create a new system rumo device instance on the controller. */
async function createDevice(controller: ControllerConfigWithPassword, namespace: string): Promise<void> {
    const body = {
        meta: {
            type: `/~/type/dev/rumo/system/${namespace}`,
            label: namespace,
            alias: namespace,
        },
    };
    const res = await rumoRequest(controller, 'POST', '/~', body);
    if (res.statusCode !== 200 && res.statusCode !== 201) {
        throw new Error(`Failed to create device (HTTP ${res.statusCode}): ${res.body}`);
    }
}

/** Trigger "Request Template" on an existing device to apply template changes. */
async function requestTemplate(controller: ControllerConfigWithPassword, namespace: string): Promise<void> {
    // Find the device id by listing devices of this type
    const listRes = await rumoRequest(
        controller,
        'GET',
        `/~/ws/0/tag/obj/meta/type?tag=/~/type/dev/rumo/system/${namespace}`
    );
    if (listRes.statusCode !== 200) {
        throw new Error(`Could not find device for namespace "${namespace}" (HTTP ${listRes.statusCode})`);
    }
    let devPath: string;
    try {
        const data = JSON.parse(listRes.body);
        // Response is an object keyed by device path
        const keys = Object.keys(data);
        if (keys.length === 0) { throw new Error('No device found'); }
        devPath = keys[0]; // e.g. /~/ws/0/dev/101
    } catch (e) {
        throw new Error(`Could not parse device list: ${(e as Error).message}`);
    }

    // POST requestTemplate command
    const res = await rumoRequest(controller, 'POST', `${devPath}/cmd/requestTemplate`, {});
    if (res.statusCode !== 200 && res.statusCode !== 204) {
        throw new Error(`requestTemplate failed (HTTP ${res.statusCode}): ${res.body}`);
    }
}

// ── Template file helpers ──────────────────────────────────────────────────────

/**
 * Build the cap/fb/type entry for one app.
 */
function buildCapEntry(appTypePath: string, group: string, singleton: boolean): object {
    const entry: Record<string, unknown> = {
        required: true,
        properties: {
            min: { required: true, default: singleton ? 1 : 0 },
            group: { required: true, default: group },
        },
    };
    if (singleton) {
        (entry.properties as Record<string, unknown>)['max'] = { required: true, default: 1 };
    }
    return entry;
}

/**
 * Read existing template JSON or create a minimal skeleton.
 */
function readOrCreateTemplate(templatePath: string, namespace: string): Record<string, unknown> {
    if (fs.existsSync(templatePath)) {
        try {
            return JSON.parse(fs.readFileSync(templatePath, 'utf8'));
        } catch {
            // fall through to create new
        }
    }
    return {
        id: `/~/type/dev/rumo/system/${namespace}`,
        extends: '/~/type/dev/rumo',
        properties: {
            meta: {
                properties: {
                    label: { default: namespace },
                    hardwareType: { default: 'Ethernet' },
                },
            },
            fb: {
                type: 'object',
                description: 'Describes the blocks of a device',
                required: true,
                default: {},
                properties: {},
            },
            cap: {
                required: true,
                properties: {
                    fb: {
                        required: true,
                        properties: {
                            type: {
                                required: true,
                                properties: {},
                            },
                        },
                    },
                },
            },
        },
    };
}

/**
 * Add an app entry to the template JSON and write it to disk.
 */
function addAppToTemplate(
    templatePath: string,
    namespace: string,
    appName: string,
    group: string,
    singleton: boolean
): void {
    const template = readOrCreateTemplate(templatePath, namespace);

    // Navigate / create the nested structure
    const props = template.properties as Record<string, unknown>;
    const cap = props['cap'] as Record<string, unknown>;
    const capProps = cap['properties'] as Record<string, unknown>;
    const fb = capProps['fb'] as Record<string, unknown>;
    const fbProps = fb['properties'] as Record<string, unknown>;
    const type = fbProps['type'] as Record<string, unknown>;
    const typeProps = type['properties'] as Record<string, unknown>;

    const appTypePath = `/~/type/app/${namespace}/${appName}`;
    typeProps[appTypePath] = buildCapEntry(appTypePath, group, singleton);

    // Ensure directory exists
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.writeFileSync(templatePath, JSON.stringify(template, null, 2), 'utf8');
}

// ── Group icon directory helpers ───────────────────────────────────────────────

/**
 * Ensure the _group/{namespace}/{groupFolder}/ directory exists in the workspace.
 * Creates a .gitkeep so git tracks the (otherwise empty) directory.
 */
function ensureGroupIconDir(workspaceRoot: string, namespace: string, groupFolder: string): void {
    const dir = path.join(workspaceRoot, 'controller', 'type', '_group', namespace);
    fs.mkdirSync(dir, { recursive: true });
    const gitkeep = path.join(dir, '.gitkeep');
    if (!fs.existsSync(gitkeep)) {
        fs.writeFileSync(gitkeep, '', 'utf8');
    }
    // Placeholder file — SFTP plugin needs at least one file to create the dir on the controller
    const placeholder = path.join(dir, `${groupFolder}.svg`);
    if (!fs.existsSync(placeholder)) {
        // Write a minimal valid SVG as placeholder
        fs.writeFileSync(
            placeholder,
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>',
            'utf8'
        );
    }
}

// ── Existing namespace/group discovery ────────────────────────────────────────

/**
 * Find all namespaces already defined in controller/type/dev/rumo/system/
 */
function findExistingNamespaces(workspaceRoot: string): string[] {
    const systemDir = path.join(workspaceRoot, 'controller', 'type', 'dev', 'rumo', 'system');
    if (!fs.existsSync(systemDir)) { return []; }
    return fs.readdirSync(systemDir).filter(name => {
        const templateFile = path.join(systemDir, name, '_default.json');
        return fs.existsSync(templateFile);
    });
}

/**
 * Find all groups already defined in a namespace template.
 */
function findExistingGroups(workspaceRoot: string, namespace: string): string[] {
    const templatePath = path.join(
        workspaceRoot, 'controller', 'type', 'dev', 'rumo', 'system', namespace, '_default.json'
    );
    if (!fs.existsSync(templatePath)) { return []; }
    try {
        const t = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const any = t as any;
        const typeProps: Record<string, unknown> =
            any?.properties?.cap?.properties?.fb?.properties?.type?.properties ?? {};
        const groups = new Set<string>();
        for (const entry of Object.values(typeProps)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const group: string = (entry as any)?.properties?.group?.default ?? '';
            if (group) { groups.add(group.split('/')[0]); }
        }
        return [...groups];
    } catch {
        return [];
    }
}

// ── Main command ───────────────────────────────────────────────────────────────

export async function cmdAddAppToProjectEditor(
    context: vscode.ExtensionContext,
    fileUri: vscode.Uri,
    getController: () => Promise<ControllerConfigWithPassword | undefined>
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('RumoAppDev: No workspace folder open.');
        return;
    }

    // Derive app name from file path: .../type/app/{namespace}/{appName}/_default.ts
    const filePath = fileUri.fsPath;
    const typeAppIdx = filePath.split(path.sep).lastIndexOf('app');
    const parts = filePath.split(path.sep).slice(typeAppIdx + 1);
    // parts = [namespace?, ..., appName, _default.ts] OR just [appName, _default.ts]
    const appName = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (!appName) {
        vscode.window.showErrorMessage('RumoAppDev: Could not determine app name from file path.');
        return;
    }

    // ── Step 1: Namespace ──────────────────────────────────────────────────────
    const existingNamespaces = findExistingNamespaces(workspaceRoot);
    const namespaceItems: vscode.QuickPickItem[] = [
        ...existingNamespaces.map(n => ({ label: n, description: 'existing' })),
        { label: '$(add) Create new namespace...', description: '' },
    ];

    const nsPick = await vscode.window.showQuickPick(namespaceItems, {
        title: 'Add App to Project Editor (1/3)',
        placeHolder: 'Select or create a namespace (device name)',
    });
    if (!nsPick) { return; }

    let namespace: string;
    if (nsPick.label.startsWith('$(add)')) {
        const input = await vscode.window.showInputBox({
            title: 'New namespace name',
            prompt: 'Enter a namespace name (e.g. "myApps"). This becomes the device name in the Project Editor.',
            validateInput: v => /^[a-zA-Z0-9_-]+$/.test(v) ? undefined : 'Only letters, digits, _ and - allowed',
        });
        if (!input) { return; }
        namespace = input;
    } else {
        namespace = nsPick.label;
    }

    // ── Step 2: Group ──────────────────────────────────────────────────────────
    const existingGroups = findExistingGroups(workspaceRoot, namespace);
    const groupItems: vscode.QuickPickItem[] = [
        ...existingGroups.map(g => ({ label: g, description: 'existing' })),
        { label: '$(add) Create new group...', description: '' },
    ];

    const groupPick = await vscode.window.showQuickPick(groupItems, {
        title: 'Add App to Project Editor (2/3)',
        placeHolder: 'Select or create a group folder',
    });
    if (!groupPick) { return; }

    let groupFolder: string;
    if (groupPick.label.startsWith('$(add)')) {
        const input = await vscode.window.showInputBox({
            title: 'New group name',
            prompt: 'Enter a group folder name (e.g. "math", "logic", "settings")',
            validateInput: v => /^[a-zA-Z0-9_-]+$/.test(v) ? undefined : 'Only letters, digits, _ and - allowed',
        });
        if (!input) { return; }
        groupFolder = input;
    } else {
        groupFolder = groupPick.label;
    }

    const group = `${groupFolder}/${appName}`;

    // ── Step 3: Singleton or multi-instance ───────────────────────────────────
    const instancePick = await vscode.window.showQuickPick(
        [
            { label: 'Multiple instances', description: 'App can be added multiple times', value: false },
            { label: 'Singleton', description: 'App can only be added once', value: true },
        ],
        {
            title: 'Add App to Project Editor (3/3)',
            placeHolder: 'How many instances of this app are allowed?',
        }
    );
    if (!instancePick) { return; }
    const singleton = instancePick.value;

    // ── Write template file ────────────────────────────────────────────────────
    const templatePath = path.join(
        workspaceRoot, 'controller', 'type', 'dev', 'rumo', 'system', namespace, '_default.json'
    );
    const isNewNamespace = !existingNamespaces.includes(namespace);
    const isNewGroup = !existingGroups.includes(groupFolder);

    addAppToTemplate(templatePath, namespace, appName, group, singleton);
    vscode.window.showInformationMessage(`RumoAppDev: Added "${appName}" to template for namespace "${namespace}".`);

    // Ensure group icon directory exists (with placeholder SVG)
    if (isNewGroup) {
        ensureGroupIconDir(workspaceRoot, namespace, groupFolder);
    }

    // ── Apply to controller ────────────────────────────────────────────────────
    const controller = await getController();
    if (!controller) {
        vscode.window.showWarningMessage('RumoAppDev: No controller configured — template saved locally only. Apply manually on the controller.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'RumoAppDev: Applying changes to controller…',
            cancellable: false,
        },
        async (progress) => {
            try {
                const exists = await deviceExists(controller, namespace);

                if (!exists) {
                    // New device: deploy template via SFTP first, then create device instance
                    progress.report({ message: 'Creating new device on controller…' });

                    // Trigger SFTP upload by opening the template file in VS Code
                    const templateUri = vscode.Uri.file(templatePath);
                    const doc = await vscode.workspace.openTextDocument(templateUri);
                    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                    // Touch the file to trigger SFTP upload
                    await editor.edit(eb => eb.insert(new vscode.Position(0, 0), ''));
                    await editor.edit(eb => {
                        const text = doc.getText();
                        if (text.startsWith('\n') || text.startsWith(' ')) {
                            eb.delete(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)));
                        }
                    });
                    await doc.save();

                    // Wait for SFTP to upload
                    progress.report({ message: 'Waiting for SFTP upload…' });
                    await new Promise(r => setTimeout(r, 3000));

                    // Create device instance via REST
                    progress.report({ message: 'Creating device instance…' });
                    await createDevice(controller, namespace);

                    vscode.window.showInformationMessage(
                        `RumoAppDev: Device "${namespace}" created. Reload the Project Editor page to see your app.`
                    );
                } else {
                    // Existing device: deploy template via SFTP, then request template update
                    const templateUri = vscode.Uri.file(templatePath);
                    const doc = await vscode.workspace.openTextDocument(templateUri);
                    const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                    await editor.edit(eb => eb.insert(new vscode.Position(0, 0), ''));
                    await editor.edit(eb => {
                        const text = doc.getText();
                        if (text.startsWith('\n') || text.startsWith(' ')) {
                            eb.delete(new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)));
                        }
                    });
                    await doc.save();

                    progress.report({ message: 'Waiting for SFTP upload…' });
                    await new Promise(r => setTimeout(r, 3000));

                    progress.report({ message: 'Requesting template update on controller (this may take a moment)…' });
                    await requestTemplate(controller, namespace);

                    vscode.window.showInformationMessage(
                        `RumoAppDev: Template updated for "${namespace}". Reload the Project Editor page to see your app.`
                    );
                }
            } catch (err) {
                vscode.window.showErrorMessage(`RumoAppDev: ${(err as Error).message}`);
            }
        }
    );
}
