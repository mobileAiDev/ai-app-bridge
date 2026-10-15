# Windows Host support: implementation and acceptance boundary

The user requires Windows to have the same task-level, explicit power lease as
macOS, with Windows physical testing deferred until a machine is available.
That requirement is not met by merely shipping a PowerShell source file.

## Published 0.4.13 and initial findings

- `bin/power/windows.ps1` implements `SetThreadExecutionState`, a monotonic
  worker deadline, renew/release messages and EOF cleanup. Acquisition and
  release run on the same synchronous thread and release checks the native
  thread ID. The Host lease belongs to the persistent Runtime, not one CLI
  command or a subtask. This implementation already exists in public 0.4.10.
- Protocol tests use real Node child processes on macOS. They have not executed
  PowerShell or the Win32 power API. They cannot establish physical Windows
  display/system behavior. The worker's deadline is not a kernel-enforced TTL
  if that worker itself stops running.
- A separate review reproduced stale state after the worker closed. The local
  candidate propagates its termination to the owning lease without waiting for
  a heartbeat. It preserves the original cause, does not reacquire automatically,
  and cannot release another lease or invalidate a replacement handle. New
  lifecycle tests went from three failures to eight passes; all 67 power tests
  passed. These are Host/process tests, not Windows API tests.
- **The normal Windows CLI installation in public 0.4.13 is blocked.** Its bundled
  native FactStore has only Darwin arm64/x64 and Linux glibc arm64/x64 artifacts.
  `binding-path.js` rejects win32 and the install hook immediately loads that
  binding. The actual resolver, run in an isolated Mac Node process with only
  platform/architecture overridden to win32/x64, returned
  `native_platform_unsupported`. This is a reproducible loader decision, not a
  claim that a Windows machine was tested.
- The C store directly uses POSIX mapping, synchronization, file locking,
  directory enumeration and pthreads. A manifest entry alone cannot make a
  Windows artifact. The Android executor preparation path also explicitly
  rejects Windows Gradle wrappers. Other Host durable-file and process paths
  require Windows verification before claiming the entire CLI is supported.

Evidence is in sibling directory
`ai-app-bridge-release-evidence/0.4.10-device-supplement-2026-10-15/`:
`windows-final-review.md`, `windows-installation-blocker.json`, and
`windows-worker-exit-{red,green,related}.log`.

## Implementation plan

1. Add a small explicit native platform boundary for mapped files, file size,
   flushes, interprocess locks, Unicode paths, directory enumeration and thread
   synchronization. Implement Windows operations behind that boundary while
   preserving the existing on-disk format, commit ordering, recovery and locking
   guarantees. Leave the Mac/Linux behavior unchanged. Do not substitute an
   unannounced storage backend or skip durability operations to make tests pass.
2. Build a real Windows Node-API artifact with source/compiler/hash provenance,
   then run its native store, golden-format, corruption/recovery and competing
   process tests in Windows. Cross-compilation alone is not runtime acceptance.
   Start with the architecture actually validated; do not claim all Windows
   architectures from one artifact.
3. Check the full Host path: fresh npm install without compiler/Python,
   persistent Runtime, CLI/MCP reconnect, JavaScript/Python execution, original
   action recovery, recording/checkpoint, durable ownership writes, cancellation
   and scoped process-tree cleanup. Verify the directory-flush and atomic-file
   paths on Windows rather than assuming POSIX behavior or ignoring errors.
   Add Windows executor preparation only with tested executable/argv handling.
4. Run the actual PowerShell worker and native API on Windows, then validate
   explicit parent leases across command return and subtask completion,
   overlapping leases, renewal, deadline, EOF and process failure. Verify
   system/display/both and restoration on the user's physical machine when
   available. A Windows CI runner can establish software behavior before that;
   it cannot establish a laptop's physical display or sleep behavior.
5. Only after the relevant gates pass, update the package support matrix,
   installer guidance and coordinated release. Preserve Windows physical
   verification as pending until performed. Public 0.4.10 is not overwritten.

## Candidate progress and current decision

The isolated `codex/windows-host-validation` candidate implements the native
platform boundary, Windows Host file/process operations and command shims.
Actual Windows CI has now passed native compilation, 17 Node storage cases,
the C suite, golden-format parity and all nine fresh-package installation checks.
An intermediate Host run passed 177 cases, failed one cancellation-cleanup case
and skipped two. A focused diagnostic then reproduced early cancellation return
in 7 of 20 repeats: Job accounting reached zero before the original process
handle was signaled. These failures and the earlier build/lifetime failures
remain recorded in
[Windows Host validation](WINDOWS_HOST_VALIDATION_2026-10-15.md).

The final software gates now pass at
`6187bb57a389aeab37b4ec4e2a4c5a5c28cb9621`:

- [Windows run 38734283036](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734283036):
  **206 passed, 0 failed, 2 POSIX signal-fixture skips**. All 20 immediate
  cancellation checks and three concurrent nested-Job checks (23/24/25 recorded
  members) passed. Other tasks and completed daemons retain their original
  identities. The independent stop controller and real isolated-port ADB
  lifecycle passed.
- [Existing POSIX targets run 38734289532](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734289532):
  darwin-x64, linux-x64-glibc and linux-arm64-glibc each passed **369 Host cases,
  0 failed, 1 platform skip**, native 17, C/golden and nine clean-install checks.
  These are regressions of already published targets, not additional platform
  expansion. Windows also passed native 17, C/golden and the nine installed
  0.4.14 CLI/MCP/Script/recovery checks without invoking a compiler.

The cancellation implementation waits for real process handles with one shared
deadline, prevents new associations only while closing that Job, and preserves
cleanup diagnostics instead of losing them behind an earlier error. Normal
completion still releases the tool's managed daemon. The final actual Windows
artifact is imported, with SHA-256
`50c6f2196be218c277939060e6c97cf6e644fd5c999938f1a97320c72adcc49b`.
Its process source hash is
`307b8d8f9638f554b2ec17d29e2f551d54c2964e426e897041f27bd5842be7ef`;
all seven native source hashes and five binary hashes are recorded in the
validation document and match the release manifest. The evidence index is
`ai-app-bridge-release-evidence/windows-closeout-2026-10-15/ci/verified-final-artifacts-6187bb5.json`,
with the subsequent import recorded in `ci/windows-prebuild-import-6187bb5.json`.

The win32-x64 installation/runtime software acceptance is therefore complete
for the coordinated 0.4.14 candidate. The actual PowerShell API and persistent
work-lease tests passed on Windows CI, including system/display/both modes,
renewal, deadline, EOF, overlapping leases and worker death. **Physical Windows
display/system idle prevention and restoration remain untested**, as the user
explicitly deferred that check. Publication and local upgrades remain separate
release work; this acceptance must not be presented as a completed physical
Windows power test or support for untested Windows architectures.

The API's scope is idle system/display prevention; explicit manual sleep and
screen savers remain outside its guarantees, as documented by
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate).
