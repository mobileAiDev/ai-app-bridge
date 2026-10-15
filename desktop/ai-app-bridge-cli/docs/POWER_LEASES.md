# Work power leases

Power protection belongs to a bounded work lease. A resident MCP connection is
not an active-work signal. A lease survives the gap between Bridge calls, model
thinking and context compaction; ending the work releases its resources.

`bin/power/index.js` owns work deadlines and platform refresh. The platform
adapters own native assertions. `bin/power/activity-lease.js` supplies the
ordinary activity window: an actual Bridge operation touches a ten-minute lease
and later operations extend it. Explicit sessions may choose a longer lease.
Script/Intent work should use its operation deadline and release at terminal
completion/cancellation. Clients must not repeatedly replay business actions
just to keep a device awake.

These are three distinct lifetimes: ordinary activity keeps a ten-minute gap
between real calls; an explicit `power acquire` uses its chosen work duration;
an active Script/Intent additionally owns protection up to its known operation
deadline even if it runs longer than ten minutes. None means the whole task is
permanently active. The public `power` automatic configuration can turn activity
protection off for intentional sleep/lock testing; explicit leases have their
own release lifecycle.

For a task spanning several programs, delegated subtasks or long reasoning gaps,
the coordinating agent should acquire explicit Host and selected-device leases
for the overall task, retain their IDs and renew before their bounded deadline.
A subtask releases only its own additional lease; finishing one test must not
end the coordinator's protection while the overall work continues. A connected
MCP client has no signal for whether a chat is thinking, idle or finished, so
conversation activity must not be inferred from the existence of that process.
The coordinator explicitly ends these leases when the overall work ends.

## Public CLI and MCP

```sh
ai-app-bridge power --operation capabilities --extract null
ai-app-bridge power --operation acquire --owner-id review-session \
  --target '{"platform":"host"}' --mode both --lease-ms 1800000 --extract null
ai-app-bridge power --operation status --lease-id RETURNED_LEASE_ID --extract null
ai-app-bridge power --operation renew --lease-id RETURNED_LEASE_ID --lease-ms 1800000 --extract null
ai-app-bridge power --operation release --lease-id RETURNED_LEASE_ID --extract null
ai-app-bridge power --operation auto --enabled false --extract null
```

The equivalent MCP `run` arguments for a selected iOS foreground App are:

```json
{
  "command": "power",
  "arguments": {
    "operation": "acquire",
    "ownerId": "review-session",
    "target": {"platform": "ios", "deviceId": "SELECTED_UDID", "bundleId": "your.test.app"},
    "mode": "display",
    "leaseMs": 1800000
  },
  "extract": null
}
```

Ordinary actual operations refresh the default ten-minute activity window;
Script/Intent also hold an operation lease until their deadline or terminal
state. `auto --enabled false` releases automatic protection and prevents new
automatic leases, while preserving separately acquired explicit leases. Use
`auto --enabled true` to restore automatic protection. Automatic acquisition
failures produce warnings and have a 30-second retry cooldown, so a disconnected
or older SDK does not delay every UI call. Explicit `power acquire` may retry
immediately. A failed power acquisition does not veto the requested UI action.

Automatic iOS work selects `recovery:"reacquire-ended"`. If the selected SDK
explicitly reports that its assertion has ended while the Host work deadline is
still live, the next heartbeat attempts one new assertion for that same target.
It does not extend the work deadline or require a UI action. The result retains
`assertionRecovery` with the attempt, reason, time and confirmation. Ordinary
touches still avoid a descriptor/status request per UI action.

Explicit `acquire` defaults to `recovery:"manual"`; callers may choose
`"reacquire-ended"` for an iOS SDK target. Connection errors, identity failures,
an App that is not foreground, and a failed replacement remain visible failures.
They do not trigger an endless retry or change an explicit port. The mode does
not start an App, dismiss a system alert, unlock a phone, or protect another App.
Disabling automatic work or ending the operation releases its protection and
cancels further recovery. A new acquire with an unknown response has no confirmed
expiry bound; the old assertion's timestamp cannot bound the new one.

## Internal integration

```js
const { createPowerManager } = require('./power');
const { createPlatformAdapter } = require('./power/platform-adapters');
const { createActivityLeases } = require('./power/activity-lease');
const power = createPowerManager({
  acquireAdapter: createPlatformAdapter({
    iosRequest: async (target, body) =>
      (await iosProvider.runtimePort(target)).post('/v1/power', body),
  }),
});
const activity = createActivityLeases({ manager: power, idleLeaseMs: 600000 });

// Keep this owner stable for the actual work session, not the individual call.
const result = await activity.touch({ ownerId, target: { platform: 'host' }, mode: 'both' });
// A false result carries a warning; it must not veto the requested UI action.
await activity.end({ ownerId });
await activity.close();
await power.close();
```

The iOS callback deliberately uses `runtimePort().post()`. Existing
`runtimePost()` routes mutation commands through managed H5/Flutter execution;
it is not a generic HTTP POST transport. The bound port preserves the selected
device, bundle, runtime epoch, process and endpoint checks.

The manager methods are `acquire({ownerId,target,mode,leaseMs,recovery?})`,
`renew({leaseId,leaseMs})`, `release({leaseId})`, `status({leaseId?})`, and
`close()`. `leaseMs` is 1–86,400,000 milliseconds. Targets are explicit:

| Target | Requested modes | Actual protection |
| --- | --- | --- |
| `{platform:'host'}` on macOS | `system`, `display`, `both` | Host idle sleep/display idle assertions through `caffeinate -i`/`-d`. No `-u` input/wakeup declaration or power-setting changes. |
| `{platform:'host'}` Windows adapter | `system`, `display`, `both` | Implemented PowerShell worker uses `SetThreadExecutionState` and clears it on the same thread. The current CLI's native FactStore installation does not yet support Windows; this row is an adapter contract, not complete Windows Host availability. Screensavers and explicit manual sleep are outside the API. |
| `{platform:'android',serial}` | `system`, `display`, `both` | A separate shell-owned `app_process` holds timed `PowerManager` locks for the selected device. `system` is a CPU partial lock. `display` keeps an already awake display on; it also keeps CPU active while the display is on. `both` adds the independent partial lock so CPU remains protected when display is off. No second UI automation connection is opened. |
| `{platform:'ios',deviceId,bundleId}` | `display` only | The selected SDK App's `UIApplication.isIdleTimerDisabled` while active in the foreground. It does not cover another foreground App or background CPU execution. |

The returned `mode` and `coverage` keep the request distinct from actual scope.
No mode silently falls back to an unsupported platform feature. Unsupported
protection is reported; it does not imply the associated business command must
be rejected. A host lease and a device lease are separate acquisitions.

## Lifetime and failure behavior

The default platform assertion TTL is 60 seconds, refreshed every 15 seconds
by the Host runtime. This timer never extends the logical work deadline. A
fresh Bridge activity signal extends work without a native call per UI action
(`renew({refreshAssertion:false})`); near-expiry assertions renew immediately.
The ordinary platform timer remains armed throughout idle thinking gaps.
Its execution scope belongs to the work lease. Completion or cancellation of
the earlier command that established it must not cancel later timer refreshes.

Each lease owns its own child process or SDK lease ID. Releasing one cannot
release another. Explicit release, cancellation, work expiry and Host shutdown
all close only owned resources. Startup/close races are serialized per lease.
The Windows/Android child channel also reports a confirmed process exit to its
own lease immediately through that queue, retaining the first failure reason.
It does not wait for the next heartbeat, reacquire automatically or invalidate
a replacement handle when an old handle exits. An Android transport exit still
does not prove remote release; the native lock's confirmed TTL bounds that case.
`platformExpiresAtMs` is a conservative bound on the most recently confirmed
platform assertion. macOS has whole-second native expiry resolution.

- macOS binds the assertion to both the parent PID and `-t` native timeout.
  Replacement assertions are confirmed through `pmset` before the previous one
  is released. An already lost assertion is reported, not silently recreated.
- Windows uses a monotonic TTL on the assertion-owning thread. A background
  stdin reader leaves that thread free to enforce its timeout. In particular,
  `Console.In.ReadLineAsync()` cannot be used as a nonblocking timer boundary.
  Pipe EOF, explicit release, TTL expiry and process exit release the assertion.
  This deadline is enforced by the running PowerShell worker, not a timed Win32
  assertion. Suspending or hanging that worker removes the timer guarantee;
  `platformExpiresAtMs` is not a kernel-enforced bound in that case.
  The worker neither changes PowerShell execution policy nor changes power plans.
- Android uses `PowerManager.acquire(timeout)` and a device-side monotonic
  expiry timer in the separate worker.
  EOF releases the worker's locks. Killing an ADB transport alone does not prove
  remote release: absent a device acknowledgement, the result reports
  `released:false`, `boundedByPlatformExpiry:true`. The native timeout remains
  the release bound when Host/USB communication is gone. The package contains
  the Java source, built dex jar and source/artifact SHA-256 manifest.
- iOS preserves the preexisting idle timer setting on the first lease and
  restores it after the last lease. Leaving the active foreground state,
  listener failure/cancellation, explicit release and device TTL expiry restore
  it. The SDK timer survives Host disconnect. UIKit work stays on the main
  thread. An expired lease cannot be renewed into existence.

A lost acquire response does not prove that the device created no assertion.
Without a confirmed handle, cleanup reports `acquisition_not_confirmed`; no
absolute platform expiry timestamp is invented. An assertion that was accepted
on the device still uses its requested platform TTL.

No adapter unlocks a manually locked device, defeats lid/manual sleep, or
overrides OS security, Doze or device-management policies. No synthetic input
fallback is implemented. iOS external-App WDA lock/unlock/button routes are not
equivalent to a safe idle-protection lease.

## Verification boundary (2026-10-15)

Evidence is retained outside the repo in
`ai-app-bridge-release-evidence/optimization-next-2026-10-15/power/`.

- macOS `macos-report.json`: actual own-PID assertions, automatic renewal,
  two independent leases, Host SIGKILL release (118 ms observed), and native
  timeout during Host SIGSTOP. The root task's existing assertion was preserved;
  this does not prove whole-host sleep behavior with all other assertions absent.
- Android `android-report.json`: independent API 36 emulator 5600, no-protection
  idle-to-sleep negative control, plugged/unplugged display protection, CPU-only
  display-off distinction, two leases, work expiry, Host crash/stall and dedicated
  ADB transport loss. Screenshots are byte-identical across each display test;
  draft, zero order submissions and activity callbacks remain unchanged.
  Test-only battery/timeout/stay-on controls were restored. This is not an OEM
  physical-device battery or Doze certification.
- Swift `swift-mirror-test.log`: four controller tests plus canonical/Flutter
  source parity, including a real main-queue timer expiry, prior-setting
  restoration and overlapping leases. The adjacent
  `ios-device/power-real-report.json` records 12 checks on the selected physical
  iPhone: overlapping foreground leases, renewal independent of the work
  deadline, last-owner restoration, expiry, unsupported CPU mode, Host
  SIGKILL/SIGSTOP and leaving the foreground. The actual SDK idle flag and
  sample state were read back. A post-expiry status request also runs expiry
  reconciliation, so that response alone does not prove when the timer fired;
  the independent main-queue timer test supplies that narrower evidence.
- Windows: adapter reviewed against the documented system API and automated
  child protocol/lifecycle tests on macOS. The bundled native FactStore currently
  rejects Windows installation, so full Windows Host support is not implemented.
  Actual Windows power API and physical behavior also remain unverified. Shipping
  the adapter source is not evidence that the normal Windows CLI can execute it.
- Installed CLI/MCP: `public-entrypoints-1792034976253/report.json` records ten
  real macOS checks, including shared lease visibility, reconnect, auto disable
  preserving explicit work, Script cancellation and Runtime shutdown. These
  checks exercised actual assertions; they did not operate any device UI.

At the original publication checkpoint, the user disconnected the phones and
requested no further device operations. The owned Host runtime was stopped
without another device request; final device-side release was not queried after
unplugging. That historical result retains the platform TTL as its release bound.

The user subsequently reconnected both phones. The physical supplement exposed
a Host command-context bug that the earlier direct SDK checks did not cover.
With the timer-scope repair included in 0.4.11, Kiwix stayed foreground with its actual
SDK assertion and idle flag active for 75.017 seconds without touch input. Explicit
release restored the original flag. The combined candidate then passed one real
Kiwix process restart: its default heartbeat made one confirmed replacement in
479 ms, retained the original work deadline, and protected a further 75.012-second
no-touch foreground window. Release restored the prior flag. These candidate
results validate the repair included in 0.4.11; public 0.4.10 does not contain it. On OPPO,
an 80.590-second positive run
retained App foreground and an unlocked keyguard while the assertion renewed;
its original ten-minute screen timeout and stay-on settings were unchanged, so
this does not isolate the assertion's efficacy from those settings. Owned
resources and test controls were restored. Evidence is in sibling
`ai-app-bridge-release-evidence/0.4.10-device-supplement-2026-10-15/`.

Neither result establishes protection for arbitrary external iOS Apps or a
secure device that was already locked. System permission alerts must be handled
through the selected WDA executor; SDK foreground loss is not evidence that the
alert was handled or that the original business action completed.

Sources: [Microsoft execution-state API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate),
[Console input async caveat](https://learn.microsoft.com/en-us/dotnet/api/system.io.textreader.readlineasync),
[Android PowerManager](https://developer.android.com/reference/android/os/PowerManager),
[timed Android WakeLocks](https://developer.android.com/develop/background-work/background-tasks/awake/wakelock/set),
[UIKit idle timer](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled).
macOS flags were checked against the installed `caffeinate(8)` manual.
