# AI App Bridge Web

Browser-side SDK for AI App Bridge Web sessions. Use it in debug/test builds
to let an agent communicate with a running web page through the desktop AI App
Bridge shared execution runtime, through either CLI or MCP.

Agent-side commands live in the `web` domain: `web-session-start`,
`web-connect-info`, `web-sessions`, `web-status`, `web-dom`, `web-logs`,
`web-network`, `web-state`, `web-events`, `web-command`, `web-click`,
`web-input`, `web-key`, `web-wait`, and `web-scroll`. MCP clients should call
`capabilities` first, then `run` the selected command with `sessionId` and
the exact document `runtimeEpoch` and optional `targetId: "main"`.

Web Intent uses `provider: "h5"` and an explicit Web target. Script admits
typed DOM controls through the same serving provider. See the desktop
[Web command contract](../../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#web-dom-intent-and-script)
and [Script authoring guide](../../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md).

DOM controls expose normalized `checked` (`true`, `false`, `"mixed"` or `null`)
and raw `ariaChecked`. Native checkbox/radio observations read live properties;
ARIA controls retain their explicit state. Unknown state is not reported as
unchecked. Use the current SDK with the current Host; missing `checked` is an
invalid snapshot. A semantic click must still be followed by a fresh observation
and an independent business check where persistence matters.

## Capture windows and network bodies

Network body capture is explicitly enabled with `captureRequestBodies: true`
and `captureResponseBodies: true`; both default to disabled for automatic fetch
and XHR capture. Each body includes its `requestBodyState`/`responseBodyState` and
`requestBodyEncoding`/`responseBodyEncoding`. Read `utf8` directly and decode
`base64` before applying an App protocol decoder. Binary fetch payloads, including
Protobuf, retain their original bytes. XHR response types other than text remain
explicitly unsupported in this version.

Byte bodies are bounded to 12,000 bytes. Oversized requests are marked truncated;
oversized response streams omit the body with `too-large`. Response capture has a
one-second deadline, uses a clone and does not delay or consume the App response.
Disabled, unknown and unavailable bodies are never reported as empty responses.

The current Host and SDK use `aab.web-capture/v1` barriers. Capture sequence,
loss and pending counters describe what the SDK has emitted through that point.
Automatic network records freeze the synchronous dispatch origin at request
initiation; asynchronous origins that cannot be established stay `unattributed`.
Use an explicit context when the App can supply the real action ID. A later
active action is never substituted for a missing origin.

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

## Bounded UI Observation

UI observation is off by default, including after `bridge.start()`.
`capture.ui` configures an explicitly requested window; `false` disables this
capability. Set it to `true` for defaults, or pass an object to bound its work:

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

Open a window with `bridge.uiObservation({ operation: 'start', durationMs: 1500 })`
or the Host `web-ui-observation` command. Durations must be 100–5000 ms.
`{ operation: 'stop', leaseId }` releases that owner's window early;
`{ operation: 'status' }` reads its state. Expiry, disconnect and SDK stop flush
pending events, remove UI listeners and restore History methods. A later SDK
start leaves observation off. Missing events outside a window cannot establish
UI stability or action success. No screenshots or video are captured by this API.

This package is intended for debug and test builds. Keep command handlers
whitelisted and do not enable it in production without a deliberate security
review.
