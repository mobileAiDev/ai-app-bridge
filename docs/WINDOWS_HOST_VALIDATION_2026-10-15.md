# Windows Host candidate validation

This work follows the remaining implementation requirement in
[the Windows support plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).
The experiments began on `codex/windows-host-validation`, leaving public
0.4.13, installed consumers and the shared production Runtime unchanged during
acceptance. Final software evidence covers the coordinated 0.4.14 candidate at
`6187bb57a389aeab37b4ec4e2a4c5a5c28cb9621`; publication and local upgrades are
separate release steps.

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
| Windows native build | Final run 38734283036 compiled the current source with MSVC; its binary and all seven source hashes match the manifest and installed package. The exact verified win32-x64 binary is now imported into the release tree. |
| Windows native format/recovery | Final run 38734283036 passed all 17 Node cases, the C suite and byte-for-byte golden parity. |
| Windows Runtime/process/power | Final run 38734283036: 206 passed, zero failed, two POSIX signal-fixture skips. All 20 immediate cancellation checks and three nested concurrent-spawn checks passed, alongside real ADB, independent controllers and native power-worker tests. |
| Windows fresh installed package | Final run 38734283036 passed all nine checks against the installed 248-file 0.4.14 package in 14.361 seconds, with build tools disabled and no remaining test Runtime. |
| Existing Intel Mac and Linux targets | Final run 38734289532 passed on darwin-x64, linux-x64-glibc and linux-arm64-glibc at the same source revision. Each passed native 17, C/golden, 369 Host cases with zero failures and one platform skip, plus all nine installation checks. These are regressions of targets already shipped in 0.4.13. |
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
tests commit `cae2137570c33378e34e22ed57950f8b055adf7e`: 177 Host cases passed,
one cancellation case failed and two were skipped. Its fresh 248-file package
passed nine checks in 18.013 seconds. It reproduces the old
failure using the two production files from `c5777d5`, then restores their exact
candidate bytes. In the old control, completed command/JavaScript/Python daemons
die with the Host while an independent process survives; in the candidate all
four retain their original process identities. The real ADB server test also
passes. At that revision, this comparison did not close the separate cancellation failure in
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
passes. The corrective process-handle synchronization therefore required a new
real Windows run, recorded below. These failed runs remain part of the evidence.

## Final source-specific acceptance

Both final runs test `6187bb57a389aeab37b4ec4e2a4c5a5c28cb9621`:
[Windows 38734283036](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734283036)
and [existing POSIX targets 38734289532](https://github.com/mobileAiDev/ai-app-bridge/actions/runs/38734289532).
Windows ran on x64 Windows Server 2022 (10.0.20348), Node 26.3.0 and MSVC
19.44.35229.0. This validates win32-x64, not untested Windows architectures.
The earlier POSIX run 38727503505 passed 365 Host cases per target; the final
run repeats acceptance with the rebuilt artifacts and 369 passing cases each.

The cancellation correction seals only a cancelling Job against new process
associations, opens and verifies its member process handles, then waits for
those actual handles to become signaled. Its shared deadline covers the entire
wait. It closes its handles before checking final Job accounting. Snapshot
failures still request termination of the owned Job and remain explicit errors;
they do not become a successful cancellation. Normal completion still releases
the Job without terminating independently managed daemons. Cleanup errors are
retained in `details.cleanup`, including after output overflow or cancellation.

All 20 ordinary cancellation cases show both selected original processes gone
at callback completion, the other command's two identities unchanged and no
cleanup error. The three nested-Job cases recorded 23, 24 and 25 members, with
continued spawn attempts before cancellation: every recorded member had exited
at return and no later effects appeared. The original immediate assertions were
not weakened to wait for late cleanup.

The same final run reproduces the old daemon-loss fault using the fixed old
production sources and then restores the exact candidate bytes. The candidate
preserves completed command, JavaScript and Python daemons plus an independent
process after Host death, while unfinished trees terminate. Real SDK ADB keeps
the same isolated-port server across completed commands. Independent Runtime
stop controllers finish their receipts; normal stop delivers its response and
closes incomplete HTTP connections while retaining original Script records.

Clean installed-package checks cover shared CLI/MCP Runtime identity, Unicode
Python, disconnect continuation, `askAgent`, original-operation checkpoint
recovery with one recorded effect, cancellation and final Runtime cleanup. The
PowerShell tests execute the native system/display/both API modes, same-thread
release, renewal, deadline, EOF, overlapping leases and worker death. Physical
Windows display/system idle-prevention and restoration remain **not tested**.

The evidence index is `ci/verified-final-artifacts-6187bb5.json`; actual Windows
import is recorded separately in `ci/windows-prebuild-import-6187bb5.json`.
Process records are in `runtime/cancellation-acceptance.json`. The verification
index precedes import and retains its original `imported: false` snapshot.

### Source and artifact identity

All five native manifest entries share these source hashes, verified against
the tested commit and current files under `native/segmented-fact-store/`:

| Source | SHA-256 |
| --- | --- |
| `binding.gyp` | `5c60f9923fe95d63f906a6410677247844725ccd0566a3a38ec37eddac13e38e` |
| `include/sfs.h` | `90f7249662a6768a46dc1760aaf69fd8a1ba94b1694a23c790321c9339073ab7` |
| `src/sfs.c` | `9dfe2752d58a243f66ec220096e9ba84f8ff371201bf9b1e84dd63787ac79c14` |
| `src/sfs_platform.h` | `e8d220aba32a15bbcee3ce8a6fdb1a620833f4458be43812de319c189594262d` |
| `bindings/node/sfs_node.c` | `b8593c6f3e3e73c137bd6727e0e4da78debf6857c39615c5edad57a68d887380` |
| `bindings/node/windows_process.c` | `307b8d8f9638f554b2ec17d29e2f551d54c2964e426e897041f27bd5842be7ef` |
| `bindings/node/windows_process.h` | `e8d26287a70321daf86191ba3a0c7a6146b5faecce9ec3030a9db6a1ecf7a526` |

These are the SHA-256 values of the actual `segmented_fact_store.node` files,
not merely names of build targets. CI verifies installed-package parity for
Windows and the three POSIX matrix targets; darwin-arm64 has the local native
17-case result in `integration/final-source-mac-native.log`.

| Target | Binary SHA-256 |
| --- | --- |
| `win32-x64` | `50c6f2196be218c277939060e6c97cf6e644fd5c999938f1a97320c72adcc49b` |
| `darwin-arm64` | `4b6ff599a7a120f30c84d3b27072549c0c6c08fde668f246e1664411f912cf4c` |
| `darwin-x64` | `5a5e5c1c30e498b12bc183958032be1dbef34121d6119a591adfe5456b6d5760` |
| `linux-arm64-glibc` | `21b5e4e1264e32b71e1d991b39d8423c2fbc43d3fe06ab02260a51aaf38cb6e3` |
| `linux-x64-glibc` | `1d86ca1a3ba15716b853ff1fe58c9d8dacdfe4fb9bc1cf87815bf906ebd34b34` |

## Release boundary

The coordinated 0.4.13 release and local upgrade are complete as recorded in
[the release verification](RELEASE_VERIFICATION_0.4.13_2026-10-15.md).
The win32-x64 software gates for coordinated 0.4.14 are now complete, including
the exact imported prebuild. Windows physical sleep validation remains deferred
by the user and must remain marked pending in release materials. This candidate
makes no new whole-App speed claim and does not replace physical Android/iOS or
complex-App acceptance. Publication and local upgrades require their own release
verification; passing these gates alone does not claim they have happened.
