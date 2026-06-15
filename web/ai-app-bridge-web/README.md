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
    xhr: true
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
      xhr: true
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

This package is intended for debug and test builds. Keep command handlers
whitelisted and do not enable it in production without a deliberate security
review.
