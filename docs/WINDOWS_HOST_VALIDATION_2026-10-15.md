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
| macOS integrated Host | Integrated lifecycle regression: 1,887 passed, zero failed, 22 Windows-only cases skipped. Subsequent Windows-only release-diagnostic and detached-worker changes passed focused suites of 36 and 42 cases. These Mac checks do not execute Win32 APIs. |
| macOS SDK source mirror | Swift suite: 82 passed; canonical C source and private platform header are mirrored into iOS/Flutter/WDA packaging. |
| Test-fixture maintenance | Swift/Flutter acceptance-count and action-phase assertions corrected with original red evidence retained; each full suite passed 82 cases. |
| Fresh installed package on macOS | Actual prebuilt installation, CLI/MCP continuation, JS/Python, checkpoint/recording recovery and cancellation passed. This is not Windows evidence. |
| Windows native build | Run 38729796010 compiled with MSVC; its binary and all seven source hashes match the uploaded manifest and installed package. The verified candidate binary has not yet been imported into the release tree. |
| Windows native format/recovery | Run 38729796010 passed all 17 Node cases, the C suite and byte-for-byte golden parity. |
| Windows Runtime/process/power | Run 38729796010: 177 passed, one failed, two skipped. Actual ADB and the completed-service/Host-death comparison passed. Cancellation still returned while an owned process was reported live; this remains a release blocker. |
| Windows fresh installed package | Run 38729796010 passed all nine checks against the installed 248-file package in 18.013 seconds, with build tools disabled and no remaining test Runtime. |
| Existing Intel Mac and Linux targets | Run 38727503505 passed on darwin-x64, linux-x64-glibc and linux-arm64-glibc. Each passed native 17, C/golden, 365 Host tests (one platform skip) and all nine installation checks. Seven native source hashes match the current tree. These are regressions of targets already shipped in 0.4.13. |
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

The third Windows run,
[38727503138](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38727503138),
passed 172 Host cases and failed two. One test accidentally supplied ADB's remote
host option, which prevents server startup. The other exposed libuv's enclosing
Host Job: releasing the Bridge Job still left completed daemons subject to Host
death. The trusted workers now detach from that enclosing Job, and Bridge attaches
its own Job before allowing the requested code to start. General breakaway flags
are not enabled.

The fourth Windows run,
[38729796010](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38729796010),
tests commit `cae2137570c33378e34e22ed57950f8b055adf7e`. It reproduces the old
failure using the two production files from `c5777d5`, then restores their exact
candidate bytes. In the old control, completed command/JavaScript/Python daemons
die with the Host while an independent process survives; in the candidate all
four retain their original process identities. The real ADB server test also
passes. This comparison does not close the separate cancellation failure in
`windows-command.integration.test.js`. The failing run and all logs are retained
in `ci/verified-artifacts-38729796010.json` under the evidence root.

A focused 20-repeat diagnostic,
[38731842230](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38731842230),
tests commit `a669c0867200122de69f0592df8a0a59198dba8b`. Seven repeats still saw
the selected command's original creation identity at callback completion; each
became stopped in the bounded diagnostic tail. The descendant had stopped and
the independent command remained alive. No native cleanup error was returned.
This identifies a completion-order problem rather than PID reuse: Job accounting
reported zero active members before every process object was signaled. The
immediate assertion remains strict; tail observations do not turn failures into
passes. The corrective process-handle synchronization still requires real
Windows validation.

## Release boundary

The coordinated 0.4.13 release and local upgrade are complete as recorded in
[the release verification](RELEASE_VERIFICATION_0.4.13_2026-10-15.md).
Windows support is separate pending implementation/acceptance work. This
candidate makes no new whole-App speed claim and is not a replacement for
physical Android/iOS or complex-App acceptance. Update the support matrix and
ship a new coordinated version only after the applicable software gates pass.
