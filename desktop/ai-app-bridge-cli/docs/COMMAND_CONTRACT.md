# Command contract: aab.command/v1

Intent and Script are first-class execution interfaces. Intent observes a target,
accepts a decision tied to that observation, dispatches and records its receipt.
Script runs repeatable JavaScript/Python with progress, assertions and control.
Both use the device capabilities below and retained evidence. A single command
remains useful for observation, interaction, fixture setup and diagnosis.

## Discovery and entrypoints

MCP exposes exactly `capabilities` and `run`. A default or domain query returns
a light command directory. Use `capabilities {"command":"tap-text"}`
for its current `inputSchema`, platform, role and supported entrypoints. Domain
`execution` contains Intent, Script, runtime lifecycle and device ownership;
`evidence` contains archive operations.
`capabilities {"includeOptions":true}` returns every current command schema.

Load only the operation needed for Intent, Script or evidence, for example
`capabilities {"command":"intent","operation":"start"}`. To inspect an Intent
action, add the actual platform, provider and action:
`capabilities {"command":"intent","operation":"decide","platform":"android","provider":"native","action":"tap"}`.
These filters narrow discovery only; execution still validates against the full
runtime contract. Intent terminal decisions remain available in the selected
decision schema. Unsupported operations or scope combinations return an error
with the offending field. Omit filters to read the complete command contract.

All parameters are under `run.arguments`:

```json
{"command":"tap-text","arguments":{"serial":"DEVICE","packageName":"com.example.app","targetText":"设置","provider":"auto"}}
```

Names are canonical and case-sensitive. Unknown arguments, aliases, invalid
JSON types, null numeric values and out-of-range coordinates fail before storage
or device access. Validation includes nested control objects and the selected
operation's fields. CLI flags convert textual numbers/booleans and parse typed
object flags as JSON; MCP accepts the actual JSON type. CLI flags use canonical
`--kebab-case` names followed by separate value tokens. Extra positional tokens
fail with `unexpected_argument`; repeated single-value flags fail with
`duplicate_argument` before device access, so a later value cannot replace the
original target. Only `--category` and `--extra` accept repeated values. Parse
failures return the same JSON error envelope and exit code 1 as validation errors.
The CLI's `--help` and `--help COMMAND` come from the same registry. Help accepts
the same filters, such as `--help intent --operation decide --platform android
--provider native --action tap`, without starting a Runtime. All
registered commands are available through CLI and MCP, including Intent, Script,
installation, permission dialogs, evidence and Web sessions. Both adapters call
`runtime-client.js`; one independent `execution-runtime.js` owns the protocol-neutral
`execution-host.js`. MCP does not spawn the CLI for each request, and neither
adapter has a separate execution state machine.
Within the shared Host, `target-execution.js` still owns ordinary-command
queueing, deadlines and request-ID idempotency. Intent and Script use the same
provider access and device ownership through their execution-specific contracts.

### Shared runtime lifecycle

The first executing command starts a local runtime. `runtime --operation start`
starts it explicitly; `runtime --operation status` inspects it without starting
one; `runtime --operation stop` cancels and drains active work before releasing
its ownership. CLI exit, MCP EOF and client SIGINT/SIGTERM close only that client.
Use `intent`/`script --operation cancel --operation-id ID` to cancel one task.
The same operation ID can be queried and controlled from either entrypoint.

A runtime namespace is keyed by the canonical FactStore directory. Configure it
with `AI_APP_BRIDGE_FACT_STORE_DIR`; symlinks to the same directory identify the
same store. Control files default to `~/.ai-app-bridge/runtimes/v1`; the explicit
`AI_APP_BRIDGE_RUNTIME_HOME` override must match in clients that share a runtime.
A private endpoint record and token authenticate loopback requests. An OS-held
SQLite lock controls ownership; a stale PID or failed health probe never permits
replacing a live owner. Startup candidates can repeat the ownership election
only after proving the lock is free and before dispatching any command.

Code, bundled runtime artifacts, native-store binary, Node version, FactStore
profile and provider configuration must match the owner. Mismatch rejects
execution with `runtime_code_mismatch` or `runtime_configuration_mismatch`.
`runtime status` reports the owner and compatibility; explicit `runtime stop`
remains available from a different build/configuration. An unresponsive owner
returns `runtime_unresponsive` without killing or replacing it. Lost execution
connections report an unknown outcome after request submission; execution is
never automatically retried. Runtime crashes retain the existing durable
`runtime_lost` and original-device-receipt recovery rules.

The runtime uses the environment, including PATH, that started it. PATH is not
silently replaced by later clients. Use explicit command/target executable paths
or stop and start the runtime to change its environment. Each request separately
carries the caller's working directory. Contract-defined local paths resolve
there; Script freezes its `cwd`, source and target before starting. Subsequent
clients cannot change those paths. `evidence verify` is offline in both adapters
and requires neither a running runtime nor an available FactStore.

CLI results are one JSON envelope: `{kind: "json"|"text"|"bytes", value, history?}`.
JSON false, zero and null remain values; text is a string and bytes are base64.
`history` contains the same recording outcome that MCP exposes as `_history`.
Command failures have `value.ok:false` and exit code 1. MCP uses its normal
content and `isError` representation. These are wire-format differences;
validation, dispatch, task control and evidence semantics are shared.

`batch`, `smoke`, `launch-native-test` and `launch-flutter` were removed. Use a
code Script for sequences, `launch-app` for a Flutter app's actual launcher, and
`launch-activity` with a supplied component/extra for app-specific test routes.
Full MCP surface, underscore tool aliases and duplicate outer parameters were
removed. There is no automatic migration or hidden command substitution.

## Android SDK transport

App commands require `packageName`. `port` selects only an optional Host TCP port;
it cannot identify an App or skip endpoint discovery. Device capabilities such as
screenshot and keyevent still work without an SDK package.

The SDK listens on `localabstract:aab-sdk-<runtimeEpoch>` and atomically publishes
`files/ai_app_bridge_endpoint.json` in its App-private directory. The
`ai-app-bridge.android-endpoint.v1` record contains `ok`, `packageName`,
`runtimeEpoch`, `transport:"localabstract"`, `socketName`, `version`, `updatedAtMs`
and `error` (null when ready). Each Host request reads that file through `run-as`
on the resolved serial, validates its package and runtime socket, then creates or
reuses the exact ADB mapping and checks it before HTTP dispatch. Reads and actions
are each attempted once. No cached device port, port scan, TCP listener or old
port-file fallback remains in the Android SDK path.

An older SDK without this endpoint must be rebuilt. Discovery failure is
`bridge_endpoint_discovery_failed`; malformed identity is `bridge_endpoint_invalid`
or `bridge_package_mismatch`; an unready endpoint is `bridge_not_ready`.
`remove-forward` requires `serial` and the Host `port` and verifies the mapping's
serial before removal.

## iOS SDK transport

SDK commands (`ios-status/tree/logs/network/state/events/h5-dom/h5-eval/h5-click/h5-input/h5-scroll` and
`ios-flutter-tree/nodes/action`, plus typed Flutter controls) require explicit `deviceId` and `bundleId`.

iOS Intent supports explicit `provider:"native"`, `provider:"h5"` and `provider:"flutter"` with an iOS target.
Native observation uses the bound WDA tree; tap and inputText require the native
selector below and an explicit WDA session in the target. Android native selectors,
keyevent, back and native gestures are not accepted on the iOS branch.
Native `setOrientation` requires `orientation` and no element selector; it binds
the observed Runner epoch, App process and WDA session before rotating.
An App transition currently requires an explicit session close/create and a new
Intent target; a system dialog disappearing does not silently retarget the old
Intent. The original action receipt remains recorded if its next observation fails.

For Flutter,
Observation, tap, text replacement, scrollBy, back and hideKeyboard use the production SDK
adapter and the existing managed execution port. Before a selected action,
the adapter reobserves and verifies the original Element identity; the SDK
validates the Element reference again at execution. H5 observation and typed actions
use the document/element contract below; the providers do not switch implicitly.

WKWebView DOM observations include `viewport` (`width`, `height`, `scrollX`,
`scrollY`), each control's standard text-editing eligibility in `editable`, and
DOM `interaction.status`: `ready`, `outside-viewport`, `obscured`, `hidden` or
`disabled`. Intent summaries preserve these facts, including empty editors.
`visible` describes CSS rendering; it does not mean a control is inside the
viewport or passes UIKit hit testing. Native hit testing still runs before an
input or click. A scroll receipt includes the resulting DOM interaction state;
requesting a scroll does not guarantee the control moved into view. `text` is
rendered DOM text and can contain an editor's own placeholder decorations.
Text input accepts text-like input types, textarea and editable content; it
does not treat date, color, checkbox or file controls as text fields.

JS/Python Script can call the catalog's iOS observations, capture queries,
launch, WDA session/actions and typed Flutter/H5 controls. `ios-tap-flutter`,
`ios-input-flutter-text` and `ios-scroll-flutter` require an exact `selector`
(`text` or `nodeId`); input also requires `text`, and scroll requires `delta`
in logical pixels. `ios-flutter-back` requests one navigation back action.
`ios-flutter-hide-keyboard` requests explicit focus/keyboard dismissal; observe
`viewport.viewInsets.bottom === 0` before acting on newly exposed controls.
These share the ordinary iOS provider's physical-UDID admission and original
completion receipts. A Script's public `requestId`, or Intent's internal
`runtimeActionId`, is preserved as the SDK/WDA action ID. Catalog availability
states implementation support, not completed complex-App or platform acceptance.
`deviceId` is the selected CoreDevice identifier or UDID. The device must expose
a connected developer tunnel with developer mode and DDI services ready.

Each command copies `Documents/ai_app_bridge_port.json` through devicectl from
that device's App data container. The atomically published descriptor declares
`schemaVersion:"aab.ios-runtime/v1"`, `bundleId`, `runtimeEpoch`, `processId`, `port`
and `ok:true`. The listener asks the OS for an available port and publishes the
actual bound port only when ready. It does not scan a fixed port range. A
starting, waiting or failed descriptor has `ok:false`, `port:0` and its reason;
it cannot authorize HTTP access. Ready descriptors and responses require a
port from 1 through 65535. An old, absent or invalid descriptor fails before HTTP access.
There is no port scan or hostname fallback. An optional `runtimeUrl` or
`iosHost`/`iosPort` selects the transport endpoint; it never replaces container
verification. A forwarded Host port may differ from the SDK's bound native port.

Host requests carry `X-AAB-Runtime-Schema`, `X-AAB-Bundle-Id`,
`X-AAB-Runtime-Epoch`, `X-AAB-Process-Id` and `X-AAB-Runtime-Port`. Every response
carries the matching `runtimeBinding`. Control requests first check bound status
so an old SDK cannot ignore headers and execute a write; the SDK rechecks all
five fields before dispatch. Missing, duplicate or mismatched identity headers
are rejected. These are process-routing credentials, not authentication.
Flutter snapshot ingress retains its existing contract.

Capture writes made immediately after SDK `start()` wait for persistent-store
attachment. The startup queue holds at most 256 records and 1 MiB of serialized
payload plus identity strings; it never supplies query results. `ios-status`
exposes `capture.pendingRecords` and `capture.pendingBytes`. SDK, HTTP capture
POSTs and Flutter capture ingress use the same append path. HTTP/Flutter replies
wait until the backend returns an actual receipt with its original `mobileFactId`;
`accepted:true, committed:false` still means queued, not durable proof. Queries
flush and read the original store before returning committed coverage.

Opening failure, disabled persistence, startup overflow and stop reject pending
writes explicitly (`capture_store_open_failed`, `capture_store_disabled`,
`capture_startup_queue_full`, `capture_store_unavailable`). A cancelled attachment
cannot replay its pending captures after restart. Dropped captures retain a gap;
successful startup does not erase earlier losses. A bounded decision window or
an exact original reference must carry its own coverage.

iOS capture queries scan the requested storage partition: logs use app-log,
network uses network, and state/events share state-event. Sequence-only seeks
exclude earlier records in that partition; returned page cursors keep the
existing global sequence and fixed upper watermark. Global and partition seeks
retain only bounded read positions, and still verify the original frame bytes.
Exact-reference lookup within state-event remains a paged scan; the current
implementation does not provide an indexed constant-time lookup for that case.

The default SDK command deadline is 30000 ms across device discovery, container
copy, preflight and response; `timeoutMs` replaces that total budget. Individual
HTTP requests default to 5000 ms within it. Descriptor reads are bounded to
4096 bytes and HTTP responses to 8 MiB. HTTPS verifies certificates. Invalid or
non-object JSON and responses without a boolean `ok` fail explicitly. Cancellation
waits for local child/socket close. A lost control response remains
`dispatched:null, ambiguous:true, settled:false` until the original SDK completion
is recovered; local cancellation does not prove that the App stopped executing.

### iOS WKWebView targets and DOM controls

`ios-h5-dom` requires one visible WebView, or an explicit `webViewId` previously
returned in `webViews` when selection is ambiguous. It returns `pageRef` with
`aab.ios-h5-target/v1`, SDK epoch, bundle/PID, WebView ID, document ID and URL.
`dom.controls` exposes stable element IDs, visible text, ariaLabel, values and bounds.
Password values are redacted. The first 1000 controls and first 20000 body characters
are retained with explicit truncation flags. Text selection rejects a truncated
snapshot; an explicit observed element ID remains usable within the renderer's
5000-control scan bound.

`ios-h5-click`, `ios-h5-input` and `ios-h5-scroll` require `selector` with exactly
one of `elementId`, exact `text`, or exact `ariaLabel`; optional `tag` narrows it.
Input requires `text` (including empty text to clear). Scroll brings that element
into view. Click/input require the element to be in the viewport and unobscured.
These are DOM operations, not trusted physical touch or keyboard events. Native
hit testing checks the DOM action point before click/input, then the renderer
checks the original identity and unchanged geometry, including DOM scroll offsets,
in its final action turn. The native point is mapped from document coordinates
using UIScrollView zoom and coordinate conversion; CSS innerHeight need not equal
the native area remaining between toolbars. `nativeHit` records the mapped point,
scroll offset, scale and actual hit view. Active scrolling/zooming requires a new
observation. Non-default WKWebView pageZoom returns `ios_h5_page_zoom_unsupported`;
invalid geometry, a point outside the native viewport and native occlusion have
distinct errors.

Script commands select from a fresh snapshot. Optional `expectedTarget` binds the
original `{pageRef,element}` as well. H5 Intent always carries that original target
from its committed observation, and offers `tap`, `inputText`, and `scroll`.
A replaced node, document navigation, history route change or BFCache restore
requires a new observation. Multiple simultaneously visible WebViews require explicit selection; an
App must be active and its selected view attached and visible. Nested frames,
shadow DOM, zoom/transformed viewport coverage and simultaneous multi-WebView
selection are not yet accepted as production coverage. Kiwix real-device tab
creation/closure has verified cached WebView identity, same-URL editor isolation,
and rejection of hidden, closed and stale targets; see the
[business evidence](../../../docs/IOS_H5_EDITOR_BUSINESS_2026-09-11.md#真实双标签隔离).
Intent selects a WebView through `start.observationTarget` or
`observe.observationTarget`, independently of its frozen device/App target.
Use `{"webViewId":"observed ID"}` for an explicit selection, or `null` to require
one visible WebView. `start.target.webViewId` is no longer accepted for Intent;
Script target defaults retain their separate contract. See Intent operations below
for selection, failure evidence and revision semantics.

Expert `ios-h5-eval` now requires `expectedPage` from `ios-h5-dom`; unbound scripts
are rejected. All iOS H5 actions use `/v1/h5/action` with a typed payload and the
existing managed action ID/deadline/receipt. Old SDKs return
`ios_h5_target_schema_required` before dispatch. Script uses the typed commands;
expert eval is not exposed as a Script capability.

### iOS SDK execution and recovery

`ios-h5-eval`, typed iOS H5 controls and `ios-flutter-action` require a matching SDK that advertises
managed execution. Host supplies the action ID, original runtime epoch and remaining
deadline. H5 uses the SDK process epoch; Flutter uses its Dart engine epoch.
The two kinds share one SDK admission slot. Queued work must obtain permission
immediately before a mutation. A queued cancellation revokes that permission;
after permission is issued, only the original execution callback can settle it.
The iOS Flutter MethodChannel is asynchronous and rejects unmanaged `runAction`.

Before reporting a settled result, the SDK synchronously persists an
`aab.ios-completion/v1` record in its internal action partition. A write failure
keeps admission closed. Retrying cancellation can persist that same completed
result; it cannot execute the action again. Queries read the segmented disk store,
including after an App restart. Opaque cursors retain a fixed committed upper
bound. Missing, evicted or invalid records cannot release unknown ownership.

All public iOS mutation commands share Host ownership keyed by the physical
UDID (`ios:<UDID>`), including different Apps and CoreDevice/UDID aliases.
The pending action is durable before dispatch. Host termination or response loss
therefore blocks subsequent mutations until the original completion is proven.
This coordination covers one OS user sharing the same ownership directory.

Use `ios-execution` through CLI or MCP:

- `status`: requires `deviceId` and `bundleId`; returns Host ownership and SDK status.
- `result`: additionally requires `kind:"h5"|"flutter"`, `actionId` and
  `runtimeEpoch`; queries that original completion through bounded disk pages.
- `cancel`: has the same identity fields as `result`; requests cancellation and
  reports the original completion or an unresolved result.
- `reconcile`: requires `deviceId` and the original `bundleId`; reads the saved
  pending identity and releases Host ownership only with its durable SDK receipt.

An explicit `runtimeUrl` or `iosHost`/`iosPort` can select the new connection used
for recovery. Container verification still binds the same physical device and
App. A new serving process does not replace the original action epoch. `status`
showing an idle runtime and `cancel` receiving an acknowledgement are insufficient;
run `reconcile` to resolve a retained Host reservation.

These receipts prove the execution callback ended, not business success or all
asynchronous work triggered by arbitrary App code. WDA has its separate Runner
execution namespace below. Generic lost install/launch replies, simultaneous multi-WebView
acceptance and complete complex iOS business coverage remain open. Native, H5 and
Flutter Intent/Script are available within their implemented command contracts;
availability does not establish production acceptance.

### iOS WDA target and session

WDA commands require explicit `deviceId` and `wdaRunnerBundleId`. The latter is
the Runner application that owns the data container, not the App under test or
the test bundle. Every connection copies `Documents/ai_app_bridge_wda.json` from
that exact device/Runner container. It declares `schemaVersion:"aab.ios-wda/v1"`,
`bundleId`, `runtimeEpoch`, `processId`, `port` and `ok:true`. Status preflight,
request headers and every response must match all five identity fields. A WDA
URL, hostname, `/status` response or vendor UUID alone cannot establish a
physical-device binding. These fields protect routing; they are not authentication.

`ios-setup --start-wda` builds a prepared copy of pinned `appium-webdriveragent`
14.1.1; the dependency's installed source is not modified. Signing requires
`teamId` or the configured development team. `wdaTestBundleId` defaults to
`io.github.mobileaidev.aiappbridge.wda`; its Runner ID is the test bundle ID plus
`.xctrunner`. Setup returns `wdaRunnerBundleId`. Unmodified WDA is rejected.
Setup first runs `build-for-testing` on the Host, then starts the device with
`test-without-building`. A local compilation failure reports `ios_wda_build_failed`
without marking a device dispatch. Device-test interruption still requires original
device completion proof. After WDA is ready, setup launches the target App and
checks a fresh SDK response because starting the Runner changes the foreground App.
`wdaProjectPath`, `wdaBundleId`, unbound URL discovery and log/port scans are
removed. An optional `wdaUrl` can select an explicitly forwarded HTTP(S) endpoint;
without it, use only the selected developer tunnel IP and descriptor port.

`ios-wda-session` operations are explicit:

- `status`: requires the device and Runner IDs; returns foreground App and current
  session. It does not accept `bundleId` or `wdaSessionId`.
- `create`: additionally requires `bundleId`. The App must already be foreground;
  its actual bundle ID and process ID are frozen into the returned session.
  It cannot launch an App or replace an existing session.
- `close`: requires `bundleId` and `wdaSessionId`. It closes exactly that session
  without terminating the App, including after the foreground App changes.

`ios-uia-tree`, `ios-tap`, `ios-input` and `ios-swipe` require all four IDs:
`deviceId`, `wdaRunnerBundleId`, `bundleId`, `wdaSessionId`. The prepared Runner
checks its own identity and the session's foreground App/PID on its main route
queue before dispatch. Old Runner epochs, switched Apps and restarted processes
fail explicitly. A tree read never creates a session. Tap and swipe remain
coordinate operations scoped to this foreground App; they are not semantic
element actions.

`ios-set-orientation` requires the same four IDs plus `orientation`: `portrait`,
`landscapeLeft`, `landscapeRight` or `portraitUpsideDown`. These are App interface
directions; the Runner explicitly converts the opposite landscape device direction.
The Runner must advertise `orientationSchema:"aab.ios-orientation/v1"`.
The command uses the managed `set-orientation` action and the original XCTest
orientation callback. Its result reports `requestedOrientation` and
`observedInterfaceOrientation` (null if unknown); a different observed direction
returns `ios_wda_orientation_not_observed`, even when XCTest accepted the request.
Reobserve the tree/DOM and verify the intended controls after rotation.

Optional `expectedSession` has `{schemaVersion:"aab.ios-native-session/v1",
runnerEpoch,bundleId,processId,sessionId}` from the preceding `ios-uia-tree`.
Intent supplies it automatically for
`{action:"setOrientation",orientation:"landscapeLeft"}`. A changed observation
binding returns `reobserve_required` before dispatch; the Runner also checks
foreground identity immediately before submission. CLI/MCP use this same command,
and Script uses `ctx.call('ios-set-orientation',{orientation:'portrait'})` with
`app.interact`. No session is implicitly created or replaced.

`ios-tap-native` and `ios-input-native-text` require those same four target IDs
and a `selector` with exactly one of `accessibilityId`, `label`, or `elementId`;
optional `type` distinguishes repeated labels (for example a Button from a
StaticText). Input also requires `text` and replaces the selected editor's value.
The Runner must advertise `aab.ios-native-target/v1`. Missing, ambiguous, hidden,
disabled or changed controls fail explicitly; there is no coordinate fallback.
Intent passes its observed `expectedTarget`, binding the original element UID,
raw identifier, label, type, App process, session and Runner epoch. Script can
pass the same expectedTarget, or resolve a fresh exact selector on each call.
An unlabeled icon can use an elementId read from the current tree, not a UID
retained across App relaunches. The Runner revalidates immediately before the
original XCTest event submission. Managed action HTTP waits use the admitted
action deadline; ordinary reads retain their short request budget.

When an iOS native Intent summary exceeds its byte budget, visible buttons and
inputs take priority over long WKWebView text, followed by other visible nodes.
The returned nodes retain the original preorder, sourceIndex, element IDs and
visibility facts. This preserves native toolbar/sheet controls without inferring
that they are clickable or unoccluded. A truncated summary cannot prove absence;
the original observation tree remains available through the evidence export.

`ios-input` requires exactly one `elementId` or `accessibilityId`, plus `text`
(0–16384 characters). An accessibility ID must resolve to exactly one W3C element;
zero or multiple matches fail. Host submits one managed input action. Runner
clicks that editor, optionally sends one keyboard-clear HID event for
`clearFirst:true`, observes the empty value, and sends the text. Each event checks
App/PID/session and the selected editor; keyboard events also require its focus
immediately before permission. Missing, stale or unfocused editors fail; a
nonempty or unsupported raw value after clearing fails with `ios_wda_clear_not_observed`.
An empty XCTest value can be `nil` or an empty string. The displayed placeholder
is not used as proof of an empty editor. The clear event settles only from the
original XCTest daemon callback, followed by a fresh editor/focus check.
There are no coordinate/global-key endpoint replacements or clearing retries.
XCTest synthesizes keyboard events using the current keyboard focus: these checks
cannot atomically prevent an App from switching focus during an already submitted
event. Input, replacement and clearing were verified on the iPhone 17 Pro Max
with iOS 27.0 in the 2026-09-10 device checkpoint. Reentrant focus behavior and
other editor/keyboard/system combinations remain separate acceptance gaps.

`value.error` is a command failure even on HTTP 200. Missing or mismatched
response identity cannot pass. Normal WDA command deadlines default to 30000 ms
across discovery and HTTP. Cancellation closes local requests, and failed setup
waits for its own xcodebuild process to close; it never kills another Runner's
process group. A lost WDA write response retains physical-device ownership and
is never replayed through another route. `doctor.ready` requires a connected device,
developer services, the App SDK and bound WDA; it is a connectivity result, not
production acceptance.

### iOS WDA execution and recovery

The prepared Runner advertises `aab.wda-execution/v1` at `/aab/status`. Session
create/close, tap, swipe and input all use one managed admission slot. Control
requests run outside the UI queue, so queued work can be cancelled while main is
busy. Every event requires permission immediately before submission. Queued
cancellation ends without an event; once an event is submitted, cancellation
prevents later steps but retains occupancy until the original XCTest completion
callback. It does not actively abort an in-flight XCTest event. A missing callback
or an exception during submission remains unresolved.

Runner synchronously commits `aab.wda-completion/v1` into the real segmented
action store before reporting settlement. Records bind Runner, operation,
App/PID, session, action ID and original Runner epoch. Persistence failure keeps
admission closed; cancellation may retry storing the same finished result, never
replay its event. Disk reads are paged at 64 records/2 MiB with a fixed committed
upper bound and scope-bound cursors. Missing or evicted records cannot release
ownership, even when a new Runner is idle.

Use the existing `ios-execution` command with `kind:"wda"`:

- `status`: requires `deviceId` and `wdaRunnerBundleId`; returns Host ownership
  and Runner execution status.
- `result`/`cancel`: also require the original `actionId` and `runtimeEpoch`.
- `reconcile`: reads the durable Host pending identity and queries only that
  original Runner/action/epoch/target. A committed matching receipt releases the
  physical UDID reservation without replay. A new serving Runner epoch does not
  replace the original completion epoch.

The WDA branch rejects SDK-only `bundleId`, `runtimeUrl`, `iosHost` and `iosPort`.
An explicit `wdaUrl` can select the current forwarded connection; the exact
device/Runner container must still match. `status` showing idle or `cancel`
acknowledging the request is insufficient to release retained Host ownership.
Use `reconcile`. Software fault checks and unsigned arm64 compilation qualify
this contract; physical-device execution remains a separate gate.

## Execution operation contracts

`operation` is required. Each operation accepts only its own fields. For Intent,
use `start/status/observe/decide/pause/resume/cancel/intervene`; intervention
requires a reason. For Script, use `start/status/wait/result/pause/resume/decide/cancel/runtime-status`.
Read progress through `status` or event pages from `wait`; `ctx.progress()` remains
available inside the program. `progress`, Script `intervene`, Intent `reobserve`,
and `start.spec` are removed aliases.

Intent start requires `goal` and an explicit Android, iOS or Web target. Android uses
`platform:"android"`, `serial`, and `packageName`; optional fields include `adb`,
`port` and a `foregroundPackages` allowlist. iOS uses `platform:"ios"`, `deviceId`
and `bundleId`, plus the SDK/WDA binding described above. Web uses `platform:"web"`,
`sessionId`, `runtimeEpoch` and the observed `targetId`, with provider `h5`. Supervised
mode is the default. Autonomous mode requires `mode:"autonomous"` and `agentModule`;
its `budget` defaults to 30 actions, 30 Agent calls, 120000 ms and `allowlist:["tap"]`.
The allowlist uses the public action vocabulary, including Web `pressKey` and iOS
`setOrientation`; it never bypasses the selected provider/platform action schema.
The last permitted Agent reply is validated and may act or finish. A spent action
or call budget prevents another Agent call. Malformed replies remain
`waiting_for_decision` with a field error and require explicit correction; they
neither dispatch nor trigger another Agent request automatically.

Every decision requires `decisionId`, positive integer `basedOnRevision`, and
`agentDecision`. `act` requires a provider-specific `action`; terminal decisions
`complete/fail/inconclusive` forbid one. Tap uses an exact `selector` object, with
one identity: Native/UIA `text`, `resourceName` or `contentDescription`; Flutter
`text` or `nodeId`. Only Native supports a scoped `within` selector. Actions inherit
the provider of the committed observation; an explicit provider must match it.
To change providers within a supervised Intent, call
`{"operation":"observe","operationId":"…","provider":"h5","basedOnRevision":3}`.
`provider` and `basedOnRevision` are optional. Android accepts `native/uia/flutter/h5`;
iOS accepts `native/h5/flutter`; Web accepts `h5`. The device/App target and any WDA session stay
frozen. Switching to iOS native requires the original target to contain its WDA
Runner and session. Installation and permission workflows retain their required
`uia` provider and reject another provider or any explicit `observationTarget`.

For Android and iOS H5, `start` and `observe` accept `observationTarget:{webViewId:"observed ID"}`
or `null`. Start defaults to `null`; an explicit selection is configured at start.
On `observe`, omitting it retains the committed selection when the provider is
unchanged. Changing provider without a selection clears it to `null`. An explicit
`null` requires one visible WebView; ambiguity never selects the first candidate.
An explicit ID never selects a replacement if its view becomes hidden or closes.
The object accepts only `webViewId` and is supported by Android and iOS H5. Invalid
selections return a field error before provider I/O or revision changes.

Subsequent provider and WebView selections change only after their observation and
summary are committed.
Use the returned revision for the next decision; a decision from before the switch
returns `reobserve_required` without dispatch. Provider acquisition failure enters
`waiting_for_observation` and blocks decisions on the retained old summary. Retrying
`observe` with neither selection reads the last successfully selected provider and
WebView; specify the desired selection again to retry a failed switch. A rejected
provider observation is retained as an `observation-failed` checkpoint before
`observationFailure` exposes its evidence ID, attempted selection and original
structured response (including available `webViews`). A successful observation
clears the active failure; its checkpoint remains in history and exported evidence.
Failure details are not exposed if their evidence cannot be persisted. A pending
observation cannot accept another observation or action, and cancellation drains
it before finalization. H5 actions still bind the page and element from the
committed observation, including after an explicit WebView selection.

Native/UIA scrolling is `scroll` with required `direction:"up"|"down"`; Native also
requires the exact scroll-container `selector`. Flutter uses
`scrollBy` with required container `selector` and `delta`. Native and Flutter
`inputText` require `selector` and `value`, including an empty value to clear.
`keyevent` requires `keyCode` and accepts 0;
`back` has no key parameter. See the discovered schema for native editing gestures.

Intent capture requirements use `require.streams`, a nonempty unique array of
`logs/network/state/events`, plus the documented query window/limit options.
These options cannot replace the operation's target. Business JSON is open only
where declared, such as `script.inputs`, Script Agent answers and registered Web
App action data; control objects reject unknown fields and invalid values.

Intent expands `require.streams` into individual capture reads; the streams list
and foreground-routing options never become command arguments. A historical
partial page retains its gap. Its committed SDK watermark can bound the next
action window; only that later read can establish complete coverage for new
facts. Capture failures retain their machine code, field and message in the
observation and portable recording.

Script start accepts `script`, optional operation ID, `recordingDir`, and
`pythonPath` for Python only. Supply `script.target` for device work. Language is
exactly `javascript` or `python`; source is exactly one of `source` or `sourcePath`.
Policy supports `timeoutMs`, `restartPolicy`, `maxOutputBytes`, `maxProgressBytes`.
`policy.onFailure` was unused and has been removed: source checks call results
and assertion verdicts, uncaught exceptions fail execution, and pause is explicit.
Recording currently requires `restartPolicy:"none"`. Frozen checkpoint recovery
uses its saved program and never blends missing caller fields with stored fields.

Script completion persists its returned JSON before exposing `completed`. Status,
wait responses and terminal events carry only
`resultRef:{evidenceId,bytes,sha256,originalSha256,representation}`; the full value
is read with `script {operation:"result",operationId:"…"}`. This reads and checks
the retained FactStore record, including after runtime restart, independently of
the bounded progress ring. `maxOutputBytes` defaults to 1 MiB and accepts at most
64 MiB; the store must retain the whole result or report failure. A failed result
write ends the operation as `failed` with `result_not_persisted`.

Results use the same password/token redaction as other persistent evidence.
`representation` is `original-json` or `redacted-json`; `sha256` and `bytes`
describe the persisted canonical JSON, and `originalSha256` describes the original
canonical return value. Successful reads return `result`, `resultRef` and
`persisted:true`. An unfinished operation returns `result_not_ready`; failed or
cancelled work returns `result_unavailable`. Missing result persistence, retained
checkpoint with evicted result, and inconsistent content return
`result_not_persisted`, `result_not_retained` and `result_checksum_mismatch`
respectively. An evicted or unknown operation may return `unknown_operation`;
store/read errors remain errors. No missing result is reconstructed from events.

`flutter-action` and `ios-flutter-action` accept a typed `payload` object for the
documented SDK actions. Payload `actionId` is owned by the Host. These remain expert
commands; raw SDK actions do not acquire Intent's observation contract. `web-command`
uses a builtin name and its typed `arguments`; registered App actions use
`name:"action", arguments:{name:"registered.name", arguments:{...}}`. Web target
commands require `sessionId`.

Flutter semantic taps resolve against the complete operable tree before DOWN.
While the pointer is held, the SDK revalidates the original Element, semantics,
action ancestors and the actual touch position. A removed, changed, covered or
moved-away target receives CANCEL instead of UP. Automatic whole-App snapshots
wait until this short pointer terminates, then resume; they cannot add tree
inspection work to the held gesture. App callbacks can still block the Flutter
isolate, and a mechanical tap receipt still requires an observed business outcome.

## Target and dispatch

Every Android mutation requires explicit `serial`. App-specific commands require
`packageName` or, for compatible SDK reads, an explicit bridge port. Discovery
currently exposes common transport options; command-specific semantic and nested
runtime schemas are still being tightened. The current contract does not claim
that every advertised optional parameter is already equally meaningful on all
platforms. Read `entrypoints.script` independently of direct MCP availability.

`tap` uses physical pixels. An explicit package must match the foreground even
with `feedback:"off"`. App scope uses the SDK; `scope:"device"` chooses physical
ADB input. Unknown/mismatched foreground is a non-dispatched failure.
`tap-flutter` uses Flutter logical pixels, with no DPR multiplication.

`tree` and `uia-tree` compact reads accept `maxDepth` from 0 to 200 and
`maxNodes` from 1 to 1000. These parameters constrain actual returned nodes;
values outside the implemented limits fail validation instead of being clamped.

`tap-text` retains automatic provider selection. `provider:"auto"` inspects
Native, Flutter, then UIAutomator until one exact operable match is selected.
Read-only discovery failures are recorded and another provider may be inspected.
Ambiguous matches stop selection. The returned `provider`, `coordinateSpace`,
`selected` and `observations` explain the choice. Specify `native`, `flutter`
or `uia` to pin replay. Foreground changes invalidate the choice. After dispatch,
an error or unknown result is returned without another provider attempt.
This convenience command does not provide Intent's complete revision and page
identity contract; flows needing that contract should use Intent decisions.

`input-text` is SDK native Unicode input and accepts an empty string to clear
an editor. An optional exact Native `selector`, including `within`, binds a
unique editable View using the same target protocol as Intent. A selector and
coordinates are mutually exclusive. Without either, it requires a visible
focused EditText in the focused foreground window; it never chooses an arbitrary
first editor. An SDK failure is returned without ASCII ADB retry.
`clear-app-data` selects `method:"pm-clear"` (default) or
`"runtime"` before one attempt. WDA tap/input/swipe use their selected endpoint
once; a response timeout is ambiguous and is not retried through another endpoint.

Android mutations share physical-serial ownership across cooperating Host
processes and package installations under the same OS user. Different packages
on one serial contend; different serials remain independent. The shared directory
is `~/.ai-app-bridge/device-ownership/v1`, independent of FactStore and working
directory. `AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR` explicitly configures a shared
namespace; all cooperating processes must use the same directory. This does not
arbitrate unrelated ADB clients, other OS users, remote hosts, or two serial
aliases that address one phone.

An OS-managed exclusive lock has no heartbeat expiry. A separately synced journal
records pending work before dispatch. An idle dead owner can be replaced; an
unresolved action survives Host death, timeout and restart and blocks new writes
with `device_ownership_unresolved`. Long-running installation retains its own
record while observed installer UI actions execute under the same owner. Ending
the local ADB process does not by itself confirm a cancelled install has settled.

Use `device-ownership {operation:"status",serial:"DEVICE"}` to inspect ownership,
or `operation:"reconcile"` to query the recorded action through its original
package and transport configuration. Reconciliation exclusively owns the device
while checking; there is no force-release, caller-supplied replacement target,
expiry, or action replay. Android Native, Flutter, H5 and managed shell actions can
recover from an identity-matching `aab.native-execution/v1`,
`aab.flutter-execution/v1`, `aab.h5-execution/v1` or
`aab.android-shell-execution/v1` terminal receipt. UIA node actions use
`aab.uia.execution.v1`, additionally matching the boot ID, original request
bytes/hash, snapshot and node binding. Recovery queries the original runtime or
reads that same action's durable phone record; it never starts a replacement action.
Successful reconciliation returns `executionReceipt` and records it
in its own execution history; the original unknown result remains unchanged.
A missing action, idle SDK, changed runtime or failed connection is insufficient.
Other transports without a matching completion protocol remain unresolved.
Installation uses the original phone job and PackageInstaller session contract
described below.

The ownership journal is `aab.device-ownership/v2`, under the **same physical
lock directory** above. Reading v1 preserves every unresolved identity and
reservation; the next commit upgrades its format. v1 had no pending-ack queue,
so the upgrade cannot invent cleanup obligations for already forgotten actions.
Older writers reject v2 instead of dropping its new records.

UIA settlement atomically saves an acknowledgement obligation with the exact
request, receipt and original FactStore destination. At most eight may remain;
`device_acknowledgements_full` rejects further UIA preparation until reconciliation.
Acknowledgement first synchronously commits and reads back a completion record
in the same segmented FactStore used by MCP/Intent/Script. Only then may the phone
confirm its copy and the Host remove the obligation. Failures preserve the queue
without changing the known effect or replaying it. A busy native FactStore reports
`fact_store_writer_busy`: reconcile from its owning Host, or close that Host before
retrying. Changing the new Host's recording directory does not redirect an old
obligation. Ownership journals are bounded to 4 MiB.

`device-ownership {operation:"receipt",serial:"DEVICE",runtimeEpoch:"UUID",actionId:"ORIGINAL-ID"}`
reads retained UIA completion history from the configured Host FactStore without
contacting the phone. The returned request and completion each have `json`,
`originalSha256`, `storedSha256`, and `representation` (`original-json` or
`redacted-json`). `originalCompletionAvailable:false` explicitly means redaction
changed the original bytes. Missing or evicted history returns
`device_completion_not_retained`; it is never interpreted as an action outcome.
This query does not reconcile or release unknown ownership. History remains subject
to FactStore retention quotas, independent of later overwrites of `lastSettlement`.

Reconciliation also drains pending acknowledgements when there is no unresolved
effect, and reports each `acknowledgements[].disposition` with its durable history
reference. A stopped original session is acknowledged by a maintenance process
holding the phone root lock, without opening UiAutomation. A newer live runtime
may acknowledge an older epoch. `not_retained` only says its phone copy is already
absent; it is accepted for cleanup solely after the Host's matching completion
representation has been durably stored. An active epoch uses its original engine.
Another unresolved action remains occupied throughout cleanup of known history.

Android shell mutations, including explicit physical input, app launch,
PackageManager permission changes, app-ops, process signals and `logcat` clear,
use a detached phone worker. The Host persists the original action ID, job ID,
boot ID, command hash and monotonic admission deadline before starting it. The
phone records completion after the shell command exits. A pre-admission cancel
or expired deadline prevents the command from starting. After admission, the
command drains naturally; cancelling or killing the Host does not stop it or
release unknown ownership. Recovery checks this original job without replaying it.

The command process ending does not prove that navigation, PackageInstaller or
another asynchronous Android service completed its business operation. A shell
proof does not provide SDK target binding or App event correlation. UIA semantic
clicks use the separate node runtime described below.

Phone jobs are stored under `/data/local/tmp/ai-app-bridge-shell/v1`. Each stdout
and stderr file is limited to 64 KiB on the verified Android shell; exceeding
the limit fails the command and retains its exit code and completion proof.
At most 512 unacknowledged job directories may remain. A new preparation removes
only acknowledged directories; capacity exhaustion returns
`shell_execution_store_full` before dispatch. Unknown jobs are never evicted to
make room. A normal Host acknowledges only after reading the output and syncing
the matching proof to its ownership journal. Unread output, abandoned preparation
and recovered jobs remain retained; automatic retirement of those records is
not implemented. A missing directory or changed boot cannot release ownership.

`logcat` reads retain their text result. `logcat {clear:true}` returns an object
with `ok`, `text` and the verified execution fields because it mutates the phone.

A common command's `requestId` reuses the result only for the same target and
canonical command/arguments. Different content returns `idempotency_conflict`.
That cache is bounded and process-local, not a durable exactly-once guarantee.

## Script access and evidence

The catalog exposes executable Android, iOS and desktop Web capabilities.
Script calls use the same provider and target ownership as direct CLI/MCP calls;
catalog support does not establish complete platform business acceptance. Unsupported Script target
fields are rejected instead of being silently discarded. Recovery hashes include
target and permissions as well as source/policy.

`script decide` answers `ctx.askAgent` with a JSON value, including structured
objects, arrays and primitive values such as null or false. Supply the question's
requestId and revision. Repeating the same answer by canonical JSON content is
idempotent; changing an already answered question's value is rejected. Omitting
the answer is invalid and is distinct from explicitly answering null.

Default permissions are `app.read`, `capture.read`, `app.interact`. The trusted
caller may explicitly include `app.lifecycle` for clear data and
`app.permissions` for permission/app-op fixture changes. The host freezes this
selection into the operation; Script source cannot change it through `ctx.call`.
These are capability declarations inside a trusted local execution model, not
an OS sandbox or a multi-tenant authorization system. Raw eval and provider
management remain explicit direct expert commands. Capture-only calls cannot
supply CDP eval code or clear device logs.

Android mobile capture reads the device FactStore after durable attachment; Host
execution/observation records use the Host FactStore. iOS public capture now uses
the device segmented store as described below. Web capture is committed on ingress
to the Host FactStore; retained history and live barrier coverage have distinct
contracts described in the Web section. Strong mobile evidence
requires actual refs, matching epoch/target, the requested window and valid
coverage. Archive validity, command completion and business assertions are
separate results. See [Script authoring](SCRIPT_AUTHORING.md) and
[evidence archives](EVIDENCE_ARCHIVE.md).

## iOS persistent capture

The iOS SDK has one write/read path for logs, network, events and state. Before
persistent attachment, capture returns `ok:false` with `capture_store_opening`
or `capture_store_unavailable`; no in-memory payload history substitutes for it.
A successful POST means its record was queued. The returned `receipt` has
`accepted:true`, `committed:false` and the original `mobileFactId`. A later
successful persistent query proves the matching record exists. Flutter's iOS
MethodChannel forwards the complete payload, including `actionId`, and returns
the same receipt. App-log/NSLog/H5 console capture also uses this store; the
separate device-log partition remains separate.

HTTP GET accepts `view`, `sinceId`, `sinceMs`, `limit`, `runtimeEpoch`,
`afterActionId`, `factCursor`, `mobileFactId` and `targetKey`. Unknown names,
empty identifiers and invalid numbers fail explicitly. `limit` is 1–1000,
default 200; `sinceId` is exclusive, `sinceMs` inclusive. The old `since-id`
and `since-ms` HTTP aliases and silent limit clamping are removed.

- `legacy-live` is a bounded current-runtime projection; state keeps the latest
  value per key. It reads persistent facts and reports projection limits.
- `decision-window` reads the current runtime. An action filter requires a
  pre-action cursor, capture ID or timestamp boundary.
- `connected-history` reads retained records across runtimes. A capture ID
  filter also requires `runtimeEpoch`, since IDs restart in each runtime.
  An exact `mobileFactId` can resolve its original record after restart.

Queries flush and freeze the durable upper sequence in one writer operation;
new writes cannot enter that committed boundary. Each response carries refs,
coverage, the target/runtime, `nextCursor` and `watermarkCursor`. Page cursors
freeze the upper boundary; a watermark starts a subsequent window. A page scans
at most 1024 logical records or 8 MiB, with a two-second scan budget in addition
to bounded writer waits. An empty filtered page can have `hasMore:true`; callers
must use its `nextCursor`. Each writer read batch is at most 64 logical records
and 2 MiB. Query projection and page memory have explicit limits; payload
history is not hydrated into a second cache.

Clear persists stream generations and invalidates old cursors. Retention or
known write loss produces partial coverage. An unknown pre-attachment loss
cannot be cleared by `sinceId:0`. Metadata corruption, flush errors and changed
store bindings never return committed success. Capture status counts are bounded
accepted counts since attachment, not totals for retained disk history.

This storage contract has real-disk Swift integration coverage and iOS compilation
proof. Storage proof and complex business acceptance are separate. iOS Intent
and Script now use explicit native/H5/Flutter providers and bound execution
receipts described above; each real-App scenario retains its own evidence limits.

## Semantic targets and text waits

`tap-uia` takes an explicit package and either a selector or the complete
`targetRef` described below. A selector has exactly one field:
`{"text":"All files"}`, `{"contentDescription":"All files"}` or
`{"resourceName":"com.example:id/files"}`. A text selector matches only the
text attribute. A parent accessibility description with the same wording does
not make that child text ambiguous. Two actual text matches remain an error.
The command observes the current UIA runtime, binds the selected node, checks
the foreground again and sends the same original action ID through the existing
UIA execution journal. CLI, MCP and Script share this implementation.

For duplicate or unlabelled controls, `uia-tree` with `compact:true` exposes
`node.targetRef`; Intent UIA summaries expose the same reference. It contains
`{schemaVersion:"aab.uia.target/v1",bootId,runtimeEpoch,snapshotId,nodeRef}`.
Pass that complete object as `tap-uia.targetRef`, mutually exclusive with
`selector`. An Intent uses `selector:{nodeRef:node.targetRef.nodeRef}` from its
current revision, which supplies the original observation identity.

Reference actions use the retained node from that exact snapshot. The phone
locates the same accessibility source in the same focused window and checks all
original node and clickable-ancestor attributes before requesting the click.
Duplicate text does not choose a different node. Expired, changed or foreign
references fail before dispatch; they are never replaced with a fresh text
match. UIA retains at most eight snapshots for 60 seconds, so Scripts observe
immediately before selecting and acting. This is a runtime reference, not a
persistent selector to save between runs.

The convenience text commands below match display text and, for Native/UIA,
accessibility descriptions. When this yields several candidates, use `tap-uia`
or an Intent with a precise selector to state which attribute is intended.

`tap-text`, `tap-uia-text` and `tap-flutter-text` share exact, unique selection,
fresh revalidation and foreground checks. Auto discovery happens only before a
provider is selected. Revalidation failure never dispatches through a different
provider. Native selection is limited to the top non-hidden window; a dialog,
unknown root or disabled foreground root cannot expose a background target.
Flutter text targeting also checks that the native foreground is the activity.
Coordinates returned by Flutter remain logical pixels.

Native Intent tap/input/longPress/swipe/scroll and Flutter tap/input/scrollBy re-read before input.
UIA revalidates its saved node reference on the phone before Binder admission.
Changed identity, ambiguity or invalid bounds reject before dispatch. Native
input requires the SDK's explicit `editable:true`, including standard EditText.
Native tree nodes expose `checked:true|false` for Android `Checkable` controls
and `checked:null` for other Views. The checked state participates in the SDK
target guard; a state change after observation rejects the old target before
dispatch, so a stale checkbox action cannot toggle a newly changed value.
Semantic summaries retain both checked and unchecked controls, including
unlabelled preference switches. UIAutomator's `checked` value is meaningful only
when its node declares `checkable:true`; other UIA nodes have `checked:null`.

`tap-native` exposes a precise Native selector to CLI, MCP and Script callers:

```js
await ctx.call('tap-native', { selector: {
  resourceName: 'com.example.app:id/confirm',
  within: { text: 'Test item', ancestor: { resourceName: 'com.example.app:id/row' } }
} });
```

It requires an explicit App target and one unique match, revalidates the same View
before dispatch, and retains the original Native execution receipt. Its selector
uses the shared Native contract, including `within`; ambiguous, replaced and
unbound targets fail without dispatch. Passive descendants inside a selected
semantic container may receive its gesture; an interactive child or unrelated
overlay still prevents that container tap.

`input-text` with a `selector` uses the same foreground and View revalidation,
requires `editable:true`, and sends the exact editor reference to the SDK.
CLI, MCP and Script share this entry; missing, ambiguous, replaced or noneditable
targets fail before input. For example:

```js
await ctx.call('input-text', {
  selector: { resourceName: 'com.example.app:id/search' }, text: 'Monaco'
});
```

Native Intent `tap`/`inputText`, `tap-native`, selector-based `input-text` and the Native branch of `tap-text` additionally
require `targetRef.schemaVersion:"aab.native-target/v1"` from the SDK tree. The
Host sends the selector, reference and action ID to `/v1/action/tap-target` or
`/v1/action/input-target`, without coordinates. In one UI-thread task the SDK
checks the runtime, focused window, View instance, observed semantic ancestry,
uniqueness, editability and clipping, then uses the current bounds/selected editor.
Same-View layout movement is allowed; replacing a View with an identically named
View is rejected. Input rechecks after synchronous focus/connection callbacks
and again after the input connection sets the selection, before committing text.
A rejection after requesting focus reports `dispatched:true`, since that effect
already occurred; it does not commit text to a replacement editor.

Coordinate and focused `input-text` also retain the selected editor and window
across those callbacks. A detached/replaced editor returns
`native_target_replaced`; changed focus returns `input_focus_changed`. Neither
path redirects text to the new focus. This binds the SDK's editor selection and
commit call, without making custom App input-connection behavior transactional.

Missing references or an unsupported endpoint return
`native_atomic_target_unavailable`; this selected Native attempt never downgrades
to coordinate or device input. A queued SDK task that times out is cancelled;
a mutation already running at timeout returns an ambiguous outcome. These checks
do not make app touch handlers or business outcomes transactional.
Explicit coordinate commands retain their primitive role.

UIA observation and semantic clicks require Android API 33 or newer and the
bundled, hash-verified `runtime/uia` module. `uia-tree` opens or reuses one
UiAutomation connection on the explicit device. XML snapshots carry boot,
runtime and snapshot IDs; each node has an opaque reference. Ordinary UIA text
commands, Intent (including installer and permission choices), and JavaScript /
Python Script calls send that reference and their original action ID to the
same runtime. They do not convert text matches into physical coordinates.

The runtime checks the focused default-display window, unique selector match,
node attributes and clickable ancestor before one node action. Its guarantee
is `same_connection_node_and_reobserved_attributes`, not a transaction across
the App's content changes and Android window management. Original Binder
callbacks distinguish handled/rejected outcomes; an admitted action without a
matching callback remains unknown. Host timeout, cancellation or process exit
does not release that action's device ownership. Pre-admission cancellation
persists a tombstone, so a delayed start cannot execute afterward.

For a dead UIA owner, `device-ownership --operation reconcile` can recover a
committed `prepared` or `queued` record. One-shot phone maintenance must acquire
the original root's exclusive OS lock and validate the original request, epoch,
executable hash, zero interaction ID and empty receipt. It writes a durable
`recovered_before_admission` receipt with `dispatched:false` and
`uia_owner_exited_before_admission`; it never starts UiAutomation. The receipt
separately identifies the recovery boot/elapsed time, original preparation time,
prior record SHA-256 and executable hashes. It has no original callback or
`completedAtElapsedMs`. Original request bytes and deadline stay unchanged.
Already admitted/unknown actions and absent original records remain unresolved.
The first valid recovery receipt is retained on retry, persisted to FactStore,
and acknowledged through the same durable cleanup queue as other UIA receipts.

`uia-runtime --serial DEVICE --operation status|start|stop` exposes expert
lifecycle control. `status` is read-only; `start` and `stop` share device
ownership with actions. Stop requires committed terminal actions. Explicit start
checks the phone's OS-managed process lock. A dead process can be reopened only
after the new process acquires that lock and audits all original action records;
any nonterminal or corrupt record blocks reopening, including after a reboot.
An HTTP timeout or a stale `running` descriptor does not authorize replacement.
Authentication tokens
stay in private phone descriptors and are absent from public status and Host
ownership records. Each runtime retains at most 256 actions; the root retains
at most 64 sessions. A fresh observation automatically rotates a full session
only when every action is durably terminal and acknowledged. An already bound
action never triggers rotation; a full journal rejects it before Host preparation.
Old epoch references become invalid and require a new observation.

At startup, fully acknowledged sessions move atomically into `retired/`; both
parent directories are synced before any contents are deleted. Interrupted
deletion resumes there. Unacknowledged original receipts remain byte-exact in
`sessions/`. Reclamation never evicts unknown actions or trusts temporary files
as completion proof. Host acknowledgement follows durable ownership settlement,
so long-term evidence must be read from Host storage/archives after phone-side
retirement. A stopped session's unacknowledged receipt is retained and can be
acknowledged through exclusive-lock maintenance. Current real-device evidence
covers API 36 on OPPO PGFM10 and OnePlus PKR110 with distinct checkpoint scopes.

Nonsecret JSON captured as text keeps its original bytes during evidence
persistence, so Android's escaped solidus characters do not invalidate receipt
hashes. Credential redaction still applies, including duplicate/escaped JSON
keys. A redacted representation is not the original cryptographic credential.

Flutter semantic actions require `aab.flutter-target/v1` references from the
operable tree. IDs identify live Elements across snapshots; the reference also
binds the runtime, observed semantics, action ancestor, editor controller/focus
node and scroll container. The SDK rebuilds its current targets before dispatch,
rejects changed/replaced/covered targets, and uses current logical geometry.
A missing reference returns `flutter_atomic_target_unavailable` without a
coordinate fallback. Truncated trees cannot establish a unique target.

Flutter Intent compares target identities structurally; JSON object key order
does not identify an Element. Runtime, Element, semantic or guard changes still
require a fresh observation. The operable viewport reports logical-pixel
`viewInsets`; visible geometry intersects the actual View viewport excluding the
native keyboard. A partially visible scroll container keeps its exposed bounds;
a fully covered control cannot receive a semantic action. This does not detect
every native system overlay outside Flutter's hit-test tree.

Flutter editor observations and Intent summaries preserve the standard field's
optional `label`, `hint` and `errorText`. Material declarations come from that
editor's InputDecorator; a Cupertino placeholder is a hint, not a label. Custom
label/error widgets are not inferred from nearby text. Select the observed node
by its metadata, then submit its exact `nodeId`; no label selector is implied.
Label or hint changes invalidate the observed editor identity, while a validation
message alone does not. Transparent TextSpan content and controls under
zero-opacity Opacity/FadeTransition are excluded from the operable tree;
diagnostic strings are not used as visible text. Arbitrary canvas/shader paint
still needs App semantics.

The diagnostic widget-inspector JSON is separately bounded to 64 levels and
4000 entries and reports `truncated`. Its truncation does not imply that the
operable tree is truncated or that unreported diagnostic widgets are absent.

`tap-flutter` accepts either `selector:{text|nodeId}` or the explicit logical
coordinate pair `tapX/tapY`. `input-flutter-text` accepts an optional selector or
coordinate pair; when both are omitted it selects one focused editor, or one
unique visible editor. Several unfocused editors return
`flutter_selector_not_unique`. After the tap and awaited frames, the SDK verifies
the original EditableText, controller and focus before addressing that exact
TextInputClient. `flutter_input_focus_changed` never redirects text to the new
focus. App input formatters and callbacks retain their normal behavior.

`scroll-flutter` accepts a container selector with `delta` or `targetText`.
Omitting the selector requires one visible Scrollable. Scrolling until text
uses exact unique matching and retains that container across frames; there is
no last-container choice, hidden keyboard action or fallback physical swipe.
`flutter_scroll_boundary` reports no movement. These commands retain the
existing Script `app.interact` permission; raw `flutter-action` remains expert
only. Raw target references/action IDs are not public payload parameters.

The Dart runtime rejects overlapping action requests with `flutter_action_busy`.
Target removal/change during a bound tap sends CANCEL before UP; restarting the
runtime invalidates old references. Android additionally advertises
`executionSchema:aab.flutter-execution/v1`. Host freezes its runtime epoch and
action ID and sends the remaining execution budget, without restarting it.
Missing capability fails with `flutter_execution_unavailable`; there is no
old-protocol retry. Intent, Script and direct actions share this transport.

Android receives Flutter actions asynchronously, leaving its HTTP listener free
for cancellation. Dart obtains native admission before starting a pointer
sequence, writing the bound editor, or making another scroll jump. An admitted
pointer sequence handles its timing and terminal events locally; waiting on a
channel while holding DOWN must not turn a short tap into a long press. Local
stop signals and a monotonic deadline terminate Bridge-owned waits with CANCEL.
Opaque App futures remain owned until they actually finish.

On a lost response or Host cancellation, Host sends one bounded cancellation
request to the same connection and runtime, without replaying the action. Only
the original action's matching terminal receipt proves `settled:true`.
Queued requests whose admission was revoked prove `dispatched:false`. A stopped
request with previously granted admission remains SDK-busy until its original
completion. After the 1500 ms cleanup grace period, missing confirmation returns
`dispatched:null, ambiguous:true, settled:false`; it does not free SDK admission.
A repeated cancel can retrieve the single retained terminal receipt. This is
bounded cleanup evidence, not a persistent idempotency or rollback service.

Cancellation does not undo delivered input or App callbacks; an action may
finish before its stop signal is observed. SDK settlement means no further
Bridge-controlled continuation for that action. Cross-process device ownership
retains unresolved work across Host death and can reconcile the original SDK
receipt as described above. iOS
still uses its distinct transport and does not advertise this Android contract.

Native Android tap, text input and gestures share one SDK execution coordinator.
`status.debugBridge.nativeExecutionSchema` advertises `aab.native-execution/v1`;
`nativeAction` identifies the active operation or is null. Host sends its action
ID, the observed runtime epoch and remaining timeout in `execution`. Missing
capability is `native_execution_unavailable`; there is no old-protocol retry.
The shared `/v1/action/cancel` requires the original action ID and runtime epoch.
This replaces the former gesture-only cancellation endpoint and status field.

Cancellation before main-thread dispatch prevents a late tap or input. Once an
App callback has begun, the SDK retains occupation until it actually returns;
the 1500 ms cleanup grace only bounds the reply, not callback lifetime. A blocked
callback returns `settled:false, dispatched:null, ambiguous:true`. Tap stops
with CANCEL before a late UP; input checks cancellation before subsequent writes.
Input already committed and App side effects are not rolled back.

The coordinator retains one immutable terminal receipt in memory. Repeated
cancellation can retrieve that receipt; reusing its action ID for another action
is rejected. This is not durable deduplication: SDK restart or a missing cached
receipt cannot prove an unresolved prior action settled. Terminal
`native.action.settled` events carry the original action identity without input
text. Native, Flutter, H5 evaluation and runtime clear-data cannot overlap an
active Native operation through this SDK.

Native/Flutter/H5/managed-shell action results expose a compact `executionReceipt` when verified
settlement or explicit non-dispatch is known, and null when it remains unknown.
Ordinary execution history, Intent action receipts and Script action receipts
preserve it. Commands containing several physical operations can return
`executionReceipts`; ordinary history and Script action receipts preserve that
array. Each response hash covers the validated protocol result before Host
metadata, not the raw transport bytes. Settlement proves the recorded execution ended;
it does not turn an ambiguous action or unverified business assertion into a pass.

Native Intent `longPress`, `swipe` and `scroll` use `/v1/action/gesture-target`.
The top visible SDK window owns pointer selection. A touchable, non-focusable
popup can use its focused owner with the same application window token; the SDK
does not select a background window when the popup blocks an action. Native/H5
window selection shares this rule. Native window observation carries
`focused`, `focusable`, `touchable` and nullable
`focusOwnerWindowId`. Native input requires actual focus in the selected window.
Native touch events keep screen-space `rawX/rawY` and window-local `x/y` distinct,
so App outside-touch interceptors receive the same coordinate spaces as normal input.
Script and direct callers use the shared `native-gesture` command, requiring
`serial`, `packageName` and a typed `payload` with the same selector/action fields:

```javascript
await ctx.call('native-gesture', {
  payload: { action: 'longPress', selector: { text: 'Observed note' }, durationMs: 700 }
});
await ctx.call('native-gesture', {
  payload: { action: 'scroll', selector: { resourceName: 'example.app:id/list' }, direction: 'down' }
});
```

The shared command observes a fresh target; Intent binds its decision to the
committed observation. Both send an SDK reference and Host-owned action ID.
Callers cannot supply `targetRef` or `actionId` in the public payload. Long press
requires `durationMs:500..10000`; swipe requires `durationMs:1..10000` and numeric
`deltaX/deltaY` relative to the selected node's current center. The endpoint must
remain in the current window. Scroll uses the selected container's visible area,
with `durationMs` defaulting to 400; a container that cannot move in the requested
direction returns `native_scroll_boundary` before DOWN. Rounded zero movement
and out-of-window endpoints also reject before DOWN. Public `swipe` remains the
separate ADB device-coordinate primitive.

The SDK checks the reference immediately before DOWN, then runs a timed stream
on the UI handler so actual long-click callbacks and frames can run. Android
owns routing inside the original window until UP/CANCEL; moving/recycling list
children does not cause semantic retargeting during the stream. Window/focus loss
sends CANCEL to that original window and reports `native_gesture_window_changed`.
This can occur after a long-click has already opened a dialog; inspect the result.

After Host cancellation or response loss, Host sends one bounded cancellation to
the same forwarded endpoint with the exact action ID and runtime epoch, outside
the aborted execution scope. It waits for that reply, never retries the gesture,
and preserves uncertainty if acknowledgement is missing or invalid. The SDK
keeps a blocked active touch reserved until CANCEL actually runs. Native tap/input,
Flutter action, H5 eval and runtime clear-data reject `native_action_busy` during
that interval. This SDK reservation does not arbitrate external device inputs.
Queued cancellation proves `dispatched:false`; blocked delivery may return
`dispatched:null, ambiguous:true`. CANCEL stops the stream, not prior App effects.

Gesture receipts include actual duration, event count, start/end coordinates and
completion. Started/terminal `ui.interaction` events carry the action ID. A capture
callback failure is exposed as `evidenceError` separately from touch delivery;
it cannot trigger another terminal touch. Arbitrary asynchronous App callbacks
are not all causally tagged. Verify fresh phone events and independent App state.

`wait-text` accepts `timeoutMs` (default 10000), `intervalMs` (default 500),
`provider:auto|native|flutter|uia`, optional `targetText`, `requireText` and
`absentText` arrays, and `requireActivity` (full class name). All text matches are
exact and come from one fresh visible provider tree; metadata, hidden windows
and text from another provider cannot complete a condition. For example:

```json
{"command":"wait-text","arguments":{"serial":"DEVICE","packageName":"com.example.app","provider":"native","targetText":"Save, draft","requireText":["Editor"],"absentText":["Loading"],"timeoutMs":5000}}
```

At least one condition is required. Pure absence or Activity-only waits require
an explicit provider. An unreadable/invalid tree returns `observation_unavailable`,
never successful absence. A deadline returns `deadline_exceeded`; the last
available check reports missing/unexpected labels. Cancellation remains
`cancelled`. `timeoutSec` and CSV strings are rejected for this command. In the
CLI, pass JSON arrays to `--require-text`/`--absent-text`; commas remain part of the label.
The H5 wait contract is described below; other platform waits remain separate.

## Android H5 execution and DOM operations

Android Intent supports `provider: "h5"` through the same SDK and typed commands
used by CLI, MCP and Script. `intent start/observe` accepts
`observationTarget: { webViewId }`; `null` requires exactly one visible WebView.
Ambiguity returns candidate IDs. An explicit ID never selects a replacement.

`h5-dom` returns `h5TargetSchema: "aab.android-h5-target/v1"`, `pageRef` and
`dom.controls`. The page reference binds the runtime epoch, package, process,
Activity, foreground window, WebView, document generation and URL. Each control
has an `elementId` tied to that DOM object. Navigation, including history return
to the same URL, and replacing an element invalidate the original action.

`h5-click`, `h5-input`, `h5-scroll` and `h5-wait` use an object `selector` with
exactly one of `elementId`, exact `text` or exact `ariaLabel`, optionally qualified
by `tag`. CSS strings and the old `targetText`/`exact` aliases are removed from
these Android commands. A truncated snapshot requires an explicit observed
`elementId`; duplicate visible matches are rejected. `expectedTarget` on typed
mutations binds the original `{ pageRef, element }`. Intent supplies this binding
automatically from its committed observation.

`h5-input` uses string `text`, including `""` to clear an editor. It validates
editability and rechecks the same element and value after focus callbacks.
Controls retain separate label, text and value; sensitive values are redacted.
Snapshots contain at most 1000 controls, with the actual count and truncation
flag, and at most 20000 body characters. Display text and values are capped at
500 characters. These semantic DOM operations do not promise trusted browser
input events or business acceptance.

Click/input first obtain a DOM action point, then check Android clipping and
native occlusion. The final renderer turn must still match the original element,
document and geometry. Standard Android WebView coordinates account for scale
and scroll offsets. Non-standard WebView geometry and transformed native views
return explicit unsupported errors. Snapshot adapters may still observe them;
there is no automatic provider fallback. Frame selection remains unimplemented.

`h5-scroll` accepts either a selector to bring an element into view, or both
`deltaX` and `deltaY` to scroll the page in CSS pixels. Mixing these forms or
supplying two zero deltas is rejected. Page scrolling can include `expectedPage`.
Expert `h5-eval` always requires `expectedPage`; it executes synchronous JavaScript
in that observed page. Script does not permit this expert escape hatch.

Mutations use `/v1/h5/action` and `aab.h5-execution/v1`. The SDK advertises
`h5ExecutionSchema`, `h5TargetSchema` and the active `h5Action` in
`status.debugBridge`. `/v1/h5/cancel` accepts only the original action ID and
runtime epoch. Cancellation before admission prevents submission; cancellation
between the read-only geometry probe and final action prevents the mutation.
After submission, WebView offers no cancellation acknowledgement: occupancy is
retained until the original callback and Java invocation have both completed.
Uncertain effects continue to block other device mutations. Native, Flutter and
H5 share coordination while retaining their own identities and receipts.

`h5-wait` only polls observations. It keeps the original WebView ID and retries
only a readable snapshot with an absent selector. It uses `timeoutMs` (default
10000) and `intervalMs` (default 500), returns `h5_wait_timeout` on local expiry,
and respects the encompassing Host deadline and cancellation. It has no mutation
action ID. Missing WebViews, ambiguity and protocol errors return immediately.

Flutter H5 uses an explicit adapter contract. Registration requires
`isVisible: bool Function()` backed by the App's actual route/widget state;
it does not infer native occlusion. `flutter-h5-dom` may omit `adapterId` only
when exactly one registered adapter is visible. Multiple visible adapters require
an explicit ID. Duplicate registration is rejected; unregister before replacing
an ID, and discard its old page references.

`pageRef` uses `aab.flutter-h5-target/v1` and binds `runtimeEpoch`, `adapterId`,
`adapterGeneration`, `documentId` and `url`. `flutter-h5-click/input/wait` use
`selector:{elementId|text|ariaLabel,tag?}`; CSS strings, `targetText` and `exact`
are removed. Input uses string `text`, including an empty string. Typed mutations
may carry `expectedTarget:{pageRef,element}` from the observation. Scroll accepts
either a selector or both `deltaX`/`deltaY`; page scrolling may bind `expectedPage`.
Expert eval requires `expectedPage` and retains managed original completion and
cancellation. Wait only observes the same adapter and document; navigation or
replacement fails instead of selecting another document. The shared renderer
checks DOM occlusion; platform/App visibility and business acceptance remain
separate evidence requirements.

Android and iOS share the generated DOM identity renderer
in `shared/h5/renderer.js`; native window/geometry checks remain platform-owned.
Regenerate with `python3 shared/h5/generate.py` and check mirrors with `--check`.

## Web DOM, Intent and Script

Web commands run on the shared runtime that owns the browser's SDK
connection, accessible from both CLI and MCP. Select a live `sessionId`, `runtimeEpoch` and `targetId: "main"`
from `web-sessions`. A Web Intent target adds `platform: "web"` and uses
`provider: "h5"`; other providers are rejected. Script supports the catalog's
typed Web commands with the same target. Neither entrypoint creates a second
provider or reconnects a different page behind the original target.

`web-dom` returns `webTargetSchema: "aab.web-dom-target/v1"`, `pageRef` and
`dom.controls`. The page reference contains the schema, session, runtime, target,
navigation ID and URL. Navigation IDs change even when a page returns to the same
URL. Each control has an `elementId` tied to the actual DOM element in that
document; replacing a node with identical HTML creates a different identity.

Every control includes `checked: true | false | "mixed" | null` and the raw
`ariaChecked` attribute (`string | null`). Native checkbox/radio state comes
from its live property, with an indeterminate checkbox reported as `"mixed"`.
Supported ARIA controls use their declared state; missing, invalid or unsupported
state remains `null`. For `radio`, `menuitemradio` and `switch`, an ARIA `mixed`
value means false under [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/#aria-checked);
the raw attribute is still preserved. Checkbox/menuitemcheckbox retain `"mixed"`.
Intent summaries preserve these checkable roles and state, including textless
controls. A hidden companion input and its visible custom checkbox remain
separate nodes with separate interaction readiness.

Use the matching current Web SDK: a snapshot without `checked`, or with a value
outside this contract, fails as `invalid_web_dom_control`. The Host does not
substitute false for missing state. Checked state is observation data, not part
of element identity. `web-click` remains one click, not an idempotent set-state
operation; reobserve and verify the business result after it.

Typed actions take an object `selector` with exactly one identity field:
`elementId`, `text`, `ariaLabel` or `css`, optionally restricted by `tag`/`role`.
They require one visible match. String selectors, mixed identity fields and
ambiguous text matches are rejected. `web-dom.selector` is a CSS string for a
bounded read; it is a different argument contract from an action selector.
Intent decisions select observed controls by `elementId`, `text` or `ariaLabel`;
they do not run an unobserved CSS query. A truncated Intent snapshot is rejected
for action selection, rather than assuming the missing controls cannot match.

An action may bind its original observation using
`expectedTarget: { pageRef, element }`. Copy the element fields `elementId`,
`tag`, `id`, `name`, `type`, `role`, `ariaLabel`, `placeholder`, `href` and `text`
from that observation. Intent supplies this binding automatically. The SDK
rechecks the original page and element before dispatch, including after focus
callbacks. A changed page or element requires a new observation; it never selects
a replacement using the old text or CSS selector.

| Command | Behavior |
| --- | --- |
| `web-click` | Invoke one semantic DOM click on the unique visible, enabled, unobscured control. |
| `web-input` | Replace `value` (a string, including empty) in a supported text input, textarea or contenteditable. Native form setters and browser input events reach framework handlers; rich-text insertion uses the browser editing path. |
| `web-key` | Deliver one bubbling, cancellable `keydown` for `Enter` or `Escape` to the selected control. The receipt reports `trusted: false` and `defaultPrevented`; keyup, trusted keyboard defaults and general shortcuts are not promised. |
| `web-scroll` | `mode: "into-view"` requires a selector and no deltas. `mode: "by"` requires at least one explicit `deltaX`/`deltaY`, with an optional element selector. |
| `web-wait` | Wait for exactly one of a typed selector or body `targetText`, within the command deadline. |

DOM observations include `visible`, `disabled`, `editable` and
`interaction.status`: `ready`, `hidden`, `disabled`, `outside-viewport` or
`obscured`. A ready/obscured observation includes the checked point; an obscured
one includes the hit element's diagnostic identity. Interaction state explains
the observation and is checked again at execution. Errors retain their original
receipt and dispatch status, including `web_element_ambiguous`,
`web_element_changed`, `web_element_obscured`, `web_element_outside_viewport`
and `reobserve_required`. Successful dispatch does not establish asynchronous
business completion; observe and assert the actual resulting state.

Script admits `web-status`/`web-dom` under `app.read` and these typed controls
under `app.interact`. Raw `web-command` remains outside its catalog. DOM reads
produce Host tree references for device assertions. Ordinary
`web-logs/network/state/events` query committed Host FactStore records. They are
available under Script `capture.read` and Intent `require.streams`.
The default `view: "decision-window"` requires the exact connected document.
Each query obtains an SDK capture barrier; its upper FactStore cursor is frozen
when that response reaches the Host, before later frames can enter the window.
The `wc1:` watermark and its SDK/Host counters are persisted in FactStore.

Observe before acting and pass the returned `watermarkCursor` as `factCursor`
after the action. `afterActionId` additionally filters explicitly associated
records and requires that lower watermark. In Intent requirements, omitting
`afterActionId` selects the current action; explicit `null` retains all records
in the temporal window. Repeated observations of one action keep its original
lower watermark so a delayed response remains observable. This temporal window
does not assert that every included request was caused by the action.

`coverage.scope: "sdk-captures-through-barrier"` describes recorded SDK captures.
Queue loss, sequence gaps, rejected captures and connection changes retain partial
coverage; pending requests also prevent complete coverage. The window does not
cover uncaptured traffic or future asynchronous work. Each record identifies
`association: "explicit" | "synchronous" | "unattributed"`; unknown origins keep
`actionId: null`. Request identity is captured when a request starts, never taken
from the action active when its response arrives. Script dispatch now supplies
the same original action ID to the provider, receipt and synchronous UI event.

Pages scan at most 16 records. Keep the original `factCursor`, filters and returned
`throughCursor` with `nextCursor` for continuation. The upper bound stays fixed.
A continuation page alone cannot pass a whole-window Script assertion; automatic
aggregation of evidence across pages remains open. `history: true` or
`view: "connected-history"` reads retained Host records, including while offline,
with partial `retained-host-history` coverage. History forbids `factCursor` and
`afterActionId`; explicit `history: true` conflicts with `view: "decision-window"`.

Optional request/response bodies carry `BodyState` and `BodyEncoding` fields.
`utf8` bodies contain text; `base64` bodies preserve binary protocol bytes. Decode
only complete bodies using the declared encoding and the App's protocol schema.
Missing, disabled, oversized or timed-out bodies cannot prove submitted content.
Full payload exports preserve Web Host references, document identity, action
association and barrier diagnostics, and can be checked offline.

A browser harness screenshot is a separate artifact, not a Script-owned
screenshot reference or an archive attachment by default. See [Script authoring](SCRIPT_AUTHORING.md) and the
[Memos real-App result](../../../docs/WEB_MEMOS_BUSINESS_2026-09-11.md) for the
implemented scope and remaining evidence gaps.

## Errors and remaining work

Ordinary Android commands share one Host deadline from queue entry through
provider calls and optional feedback. `timeoutMs` defaults to 30000; a timed
logcat collection defaults to its requested duration plus 1000 ms. An explicit
`adbTimeoutMs` caps each subprocess within that same deadline. Nested calls cannot
extend the deadline. ADB/HTTP work and local polling stop cooperatively, and local
subprocesses/sockets close before the call settles. `deadline_exceeded` before an
action has `dispatched:false`; after submission it retains `ambiguous:true`.
This does not undo work already accepted by Android or the App SDK. Install and
permission Intent workflows retain the separate lifecycle rules below; iOS/Web
provider cancellation still needs its own redesign.

Common command failures use `ok:false`, a stable string `error`, human `message`,
optional `field`/`details`, and `dispatched`/`ambiguous`. `dispatched:null` means
unknown. Argument rejections have `dispatched:false, ambiguous:false`. MCP
`isError` follows command failure; CLI returns exit code 1. Runtime operations
retain their own status/control and evidence envelopes; a completed Script may
contain failed or inconclusive assertions.

The implemented contracts above define the supported command scope. Frame
selection and merged multi-page strong assertions remain unsupported. Platform
capability, execution completion and acceptance of a particular App workflow
must be assessed separately from its retained evidence.

## Ordinary Intent lifetime and recovery

`intent start.timeoutMs` is a total lifetime budget (default 300000 ms). It starts
before the first observation and includes decision waits, paused time, Agent
replies, subsequent observations and actions. An autonomous budget can shorten
this deadline. Nested provider work cannot extend it. Pause invalidates the
pending Agent reply; resume obtains a new decision. Agent adapters receive an
`AbortSignal`; late replies cannot dispatch through the stopped Intent. The
adapter must cooperate to stop any external computation it owns.

Cancel first enters `cancelling`, aborts owned provider work and waits for that
work and its evidence writes. Timeout similarly stops new dispatch with
`deadline_exceeded`. Other terminal outcomes pass through `finishing`. A terminal
checkpoint is committed after the pending work settles and before the terminal
status is exposed. Final persistence can extend beyond the execution deadline.
`blocked_evidence_store` means this commit failed; `terminalEvidenceId` is absent.
`pendingOperations` counts owned execution calls, not the final checkpoint write.
Cancel cannot rewrite an already settled outcome. An accepted but unconfirmed
action retains `lastAction.dispatched` and `lastAction.ambiguous`; cancellation
does not imply rollback. Complete/fail/inconclusive decisions also require the
current `basedOnRevision`.

After execution-runtime restart, `intent status` reads checksum-verified Host evidence and
returns `live:false, recovered:true, restartPolicy:"none"`. A durable terminal
checkpoint restores the outcome. Retained evidence without a terminal checkpoint
returns `interrupted/runtime_restarted`, including unmatched action markers.
There is no automatic replay, and a retained operation ID cannot be reused.
Store read failures are errors, not an empty history. Explicit runtime stop or a
signal to the runtime closes Intent intake, drains pending start/decide work and
persists terminal evidence before closing Host storage. CLI exit and MCP EOF
only disconnect the client. Mobile capture queries continue to use the live mobile
store; this recovery contract applies to Host execution evidence.

## Installation is an Intent operation

`install-apk` starts an ordinary supervised Intent operation through CLI or MCP. It
returns `command:"intent"`, an `operationId` and `installation` status. Supply
`serial` and `apkPath`; optional `packageName` must match the APK manifest.
Android SDK `aapt` and `apksigner` are required, found under `ANDROID_SDK_ROOT`
or supplied as `aaptPath`/`apksignerPath`.

The Host freezes and inspects the APK, stages those exact bytes on the phone,
and commits the original action/job/boot identity before launching one detached
installation worker. The worker rechecks the APK SHA-256, creates one non-staged
PackageInstaller session, writes the base APK, and commits that session. The
session ID and original PackageManager CLI response are retained on the phone.
`allowDowngrade` is opt-in. `streaming` has been removed and is rejected.

`timeoutMs` bounds device staging, admission and Host waiting (default 180000).
APK inspection, initial/final installed-identity reads and UI observation still
have separate bounded calls; this is not yet one end-to-end deadline. Inspectors
accept verified signer output from `Signer #N` and SDK `V1`, `V2`, `V3`, `V3.0`,
`V3.1`, `V4` signer formats; unsupported formats reject without submitting an APK.

When system interaction is needed, the calling Agent uses `intent observe`, reads
the actual foreground tree, then submits `intent decide` with its revision and
one exact selector. The adapter has no ROM package table, positive-button labels
or automatic click loop. Observation and decision may need to repeat as the
system page changes. Without an Agent decision, no system button is clicked.
The operation holds the phone's mutation lease through package verification.

For example, after receiving a fresh observation:

```json
{"command":"intent","arguments":{"operation":"decide","operationId":"FROM_START","decision":{"decisionId":"choice-1","basedOnRevision":2,"agentDecision":"act","action":{"action":"tap","selector":{"resourceName":"ID_FROM_ACTUAL_OBSERVATION"}}}}}
```

Completion requires the matching original shell-job receipt, a successful
PackageInstaller commit response, and an independent `pm path`/`sha256sum` check
of the installed bytes. The proof binds actionId, jobId, Android boot, command
hash, admission deadline, installId, package and APK hash, and identifies the
PackageInstaller session. The install receipt response hashes use canonical JSON
with sorted object keys, so archive serialization preserves their verification.
A matching old APK, a local ADB exit, a missing session
or a mismatched receipt cannot settle this request. Caller `complete` decisions
cannot override verification. Split APK layouts are explicitly unsupported.

The supported PackageManager CLI protocol recognizes exact `Success` and final
`INSTALL_FAILED_*` / `INSTALL_PARSE_FAILED_*` failure responses. This is parsing
machine command output, not recognizing installer button text. Pending-user-action,
warnings, unfamiliar OEM output, truncated output, process death and changed boot
remain unresolved. A terminal install rejection releases ownership but fails the
workflow, even when the old APK still matches.

`intent cancel` stops Host waiting and UI decisions. It can prevent admission;
once the phone worker is admitted it drains the original request, without a
second install or a rollback promise. If its original result is unavailable,
physical-device ownership remains blocked after cancellation, timeout, EOF or
Host death. `device-ownership reconcile` reads that same job and response; it
never repeats the install. It does not resume the lost Intent decision loop.
A still-waiting PackageInstaller interaction must finish before it can provide
completion proof. `pause` only suspends UI decisions.

The phone staging area admits at most 64 retained installations. APK staging is
removed and the shell receipt acknowledged only after a known result is settled;
normal completion and cross-Host recovery persist the exact ownership proof first.
Cleanup failure is reported separately and cannot erase a known execution result.
Unknown/orphaned staging, eviction/reboot recovery, warning/OEM variants, active
PackageInstaller cancellation and multi-ROM verification remain separate gates.

## Ordinary MCP command history

Ordinary command execution and auxiliary history persistence have separate
outcomes. `ok`, dispatch state and `executionReceipt` describe the original
provider operation. A history failure never retries or rewrites that operation.
Intent/Script required evidence commits retain their existing strict admission
and terminal-evidence contracts.

Object results carry `_history` with schema `aab.command-history/v1`, including
when `feedback:"off"`. Every ordinary CLI/MCP result also carries the same value in
`_meta["ai-app-bridge/history"]`, so raw text/image-result consumers can inspect
history without rewriting the original content. This is MCP history metadata;
CLI and MCP use the same history store; direct internal provider calls do not acquire an auxiliary one.

- `stored`: this invocation's action and returned Host evidence references were
  committed. It is not a claim of complete mobile history or business correctness.
- `partial`: one or more writes failed. `action` and `evidence` identify which
  references were stored; `errors` preserves their failure codes.
- `unavailable`: history initialization or recording setup failed.
- `disabled`: auxiliary history was explicitly disabled or no recorder was supplied.

A failed action reference has `stored:false`; unavailable `globalSeq` is `null`.
`replayed:false` makes the no-retry rule explicit. Use read-only verification of
the original action when history is partial/unavailable. Do not repeat a mutation
just to obtain a stored reference. A failed evidence append is not added to the
in-process dedupe set, so a later observation may persist the same evidence.
Repeated request IDs reuse execution without appending references to the cached
feedback object; each delivery reports its own history-write attempt.
Background observer health remains separate from this foreground write report.

## Runtime permission requests use Intent

Trigger the runtime permission request through the App's existing flow, then call:

```json
{"command":"permission-dialog","arguments":{"serial":"DEVICE","packageName":"com.example.app","permission":"android.permission.RECORD_AUDIO","outcome":"allow-once"}}
```

This MCP entry returns an ordinary Intent ID, the actual UI summary, and
`permissionDialog`. Choose an exact selector from that summary through `intent
decide`. The Host has no permission-button label or resource-ID table. The
request's App, Android user, UID and Activity instance must still match at input.
The UIA node runtime revalidates the saved reference and current selector;
changed text, window identity or duplicate matches stop dispatch. Android ActivityManager currently exposes the requesting App,
not the requested permission list. The Agent must match the dialog's meaning to
`permission`; the independent PackageManager query verifies that named permission.

| outcome | Required result after an owned action and original Activity closure |
| --- | --- |
| `allow` | `granted:true`, `ONE_TIME` absent |
| `allow-once` | `granted:true`, `ONE_TIME` present |
| `deny` | `granted:false`, `USER_SET` present |
| `dismiss` | Grant and all permission flags unchanged from the initial state |

`deny` accepts only an observed tap. Its state check does not distinguish first
refusal from "don't ask again"; the selected visible control is retained in the
receipt. `dismiss` accepts an observed tap or `{ "action":"back" }`. A named
permission alone does not verify every permission in a grouped request, an app-op,
or background access. These require their own observations and state assertions.

When Android has closed the window but is still retiring its Activity record,
`status:waiting_for_observation`, `permissionDialog.pending:activity_closure`
means verification is pending. Use `intent observe` to refresh the proof; no
second button click is required. Missing/changed evidence never becomes success.
Caller `complete` cannot override verification. Export the Intent's plan, UI,
decision, receipt and final permission checkpoint with `evidence export`.

`intent cancel` stops further dispatch, waits for any submitted input to settle,
then records the actual state. It does not close the dialog or undo an Android
grant. `timeoutMs` defaults to 60000: after that deadline no new input is sent;
in-flight bounded ADB calls and final verification can finish later.
`adbTimeoutMs` bounds individual ADB calls (default 15000). Pause suspends Agent
input while the deadline continues. EOF and signal shutdown finalize active
workflows before closing FactStore. Ownership is still within one Host process;
external input and abrupt process death are not an exactly-once guarantee.

The requester probe currently requires one top-resumed Activity and its detailed
ActivityManager record. Unsupported/multi-display layouts return explicit errors;
there is no ROM-name fallback. These Android contracts do not imply iOS parity.

`permission-state`, `permission-grant` and `permission-revoke` remain direct
CLI/MCP capabilities and Script calls. All require `serial`, `packageName` and
`permission`; optional `userId` selects an Android user, otherwise the actual
current user is resolved and frozen. They read the runtime-permission section of
that exact package/user, never a Host cache or SDK port. `grant`/`revoke` verify the
result after one `pm` submission and retain the before state. Failure distinguishes
missing runtime permission, unavailable query, rejected change and unverified
result. OEM restrictions may reject the shell identity with `permission_change_denied`; the result includes the platform reason and the independent before/after states. No automatic root or UI fallback is attempted. Script requires `app.permissions` for these fixture mutations and
`app.read` for queries. `permission-dialog` is a supervised operation and is not
a synchronous Script primitive; fixed regression can replay known selectors with
explicit state assertions, or request Agent help through `ctx.askAgent`.
