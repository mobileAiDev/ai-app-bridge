# Web Bridge Design

## Goal

Add a browser-page AI Bridge that lets an agent communicate with a running web
application at the application layer. The web bridge should be isolated from
Android/Flutter runtime code and should reuse the existing evidence loop:

```text
agent command -> page SDK action -> app evidence -> agent verification
```

## Scope

The web bridge is an application-level SDK plus a desktop-side provider.

It should provide:

- runtime connection status
- console and error capture
- `fetch` and `XMLHttpRequest` capture
- application state records
- business events
- DOM/interactive-node snapshots
- whitelisted commands
- assertion results
- batch execution

It should not try to replace full browser automation. Real clicks, screenshots,
browser permissions, downloads, and cross-origin frames remain the job of an
outer browser provider such as Playwright/CDP.

## Proposed Package Layout

```text
web/ai-app-bridge-web/
  package.json
  src/
    index.ts
    client.ts
    transport.ts
    capture/
      console.ts
      errors.ts
      network.ts
      dom.ts
    commands.ts
    redaction.ts
  README.md

desktop/ai-app-bridge-cli/
  web-provider/
    sessions.js
    protocol.js
    commands.js
    capture-store.js
```

The exact source layout can change, but the package boundary should stay clear:
browser SDK code lives under `web/`, desktop provider code lives under
`desktop/ai-app-bridge-cli/`.

The web provider should be session-based. Unlike current Android commands,
which can be executed by spawning the CLI for a single request, web SDK
connections require a long-lived session registry. The MCP/desktop process
should own that registry or start a managed session server.

## Transport

Primary transport:

```text
browser SDK -> WebSocket -> desktop session server
```

Fallback transport:

```text
browser SDK -> HTTP polling -> desktop session server
```

The SDK supports explicit endpoint and token configuration:

```js
const bridge = createAiAppBridge({
  endpoint: "ws://127.0.0.1:18180/ai-app-bridge-web",
  token: "<session-token>",
  appName: "example-web-app"
});

bridge.start();
```

For local browser development, `127.0.0.1` points at the developer machine. For
remote browsers or mobile browsers, use a reachable HTTPS/WSS tunnel or LAN
address.

## Minimal SDK API

```js
const bridge = createAiAppBridge({ endpoint, token, appName, capture });
bridge.start();
bridge.disconnect();

bridge.recordLog(level, tag, message, data);
bridge.recordNetwork(record);
bridge.recordState(namespace, key, value);
bridge.recordEvent(category, name, data);

bridge.registerAction(name, handler);
bridge.unregisterAction(name);
bridge.snapshotDom(options);
```

Automatic capture should be opt-in by category:

```js
createAiAppBridge({
  endpoint,
  token,
  appName,
  capture: {
    console: true,
    errors: true,
    fetch: true,
    xhr: true,
    dom: true
  }
});
```

## Desktop/MCP Commands

Web commands should use `sessionId`, not Android `packageName`.

```text
web-provider-status
web-session-start
web-connect-info
web-sessions
web-status
web-dom
web-logs
web-network
web-state
web-events
web-command
web-click
web-input
web-wait
web-scroll
```

Current Android MCP rules remain unchanged. Web commands must not relax the
Android requirement that app-specific commands pass `packageName` or explicit
`port`.

Multi-step Web flows use the shared MCP `batch` command with web steps instead
of a separate `web-batch` command.

The command registry should distinguish target kinds instead of using the
current Android-only `targetApp` concept for every target:

```text
targetKind: none | android-app | web-target
```

`android-app` keeps the current `packageName`/`port` guard. `web-target`
requires `sessionId` or a unique `targetId`. If a session has multiple live
targets, commands must return `web_target_ambiguous` with candidates.

Suggested target IDs:

```text
main                   main document
frame:<stable-id>      same-origin iframe
custom:<id>            SDK-registered custom surface
cdp:<target-id>        optional browser-provider target
```

## Command Safety

The SDK should execute only whitelisted commands.

Allowed by default:

- read status
- read DOM snapshot
- read registered state providers
- call registered action handlers
- click/input/wait/scroll through the SDK command path

Potentially risky and disabled by default:

- arbitrary `eval`
- direct mutation of global app state
- reading unrestricted storage

An application can opt into additional commands during development, but the
default package should be safe for debug/test integration.

## Evidence Reuse

The web bridge should reuse the Android/Flutter capture vocabulary:

- `logs`
- `network`
- `state`
- `events`
- `dom`
- `status`
- `commandResult`

Records should include:

- monotonically increasing `id`
- `timestampMs`
- `source`
- provider-specific metadata when useful

Network records must redact sensitive headers, query parameters, and payload
fields using the same key patterns as the existing Android runtime where
possible.

Console capture should map into `logs` with a source such as `console-auto`.
Web-specific fields such as `sessionId`, `targetId`, `origin`, `url`, and
`route` should be additive metadata, not a separate evidence vocabulary.

## Browser Provider Pairing

The SDK gives application-level truth. A browser provider gives outer-browser
truth.

Recommended combined flow:

```text
Playwright/CDP opens app
Web SDK connects to session server
Agent asks SDK for state/network/events
Agent uses Playwright/CDP for true click/screenshot when needed
Agent uses SDK action handlers for semantic business actions
```

This gives high observability without forcing all actions through synthetic DOM
events.

## Validation Plan

Before publish:

```bash
cd desktop/ai-app-bridge-cli && npm run check
npm pack --dry-run
```

For the web package:

```bash
cd web/ai-app-bridge-web
npm install
npm test
npm run build
npm pack --dry-run
```

Add an example page that proves:

- SDK connects to the desktop session server.
- console/error capture works.
- fetch/XHR capture works.
- DOM snapshot returns interactive controls.
- a registered action can mutate page state.
- agent can read evidence after the action.

## Publish Gate

Do not publish until:

- package name and public API are stable
- generated package contents are reviewed
- compatibility gate for existing Android/Flutter/CLI/MCP passes
- npm auth is provided out of band through environment/local npm config
- final publish approval is explicit
