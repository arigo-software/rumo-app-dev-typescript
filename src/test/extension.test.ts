import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

suite('Boilerplate Watcher Test', () => {

    let testDir: string;

    setup(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rumo-test-'));
        fs.mkdirSync(path.join(testDir, 'src', 'type', 'app', 'myapp'), { recursive: true });
    });

    teardown(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('Boilerplate inserted into new empty _default.ts', async () => {
        const filePath = path.join(testDir, 'src', 'type', 'app', 'myapp', '_default.ts');

        // Create empty file (simulates user creating new file in VS Code)
        fs.writeFileSync(filePath, '');

        // Open in VS Code to trigger FileSystemWatcher
        const uri = vscode.Uri.file(filePath);
        await vscode.workspace.openTextDocument(uri);

        // Wait for watcher to fire and boilerplate to be inserted
        await new Promise(r => setTimeout(r, 1500));

        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('AppDefinition'), `Expected boilerplate, got: "${content.substring(0, 100)}"`);
        assert.ok(content.includes('export = appDef'), 'Expected export = appDef');
    });

    test('Boilerplate NOT inserted into non-empty _default.ts', async () => {
        const filePath = path.join(testDir, 'src', 'type', 'app', 'myapp', '_default.ts');
        const existingContent = '// existing content\n';
        fs.writeFileSync(filePath, existingContent);

        const uri = vscode.Uri.file(filePath);
        await vscode.workspace.openTextDocument(uri);
        await new Promise(r => setTimeout(r, 1500));

        const content = fs.readFileSync(filePath, 'utf8');
        assert.strictEqual(content, existingContent, 'Existing content should not be overwritten');
    });
});
