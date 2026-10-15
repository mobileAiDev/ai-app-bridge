# 0.4.11 release verification

Status: partial publication. GitHub, npm, Pub, SwiftPM, local installation and
the restarted Codex MCP were verified; Android public Maven failed and the four
consumer builds were not started. The user then authorized coordinated 0.4.12
after the third public attempt failed; see
[the recovery release](RELEASE_VERIFICATION_0.4.12_2026-10-15.md).
The user authorized coordinated publication and upgrading the local
CLI/MCP setup plus the same four consumer projects. Public 0.4.10 is not
overwritten.

Evidence root: sibling `ai-app-bridge-release-evidence/0.4.11-2026-10-15/`.

Frozen source commit: `485f41b5559e0bbc09a6213ae5285d015f623176`.
Annotated `0.4.11` tag: `a8fee846fed3b0a2e508af0f12464cabf26cff24`.
The tag and public package archives stay fixed; this verification record can be
updated after publication as remaining checks finish.

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
- Public GitHub release and CLI/Web assets: downloaded and matched to frozen archives. Both npm packages have `latest` and `next` at 0.4.11; downloaded SHA-256, registry integrity and SHA-1 match.
- Pub packages: both latest 0.4.11; public SDK/helper archives match 60/60 and 6/6 frozen files. Fresh-cache hosted consumption and analysis passed after registry index propagation.
- Remote SwiftPM exact 0.4.11 consumption passed; resolved commit and 143 checked-out files match the frozen source. These generic builds and source checks do not substitute for device acceptance.
- Public Android Maven: failed after three attempts. The first logged Maven Central HTTP 429; the second returned a failed status but its complete new log was unavailable, so its cause remains unknown. The third's captured current log showed one release log-pressure unit-test assertion failure plus incomplete Lint after heap exhaustion. None published the required artifacts. Local build success does not substitute for public availability.
- Global CLI installation: public npm 0.4.11, all 238 files match its archive. Installed skill and agent metadata match the package; the prior skill is backed up.
- Newly launched global CLI/MCP: shared Runtime 0.4.11, compatible identity, doctor with zero issues, JavaScript eight concurrent status calls and Python execution passed. The default shared Runtime was also switched to 0.4.11 after confirming the old one had no active work.
- Web remote-smoke consumer: public 0.4.11 package and lockfile updated; six installed files match the public archive and 38 contract tests pass. No additional browser end-to-end acceptance is claimed by this package check.
- POS, Reader, Duo and MeasureDevice: seven references were updated, but the public-availability gate stayed closed and no 0.4.11 consumer build ran. The next coordinated upgrade uses separate 0.4.12 snapshots and records.
- Actual connected Codex MCP after the user's restart: 0.4.11 Runtime identity and `compatible: true` confirmed, followed by a successful host power acquire through this connection. The previous 0.4.10 client mismatch is retained as before-restart evidence.

Consumer updates preserve current branches, index and unrelated work; no
consumer commit, push or device installation is part of this upgrade. The K2
cashier remains outside the device scope.

Mac task-level power protection was transferred to the new Runtime before the
temporary handover Runtime was stopped, then re-established through the actual
MCP connection after Codex restarted. The old isolated iOS candidate Runtime
was stopped only after confirming zero active requests, sessions, automatic
operations and active leases. The disconnected OPPO and iPhone are not claimed
to be protected by a host-only lease.

Public and local evidence is indexed under `github-public/`, `npm/`, `sdk/`,
`maven/`, `local/` and `consumers-four/` in the evidence root. In particular,
`local/connected-codex-mcp-before-restart.json` and
`local/connected-codex-mcp-after-restart.json` distinguish the stale connected
client from its successfully verified replacement.

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
