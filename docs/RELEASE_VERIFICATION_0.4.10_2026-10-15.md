# 0.4.10 release verification

Status: all distribution channels are published and verified. GitHub, npm, Pub,
public Maven artifacts and standard remote SwiftPM consumption match the frozen
release. Four consumer upgrades, Web remote-smoke and the public-registry CLI
installation have passed. The existing Codex MCP connection still needs a
reconnect and verification; a fresh installed MCP process already passed. The
platform acceptance limits below remain unchanged by publication.

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
- Public GitHub/npm/Pub/Maven checks and standard remote SwiftPM resolution:
  passed. Both npm packages have `latest` and `next` set to `0.4.10`.
- Public-registry CLI installation, fresh CLI/MCP processes and skill parity:
  passed; all 238 package files match the frozen archive.
- Web remote-smoke: public `0.4.10` dependency installed; six package files match
  the public archive, import and syntax checks pass, and 38/38 contract tests
  pass against the public package. This is not a new browser/device E2E run.
- Four Android consumer projects: seven exact version replacements, seven
  Gradle checks and six APK packaging checks passed against public `0.4.10`.

Final review found and fixed two retained-evidence bugs: repeated recovery
could advance the default read boundary before a new program checkpoint;
inventory could omit an ambiguous receipt after its dispatch marker expired.
Focused regressions now reproduce and cover both. Effects are never replayed
to repair either view.

## Public channels

- [GitHub Release 0.4.10](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.10)
  is public and marked latest. Its CLI/Web archives and `SHA256SUMS` were fetched
  without authentication and match the frozen hashes.
- npm CLI and Web: both uploads completed, their exact public versions and
  archives were fetched, and SHA-256/SHA-512/SHA-1 and full bytes match the frozen
  archives. Both packages' `latest` and `next` are `0.4.10`. Earlier expired
  callbacks, an expired login (`whoami` returned 401) and temporary public 404s
  after successful uploads are preserved in the evidence. Successful uploads
  were never repeated to resolve the visibility delay.
- Pub SDK and helper: both uploaded once, and both exact versions and `latest`
  resolve to `0.4.10`. SDK 60 files and helper six files match frozen source.
  Public archive SHA-256 values are
  `2042115f343ddea13bbadc763087679e960addadf674a597bd6cfd4e52edd144`
  and `a58263e58022201275b1e3109467e65ffd27f66728ccd05d2e17fc5beb3d608a`.
  A fresh-cache standard hosted consumer resolved both packages in 7.405 seconds;
  analysis passed in 5.513 seconds. Two early index-propagation failures are
  retained rather than discarded or repaired by re-uploading.
- Maven/JitPack: the first two public attempts failed while downloading
  dependencies from Maven Central, each logging 114 `HTTP 429` responses and
  failing in 2m49s before compilation. After at least 15 minutes of cooldown, a
  third build of the identical tag/commit succeeded in 3m27s with 540 tasks.
  Before each retry, the failed build's version, commit and empty module list
  were checked; only that failed build record was removed through the official
  API. All eight modules/16 public artifacts were downloaded and verified;
  341 compiled classes match the frozen local build byte for byte. The public
  annotated tag was independently checked through GitHub's ref and tag-object
  APIs and still resolves to the frozen commit.
  The successful remote build used JitPack's `legacy` image (`default` in its
  log), unlike the earlier `latest` builds. Its lint process reported heap-space
  and seven partial-result XML read errors, so remote lint is not counted as a
  complete pass. The separate local full lint result remains zero errors and
  24 warnings. All three logs, the two retry receipts and the CI limitation are
  retained in the release evidence.
- Swift: standard remote SwiftPM resolution passed in 31.104 seconds with
  `exact: "0.4.10"`. `Package.resolved` pins the frozen commit and all 94 relevant
  remote checkout files match it. The first attempt's HTTP/2/TLS transport
  failures are retained; the successful retry used system Git. This result is
  remote package consumption, separate from the earlier generic iOS compilation.

## Local installation and consumers

The CLI was reinstalled globally from the public npm registry using a fresh
cache. All 238 files match the frozen archive. A fresh isolated global CLI/MCP
runtime reports `0.4.10`; shared runtime identity, eight concurrent JavaScript
status calls, Python Script execution and doctor (zero issues) passed without
device operations. Its isolated runtime was stopped in cleanup. The installed
`ai-app-bridge-use` skill matches the shipped skill. The old default runtime was
explicitly stopped before the earlier frozen-archive installation.

The already connected Codex MCP process was checked through stateless discovery:
`capabilities` for `power`/`status` still returns `unknown_command`. It has not
loaded the new command catalog and still needs a reconnect. No normal command
was sent through that old client to start an incompatible runtime.
POS, Reader, Duo and MeasureDevice now reference public `0.4.10` in all seven
planned locations. All seven Gradle checks passed, covering six APKs (POS SIT,
Reader, Duo, Measure app, receiver and protocol app). Eight resolved SDK/plugin
artifacts match the public AAR/JAR hashes. APK ZIP integrity, Manifest and DEX
presence checks passed; two concurrent Gradle projects took 73.382 seconds in
total. This is dependency and build verification, not additional device testing.

Before/after checks preserve all four repositories' HEAD, branch, index, staged
patches, unrelated dirty/untracked files and original line endings. Changes are
exact version replacements only. No consumer commit, push or device installation
was performed. The full record is `consumers-four/closeout.json` under the release
evidence root.

The Web remote-smoke dependency and lockfile also now point to the public
`0.4.10` tarball and its verified integrity value. Its existing HTML is unchanged.

## Remaining local completion step

Reconnect the existing Codex MCP client and verify that its actual connection
loads `0.4.10`. No further npm verification or publication is pending. This final
connection check requires no phone calls, installations or cashier-device use.
