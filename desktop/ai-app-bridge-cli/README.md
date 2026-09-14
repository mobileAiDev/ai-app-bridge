# AI App Bridge CLI

Android SDK connections read the selected App's private endpoint descriptor and
bind an ADB forward to its exact `localabstract:aab-sdk-<runtimeEpoch>` socket.
`--port` selects an optional Host port; it cannot identify an App or bypass endpoint
discovery. Every request checks the mapping before dispatch. Mutating requests
are never replayed after a missing route or uncertain result. For manual cleanup,
pass the exact serial and returned Host port to `remove-forward`.

This release is `0.3.5`, distributed through the npm `latest` dist-tag.
The default installation includes the Script/Intent and capture contracts below.
The `next` dist-tag also points to this release until a newer candidate is published.
The supported Node range is `>=26.3.0 <27`; this release was checked on 26.3.0.
See [the release guide](docs/RELEASE.md) for local packaging and coordinated publication.

AI App Bridge CLI/MCP supports Android native apps, Android WebView/H5/CDP,
Flutter apps on Android and iOS, iOS native apps via `AiAppBridgeIOS` plus
WebDriverAgent/XCUITest, WKWebView, and desktop Web Bridge sessions.

Intent and Script are first-class execution interfaces. The shared command registry supplies discovery, validation and provider access. See [the command contract](docs/COMMAND_CONTRACT.md) for dispatch rules and known limits.

CLI and MCP connect to one independent local execution runtime. Every registered
command is available from either entrypoint, including Intent, Script, Web,
installation and permission flows. A CLI command can start a task and a later MCP
connection can observe or decide the same operation ID. Disconnecting either
client leaves tasks running. Use `runtime --operation status` to inspect its
owner, `runtime --operation stop` to drain it, and task `cancel` to stop one task.

CLI output is `{kind: "json"|"text"|"bytes", value, history?}`. Read the command
payload from `value`; binary values are base64. Failure uses `value.ok:false` and
exit code 1. MCP wraps the same payload/history in its content format. See the
[shared lifecycle and configuration contract](docs/COMMAND_CONTRACT.md#shared-runtime-lifecycle).

Execution operations and nested controls use strict schemas. Supply an explicit
`operation`, use `script.target` and canonical `javascript`/`python` languages,
and handle call failures in source. Progress is read through `status`/`wait`.
Flutter expert payloads are JSON objects; Web App actions use the explicit
`action` wrapper. Unknown fields fail before storage or provider access.

Command domains:

- `execution`: `intent`, `script`, `runtime`, `device-ownership`
- `evidence`: archive export and offline verification

- `core`: `status`, `tree`, `uia-tree`, `screenshot`, `logs`, `network`, `state`, `events`
- `app`: `install-apk`, `clear-app-data`, `launch-*`, `freeze-app`, `thaw-app`, `permission-*`, `appops-set`
- `action`: `tap`, `tap-text`, `tap-native`, `tap-uia`, `tap-uia-text`, `input-text`, `swipe`, `native-gesture`, `keyevent`, `wait-text`, `keyboard-state`, `hide-keyboard`
- `flutter`: `flutter-tree`, `flutter-nodes`, `flutter-action`, `tap-flutter-text`, `input-flutter-text`, `scroll-flutter`
- `webview`: `h5-*`, `flutter-h5-*`, `webview-pages`, `webview-network`, `webview-console`
- `ios`: `ios-devices`, `ios-doctor`, `ios-setup`, `ios-execution` status/cancel/result/reconcile, `ios-*` runtime evidence, explicit `ios-wda-session`, WDA tree/tap/input/swipe/orientation, WKWebView, and Flutter iOS
- `web`: provider/session lifecycle, `web-execution`, observations and capture, `web-command`, `web-click`, `web-input`, `web-key`, `web-wait`, `web-scroll`
- `diagnostics` / `advanced`: `logcat`, `uia-runtime`, `forward`, `remove-forward`

MCP exposes exactly two tools: call `capabilities` to discover
domains, commands, and options, then call `run` with the selected command.

```bash
# Install the current stable release; see docs/RELEASE.md for packaging.
npm install -g @mobileaidev/ai-app-bridge@0.3.5

ai-app-bridge status --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge tree --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge clear-app-data --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-app --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-activity --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample --activity .MainActivity --extra route=/home
ai-app-bridge screenshot --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge input-text --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample --text "中文输入" --hide-keyboard
ai-app-bridge network --package-name io.github.mobileaidev.aiappbridge.sample --compact --url-filter /api/
ai-app-bridge webview-network --package-name io.github.mobileaidev.aiappbridge.sample --duration-ms 3000
ai-app-bridge ios-devices
ai-app-bridge ios-doctor --device-id <device-or-udid> --bundle-id <ios.bundle.id> --wda-runner-bundle-id <runner-from-setup>
ai-app-bridge ios-setup --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-execution --operation status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-execution --operation reconcile --device-id <device-or-udid> --bundle-id <original.ios.bundle.id>
ai-app-bridge ios-execution --operation reconcile --kind wda --device-id <device-or-udid> --wda-runner-bundle-id <runner.bundle.id>
ai-app-bridge ios-wda-session --operation create --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id>
ai-app-bridge ios-tap --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id> --wda-session-id <created-session> --tap-x 120 --tap-y 360
ai-app-bridge ios-input --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id> --wda-session-id <created-session> --accessibility-id sample_text_field --clear-first --text "hello"
ai-app-bridge web-session-start --web-port 18180
ai-app-bridge runtime --operation status
ai-app-bridge thaw-app --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge freeze-app --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge-mcp --help
```

AI agents, model clients, automation frameworks, and IDE MCP clients reading
this README should load `skills/ai-app-bridge-use/SKILL.md` before operating
apps through MCP. If the client supports skills or project instructions, load
that file as the dedicated usage guide. If it does not, include the file content
in the system/developer/project instructions for the task. Codex-compatible
clients can copy the repo folder `skills/ai-app-bridge-use` into their skills
directory, for example `$CODEX_HOME/skills/ai-app-bridge-use` on macOS/Linux or
`%USERPROFILE%\.codex\skills\ai-app-bridge-use` on Windows, then restart or
refresh the session.

MCP uses a compact tool surface to avoid loading every command schema
into the model context:

- `capabilities` lists supported targets, command domains, command names, and exact argument schemas, execution role and supported entrypoints.
- `run` executes a selected command with command-specific arguments.

The `install-apk` command through CLI or MCP starts an Intent installation; system buttons are chosen
from actual observations and the installed APK is independently verified. See
[the installation contract](docs/COMMAND_CONTRACT.md#installation-is-an-intent-operation).

This keeps install, data reset, launch, UI action, Flutter, WebView/H5/CDP,
iOS, Web Bridge, logcat, network, permission, port-forward,
and first-class `script`/`intent` capabilities discoverable without exposing
dozens of full schemas at session start. `script` is trusted-local-code
JavaScript or Python: `permissions` gate Bridge SDK calls only and are not
an OS sandbox. There is no explore, export-to-script, or assemble-report command.
Per-command MCP aliases and the old full surface were removed.
All command parameters belong exclusively in `run.arguments`.

The MCP server accepts both standard `Content-Length` framed JSON-RPC messages
and single-line JSON messages. Responses use the format of the first request on
that connection, so standard MCP clients keep framed responses while local
Node REPL scripts can send and read one JSON object per line.

## Persistent facts and action feedback

The shared execution runtime serializes mutations for the same physical Android serial
across direct commands, Intent and Script. A durable device lease also arbitrates
across Host processes. Phone `logs`/`network`/`state`/`events` live in
`MobileCaptureStore` on the device. Host live commands read the phone; the
collector does not copy those payloads into Host history. Android registration
does not open a background SDK connection or poll `status`; explicit reads and
Intent/Script capture still use the live provider. Android App logs
come from that App's in-process `logs` stream on an explicit live read. The
collector does not attribute device-wide logcat to the App. Device logs are
enabled only with the additive `deviceLogScope: "device"` option and are stored
as an explicit device target. One bounded stream is then reused per explicit
serial. Web Bridge commits incoming SDK evidence directly to FactStore before
acknowledgement; the observer does not poll or mirror those records.
The default buffers are `main`, `system`, and `crash`; sensitive `radio`,
`security`, and `kernel` buffers still require explicit `deviceLogBuffers`.
The observer keeps at most 32 targets and retires a target after 30 minutes
without an explicit operation. Android expiry uses a timer without device I/O
and stops an opted-in log stream when its last target expires. Its limit,
expirations, evictions, failures, and dropped-log counters are visible in
`_feedback.observer`. Android targets report `backgroundPolling: false`; null
poll timestamps and runtime epochs do not represent a successful health check.
For `launch-app` and `launch-activity`, full feedback runs the launch first,
then captures a system UIA tree and optional screenshot. It does not require
an active App SDK before launch. These snapshots show the current screen;
without an event baseline, they do not establish a semantic UI change.

Facts are stored once in an authoritative segmented mmap store. A bounded
SQLite WAL index is only a rebuildable query projection; it is not a second
fact-payload store. Legacy history, Script evidence, and Intent evidence use
the same runtime-owned FactStore with isolated adapters and namespaces. The
default `auto` profile selects 1 GB when total disk capacity is at least 32 GiB and at
least 8 GiB is available, 512 MB when total disk capacity is at least 16 GiB and at
least 4 GiB is available, 256 MB when total capacity is at least 4 GiB and at
least 2 GiB is available, and 64 MB otherwise. Explicitly select a profile with
`AI_APP_BRIDGE_FACT_CACHE_PROFILE=1gb`, `512mb`, `256mb`, or `64mb`. Override
the store directory with `AI_APP_BRIDGE_FACT_STORE_DIR`. The legacy
`AI_APP_BRIDGE_FACT_CACHE_PATH` setting remains accepted and places the new
`fact-store-v1` directory beside that path. `AI_APP_BRIDGE_FACT_CACHE=off`
continues to disable Legacy fact recording without weakening Script/Intent
evidence gates. The default macOS path is
`~/Library/Caches/ai-app-bridge/fact-store-v1`.

Partitions have independent shares of the mmap budget: network 25%, UI 18%,
App logs 10%, device logs 7%, state/events 10%, actions 13%, notes 5%, and index
metadata 2%; 10% remains reserved for manifests and recovery. The SQLite
projection has a separate bounded budget and cannot evict mmap facts. The
feedback reports the selected profile, disk selection inputs, mmap usage, and
projection health. The npm package bundles the native source and builds its
Node-API binding during installation. If only the SQLite projection fails, queries
scan the authoritative mmap records and report the projection degradation; persistent
execution evidence remains available. If the native store cannot initialize,
foreground commands report degraded history and Script/Intent fail their evidence
gate. No in-memory buffer substitutes for persistent facts.

Existing SQLite fact-cache files are left intact and are not silently imported;
opaque `fc1` cursors cannot be reused as segmented-store `fs1` cursors.

The automatic collector persists network metadata and redacted headers. It
stores raw body byte counts plus omission flags, not request or response body
content. An explicit live `network` read keeps its existing behavior. Each fact
also carries a canonical target key, App identity, runtime epoch, global
sequence, timestamps, and an action id when correlation is available.

On an Android runtime that supports persistent capture, phone
`logs`/`network`/`state`/`events` with `history: true` read the phone FactStore
while the device is connected. This also applies to capture forwarded by the
Flutter Android plugin when its embedded Android runtime has been updated.
If the phone or runtime is unavailable they return an explicit error and do not
fall back to a Host-copied payload. iOS capture uses its segmented device store
for live, `decision-window` and `connected-history` reads. Startup, flush and
storage failures return explicit errors and incomplete coverage. Web evidence
is committed on ingress to the Host FactStore; retained history pages
Host-owned facts through the existing command plus an opaque `factCursor`.
Mobile history does not merge Host execution records into mobile facts. Use
Script/Intent history to inspect execution records separately:

```json
{
  "command": "events",
  "arguments": { "serial": "DEVICE", "packageName": "com.example.app", "history": true, "limit": 100 }
}
```

## Intent, Script and evidence

Intent supports daily observation and decisions; Script supports repeatable regression.
Individual `run` calls remain useful. A Script can be authored directly or from
observed Intent evidence. The duplicate batch executor has been removed. Start a Script
through CLI or MCP with `operation: "start"` and a `script`
object containing `schemaVersion: "aab.code-script/v1"`, `language`, one of
`source`/`sourcePath`, and an explicit Android, iOS or Web `target` for device work. Code exports
`async function main(ctx)`; Python defines its corresponding `main` entrypoint.
Each platform retains its own provider requirements and business acceptance evidence.

Read progress with `status`/`wait`; completion exposes a small `resultRef`.
Use `script --operation result --operation-id ID` to read the persisted final
JSON independently of event retention, including after runtime restart. Password
and token redaction is declared by the reference's `representation`; missing or
evicted results return an error. Full result storage is required before a Script
can report `completed`.

See [Script authoring](docs/SCRIPT_AUTHORING.md) for the executable source shape,
call envelope, assertion results, bounded UI waits and evidence reuse boundaries.

Use the public `evidence` command to export retained Intent/Script Host records
and verify their frozen archive offline. [Evidence archives](docs/EVIDENCE_ARCHIVE.md)
describes hashes, source binding, retention and the excluded external payloads.

- `completed` means that execution finished. Inspect the device assertion
  results to determine which application outcomes were verified.
- `ctx.assert({scope: "code", name, condition})` checks local code. It cannot
  claim device evidence and is counted separately in `rollingSummary`.
- Device assertions are the default. Pass the exact `evidence` object returned
  by a current `ctx.call`; fabricated, missing, expired or pre-mutation
  observations are `inconclusive`. UI tree and screenshot predicates must use
  their own evidence. The Host keeps at most 128 observations / 256 KiB of
  assertion metadata per Script and does not retain mobile capture bodies.
- For asynchronous mobile results, read the stream before the action. Save
  `before.evidence.capture.watermarkCursor` and `.runtimeEpoch`; after the
  action, pass them as `factCursor` and `runtimeEpoch` to the same stream.
  The Host verifies that this boundary was observed before that action.
  `afterActionId` is an optional association filter, not proof of business
  causality; match the actual request or business fields in the predicate.
  If startup dropped records before persistence attached, use a fresh device
  `status.updatedAtMs` as the baseline `sinceMs` and preserve that same
  `sinceMs` in later cursor reads. A cursor alone does not erase a recorded
  loss fence. New loss inside the chosen window still makes it partial.
- Strong device assertions currently require a complete single page, actual
  refs and `hasMore: false`. Multi-page reads are supported with `nextCursor`,
  but there is no merged multi-page assertion contract yet. Partial windows,
  missing refs, dropped facts and unknown capture backends stay inconclusive.
- `view: "decision-window"` queries the current epoch.
  `view: "connected-history"` (or `history: true`) queries retained mobile
  history. `mobileFactId` re-reads an exact ref while connected. Ref identity
  survives App restart while the record remains retained; clear invalidates
  the corresponding refs, and old epoch data cannot verify a new action.
  Cursors and refs are opaque and must not be synthesized.
- Android `status.capturePersistence` reports attachment and lifecycle state,
  including the actual storage operation error. Strong queries remain
  unavailable while the durable backend is not attached. Startup records
  that could not be committed are reported as a gap.
- `committed` means that the fact writer has made the record readable. The
  mobile store uses group flushing; this does not promise survival of an
  arbitrary power loss before flush. Cold disk reads and cache performance
  are measured separately; this release has not passed the old hot-query
  latency target on all devices and retained-store sizes.

Script defaults to `restartPolicy: "none"`. Opt into `"checkpoint"` only for
explicitly reentrant code that uses `ctx.checkpoint` and `ctx.resume`.
Recovery preserves the frozen source, target and permissions and uses the
real provider. It cannot restore an arbitrary JS/Python stack. An unmatched
prepare/receipt, a side effect after the last user checkpoint, or an uncertain
write requires reconciliation and is never automatically replayed. Completed
and cancelled operations cannot be resumed to repeat their effects.

The old declarative Script `steps` format is rejected with
`script_format_removed`; migrate it to an explicit code Script. All common
commands now use strict canonical arguments and physical Android serial arbitration
inside the same process. Old concurrency and alias contracts have been replaced. No fake
provider is selected by a missing production dependency.

Development checkout: [Script contract validation](scripts/validation/script-contract.md)
provides an explicit real-device MCP runner for assertion boundaries, cancellation,
checkpoint recovery and durable action receipts. Supply the server, device and
package explicitly; these runtime checks do not imply full application acceptance.

Every normal object result keeps its legacy fields and adds `_feedback` unless
`feedback: "off"` is requested. The default `auto` mode does not add post-action
UI polling, trees, or screenshots. `feedback: "full"` waits briefly for a correlated UI event; when no
change is observed, it returns an inconclusive result plus current tree and
screenshot references instead of claiming success. Observer health, runtime
epoch, dropped-log counters, and persisted fact references are reported in the
same feedback object.

For a coordinate tap on the foreground Android App, `auto`/`full` feedback uses
one App-local bridge request and reports the actual hit View, bounds, window,
and touch handling result. An explicit package mismatch stops the action. System UI uses an observed
system package and explicit device scope; an SDK failure does not trigger ADB retry.
The request id is carried into synchronous runtime log/network/state/event
records. Later asynchronous records are correlated by the bounded action
timeline instead of being presented as an exact runtime binding.

Generated Android and iOS screenshot artifacts share the same automatic
lifecycle: at most 20 files per screenshot prefix, no older than 24 hours, and
at most 64 MB total. An explicitly supplied `outFile` is user-owned and is not
automatically removed. Screenshot bytes remain files and are never copied into
the fact database.

For continuous automation, start a [code Script](docs/SCRIPT_AUTHORING.md).
Normal loops, `ctx.call`, `ctx.assert`, progress and cancellation share one
execution record. `tap-text` supports observed provider selection (`auto`) or
an explicit `native`, `flutter` or `uia` provider for repeatable execution.
For repeated labels or a semantic container, `tap-native` accepts the same exact
`text`, `contentDescription`, `resourceName` and optional `within` row scope as
Android Native Intent. CLI, MCP and Script use the same command and validated SDK
receipt; callers do not supply coordinates or fabricate a `targetRef`.

UIA reads and text actions use the bundled phone node runtime on Android API
33+. A selected node stays bound to its observation and original action ID;
ordinary commands, Intent and Script share the same executor and completion
recovery. `uia-runtime --serial DEVICE --operation status|start|stop` controls
its lifecycle. Fresh observation rotates a full, durably acknowledged session;
startup retires only confirmed history. Explicit start checks the phone's
process lock before reopening a dead runtime; unknown actions still block it.
Host crashes leave a durable pending-acknowledgement queue. `device-ownership
--operation reconcile --serial DEVICE` commits completion history, acknowledges
live or stopped phone records and retires that queue without replay.
For an exited phone owner, reconciliation can turn a matching committed
prepared/queued record into a durable non-dispatch receipt under the original
root's exclusive process lock. The receipt preserves original identity and
separately records the recovery boot/time; admitted/unknown or missing records
remain unresolved. Recovery never creates a UiAutomation connection.
`device-ownership --operation receipt --serial DEVICE --runtime-epoch UUID
--action-id ORIGINAL-ID` queries the retained FactStore representation, including
explicit original/redacted hashes. A busy FactStore preserves pending cleanup.
API 36 on OPPO PGFM10 and OnePlus PKR110 is the current real-device scope. See
the [command contract](docs/COMMAND_CONTRACT.md#semantic-targets-and-text-waits).

`freeze-app` sends SIGSTOP to the target App processes, including the Bridge
SDK and its socket. It is a process control command, not a way to obtain live
SDK observations of a frozen page. Capture evidence first; use `thaw-app` before
further reads, actions, waits or captures and before finishing. Ordinary Intent
and Script flows do not need freezing.
For visible state changes such as panels, dialogs, page transitions, tabs, or
button-triggered content, verify with both `screenshot` and `tree`/`uia-tree`;
do not conclude success from UI tree alone.

WebView network and console capture use Android WebView DevTools/CDP when the
target app is debuggable and WebView debugging is enabled.

iOS commands use Xcode `devicectl` for device/app/screenshot operations, the
AiAppBridgeIOS runtime for in-app evidence, and WebDriverAgent/XCUITest for
taps, input, swipes, and external UI tree reads. `ios-setup --start-wda --team-id`
prepares a separate copy of pinned WDA 14.1.1 with Bridge identity checks and
builds/signs that Runner. It returns the actual `wdaRunnerBundleId`; later WDA
commands require this ID and the selected `deviceId`. An optional `wdaUrl`
selects a forwarded endpoint without bypassing the Runner container check.
Create an explicit `ios-wda-session` for an already foreground App, then pass
its returned session ID with the App bundle ID. Reads do not create sessions
or launch Apps. See [the WDA contract](docs/COMMAND_CONTRACT.md#ios-wda-target-and-session).
WDA uses managed execution with queued cancellation, durable original completion
and `ios-execution --kind wda` recovery. Cancellation waits for the original
callback of an already submitted XCTest event. iOS Intent and Script support
native, H5 and Flutter providers with explicit target binding. Native Intent
`setOrientation` and CLI/MCP/Script `ios-set-orientation` share the same managed
rotation action. Reobserve the UI after rotation; capability support and individual
real-device results do not establish complete complex-App acceptance.

`input-text` uses the native SDK endpoint for Unicode text and returns its actual
failure without retrying through ADB. `clear-app-data` chooses `method:"pm-clear"`
(default) or `"runtime"` before dispatch; there is no retry through another method.

When `screenshot` runs without `--out-file`, the CLI writes a unique
PNG under a git-ignored project artifact directory. Gradle, Android, and Flutter
projects normally use `build/ai_app_bridge_artifacts`; Node projects can use
`node_modules/.cache/ai_app_bridge_artifacts`; Swift projects can use
`.build/ai_app_bridge_artifacts`. If the current git worktree has no ignored
artifact candidate, generated defaults go under `.git/ai_app_bridge_artifacts`
so they cannot dirty the repository root. It keeps the newest 20 generated
screenshots for each command prefix. Use `--artifact-dir` to choose an ignored
directory, or `--out-file` when a fixed path is intentional.

`launch-app` queries Android LAUNCHER activities before starting the app. If a
debug dependency exposes multiple launcher entries, it returns
`launcher_ambiguous` with the candidates instead of guessing. Use
`launch-activity` or `launch-app --activity/--component` to choose the intended
entry point explicitly.

### Upgrading the running CLI and MCP

`ai-app-bridge --version` (also `-V`) reads the installed entrypoint's package
version without requiring a device. Upgrading npm replaces files; it does not
replace an MCP process already connected to Cursor or another client. Stop the
shared Runtime with `ai-app-bridge runtime --operation stop` when existing work
has finished, then reconnect the client's MCP server. The MCP initialize
response reports `serverInfo.version`; refresh cached tool descriptions in the
client when they still show removed commands such as `batch` or `smoke`.
A running Runtime from different source code reports `runtime_code_mismatch`
until explicitly stopped, so in-flight work is not silently moved to new code.
