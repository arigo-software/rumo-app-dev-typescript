#!/bin/bash
set -e
PROJ="/home/agent/.openclaw/workspace/projects/rumo-app-dev"
VSCE_GLOBAL="/home/agent/.npm/_npx/66fbc91407e86cd3/node_modules/@vscode/vsce/vsce"
cd "$PROJ"

# Step 1: Bundle with dev deps present
echo "→ Bundling TypeScript..."
node esbuild.js

# Step 2: Temporarily disable prepublish so vsce doesn't re-run it
sed -i 's/"vscode:prepublish": "npm run bundle"/"vscode:prepublish": "echo skip"/' package.json

# Step 3: Swap node_modules to prod-only
echo "→ Swapping to prod node_modules..."
mv node_modules node_modules_dev
cp -r /tmp/sftp-test/node_modules .
echo "   prod modules: $(ls node_modules | wc -l)"

# Step 4: Temporarily allow node_modules in VSIX
sed -i 's|^node_modules/\*\*$|# node_modules included for prod deps|' .vscodeignore

# Step 5: Package
echo "→ Packaging VSIX..."
"$VSCE_GLOBAL" package || true

# Step 6: Always restore
echo "→ Restoring..."
sed -i 's|^# node_modules included for prod deps$|node_modules/**|' .vscodeignore
rm -rf node_modules
mv node_modules_dev node_modules
sed -i 's/"vscode:prepublish": "echo skip"/"vscode:prepublish": "npm run bundle"/' package.json

echo "✅ Done!"
ls -la "$PROJ"/rumo-app-dev-*.vsix | tail -5
