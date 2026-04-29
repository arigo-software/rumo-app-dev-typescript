# Rumo App Development Guidelines

## Overview

Rumo is a TypeScript/Node.js IoT framework for datapoint-driven apps. Apps run on ARIGO Rumo controllers and react to datapoint changes via a lifecycle + callback system.

## Required Imports

```typescript
import { AppDefinition, AppHookResult, AppInstance, Request } from "lib/appDef";
import { callDpUpdate, getAsync, unpromisify } from 'lib/appUtil';
import _out from "lib/out";
import { RumoUrl } from "lib/rumoUrl";
import { SubscriptionManager } from "lib/subscriptionManager";
```

## App Skeleton

```typescript
const out = _out("MyApp");

interface MyAppInstance extends AppInstance<{
    in1: boolean;       // input
    out1: boolean;      // output
    freeMem: number;    // output
}> {
    _subscriptionManager: SubscriptionManager;
    _intervalId: NodeJS.Timeout;
    _id: any;
}

const appDef: AppDefinition = {
    input:  { in1: { type: "boolean", persistent: true, default: true } },
    output: { out1: "boolean", freeMem: "number" },
    createSync: function () {},
    init:   unpromisify(init),
    stop:   unpromisify(cleanup),
    delete: unpromisify(cleanup),
    callback: true,
    callbackSync: true,
};

async function cleanup(this: MyAppInstance): Promise<void> {
    clearInterval(this._intervalId);
    this._subscriptionManager.close();
}

async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    this._id = request.body.meta.id;

    this._subscriptionManager = new SubscriptionManager();
    const sub = this._subscriptionManager.subscribe(
        new RumoUrl("/~/ws/0/dev/0/fb/Setup/dp/freeMem/dat/value")
    );
    sub.on("update", onFreeMemUpdate(this));

    this._intervalId = setInterval(this.callback(unpromisify(onTimeout)), 2000);
    return false;
}

function onFreeMemUpdate(that: MyAppInstance) {
    return function (freeMem: number) {
        that.callbackSync(function (this: MyAppInstance) {
            this.freeMem = freeMem;
            return "freeMem";
        })();
    };
}

async function onTimeout(this: MyAppInstance): Promise<AppHookResult> {
    this.freeMem = (await getAsync("/~/ws/0/dev/0/fb/Setup/dp/freeMem/dat/value")).body;
    return "freeMem";
}

appDef.update = callDpUpdate(appDef, {
    in1: unpromisify(updateIn1),
});

async function updateIn1(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) return false;
    this.out1 = this.in1;
    return "out1";
}

export = appDef;
```

## Key Rules

**App context**: You are IN context during lifecycle functions and `callDpUpdate` handlers. You are OUTSIDE during `setInterval`, `setTimeout`, and subscription handlers.
- Re-enter with `this.callback(unpromisify(fn))` (async) or `this.callbackSync(fn)` (sync)
- Never modify datapoints outside context — use callbacks

**`request.fromDatabase`**: Always check in update handlers. Skip processing on initial DB load.

**`AppHookResult`**: Return `false`/`undefined` (no change), `"dpName"` (one DP), `["dp1","dp2"]` (multiple), `null` (all outputs).

**Cleanup**: Always clear intervals and close SubscriptionManager in stop/delete.

**`unpromisify`**: Required to wrap async functions for the framework lifecycle hooks.

## Datapoint Options

```typescript
in1: { type: "boolean", persistent: true, default: true, hidden: false, unit: "°C", array: false }
```

- `persistent`: value survives restart
- `default`: initial value on first start
- `array: true`: allows multiple bindings; `this.in1` becomes an array

**persistent + default behaviour:**

| persistent | default | Result |
|---|---|---|
| false | — | null after each start |
| false | defined | reset to default each start |
| true | — | null until first set, then persists |
| true | defined | default on first start, then persists |

## SubscriptionManager

```typescript
// Subscribe
const sub = manager.subscribe(new RumoUrl("/~/ws/0/dev/0/fb/FB/dp/dp/dat/value"));
sub.on("update", handler);   // fired on value change
sub.on("error", handler);    // fired on error
sub.on("subscribed", fn);    // fired when active

// Delta subscription (only changed values + UpdateInfo)
manager.subscribe(url, { type: 'delta' });

// Cleanup
manager.close(); // unsubscribes all
```

## Internal REST

```typescript
const result = await getAsync("/~/ws/0/dev/0/fb/Name/dp/value/dat/value");
this.output = result.body;
// also: postAsync, putAsync, deleteAsync
```

## Logging

```typescript
const out = _out("MyAppName");
out.info("msg", data);
out.warn("msg");
out.error("msg", err);
out.debug("msg");
```

## Status API

```typescript
this.setStatus!("error");               // set app status
this.setStatus!("warning", "myDp");     // set DP status
this.hasStatus!("error", undefined, (_, has) => { /* ... */ });
this.deleteStatus!("error");
```

## AppDefinition Extra Properties

```typescript
singleton: true,        // only one instance allowed
undeletable: true,      // cannot be deleted from UI (still implement delete hook)
provideDps: ["in1"],    // restrict which DPs are on this (performance)
updateOutputs: true,    // call update() also for output DP changes
initialize: true,       // webserver waits for this.initialized!(err) — MUST always be called
```

## File Structure

```
src/type/app/[type]/[name]/_default.ts       # runs on local device FBs
src/type/app/[type]/[name]/local.ts          # also runs on remote device FBs
build/type/.../_default.js                   # compiled output (auto-deployed)
controller/type/app/[type]/[name]/           # non-TypeScript assets (synced as-is to controller)
controller/type/dev/rumo/system/[ns]/        # system rumo device templates (Project Editor)
controller/type/_group/[ns]/                 # group folder icons for Project Editor
```

**`controller/type/`** is for non-TypeScript files that your app needs at runtime on the controller — for example:
- Message lists (`messages.json`)
- Templates (`template.html`)
- Config files, lookup tables, static assets

These files are synced directly to `/type/` on the controller via the SFTP plugin. Do **not** put TypeScript source here.

## Helper Classes / Shared Code

**IMPORTANT: Never create helper files in `src/lib/`.** The `lib/` folder contains read-only type definitions downloaded from the controller. It is not writable and must not be modified.

Place all custom helper classes and shared code inside the type folder, alongside the app:

```
src/type/app/[type]/[name]/_default.ts       # main app
src/type/app/[type]/[name]/myHelper.ts       # custom helper — same folder
src/type/app/[type]/[name]/utils/helpers.ts  # or in a subfolder
```

Import helpers with a relative path:

```typescript
import { MyHelper } from './myHelper';
import { helperFn } from './utils/helpers';
```

Do NOT use `lib/` for custom code. Only use `lib/` for importing built-in Rumo types (`appDef`, `appUtil`, `out`, `rumoUrl`, `subscriptionManager`, etc.).

## Project Editor Registration

To make an app available in the ARIGO Project Editor, it must be registered in a **system rumo device**.
Do **not** modify the built-in `/~/type/dev/rumo/system` device. Create your own.

### Template file

Create `controller/type/dev/rumo/system/{namespace}/_default.json`:

```json
{
  "id": "/~/type/dev/rumo/system/{namespace}",
  "extends": "/~/type/dev/rumo",
  "properties": {
    "meta": {
      "properties": {
        "label": { "default": "{namespace}" },
        "hardwareType": { "default": "Ethernet" }
      }
    },
    "fb": { "type": "object", "required": true, "default": {}, "properties": {} },
    "cap": {
      "required": true,
      "properties": {
        "fb": {
          "required": true,
          "properties": {
            "type": {
              "required": true,
              "properties": {
                "/~/type/app/{namespace}/{appName}": {
                  "required": true,
                  "properties": {
                    "min": { "required": true, "default": 0 },
                    "max": { "required": true, "default": 1 },   // omit max for unlimited instances
                    "group": { "required": true, "default": "{groupFolder}/{appName}" }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

**`cap/fb/type` fields:**
- `min: 0` = optional, `min: 1` = required
- `max: 1` = singleton; omit `max` for unlimited instances
- `group`: folder path in Project Editor tree, e.g. `"math/counter"` or `"settings/config"`

### Group icon directory

Create `controller/type/_group/{namespace}/` — even if empty, this directory must exist on the controller.
Optionally place icon files named after the group folder: `{groupFolder}.svg` (also `.png`, `.jpg`, `.gif`).

### Applying changes to the controller

**New device** (first time):
1. Deploy template via SFTP (save the file — SFTP plugin uploads automatically)
2. Create device instance via REST:
   - `POST /~`
   - Body: `{ "meta": { "type": "/~/type/dev/rumo/system/{namespace}", "label": "{namespace}", "alias": "{namespace}" } }`

**Existing device** (template updated):
1. Deploy template via SFTP
2. Trigger Request Template:
   - Get device label: `GET /~/type/dev/rumo/system/{namespace}/~/meta/label`
   - Start: `POST /~/ws/0/dev/{label}/cmd/requestTemplate` with body `{ "processingState": "request" }`
   - Poll: `GET /~/ws/0/dev/{label}/cmd/requestTemplate` — wait for `processingState === "done"` (or `"error"`)
3. Reload the Project Editor page in the browser

**Check if device exists:**
- `GET /~/type/dev/rumo/system/{namespace}/~/meta/label` — 200 = exists, error = does not exist

> With the VS Code plugin: right-click `_default.ts` → **"RumoAppDev: Add App to Project Editor"** — handles all of the above automatically.

## tsconfig

- `baseUrl: "src"` → `import x from "lib/foo"` resolves to `src/lib/foo.d.ts`
- `module: CommonJS`, `target: ES2021`
- Use `export =` not `export default`
