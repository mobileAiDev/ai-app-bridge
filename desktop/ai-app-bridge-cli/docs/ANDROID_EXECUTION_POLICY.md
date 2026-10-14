# Android execution and evidence policies

The next-release candidate makes four measured Host optimizations available through ordinary CLI, MCP, Intent and Script calls. No `AAB_PROPOSAL_*` experiment flags are used. The earlier 30–32% workflow improvement belongs to the frozen experiment and its workload; final packaged and real-device measurements must establish the benefit of this implementation.

| Setting | Default | Explicit alternative |
| --- | --- | --- |
| `sdkTransport` | `auto`: direct ADB socket transport for a verified native adb installation; forward for a custom wrapper or explicit `port` | `forward` retains the ADB forward path; `direct` requires the native installation and no `port` |
| Immutable SDK execution schemas | Reused for up to 15 seconds within the complete connection identity and observed runtime epoch | A new route, executable identity, endpoint or epoch gets a new observation; dynamic status and UI data are never cached here |
| `feedback` | `auto`: attached foreground advice is explicitly `notCollected` | `window` collects WindowManager advice; `full` also retains the existing post-action UI observation; `off` also omits feedback bookkeeping |
| `screenshotVerification` | `window`: one WindowManager observation, `ownershipVerified:false` | `ownership` additionally checks process identity, package UID and repeated window/process observations |

## Routes and recovery

Direct transport opens a new connection to the configured ADB server, selects the exact device serial and the discovered SDK runtime's abstract socket, then sends the HTTP request over that connection. It does not allocate, reuse or trust a host forward port. `--port` explicitly requests the existing forward semantics. Transport selection happens before HTTP dispatch; a failed mutation is never retried over another path.

The route includes the resolved ADB executable identity, server namespace, serial, SDK package and epoch-specific socket. Auto classification requires a native executable named adb and a bounded, cached `adb version` response whose `Installed as` real path matches that executable. A script wrapper, a native delegate wrapper that reports an underlying adb, or unverified provenance retains forwarding. This is compatibility classification, not authentication of arbitrary executable code. The result's `sdkConnection.transport` and `selection` disclose the choice.

The Host reads `ADB_SERVER_SOCKET`, or `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` when no socket override is set. These settings participate in the Host configuration identity. For a whole Script/Intent that mixes SDK, UIA and wrapped ADB commands, set the Host's server environment consistently before starting it. A client with a different effective server configuration cannot silently use an already running Host's old namespace; inspect `runtime status` and select the intended Host configuration.

Pure SDK commands also accept an explicit `adbServerSocket`, such as `tcp:127.0.0.1:5038`, `tcp:[::1]:5037` or `localfilesystem:/tmp/adb.sock`; Linux also supports `localabstract:NAME`. This is a command-level SDK connection override, not an execution-target field or a claim that other providers inherited the override. `tap`, `tap-text`, `wait-text` and `input-text` may use UIA or raw ADB input, so they use the Host server environment for the whole command. Custom wrappers still own their CLI behavior; their configured server/forward must agree with the selected SDK connection.

An SDK action records its original route before dispatch. Cancellation and later receipt queries address that route, even if the Host environment or current App endpoint changes. A direct query does not need the old adb file to remain installed. The forward path verifies the original executable identity and forward mapping because it must invoke that executable again. Neither path substitutes a new runtime for an old action. A missing original runtime leaves the prior outcome unknown; it does not replay the action or fabricate success.

`device-ownership force-stop` also uses recorded SDK server namespaces. If archives contain the same serial on different ADB servers, UIA reset and package stops run separately for each recorded route; the reply identifies each server and result. A failed route keeps `remoteResetPending:true` and its original records for a later retry. Old records without a saved namespace explicitly report `legacy_environment` and an `original_adb_namespace_unrecorded` warning when the current Host environment is used. A forced reset requires an executable ADB client even when read-only direct receipt queries do not.

Disconnected reads may rediscover the SDK endpoint once, as reported by `transportRecovery`. Actions, deadlines, cancellations and queries on a pinned original route are not rediscovered and replayed.

## Information versus action results

Default omission is represented as `foregroundObservations:[{status:"notCollected",actual:null,reason:"feedback_policy",policy:"auto",...}]`. It has no observation timestamp and is never interpreted as a foreground match. `feedback:"window"` returns the actual observation time and any mismatch/probe warnings. These facts remain advisory; SDK/UIA target validation and execution receipts decide what was actually dispatched and settled.

`wait-text` with an explicit `requireActivity` still collects the requested Activity fact even with `feedback:"off"`. Default optimization never removes a requested readiness condition. A matching text or a successful dispatch does not imply network success, navigation success, visual readiness or an App-wide acceptance result.

Screenshots continue to use `adb exec-out screencap -p`, on real devices and emulators. The result states `source:"adb-screencap"`, its file/hash and `screenshotVerification`. The lightweight default changes diagnostic cost, not the image source. The foreground sample is collected before capture; it is not an atomic proof that every captured pixel belongs to the target package. Use `ownership` when those additional ownership facts matter. Emulator-console capture and video-derived evidence are not selected by these defaults.

## Usage

```sh
ai-app-bridge tap-native --serial DEVICE --package-name example.app --selector '{"text":"Continue"}'
ai-app-bridge tap-native --serial DEVICE --package-name example.app --selector '{"text":"Continue"}' --feedback window
ai-app-bridge screenshot --serial DEVICE --package-name example.app --screenshot-verification ownership
ai-app-bridge status --serial DEVICE --package-name example.app --sdk-transport forward
```

A Script or Intent Android target may set `sdkTransport`, `feedback` and `screenshotVerification` as defaults. Script `ctx.call` arguments can override the corresponding accepted command fields. The same choices and schemas are exposed by command discovery; no second action language is introduced.

## Regression scope

`android-sdk-transport.test.js` exercises real local TCP ADB handshakes and HTTP through the production provider: ordinary default route selection, original-route cancellation/query, one mutation after a lost response, cancellation before dispatch, schema-cache request counts, malformed status, server/serial/socket separation, executable replacement and native-wrapper classification. Its two compiled executable fixtures require a C compiler and explicitly skip when one is unavailable. `android-host-policy.test.js` exercises ordinary default omission, requested Activity waiting, Script/Intent policy propagation, wrapper routing and actual subprocess screenshot diagnostics. They are Host integration tests, not Android device acceptance.

Final acceptance also requires the normal packaged product to run the same dynamic Native/H5/Flutter workflow, compare equivalent business postconditions and account for diagnostics separately. Preserve original failures, unknown receipts and screenshot readiness evidence. Do not transfer the experiment's percentage to this release until that run is complete.
