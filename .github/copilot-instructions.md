# Rumo App Development Guidelines

## Overview

This project uses the Rumo application framework, a TypeScript-based system for creating datapoint-driven applications with real-time subscriptions and lifecycle management.

## App Structure

Every Rumo app follows this pattern:

1. **AppInstance Interface**: Extends `AppInstance<DatapointMap>` with input/output datapoints and internal properties
2. **AppDefinition Object**: Defines lifecycle hooks, datapoints, and configuration
3. **Lifecycle Functions**: init, stop, delete, createSync
4. **Update Handlers**: Functions triggered when input datapoints change
5. **Export**: Export the AppDefinition object using `export = appDef`

## Required Imports

```typescript
import { AppDefinition, AppHookResult, AppInstance, Request } from "lib/appDef";
import { callDpUpdate, getAsync, unpromisify } from 'lib/appUtil';
import _out from "lib/out";
import { RumoUrl } from "lib/rumoUrl";
import { SubscriptionManager } from "lib/subscriptionManager";
```

## Naming Conventions

- **Internal properties**: Prefix with underscore (`_id`, `_intervalId`, `_subscriptionManager`) to avoid conflicts with input/output datapoint names
- **App name**: Use descriptive PascalCase for interfaces (`MyAppInstance`)
- **Datapoint names**: Use camelCase for input/output properties (`cpuUsage`, `freeMem`, `out1`)

## AppInstance Interface Pattern

```typescript
interface MyAppInstance extends AppInstance<{
    // Input datapoints (read from external sources)
    in1: boolean;

    // InputOutput datapoints (bidirectional)
    // ioValue: number;

    // Output datapoints (written by the app)
    out1: boolean;
    result: number;
}> {
    // Internal properties (always prefix with _)
    _subscriptionManager: SubscriptionManager;
    _id: any;
    _intervalId: NodeJS.Timeout;
    _customData: any;
}
```

## Datapoint Definition Options

```typescript
input: {
    // Short form (type only)
    simpleInput: "boolean",

    // Full form with all options
    advancedInput: {
        type: "number",       // boolean | number | integer | string | object
        persistent: true,     // value survives restart (default: false)
        default: 42,          // default value on first start
        hidden: false,        // hide in UI (default: false)
        unit: "°C",           // display unit
        array: false          // allow multiple bindings (default: false)
    }
}
```

**persistent + default behaviour:**

| persistent | default | Result |
|---|---|---|
| false | not defined | value is null after each start |
| false | defined | value reset to default after each start |
| true | not defined | null until first set, then last value persists |
| true | defined | default on first start, last value after that |

**Array inputs**: Set `array: true` to allow multiple bindings. The app receives all bound values as an array.

## AppDefinition Structure

```typescript
const appDef: AppDefinition = {
    input: {
        in1: { type: "boolean", persistent: true, default: true },
        threshold: { type: "number", persistent: true, default: 100 }
    },
    output: {
        out1: "boolean",
        result: "number"
    },
    inputOutput: {
        // ioValue: { type: "number", persistent: true }
    },

    // Lifecycle hooks (use unpromisify for async functions)
    createSync: function () {},
    init: unpromisify(init),
    stop: unpromisify(cleanup),
    delete: unpromisify(cleanup),

    // Enable callback support for async operations
    callback: true,
    callbackSync: true,

    // Optional properties
    // singleton: true,        // only one instance allowed
    // undeletable: true,      // cannot be deleted from UI
    // provideDps: ["in1"],    // restrict which DPs are accessible on this
    // updateOutputs: true,    // call update() also for output dp changes
};
```

## Lifecycle Functions

### init()
Called when app instance is created. Set up subscriptions, timers, and initialize state.

```typescript
async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    this._id = request.body.meta.id;

    // Set up datapoint subscriptions
    // Note: subscription handlers run outside app context, use callbackSync() in handler
    this._subscriptionManager = new SubscriptionManager();
    const subscription = this._subscriptionManager.subscribe(
        new RumoUrl("/~/ws/0/dev/0/fb/Setup/dp/value/dat/value")
    );
    subscription.on("update", onValueUpdate(this));

    // Set up timers - callback() re-enters app context when timer fires
    this._intervalId = setInterval(
        this.callback(unpromisify(periodicTask)),
        2000
    );

    return false;
}
```

### cleanup()
Called on stop or delete. Clean up resources (timers, subscriptions).

```typescript
async function cleanup(this: MyAppInstance): Promise<void> {
    if (this._intervalId) {
        clearInterval(this._intervalId);
    }
    if (this._subscriptionManager) {
        this._subscriptionManager.close();
    }
}
```

### Deferred initialization (initialize)
If your app needs async setup before being usable, use `initialize: true`:

```typescript
const appDef: AppDefinition = {
    // ...
    initialize: true,   // webserver waits for initialized() to be called
    init: unpromisify(init),
};

async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    doSomethingAsync((err: any) => {
        this.initialized!(err); // MUST always be called, even on error
    });
    return false;
}
```

> **Important**: If `initialize: true` is set, the webserver will NOT start until `this.initialized()` is called. Always call it, even on error.

## Update Handlers

Register update handlers for input datapoint changes using `callDpUpdate`:

```typescript
appDef.update = callDpUpdate(appDef, {
    in1: unpromisify(updateIn1),
    threshold: unpromisify(updateThreshold),
});

async function updateIn1(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    // Ignore database initialization updates
    if (request.fromDatabase) return false;

    // Process the input change
    this.out1 = this.in1;

    // Return the name(s) of changed output datapoints
    return "out1";
}
```

**Important**: Always check `request.fromDatabase` to avoid processing initial database loads.

## Return Values (AppHookResult)

Lifecycle and update functions return `AppHookResult` to indicate which datapoints changed:

- `false` or `undefined`: No changes
- `null`: All outputs updated
- `"datapointName"`: Single datapoint changed
- `["dp1", "dp2"]`: Multiple datapoints changed

## Subscription Pattern

Subscribe to datapoint changes using SubscriptionManager:

```typescript
this._subscriptionManager = new SubscriptionManager();
const subscription = this._subscriptionManager.subscribe(
    new RumoUrl("/~/ws/0/dev/0/fb/FunctionBlock/dp/datapointName/dat/value")
);
subscription.on("update", handler(this));
```

**Handler pattern** (closure to preserve `this` context):

```typescript
function handler(that: MyAppInstance) {
    return function(newValue: number) {
        // callbackSync() is required because subscription.on("update", ...)
        // fires outside the app context. It re-enters the app context
        // to safely update datapoints and notify the framework.
        that.callbackSync(function(this: MyAppInstance) {
            this.outputDatapoint = newValue;
            return "outputDatapoint";
        })();
    };
}
```

**Subscription types** (optional second argument):

```typescript
// Full update (default) — complete dat object on every change
manager.subscribe(url, { type: 'full' });

// Delta update — only changed values, includes UpdateInfo
manager.subscribe(url, { type: 'delta' });
```

**Delta subscription with UpdateInfo:**

```typescript
subscription.on("update", (data: any, info?: UpdateInfo) => {
    // info.url — full URL of changed value
    // info.subPath — path segments below subscribed URL
    // info.method — 'PUT' | 'DELETE'
});
```

## Async Operations and App Context

### Understanding App Context
The Rumo framework provides an **app execution context** that allows safe access to datapoints and ensures proper synchronization.

**You are automatically IN the app context when:**
- Lifecycle functions are called: `init()`, `stop()`, `delete()`, `createSync()`
- Update handlers are called: functions registered via `callDpUpdate()`

**You are OUTSIDE the app context when:**
- Timer callbacks execute: `setInterval()`, `setTimeout()`
- Subscription event handlers fire: `subscription.on("update", ...)`
- External async operations complete: HTTP responses, file I/O callbacks

**To re-enter the app context from outside**, use `callback()` or `callbackSync()`.

### unpromisify
Convert async functions to callback-based functions for the framework:

```typescript
init: unpromisify(init),
stop: unpromisify(cleanup),
```

### callback() and callbackSync()

**Use `callback()` for async timer/delayed operations:**

```typescript
this._intervalId = setInterval(
    this.callback(unpromisify(asyncFunction)),
    1000
);
```

**Use `callbackSync()` for synchronous event handlers:**

```typescript
function handler(that: MyAppInstance) {
    return function(newValue: number) {
        that.callbackSync(function(this: MyAppInstance) {
            this.output = newValue;
            return "output";
        })();
    };
}
```

**Critical**: Without `callback()` or `callbackSync()`, datapoint modifications from external callbacks may cause race conditions or be ignored by the framework.

> All app functions are automatically synchronized — only one update/callback runs at a time. Always call callback functions (even on error) to avoid deadlocks.

## Internal REST API

Use internal REST functions to read/write datapoints:

```typescript
// Async/await pattern (preferred)
const result = await getAsync("/~/ws/0/dev/0/fb/Name/dp/value/dat/value");
this.output = result.body;

// Other REST methods
await postAsync(url, body, headers);
await putAsync(url, body, headers);
await deleteAsync(url, headers);
```

## Status API

Set/read status on the app or individual datapoints:

```typescript
// Set status
this.setStatus!("error", undefined, (err) => { /* app status */ });
this.setStatus!("warning", "myDp", (err) => { /* dp status */ });

// Check status
this.hasStatus!("error", undefined, (err, has) => {
    if (has) { /* handle error state */ }
});

// Delete status
this.deleteStatus!("error", undefined, (err) => {});

// Read status
this.getStatus!(undefined, (err, status) => {
    out.info("Current status:", status);
});
```

## Logging

Initialize logger at module level and use throughout:

```typescript
import _out from "lib/out";
const out = _out("MyAppName");

// Usage
out.info("Message", data);
out.warn("Warning message");
out.error("Error occurred", error);
out.debug("Debug info", value);
```

Log levels: `debug` < `info` < `warn` < `error`. Default level is `info`.

## Advanced: AppDefinition Properties

```typescript
const appDef: AppDefinition = {
    // ...
    singleton: true,          // Only one instance of this app allowed
    undeletable: true,        // Cannot be deleted via UI (implement delete hook anyway)
    provideDps: ["in1"],      // Only these DPs accessible on this (performance)
    updateOutputs: true,      // Call update() also when output DPs change
    initialize: true,         // Webserver waits for this.initialized() call
};
```

## Common Patterns

### Periodic Data Polling

```typescript
async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    this._intervalId = setInterval(
        this.callback(unpromisify(pollData)),
        2000
    );
    return false;
}

async function pollData(this: MyAppInstance): Promise<AppHookResult> {
    const result = await getAsync("/path/to/datapoint/dat/value");
    this.outputValue = result.body;
    return "outputValue";
}
```

### Input Mirroring

```typescript
async function updateInput(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) return false;
    this.output = this.input;
    return "output";
}
```

### Conditional Processing

```typescript
async function updateValue(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) return false;

    if (this.inputValue > this.threshold) {
        this.alarm = true;
        out.warn("Threshold exceeded", this.inputValue);
        return "alarm";
    }
    return false;
}
```

### Check if App is Created or Restarted

```typescript
async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) {
        // App is restarted — data already in database
        out.info("App restarted");
    } else {
        // App is created for the first time
        out.info("App created");
    }
    return false;
}
```

### Get URL of the App Itself

```typescript
async function init(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    // request.body.meta.url — e.g. /~/ws/0/dev/0/fb/myApp
    const appUrl = request.body.meta.url;
    const dpUrl = `${appUrl}/dp/myDp/dat/value`;
    return false;
}
```

### Array Input Handling

```typescript
// AppDefinition
input: {
    values: { type: "number", array: true }
}

// In update handler
async function updateValues(this: MyAppInstance, request: Request): Promise<AppHookResult> {
    if (request.fromDatabase) return false;
    // this.values is an array of all bound values
    const sum = (this.values as number[]).reduce((a, b) => a + b, 0);
    this.result = sum;
    return "result";
}
```

## File Structure

```
src/type/app/[appType]/[appName]/_default.ts   # Main app file
src/type/app/[appType]/[appName]/local.ts       # Device FB variant (runs on remote devices too)
build/type/app/[appType]/[appName]/_default.js  # Compiled output
```

**`_default.ts` vs `local.ts`**: `_default.ts` only runs when the FB is on the local device. `local.ts` also runs for remote device FBs.

## TypeScript Configuration

- Target: ES2021
- Module: CommonJS
- BaseUrl: `src` — imports like `import x from "lib/foo"` resolve to `src/lib/foo`
- Use `export =` for module exports (not ES6 `export default`)
- Type definitions are auto-downloaded to `src/lib/*.d.ts`

## Best Practices

1. **Always clean up resources** in stop/delete hooks (clear intervals, close subscriptions)
2. **Check `request.fromDatabase`** in update handlers to avoid processing initial loads
3. **Prefix internal properties** with underscore to avoid datapoint name conflicts
4. **Return changed datapoint names** from update/lifecycle functions
5. **Use unpromisify** for all async lifecycle functions
6. **Use callback/callbackSync** to re-enter app context from external callbacks
7. **Keep AppInstance interface accurate** — list all internal properties
8. **Initialize SubscriptionManager** in init(), close in cleanup()
9. **Use RumoUrl** for datapoint paths in subscriptions
10. **Log important state changes** using the `out` logger
11. **Always call callback/initialized** — omitting it causes deadlocks
12. **Use `persistent: true` + `default`** for user-configurable parameters

## Error Handling

The framework handles errors automatically. Focus on:
- Checking return values from REST calls
- Validating input data before processing
- Logging errors for debugging
- Using the Status API to expose error state to the UI

## Testing

Test apps by:
1. Deploying to Rumo runtime environment
2. Monitoring output datapoints
3. Checking logs with `out.info/warn/error`
4. Testing input changes and verifying output updates
