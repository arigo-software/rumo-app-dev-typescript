import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ControllerConfig } from './controllerManager';

interface LaunchConfig {
    version: string;
    configurations: LaunchConfigEntry[];
}

interface LaunchConfigEntry {
    name: string;
    type: string;
    request: string;
    port: number;
    address: string;
    protocol: string;
    localRoot: string;
    remoteRoot: string;
    smartStep: boolean;
    sourceMapPathOverrides: Record<string, string>;
    skipFiles: string[];
}

export class DebugConfig {
    /**
     * Generates or updates .vscode/launch.json for the given controller.
     * The VERSION is fetched from the controller's HTTPS API.
     */
    public async updateLaunchJson(
        controller: ControllerConfig,
        workspaceRoot: string,
        version: string | undefined
    ): Promise<void> {
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        if (!fs.existsSync(vscodeDir)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
        }

        const launchPath = path.join(vscodeDir, 'launch.json');
        const ver = version ?? 'unknown';
        const remoteRoot = `/usr/lib/arigo/rumo/rumo_${ver}`;

        const newEntry: LaunchConfigEntry = {
            name: controller.name,
            type: 'node',
            request: 'attach',
            port: 9229,
            address: controller.host,
            protocol: 'inspector',
            localRoot: '${workspaceFolder}',
            remoteRoot,
            smartStep: true,
            sourceMapPathOverrides: {
                [`${remoteRoot}/type/*`]: '${workspaceFolder}/src/type/*',
            },
            skipFiles: [
                '<node_internals>/**/*.js',
                '<eval>/*',
                '${workspaceFolder}/node_modules/**/*.js',
            ],
        };

        let launchConfig: LaunchConfig;

        if (fs.existsSync(launchPath)) {
            try {
                const raw = fs.readFileSync(launchPath, 'utf8');
                launchConfig = JSON.parse(raw) as LaunchConfig;
            } catch {
                launchConfig = { version: '0.2.0', configurations: [] };
            }
        } else {
            launchConfig = { version: '0.2.0', configurations: [] };
        }

        // Replace existing entry with the same name, or append
        const idx = launchConfig.configurations.findIndex(c => c.name === controller.name);
        if (idx >= 0) {
            launchConfig.configurations[idx] = newEntry;
        } else {
            launchConfig.configurations.push(newEntry);
        }

        fs.writeFileSync(launchPath, JSON.stringify(launchConfig, null, 2), 'utf8');
        vscode.window.showInformationMessage(
            `RumoAppDev: launch.json updated for controller "${controller.name}" (version: ${ver}).`
        );
    }
}
