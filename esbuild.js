const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Clean out/ directory first (remove old tsc artifacts)
const outDir = path.join(__dirname, 'out');
if (fs.existsSync(outDir)) {
    for (const file of fs.readdirSync(outDir)) {
        if (file !== 'test') {
            fs.rmSync(path.join(outDir, file), { recursive: true, force: true });
        }
    }
}

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode', 'ssh2-sftp-client', 'ssh2', 'lzma-native'],  // native modules can't be bundled
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    minify: false,
}).catch(() => process.exit(1));
