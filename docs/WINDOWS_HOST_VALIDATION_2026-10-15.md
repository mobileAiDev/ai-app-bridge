# Windows Host candidate validation

This work follows the remaining implementation requirement in
[the Windows support plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).
It is isolated on `codex/windows-host-validation`. Public 0.4.13, `main`,
installed consumer dependencies and the shared production Runtime are unchanged.

## Candidate scope

- Preserve the native FactStore format and commit ordering through an explicit
  POSIX/Win32 platform boundary. Windows uses UTF-16 paths, mapped-file and file
  flushes, kernel file locks, and native process scopes. It does not substitute
  another database or compile a replacement during ordinary npm installation.
- Publish Host ownership/evidence names through a write-through Windows rename
  after flushing their contents. Exclusive creation remains exclusive. Removal
  retires the active name before deleting bytes; interrupted cleanup may retain
  an inert retired file. Required I/O failures remain errors. The native store's
  existing best-effort directory flush is not a new power-loss guarantee.
- Attach each unfinished Windows Script and ordinary command worker to its own
  Job before starting requested code. Cancellation or Host death terminates
  that owned tree. The Runtime itself is not put in a global kill-on-close Job:
  an independent stop controller must survive long enough to record its result.
  A complete command receipt releases its Job without terminating tool daemons,
  including after a nonzero tool exit. Script release requires a returned result
  and normal SDK exit; cancellation, failure and missing receipts retain cleanup.
  Force-stop checks creation time through the same handle used to terminate.
- Preserve literal command arguments through Windows command shims and support
  `gradlew.bat`. Python's protocol is explicitly UTF-8. Missing command receipts,
  caller timeout and confirmed failure before process creation remain distinct.
- Hold task power leases in the persistent Runtime. Test their lifetime across
  CLI return, Script completion, MCP disconnect, renewal and Runtime shutdown.

Arbitrary detached POSIX children have no newly added cleanup guarantee in this
candidate. Bridge tasks created through `ctx.call` and the Host's composed
controllers keep their independent lifecycle. Processes directly spawned inside
an unfinished Windows Script remain part of its owned tree, even if they launch
another CLI with a separate Runtime home. Cancelling that Script can terminate
them; natural completion releases the tree. No general breakaway flag is enabled.

## Evidence and acceptance gates

Evidence roots are sibling directories
`ai-app-bridge-release-evidence/windows-closeout-2026-10-15/` and
`ai-app-bridge-release-evidence/windows-host-2026-10-15/native/`.

| Gate | Current evidence |
| --- | --- |
| macOS native store | C suite, 17 Node cases and byte-for-byte v1 golden parity passed. |
| macOS integrated Host | Before the final Windows Job lifetime correction: 1,881 passed, zero failed, 20 Windows-only cases skipped. Final-source regression is pending. |
| macOS SDK source mirror | Swift suite: 82 passed; canonical C source and private platform header are mirrored into iOS/Flutter/WDA packaging. |
| Test-fixture maintenance | Swift/Flutter acceptance-count and action-phase assertions corrected with original red evidence retained; each full suite passed 82 cases. |
| Fresh installed package on macOS | Actual prebuilt installation, CLI/MCP continuation, JS/Python, checkpoint/recording recovery and cancellation passed. This is not Windows evidence. |
| Windows native build | Second real run compiled successfully with MSVC. The first run's C/C++ standard flag conflict is fixed. Final-source rebuild is pending. |
| Windows native format/recovery | Second real run passed all 17 Node cases, the C suite and byte-for-byte golden parity. Final-source rerun is pending. |
| Windows Runtime/process/power | Second real run: 160 passed, six failed, two skipped. Actual Win32 process and PowerShell lease cases passed. Five failures were Windows fixture assumptions; one exposed an overbroad Runtime Job. Corrections require another real run. |
| Windows fresh installed package | Second run skipped this step after Host failures. Pending actual installation with build tools disabled; the workflow now retains this independent evidence even when another Host check fails. |
| All published native targets | Final source-specific artifacts and regression checks pending. Old artifacts cannot be relabeled as built from this source. |
| Physical Windows display/system sleep | Deferred by the user; CI cannot establish physical sleep behavior. |

The first Windows run is
[38723044686](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38723044686),
commit `88c0f0fc274f4f0550e399e59d13af84d6d5bcc2`. Its failure and skipped
downstream tests are preserved. A corrected run must build and execute the
candidate; repeating an unchanged failed run does not add evidence.

The second run is
[38725013375](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38725013375),
commit `49293df734a4b01aeff08fefd33d690f74d71523`. Its native success does not
turn the failed Host or skipped installation gates into passes. Corrections
close SQLite readers before deleting fixtures, use a real Windows directory ACL
to prove rejected writes, and read only data segments rather than the mandatory
lock file. The process correction also adds a real SDK ADB server test on an
isolated port: inspect its listener before a second ADB call, verify the same
process survives, then explicitly stop that server. It uses no mobile devices.

## Release boundary

The coordinated 0.4.13 release and local upgrade are complete as recorded in
[the release verification](RELEASE_VERIFICATION_0.4.13_2026-10-15.md).
Windows support is separate pending implementation/acceptance work. This
candidate makes no new whole-App speed claim and is not a replacement for
physical Android/iOS or complex-App acceptance. Update the support matrix and
ship a new coordinated version only after the applicable software gates pass.
