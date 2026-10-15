# 0.4.11 release verification

Status: release preparation. The user authorized coordinated publication and
upgrading the local CLI/MCP setup plus the same four consumer projects.
No public 0.4.11 channel is claimed verified until its downloaded artifacts match
the frozen source and archive. Public 0.4.10 is not overwritten.

Evidence root: sibling `ai-app-bridge-release-evidence/0.4.11-2026-10-15/`.

## Scope

Host fixes cover iOS power renewal context, explicit confirmed-ended assertion
recovery, prompt worker-exit status and WDA recovery guidance. SDK packages are
version-aligned without execution behavior changes. The implementation commit
is `5c52106`; its 1,855 functional tests, 50 performance tests, clean-package
validation and bounded device evidence are recorded in
[the physical supplement](PHYSICAL_DEVICE_SUPPLEMENT_0.4.10_2026-10-15.md).

Windows normal CLI installation remains blocked by the native FactStore; this
release does not claim complete Windows support. See
[the implementation plan](WINDOWS_HOST_SUPPORT_PLAN_2026-10-15.md).

## Release gates

- Version alignment complete; Host functional 1,856/1,856 and performance 50/50 passed. CLI 238 and Web six archived files match source byte for byte, including file modes.
- Final CLI clean-package install, CLI/MCP/npx, Script/Intent shutdown and original-action recovery: passed; separate focused fixture/upload regressions passed 2/2.
- SDK/optional executor checks: Android 496 tests and local Maven build passed; Swift 81 and Flutter SDK 81 tests passed; both Flutter analyzers and publish dry-runs passed; generic SwiftPM and Flutter iOS builds passed.
- Public GitHub, npm, Pub, Maven and SwiftPM checks: pending.
- Local installation and installed skill parity: pending.
- POS, Reader, Duo and MeasureDevice dependency/build checks: pending.
- Actual already-connected Codex MCP version after reload: pending.

Consumer updates preserve current branches, index and unrelated work; no
consumer commit, push or device installation is part of this upgrade. The K2
cashier remains outside the device scope.

## Additional packaging finding

The first 0.4.11 clean-package run stalled at Runtime shutdown. Its controlled
ADB fixture ignored SIGTERM for every request, including power-helper upload.
The actual upload used an execFile timeout whose default signal could be ignored,
leaving the completion promise unresolved. Two scoped fixture processes remained
alive after their ten-second transfer timeout. Their original logs, process
sample and cleanup receipts remain in `cli-package/`.

The Host now uses SIGKILL at that existing upload deadline. A real child-process
regression reproduces the old hang and passes with the repair. This is an
additional Host change after the earlier 1,855-test candidate; the release must
pass fresh functional/performance/package checks. Those checks now passed without changing their deadlines. It does not stop another
Runtime, change device settings or replay an application action.
