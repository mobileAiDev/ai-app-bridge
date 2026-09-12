# UIA node runtime — integration in progress

This module provides a shell-owned accessibility connection and durable action receipts. It does not require an APK in the target application. Public CLI, MCP, Intent and Script UIA routes share this runtime. Phase status and device evidence are in [phase 3O](../../docs/COMMAND_PRODUCTION_PHASE3O_2026-09-09.md).

Build with JDK 17 and `ANDROID_HOME` pointing to an SDK with platform 35 and build tools 36.0.0:

```sh
./gradlew :ai-app-bridge-uia:buildRuntimeBundle
```

The task runs the JVM execution/journal tests and creates `build/runtime/ai-app-bridge-uia.jar` and `manifest.json`. The manifest binds the DEX, Java sources, build configuration, Android API jar and D8 jar by SHA-256. `stageRuntimeBundle` additionally copies the two files to the CLI's dedicated `runtime/uia` directory, which is included in the npm package and checked by clean-package verification.

The runtime requires API 33+. API 36 on OPPO PGFM10 and OnePlus PKR110 has the separately scoped device evidence listed in phase 3O; scenarios run on one phone do not certify the other. Framework interfaces are resolved exactly; an unsupported interface is an error.

## Transport and lifecycle

The entry class is `io.github.mobileaidev.aiappbridge.uia.UiaRuntime`. Its two arguments are the runtime root and the expected SHA-256 of the single DEX jar in `CLASSPATH`. The production root is `/data/local/tmp/ai-app-bridge-uia/v1`. Isolated device fixtures may use `/data/local/tmp/ai-app-bridge-uia-test-<lowercase-id>`.

The process verifies the artifact, takes the root's exclusive file lock, checks earlier journals, and opens one UiAutomation connection. A private `runtime.json` descriptor contains the boot ID, runtime epoch, artifact hash, local abstract socket and random bearer token. The token must remain out of command results, ownership records, logs and evidence. Host recovery can read the exact session descriptor when it needs authenticated access.

An optional third argument, `owner-status`, only probes the same OS file lock and prints an `aab.uia.owner.v1` result (`root`, `dexSha256`, `owned`). It never opens UiAutomation. Explicit Host `uia-runtime start` uses this probe; a dead owner's descriptor can be superseded only after the new process reacquires the lock and verifies every original session. Unknown or corrupt records still block startup. Failed HTTP observation does not trigger restart.

ADB forwarding targets that exact local abstract socket. Requests use `POST /v1`, a bearer token, a JSON body and a bounded Content-Length. There is one request per connection. The server has two HTTP handlers and a bounded queue; observations and action validation use a single worker. Unsupported operations and invalid field types are errors.

Operations:

| Operation | Body fields besides `op` | Effect |
| --- | --- | --- |
| `status` | none | Runtime identity, capacity, pending count, active action and closing state. |
| `observe` | none | Focused default-display window, XML and opaque node references. |
| `prepare` | `requestJson`, `requestSha256` | Persist original request identity before acknowledging preparation. |
| `start` | same original pair | Queue the prepared action once. Repeated start reads its current state. |
| `query` | same original pair | Return the original state or terminal receipt. Never dispatch. |
| `cancel` | same original pair | Cancel before admission. An absent action receives a durable cancellation tombstone. After admission it remains pending until its original callback. |
| `acknowledge` | original pair, `receiptSha256` | Durably acknowledge the exact terminal receipt. Does not erase replay protection. |
| `acknowledge-record` | `identity` | Acknowledge a terminal file from an older epoch under the current process lock; refuses the active engine's epoch. |
| `stop` | none | Close only after all actions are terminal and their receipts are committed. Drain observations and disconnect UiAutomation. |

`requestJson` is the **exact UTF-8 JSON string** hashed by `requestSha256`, not a JSON object that another implementation may reserialize. It contains exactly:

```json
{
  "schemaVersion": "aab.uia.execution.v1",
  "bootId": "<device-boot-id>",
  "runtimeEpoch": "<observed-runtime-epoch>",
  "actionId": "<original-intent-script-or-command-action-id>",
  "timeoutMs": 10000,
  "clickPolicy": "nearest_clickable_ancestor",
  "target": {
    "snapshotId": "<observed-snapshot-uuid>",
    "ref": "<observed-node-uuid>",
    "selector": {
      "kind": "text",
      "value": "Native Increment",
      "exact": true,
      "packageName": "io.github.mobileaidev.aiappbridge.sample"
    }
  }
}
```

`actionId` retains the caller's exact nonempty, well-formed Unicode string, at most 1024 UTF-16 code units. Intent and Script composite IDs are not remapped. `timeoutMs` is an integer from 1 to 60000, measured by the phone's elapsed clock from preparation. The selector kind is `text`, `contentDescription` or `resourceName`; `exact` is a boolean, and `packageName: null` explicitly means no package restriction. Click policy is `exact_node` or `nearest_clickable_ancestor`. The latter binds the nearest clickable ancestor in the observed hierarchy and revalidates that same ancestor; a disabled ancestor is rejected.

## Completion and recovery

Admission is committed before the Binder call. A positive admission response is not completion. A transport exception after admission remains unknown; expiration or client disconnection cannot turn it into a terminal action. Completion requires the matching original callback, a definite admission rejection, a pre-admission rejection, or the explicit dead-owner pre-admission recovery below.

Each terminal response includes `receiptJson` and its exact UTF-8 `receiptSha256`. The receipt binds schema, boot ID, runtime epoch, action ID and request hash. It distinguishes `original_callback`, `admission_rejected` and `before_admission`; callback receipts include the original interaction ID and handled value. `dispatched` describes platform dispatch, not the business effect.

`recover-record <identity-json>` after root/hash is a one-shot operation that must
hold the exclusive root `owner.lock` throughout validation and publication. It
never opens UiAutomation. Identity contains exactly `bootId`, `runtimeEpoch`,
`actionSha256`, `requestSha256` and `originalDexSha256`. The original committed
record must match that identity and have phase `prepared` or `queued`, interaction
ID zero, no receipt and no acknowledgement. The engine fsyncs `admitted` before
dispatch, so this persisted state plus exclusive ownership proves non-dispatch.
Absent records fail with `uia_original_action_record_not_retained`; admitted or
unknown records fail with `uia_previous_action_unresolved` and remain unchanged.
An active owner fails the OS lock acquisition with `uia_runtime_already_running`.

Recovery writes `completion: recovered_before_admission`, `dispatched: false`,
`ok: false` and `error: uia_owner_exited_before_admission` to that same record.
Its `recovery` object records the exclusive-lock authority, recovery boot ID,
`observedAtElapsedMs`, original preparation time, prior phase, exact prior-file
SHA-256, original executable hash and recovery executable hash. It has no callback
or `completedAtElapsedMs`: a reboot creates a different elapsed-clock domain.
Original request bytes, preparation time and deadline are preserved. A retry
resyncs the already validated terminal record without replacing its first receipt.
Normal Host history persistence and acknowledgement still precede phone reclamation.

Receipt publication requires an atomic file replacement and fsync of both file and directory. If a completion write fails, the runtime retains the known result, keeps the action occupied and retries that write on query. It never repeats the action. Host must persist and verify the matching receipt before releasing shared ownership and acknowledging it.

The optional arguments `acknowledge-record <identity-json>` after root/hash run
one-shot maintenance under `owner.lock`, without starting UiAutomation. Identity
contains exactly `bootId`, `runtimeEpoch`, `actionSha256`, `requestSha256`,
`receiptSha256` and `originalDexSha256`. A live newer runtime exposes the same
operation for older epochs. Only a strictly validated terminal file can be marked
acknowledged; original request and receipt bytes stay unchanged. Actual session
deletion still belongs to the next startup/rotation audit. Retried acknowledgements
repeat the durable write, including its directory fsync.

`aab.uia.ack.v1` contains only identity and cleanup disposition: `acknowledged` or
`not_retained`. It is not an execution receipt. Absence is safe to accept only for
an obligation whose matching completion representation is already durably retained
by the Host. Unknown actions never use this protocol as a completion authority.

Version 2 journal records remain at `sessions/<epoch>/actions/<sha256-of-actionId-UTF8>.json`, including after a clean runtime stop. The hash only names the file; the original ID remains in the request and receipt. Another epoch cannot use old references or execute old requests. A new process refuses to open UiAutomation if any prior journal has an unresolved action or invalid completion data. Missing records, changed epochs, process death and an idle runtime are not completion proofs. Host integration must query the live original runtime or verify the original durable receipt; it must not restart or replay an action as recovery.

## Limits and remaining gates

The current limits are 2000 nodes per snapshot, depth 64, eight snapshots, a 60-second reference lifetime, 256 original actions per runtime and 64 retained sessions per root. The Host rotates a full, fully acknowledged session before a new observation; already bound actions never rotate. Stopped-session references cannot be reused.

`UiaJournal` audits all original sessions while holding the root lock. A fully terminal, acknowledged session is atomically renamed into `retired/`; both parent directories are fsynced before contents are deleted. Interrupted cleanup resumes there. A session with even one unacknowledged terminal receipt stays byte-exact. Any original nonterminal or corrupt record blocks reopening and original-session cleanup. Temporary files cannot authorize completion. Empty interrupted construction can be reclaimed. Old executables and protocol-owned temporary files are removed only after the audit passes. HTTP disconnect diagnostics are capped at 16 lines per runtime.

The node contract checks the focused window, current selector uniqueness, actual window/source IDs, attributes, bounds and operability. It sends the action to that node identity. Attribute checks and the subsequent cross-process dispatch do not form an atomic application transaction. Virtual-node identity reuse and other displays need their own acceptance evidence.

Remaining gates include a lost callback after actual runtime death, real queued-phase death and reboot, interaction with other instrumentation, larger real system permission/install and node-change matrices, and additional ROM/API coverage. Current real-device checkpoints are recorded in the phase report. Unknown history remains unresolved after process death or reboot.
