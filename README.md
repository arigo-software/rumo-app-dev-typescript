# rumo-app-dev (TypeScript)

A comprehensive VS Code extension for developing, debugging, and deploying ARIGO Rumo applications with **TypeScript support**. This plugin streamlines the workflow for TypeScript/JavaScript app development targeting the ARIGO Rumo IoT platform.

## Features

### 🚀 Quick Start & Setup

- **Auto-Configuration**: Automatically creates required project structure (`tsconfig.json`, `.gitignore`, build directories)
- **Multiple Controllers**: Manage connections to multiple Rumo controllers with easy switching
- **One-Click Setup**: Initialize new projects with a single command

### 📦 Development Tools

- **TypeScript Support**: Full TypeScript compilation with source map generation
- **Type Definitions**: Auto-download of `d.ts` files from controller (`/user/dts/`)
- **Watch Mode**: Use `tsc --watch` for continuous compilation during development
- **Intelligent Build**: Compile TypeScript to JavaScript with proper source mapping

### 🔧 Deployment

- **SFTP Upload**: Direct upload to controller's `/type/` directory via SFTP
- **Automatic Verification**: Verify successful deployment on the controller
- **Version Tracking**: Monitor controller version and API compatibility

### 🐛 Debugging

- **Chrome DevTools Integration**: Attach debugger via Chrome DevTools Protocol (CDP)
- **Breakpoint Support**: Set breakpoints, step through code, inspect variables
- **Live Source Maps**: Debug TypeScript code directly with source maps
- **Remote Inspection**: Connect to Node.js Inspector on controller port 9229

## Installation

### Option 1: Install from GitHub Releases (Recommended)

1. **Download** the latest `.vsix` file from [GitHub Releases](https://github.com/arigo-software/rumo-app-dev-typescript/releases)
2. **Install** in VS Code: Extensions (`Ctrl+Shift+X`) → `...` menu → **Install from VSIX...** → select the file
3. **Restart** VS Code

Or from terminal:
```bash
wget https://github.com/arigo-software/rumo-app-dev-typescript/releases/download/latest/rumo-app-dev-typescript.vsix
code --install-extension rumo-app-dev-typescript.vsix
```

### Option 2: Install from Open VSX (code-server / VSCodium)

```bash
wget "https://open-vsx.org/api/arigo-software/rumo-app-dev-typescript/latest/file/arigo-software.rumo-app-dev-typescript.latest.vsix"
code-server --install-extension rumo-app-dev-typescript.latest.vsix
```

## Getting Started

### 1. Initialize a Project

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Search for: **"Rumo: Initialize Project"**
3. Enter your controller details:
   - **Controller Host**: IP address or hostname (e.g., `192.168.1.100`)
   - **Controller Port**: HTTPS port (default: `443`)
   - **Username**: Rumo user account
   - **Password**: User password
4. Choose your app directory (if developing multiple apps)

### 2. Manage Controllers

If you need to work with multiple controllers or update existing ones:

#### Add a Controller
1. Command Palette → **"RumoAppDev: Add Controller"**
2. Enter controller details (name, host, ports, username, password)
3. In a Rumo project, the new controller is automatically set as active

#### Switch Active Controller
1. Command Palette → **"RumoAppDev: Switch Controller"**
2. Select from the list — SFTP, type definitions and debug config are updated automatically

#### Edit a Controller
1. Command Palette → **"RumoAppDev: Edit Controller"**
2. Select the controller to edit
3. Update any field (name, host, ports, username, password)
4. Leave the password field empty to keep the current password
5. If the active controller was edited, the connection is automatically refreshed

#### Change Controller Password
1. Command Palette → **"RumoAppDev: Change Controller Password"**
2. Select the controller
3. Enter the new password — stored securely in VS Code SecretStorage
4. If the active controller, SFTP reconnects automatically

#### Delete a Controller
1. Command Palette → **"RumoAppDev: Delete Controller"**
2. Select the controller to delete
3. Confirm deletion (irreversible)
4. Passwords are removed from SecretStorage
5. If the active controller was deleted, you are prompted to switch to another

### 3. Build & Deploy

#### Build (TypeScript → JavaScript)

Use TypeScript compiler in watch mode for development:
```bash
npm run watch
# or for single build:
npm run build
```

This compiles TypeScript from `src/type/` to JavaScript in `build/type/`. The watch mode automatically recompiles when you save changes.

#### Deploy to Controller

The plugin automatically uploads compiled files to the controller after each successful build.
No manual step required.

### 4. Debug Your App

#### Attach Debugger
1. Enable debug mode on the controller first (see [Debug Control Packages](#debug-control-packages))
2. Open **Run and Debug** panel (`Ctrl+Shift+D`)
3. Select your controller from the dropdown
4. Click **Start Debugging** (`F5`)

#### In VS Code Debugger
- Set breakpoints directly in your `.ts` source files
- Step through code (`F10` = step over, `F11` = step into)
- Inspect variables in the Variables panel
- View call stack and execution context

#### ⚠️ Important Debug Notes
- **Resume quickly**: If you hit a breakpoint during startup, resume within a few seconds. **Important**: While paused, the entire controller is halted!
- **Use conditional breakpoints** for long-running loops to avoid watchdog timeouts

### 5. File Structure

After initialization, your project looks like this:

```
my-rumo-app/
├── src/
│   ├── type/
│   │   └── app/
│   │       └── [appname]/
│   │           └── _default.ts    # Your app source code
│   ├── lib/
│   │   └── *.d.ts                 # Type definitions (auto-downloaded)
│   └── ...
├── build/
│   ├── type/
│   │   └── app/...                # Compiled JavaScript (deployed to controller)
│   └── ...
├── controller/
│   └── type/                       # SFTP plugin mirror of /type/ from controller
│   └── ...
├── tsconfig.json                   # TypeScript config (auto-generated)
├── package.json                    # Dependencies
├── .gitignore                      # Git ignore (auto-generated)
├── .vscode/
│   ├── launch.json                # Debug configuration
│   └── sftp.json                  # SFTP config (auto-generated, git-ignored)
└── README.md
```

## Configuration

### Controller Configuration

The plugin stores controller details in VS Code settings under:
```
rumoAppDev.controllers
```

Example (`settings.json`):
```json
{
  "rumoAppDev.controllers": [
    {
      "name": "Lab Controller",
      "host": "192.168.1.100",
      "port": 443,
      "username": "admin"
    }
  ]
}
```

### SFTP Configuration

The plugin generates `sftp.json` automatically (git-ignored). For manual tweaking:
- Created in `.vscode/sftp.json`
- Contains SSH key path, server credentials, and folder sync settings
- **Syncs `/type/` folder from controller** — mirrors the remote filesystem locally in `controller/type/`
- Do **not** commit this file to version control

### TypeScript Configuration

The `tsconfig.json` is auto-generated with:
- **Target**: ES2021
- **Module**: CommonJS
- **Source Maps**: Enabled for debugging
- **Lib Paths**: Automatically configured for Rumo types
- **typeRoots**: `src/node_modules/@types` (downloaded from controller) + `node_modules/@types` (local)

### Node.js Type Definitions

Standard Node.js types (`NodeJS.Timeout`, `fs`, `Buffer`, etc.) are provided automatically — no manual import needed.

The controller ships matching `@types/node` (and potentially other packages) under `/user/dts/node_modules/@types/`. These are downloaded alongside the Rumo type definitions into `src/node_modules/@types/` and are excluded from version control (`src/node_modules/` is in `.gitignore`).

To add types for additional packages, place them under `/user/dts/node_modules/@types/<package>/` on the controller — they will be picked up on the next type definition download.

## Debug Control Packages

ARIGO provides helper packages (`enableDebug` and `disableDebug`) that must be installed on the controller to enable/disable debugging capabilities. Without these packages, the controller cannot be switched into debug mode.

Contact ARIGO to obtain and install these packages on your controller.

## Troubleshooting

### Controller Connection Failed
- Verify the controller IP/hostname is reachable
- Check username and password are correct
- Ensure HTTPS port (default 443) is accessible
- Check controller logs for authentication issues

### Deployment Hangs
- Check your network connection
- Verify SFTP port (usually 22) is open
- Try deploying a simpler app to isolate the issue
- Check controller disk space

### Debugger Won't Attach
- Ensure controller port 9229 is accessible
- Verify the app is running (check controller logs)
- Try restarting the app via the Rumo control panel
- Check if debug mode is enabled on controller

### Build Errors
- Run `npm install` to ensure dependencies are installed
- Check TypeScript version: `npm list typescript`
- Verify `src/lib/*.d.ts` files are present (re-download if missing)
- Check `tsconfig.json` compiler options

### SFTP Upload Issues
- Verify SSH key is properly configured (plugin generates it automatically)
- Check file permissions on controller (especially `/type/` directory)
- Try uploading a test file manually via SFTP client
- Check available disk space on controller

## Development Workflow (Example)

```
1. Open project folder in VS Code
2. Command Palette → "Rumo: Initialize Project" → enter controller details
3. Create src/type/app/myapp/_default.ts (boilerplate inserted automatically)
4. Build: Ctrl+Shift+B (or: npm run watch for continuous compilation)
5. Deploy: happens automatically after build
6. Debug: Run and Debug panel → select controller → F5
```

## Tips & Best Practices

### ✅ Do's

- Use TypeScript for type safety and better IDE support
- Set up source control (git) for your app
- Use conditional breakpoints in the debugger to avoid watchdog timeouts
- Regularly check controller logs for errors
- Test deployments on a dev controller before production

### ❌ Don'ts

- Don't pause long in the debugger during `init()` — the watchdog will kill your process
- Don't commit `.vscode/sftp.json` (it contains credentials)
- Don't use `console.log` for sensitive data in production
- Don't deploy directly to production without testing
- Don't modify compiled code in `build/` — always edit `src/`

## API Reference

For detailed API documentation and app development guide, refer to the ARIGO Programmer's Guide.

## Support

- **Issues**: Report plugin issues to your ARIGO support contact
- **Questions**: Reach out to the ARIGO development team

## Version History

See [GitHub Releases](https://github.com/arigo-software/rumo-app-dev-typescript/releases) for full version history and changelog.

**Latest Release Features:**
- Full TypeScript support with source maps and watch mode
- Multi-controller management with SecretStorage
- Chrome DevTools debugging integration
- Automatic SFTP deployment
- Type definition auto-download
- GitHub Releases distribution

## License

Proprietary — ARIGO Software GmbH. All rights reserved.

This extension includes open source components. See `THIRD_PARTY_NOTICES.md` (included in the extension directory) for details.

---

**Latest Release**: [GitHub Releases](https://github.com/arigo-software/rumo-app-dev-typescript/releases)  
**Repository**: [arigo-software/rumo-app-dev-typescript](https://github.com/arigo-software/rumo-app-dev-typescript)
