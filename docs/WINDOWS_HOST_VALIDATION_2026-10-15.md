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
- Attach Windows Runtime, Script and ordinary command workers to owned Jobs
  before starting requested code. Cancellation terminates the owned tree;
  other operations remain independent. Force-stop checks process creation time
  through the same process handle used to terminate it.
- Preserve literal command arguments through Windows command shims and support
  `gradlew.bat`. Python's protocol is explicitly UTF-8. Missing command receipts,
  caller timeout and confirmed failure before process creation remain distinct.
- Hold task power leases in the persistent Runtime. Test their lifetime across
  CLI return, Script completion, MCP disconnect, renewal and Runtime shutdown.

Arbitrary detached POSIX children have no newly added cleanup guarantee in this
candidate. Independent child Bridge tasks keep their documented lifecycle.

## Evidence and acceptance gates

Evidence roots are sibling directories
`ai-app-bridge-release-evidence/windows-closeout-2026-10-15/` and
`ai-app-bridge-release-evidence/windows-host-2026-10-15/native/`.

| Gate | Current evidence |
| --- | --- |
| macOS native store | C suite, 17 Node cases and byte-for-byte v1 golden parity passed. |
| macOS integrated Host | Full functional suite: 1,872 passed, zero failed, 19 Windows-only cases skipped. |
| macOS SDK source mirror | Swift suite: 82 passed; canonical C source and private platform header are mirrored into iOS/Flutter/WDA packaging. |
| Test-fixture maintenance | Swift/Flutter acceptance-count and action-phase assertions corrected with original red evidence retained; each full suite passed 82 cases. |
| Fresh installed package on macOS | Actual prebuilt installation, CLI/MCP continuation, JS/Python, checkpoint/recording recovery and cancellation passed. This is not Windows evidence. |
| Windows native build | First real run failed because Node's inherited C++ standard flag conflicted with an unconditional C11 flag. Subsequent verification is pending. |
| Windows native format/recovery | Pending real runner execution; Mac protocol tests do not satisfy this gate. |
| Windows Runtime/process/power | Pending real runner execution, including actual Win32 and PowerShell APIs. |
| Windows fresh installed package | Pending real runner execution with build tools disabled. |
| All published native targets | Final source-specific artifacts and regression checks pending. Old artifacts cannot be relabeled as built from this source. |
| Physical Windows display/system sleep | Deferred by the user; CI cannot establish physical sleep behavior. |

The first Windows run is
[38723044686](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38723044686),
commit `88c0f0fc274f4f0550e399e59d13af84d6d5bcc2`. Its failure and skipped
downstream tests are preserved. A corrected run must build and execute the
candidate; repeating an unchanged failed run does not add evidence.

## Release boundary

The coordinated 0.4.13 release and local upgrade are complete as recorded in
[the release verification](RELEASE_VERIFICATION_0.4.13_2026-10-15.md).
Windows support is separate pending implementation/acceptance work. This
candidate makes no new whole-App speed claim and is not a replacement for
physical Android/iOS or complex-App acceptance. Update the support matrix and
ship a new coordinated version only after the applicable software gates pass.
