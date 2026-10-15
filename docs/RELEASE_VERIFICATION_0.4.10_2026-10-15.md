# 0.4.10 release verification

Status: release incomplete. Source and immutable artifacts are frozen. Git and
Pub publication and standard remote SwiftPM consumption are verified. npm awaits
fresh human authentication; Maven is blocked by repeated upstream HTTP 429.
Consumer versions are unchanged and the GitHub Release remains a draft. This is
not an all-channel publication completion record.

## Frozen source

- Source commit: `079a10603d1aa3f27f6fb964c2984c6f71574ca8`.
- Annotated tag: `0.4.10`; tag object `1e8a09c0089294237fcc02c7878e962ff7a332e7`.
- The public tag resolves to the frozen commit. Source and tag were pushed
  together; later verification notes do not change the tag or published archives.

## Included and deferred work

This release adds recovery facts and interruption inventory, independent
checkpoint recording attempts, explicit assertions over returned observations,
bounded work power leases, Android Flutter profile opt-in, and preserved Web
failure diagnostics. See the [complete proposal ledger](OPTIMIZATION_EXECUTION_2026-10-15.md)
for all 57 original proposals and the follow-up review. Experimental console
capture, group commit and general exploration export are not claimed as shipped.

The user removed both phones and explicitly requested review/publication.
No further phone calls or installations are authorized for this closeout, and
the K2 cashier device must not be used as a replacement. iPhone Native/H5,
Kiwix Intent/JavaScript and power evidence exists; iPhone Python/Flutter and
full real-device recovery remain incomplete. The [iPhone report](IOS_DEVICE_REGRESSION_2026-10-15.md)
records the exact completed and unrun scopes. Windows real-machine verification
is deferred at the user's request. These limits are carried into the release,
not converted into passes by packaging or automated tests.

## Final checks

Evidence root: sibling `ai-app-bridge-release-evidence/0.4.10-2026-10-15/`.
Runtime/experimental evidence is in `optimization-next-2026-10-15/`.

- Android SDK unit tests, Gradle-plugin tests and UIA assembly: passed.
- Shared Swift suite: 81 tests passed, with the embedded source mirror checked.
- Host final regression: 1,814/1,814 functional and 50/50 performance tests passed.
- Exact CLI package: clean installation, CLI/MCP/npx, bundled native prebuild, original receipt recovery and archive verification passed.
- CLI archive SHA-256: `9038abd0da2a7d2ca99f76f5f8e93e197f3cdf6deac65a5b9ab3189f8161fffd`; all 238 shipped files equal the reviewed source.
- Web package: 38/38 tests, build and archive/source parity passed.
- Native iOS consumer: generic iOS Debug compilation passed, without signing or using a device.
- Flutter SDK/helper publication dry-runs: zero warnings; source inventories verified.
- Maven clean release build: 496 tests passed, eight modules/16 artifacts checked, lint zero errors.
- Final CLI archive differs from the execution-tested archive only in README and installation wording; all execution bytes and file modes are unchanged.
- Public Git/Pub checks: passed; other channel checks are tracked below.
- Local frozen-archive CLI/MCP and skill upgrade: passed; public-registry
  installation and four consumer upgrades remain pending.

Final review found and fixed two retained-evidence bugs: repeated recovery
could advance the default read boundary before a new program checkpoint;
inventory could omit an ambiguous receipt after its dispatch marker expired.
Focused regressions now reproduce and cover both. Effects are never replayed
to repair either view.

## Public channels

- GitHub draft assets match the frozen CLI/Web SHA-256 values. Promotion to a
  public release is pending the remaining distribution checks.
- npm CLI and Web: both first publication attempts exited with an expired web
  authentication callback (`E404`). Exact public version queries also returned
  404. These attempts are not treated as published; fresh human verification is
  required before retrying the same frozen archives.
- Pub SDK and helper: both uploaded once, and both exact versions and `latest`
  resolve to `0.4.10`. SDK 60 files and helper six files match frozen source.
  Public archive SHA-256 values are
  `2042115f343ddea13bbadc763087679e960addadf674a597bd6cfd4e52edd144`
  and `a58263e58022201275b1e3109467e65ffd27f66728ccd05d2e17fc5beb3d608a`.
  A fresh-cache standard hosted consumer resolved both packages in 7.405 seconds;
  analysis passed in 5.513 seconds. Two early index-propagation failures are
  retained rather than discarded or repaired by re-uploading.
- Maven/JitPack: both public attempts failed while downloading dependencies from
  Maven Central, each logging 114 `HTTP 429` responses and failing in 2m49s before
  compilation. Before the single retry, the failed build's version, commit and
  empty module list were checked and only that failed record was removed through
  the official API. The retry kept the identical tag/commit. It again ended in
  `Error` with no public artifacts. No further rebuild is in flight; local build
  success is not public publication. The two complete logs and deletion receipt
  are retained in the release evidence.
- Swift: standard remote SwiftPM resolution passed in 31.104 seconds with
  `exact: "0.4.10"`. `Package.resolved` pins the frozen commit and all 94 relevant
  remote checkout files match it. The first attempt's HTTP/2/TLS transport
  failures are retained; the successful retry used system Git. This result is
  remote package consumption, separate from the earlier generic iOS compilation.

## Local installation and consumers

The final frozen CLI archive was installed globally. All 238 files match the
archive. A fresh isolated global CLI/MCP runtime reports `0.4.10`; shared runtime
identity, eight concurrent JavaScript status calls, Python Script execution and
doctor (zero issues) passed without device operations. The installed
`ai-app-bridge-use` skill matches the shipped skill. The old default runtime was
explicitly stopped before installation.

This verifies new processes, not the already connected Codex MCP process. The
active connection still needs a reconnect after the public installation finishes.
The POS, Reader, Duo and MeasureDevice dependency updates wait for verified public
Maven artifacts. Their dependency versions remain `0.4.9`; only read-only
snapshots and upgrade/build runners were prepared. No consumer build or device
installation is claimed for `0.4.10` at this checkpoint.

## Remaining release steps

1. Complete fresh npm account verification, publish the frozen CLI/Web archives,
   and verify public bytes and both `latest`/`next` tags.
2. Retry the unchanged Maven release after the upstream rate limit clears, then
   verify all eight modules/16 public artifacts before consumer upgrades.
3. Build the four consumer projects and update Web remote-smoke from the public
   registry; preserve their unrelated worktree changes.
4. Install the verified public CLI package, repeat new-process MCP verification,
   reconnect the existing Codex MCP client, and publish the GitHub draft.

No phone calls, installations, or cashier-device substitution are part of these
remaining steps.
