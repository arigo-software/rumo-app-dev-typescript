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
src/type/app/[type]/[name]/_default.ts  # runs on local device FBs
src/type/app/[type]/[name]/local.ts     # also runs on remote device FBs
build/type/.../_default.js              # compiled output (auto-deployed)
```

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

## tsconfig

- `baseUrl: "src"` → `import x from "lib/foo"` resolves to `src/lib/foo.d.ts`
- `module: CommonJS`, `target: ES2021`
- Use `export =` not `export default`
