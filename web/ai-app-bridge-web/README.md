# AI App Bridge Web

Browser-side SDK for AI App Bridge Web sessions. Use it in debug/test builds
to let an agent communicate with a running web page through the desktop AI App
Bridge MCP provider.

Agent-side MCP commands live in the `web` domain: `web-session-start`,
`web-connect-info`, `web-sessions`, `web-status`, `web-dom`, `web-logs`,
`web-network`, `web-state`, `web-events`, `web-command`, `web-click`,
`web-input`, `web-wait`, and `web-scroll`. MCP clients should call
`capabilities` first, then `run` the selected command with `sessionId` and
optional `targetId`.

## Install

```bash
npm install --save-dev @mobileaidev/ai-app-bridge-web
```

The agent side uses the desktop package:

```bash
npm install -g @mobileaidev/ai-app-bridge
```

## Use With Bundlers

The SDK is framework-agnostic and can be used from React, Vue, Svelte, vanilla
JavaScript, Vite, Next.js client code, or any browser-only entry point.

```js
import { createAiAppBridge } from "@mobileaidev/ai-app-bridge-web";

const bridge = createAiAppBridge({
  endpoint: "ws://127.0.0.1:18180/ai-app-bridge-web",
  token: "session-token",
  appName: "demo-web-app",
  capture: {
    console: true,
    errors: true,
    fetch: true,
    xhr: true,
    ui: {
      debounceMs: 80,
      maxBatchSize: 50,
      maxPendingEvents: 200
    }
  }
});

bridge.start();
```

For SSR frameworks, initialize it only in client/browser code.

## Script Tag

```html
<script src="./node_modules/@mobileaidev/ai-app-bridge-web/src/index.js"></script>
<script>
  const bridge = AiAppBridgeWeb.createAiAppBridge({
    endpoint: "ws://127.0.0.1:18180/ai-app-bridge-web",
    token: "session-token",
    appName: "demo-web-app",
    capture: {
      console: true,
      errors: true,
      fetch: true,
      xhr: true,
      ui: true
    }
  });

  bridge.registerAction("demo.increment", async () => {
    window.count = (window.count || 0) + 1;
    bridge.recordState("demo", "count", window.count);
    return window.count;
  });

  bridge.start();
</script>
```

## Continuous UI Observation

`capture.ui` is opt-in. Set it to `true` for defaults, or pass an object to
bound its work:

```js
capture: {
  ui: {
    debounceMs: 80,
    maxBatchSize: 50,
    maxPendingEvents: 200,
    maxFingerprintElements: 200,
    maxFingerprintText: 2000
  }
}
```

The SDK sends `events` captures with `category: "ui"` and `name: "batch"`.
Each batch can contain document click/input/change/focus events, SPA route
transitions, DOM mutation summaries, lightweight DOM fingerprint changes, and
dialog-like open/close transitions. `droppedEvents` reports queue pressure.

Password and other sensitive inputs never include their value; they contain
only `changed`, `length`, and `sensitive: true`. Non-sensitive input values are
limited to 300 characters. DOM body text contributes only to the fingerprint
hash and is not included in the UI event payload.

This observer does not continuously capture screenshots or video. Call
`bridge.stop()` (or the existing `bridge.disconnect()`) to flush pending UI
events, remove listeners and observers, restore patched History methods, and
close the connection. A later `bridge.start()` installs a fresh observer.

This package is intended for debug and test builds. Keep command handlers
whitelisted and do not enable it in production without a deliberate security
review.
