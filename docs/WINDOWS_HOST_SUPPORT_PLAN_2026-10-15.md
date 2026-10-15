# Windows Host support: implementation and acceptance boundary

The user requires Windows to have the same task-level, explicit power lease as
macOS, with Windows physical testing deferred until a machine is available.
That requirement is not met by merely shipping a PowerShell source file.

## Current facts

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
- **The normal Windows CLI installation is currently blocked.** Its bundled
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

## Current decision

Retain the existing Windows power implementation and the tested process-exit
diagnostic repair. Treat the missing Windows Host installation/runtime support
as open implementation work, not merely an untested device checkbox. Do not
publish or report complete Windows support from the current Mac protocol tests.

The API's scope is idle system/display prevention; explicit manual sleep and
screen savers remain outside its guarantees, as documented by
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate).
