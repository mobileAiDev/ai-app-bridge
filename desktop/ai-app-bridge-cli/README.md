# AI App Bridge CLI

Android SDK connections read the selected App's private endpoint descriptor and
select its exact `localabstract:aab-sdk-<runtimeEpoch>` socket. Default
`sdkTransport:auto` uses direct ADB server transport for a verified native adb
installation. Custom wrappers, explicit `--port`, or `sdkTransport:forward` retain
the forward path and its mapping checks. `--port` cannot identify an App or bypass
endpoint discovery. Selection happens before dispatch; an uncertain mutation is
never replayed on another route. For forward cleanup, pass the exact serial and
returned Host port to `remove-forward`. See [Android execution and evidence
policies](docs/ANDROID_EXECUTION_POLICY.md) for diagnostics, server namespaces and recovery.

This release uses version `0.4.19`; see [changes and acceptance boundaries](docs/RELEASE.md).
Android foreground facts and warnings are separate from action execution. Window
formatting, mismatch or changes do not veto an explicit action or switch its target.
The SDK and UIA executors retain exact node/reference validation and original receipts.
This coordinated release uses `0.4.19` for the Host and device/Web SDKs. The
existing device and Web protocols remain unchanged.

Optional Android Instrumentation/UI Automator/Espresso/Compose/H5, Flutter integration_test,
and Playwright executors use the existing `capabilities + run` and Python/JS Script contracts.
See [integration, dependency profiles and lifecycle](docs/OPTIONAL_EXECUTORS.md).

AI App Bridge CLI/MCP supports Android native apps, Android WebView/H5/CDP,
Flutter apps on Android and iOS, iOS native apps via `AiAppBridgeIOS` plus
WebDriverAgent/XCUITest, WKWebView, and desktop Web Bridge sessions.

Use AI App Bridge as the default path for App/device work, including ADB through `adb-exec`. Intent and Script are the primary task interfaces: use Intent for observation-driven decisions and Script for known steps, waits, branches and assertions, even when the task runs only once. For a standalone log read, screenshot, status query, targeted diagnosis or explicit atomic action, call its Bridge command directly; no Intent/Script wrapper is required. Use an external tool only for an explicit user choice or a concrete Bridge availability/capability gap; a failed SDK command does not rule out Bridge UIA or ADB. See [the usage skill](skills/ai-app-bridge-use/SKILL.md) and [command contract](docs/COMMAND_CONTRACT.md).

CLI and MCP connect to one independent local execution runtime. Every registered
command is available from either entrypoint, including Intent, Script, Web,
installation and permission flows. A CLI command can start a task and a later MCP
connection can observe or decide the same operation ID. Disconnecting either
client leaves tasks running. Use `runtime --operation status --extract null` to inspect its
owner, `runtime --operation stop --extract null` to drain it, and task `cancel` to stop one task.

Active operations now own bounded idle protection on the Host and supported selected
devices. Inspect or explicitly control it with `power`; automatic protection can
be disabled for sleep tests, and failure does not veto App actions. See
[work power leases](docs/POWER_LEASES.md) for CLI examples and platform limits.

Stopped Scripts expose `inventory` and `recovery` facts, including command labels
and original action identities. Checkpoint recovery can retain independent
recording attempts. See [Script recovery](docs/SCRIPT_AUTHORING.md).

Omitted `extract` uses auto: complete results fit the budget directly or in a
lossless compact representation; larger results include a partial preview and
an original-response read request. Use explicit `null` for the original shape,
or select/regex/JavaScript/Python for a known subset. CLI: `--extract null`.
The compact body is `{command, execution, control, extraction, delivery, kind,
value?, failureStage?}`. Original execution facts and continuation controls stay
separate from the extracted value. Default body budget: 96 KiB UTF-8; overflow
can return a saved response ref. Retry with `response read`, not the original
action. CLI exits 0 / 1 / 2 for delivery success / execution failure or unknown /
post-success extraction or delivery failure. See [extraction and recovery](docs/RESPONSE_EXTRACTION.md).

Execution operations and nested controls use strict schemas. Supply an explicit
`operation`, use `script.target` and canonical `javascript`/`python` languages,
and handle call failures in source. Progress is read through `status`/`wait`.
Flutter expert payloads are JSON objects; Web App actions use the explicit
`action` wrapper. Unknown fields fail before storage or provider access.

Command domains:

- `execution`: `intent`, `script`, `runtime`, `device-ownership`, `power`
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
# After publication; before then use a reviewed local tarball (docs/INSTALLATION.md).
npm install -g @mobileaidev/ai-app-bridge@0.4.19

ai-app-bridge status --extract null --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge tree --extract null --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge clear-app-data --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-app --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge launch-activity --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample --activity .MainActivity --extra route=/home
ai-app-bridge screenshot --extract null --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge input-text --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample --text "中文输入" --hide-keyboard
ai-app-bridge network --extract null --package-name io.github.mobileaidev.aiappbridge.sample --compact --url-filter /api/
ai-app-bridge webview-network --extract null --package-name io.github.mobileaidev.aiappbridge.sample --duration-ms 3000
ai-app-bridge ios-devices --extract null
ai-app-bridge ios-doctor --extract null --device-id <device-or-udid> --bundle-id <ios.bundle.id> --wda-runner-bundle-id <runner-from-setup>
ai-app-bridge ios-setup --extract null --device-id <device-or-udid> --bundle-id <ios.bundle.id> --team-id <APPLE_TEAM_ID> --start-wda
ai-app-bridge ios-status --extract null --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-execution --extract null --operation status --device-id <device-or-udid> --bundle-id <ios.bundle.id>
ai-app-bridge ios-execution --extract null --operation reconcile --device-id <device-or-udid> --bundle-id <original.ios.bundle.id>
ai-app-bridge ios-execution --extract null --operation reconcile --kind wda --device-id <device-or-udid> --wda-runner-bundle-id <runner.bundle.id>
ai-app-bridge ios-wda-session --extract null --operation create --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id>
ai-app-bridge ios-tap --extract null --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id> --wda-session-id <created-session> --tap-x 120 --tap-y 360
ai-app-bridge ios-input --extract null --device-id <device-or-udid> --wda-runner-bundle-id <runner-from-setup> --bundle-id <ios.bundle.id> --wda-session-id <created-session> --accessibility-id sample_text_field --clear-first --text "hello"
ai-app-bridge web-session-start --extract null --web-port 18180
ai-app-bridge runtime --extract null --operation status
ai-app-bridge thaw-app --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge freeze-app --extract null --serial DEVICE --package-name io.github.mobileaidev.aiappbridge.sample
ai-app-bridge-mcp --help
```

Global installation and upgrades automatically configure detected Codex,
Claude Code, Cursor, Qoder and Antigravity clients, including their complete
`ai-app-bridge-use` skill. Run `ai-app-bridge setup --check` to inspect file
readiness, and `ai-app-bridge setup --project .` for project instructions used
by Cursor and Qoder IDE. Reload MCP and skills after installation.

`setup` is a host-only installation command, outside the MCP command registry.
Use `--client`, `--all`, `--dry-run`, `--export` or custom client paths as needed.
`AI_APP_BRIDGE_SKIP_SETUP=1` opts out of global installation setup; local
package/npx installs do not modify clients. See [client setup](docs/CLIENT_SETUP.md).
Agents operating Apps should read the installed usage skill. File checks report
session loading as unverified until the client actually discovers it.

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
JavaScript or Python: omitted `permissions` allow every registered command; explicit
permissions restrict Bridge SDK calls and are not an OS sandbox. There is no explore, export-to-script, or assemble-report command.
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
`launch-app` and `launch-activity` send the launch request first, then attach one
foreground observation. They do not require an active App SDK or a drawn first
frame. The observation may still show the previous screen during a transition.
Use `wait-text` for the actual page or business outcome.

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
  "extract": null,
  "arguments": {
    "serial": "DEVICE",
    "packageName": "com.example.app",
    "history": true,
    "limit": 100
  }
}
```

## Intent, Script and evidence

Intent handles observation-driven exploration and decisions; Script executes known
steps with live observations, waits, branches and assertions, for one-off or reusable flows.
For a known sequence, Intent's existing autonomous module runs successive local
decisions in one start call; see [the autonomous module contract](docs/COMMAND_CONTRACT.md#run-a-known-sequence-in-one-intent-call).
Individual `run` calls serve standalone operations and targeted diagnosis. A Script can be authored directly or from
observed Intent evidence. The duplicate batch executor has been removed. Start a Script
through CLI or MCP with `operation: "start"` and a `script`
object containing `schemaVersion: "aab.code-script/v1"`, `language`, one of
`source`/`sourcePath`, and an explicit Android, iOS or Web `target` for device work. Code exports
`async function main(ctx)`; Python defines its corresponding `main` entrypoint.
Each platform retains its own provider requirements and business acceptance evidence.

Read progress with `status`/`wait`; completion exposes a small `resultRef`.
Start/resume with `waitMs` and ready attention waits return the result inline.
When it is absent, use `script --operation result --operation-id ID` to read the persisted final
JSON independently of event retention, including after runtime restart. Password
and token redaction is declared by the reference's `representation`; missing or
evicted results return an error. Full result storage is required before a Script
can report `completed`.

A script that catches a command failure and returns a diagnostic report keeps
that report even if an uncertain mutation makes the execution status `failed`.
`result` then returns the report with `status: "failed"` and `executionError`;
successful retrieval does not convert the unknown effect into success. Start
with `waitMs` also returns this persisted report when the operation terminates.

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
For a stuck action or agent handoff, run `ai-app-bridge device-ownership
--operation force-stop --serial DEVICE --extract null`. This independent reset
stops old Host tasks and phone executors, archives the unknown action, and frees
occupancy without waiting for its receipt. Tasks sharing those Host processes
also stop. New operations can then start; dispatched effects are not rolled back.
Occupancy errors include the same recovery hint.
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

Android `screenshot` captures the actual display through `adb screencap` and
needs no UiAutomation connection or UIA handover. Use it from the Host at an
instrumentation test's capture checkpoint, holding the page until capture
finishes. `adb-exec` can also run ordinary ADB commands while UIA is active;
use `uia-tree` for hierarchy reads and `tap-uia` for accessibility node clicks
through the shared runtime. Test-thread operations can use one persistent
`android-executor` session with Host-managed ownership. See the
[Android execution choices](docs/OPTIONAL_EXECUTORS.md#choose-an-android-execution-path)
for capability mappings and external test APIs that still need coordination.

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

Both launch commands return `completionScope: "activity-start-request"` by
default, without Android's `am start -W` or a foreground polling loop. To request
the previous blocking launch behavior, pass `--wait-for-launch true`; the
completion scope becomes `activity-launch`. This still does not establish
login, loaded data, or another business outcome. Follow the request with a
bounded `wait-text` inside the same Intent or Script to handle cold startup.

### Upgrading the running CLI and MCP

`ai-app-bridge --version` (also `-V`) reads the installed entrypoint's package
version without requiring a device. Upgrading npm replaces files; it does not
replace an MCP process already connected to Cursor or another client. Reconnect
the client's MCP server after upgrading. Follow the mismatch diagnostic: upgrade
an older client first; only stop an older Runtime after its existing work finishes,
using `ai-app-bridge runtime --operation stop --extract null`. The MCP initialize
response reports `serverInfo.version`; refresh cached tool descriptions in the
client when they still show removed commands such as `batch` or `smoke`.
A same-version fingerprint mismatch requires aligning the source and Node
environment; the hash alone does not identify which side is newer. In-flight
work is not silently moved to new code.
