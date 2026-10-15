# 0.4.15 coordinated release verification

Status: public publication and consumer upgrades passed. Eight scoped root
OPPO functional scenarios passed against the public artifacts; five final
screenshots have transition-frame limitations recorded below. The resident Codex MCP still needs a
restart/version check. A retained-history inventory pagination failure was
reproduced after the Runtime upgrade. Its separate source candidate has passed
related regressions and a consistent copy of the real retained history; it has
not replaced the published package or shared Runtime. The release is not
claimed free of outstanding issues.

Evidence root (sibling of this repository):
`ai-app-bridge-release-evidence/0.4.15-2026-10-15/`.
Immutable tag `0.4.15` points to
`458c7d79a87f81d847daa3d53ee0d743d6fd1d85`. Publication closeout documentation
and the public Web example dependency update are subsequent changes; the tag
and uploaded package contents are not rewritten.

## Scope

All package versions advance together. The Host query correction limits evidence
reads to the `action` and `ui` partitions used by their writer. It prevents
unrelated network retention from invalidating retained operation history during
internal pagination. It does not relax the global FactStore cursor contract,
actual evidence retention checks, archive consistency or unknown outcomes.

Windows help is corrected to reflect the implementation already validated in
0.4.14. Native binaries and their platform boundary are unchanged; Android,
iOS, Flutter and Web implementation changes are version metadata only.
Inherited Windows and existing POSIX acceptance is recorded in
[0.4.14 verification](RELEASE_VERIFICATION_0.4.14_2026-10-15.md) and
[Windows validation](WINDOWS_HOST_VALIDATION_2026-10-15.md).

## Completed preparation

- Coordinated version checks: 39 pass across 28 changed version files.
- Initial isolated Maven publication: 26.239 seconds, eight modules, 16 main
  artifacts and 341 class hashes verified. Its 263-task graph excludes the test
  and Lint lifecycle. The snapshot contains 168 files; this is a local packaging
  result, not a successful public build.
- Evidence-query correction: 165 related tests pass, none fail or skip, including
  six new regression/negative-control cases. An independent read-only review
  confirms legitimate evidence and large payload chunks remain covered; actual
  evidence gaps, cursor signature errors and concurrent archive changes still
  fail explicitly. The unfiltered FactStore query contract remains unchanged.
- CLI: the exact 0.4.15 tarball passed the complete clean-package gate, including
  compiler/Python-denied installation, first/repeated npx, CLI/MCP sharing,
  JavaScript/Python, original-operation recovery, controlled UIA/ADB and
  cancellation/Runtime shutdown. All 248 packaged files and modes match source.
  The gate used controlled devices only.
- Web: all six tarball files and modes match source.
- SDK: 160 inputs frozen; 31 canonical iOS/Flutter and three WDA mirror checks
  passed. Both Pub dry runs completed without warnings; unsigned generic iOS
  consumers built from SwiftPM and Flutter CocoaPods exports in 21.654 and
  26.656 seconds. These builds compiled the private platform header. Prior
  82-case Swift and 82-case Flutter tests are reused within their verified source
  boundaries, not claimed as newly rerun device tests.
- Four Android consumers now use public 0.4.15: POS, Reader, Duo and
  MeasureDevice. Seven resolution/build checks and six APK builds passed;
  repository/index/unrelated changes were preserved. No consumer commit or
  device installation is implied by those builds.
- The remote Web example manifest and lockfile now use public 0.4.15. Its
  installed six SDK files match the public archive; consumer check and SDK
  build checks passed. This is not a newly executed browser acceptance suite.

Public download verification is recorded separately as each channel finishes.
The explicit JitPack mirror candidate passed an isolated build with a new Gradle
user home and no dependency/transform cache: 351.274 seconds, 352 observed Aliyun
Central downloads and no HTTP 429. Eight representative POM/JAR files match
the canonical inputs byte for byte. The official Gradle distribution was reused;
this was a cold dependency-cache build, not a new wrapper download. Final output comparison passed: the 16 main artifacts preserve the eight POM
contents and 341 compiled class hashes from the normal build. Logs contain no
direct Central URL; Google and Plugin Portal remain configured separately.

The source now accepts an explicit `aiAppBridge.centralRepositoryUrl` property
in both build settings. Without it, the original `mavenCentral()` configuration
is retained. `jitpack.yml` explicitly selects the Aliyun Central caching mirror;
there is no failure-driven repository substitution. The actual public JitPack
build then passed in 2 minutes 25 seconds with no HTTP 429. All 16 main
artifacts were downloaded and their POMs/classes verified against the frozen
source. The reusable procedure is in [Android publication](ANDROID_PUBLICATION.md).

## Public artifacts and local upgrade

| Channel | Verified result | Evidence below the evidence root |
| --- | --- | --- |
| GitHub | Public release, exact tag and all three asset hashes match | `github-public/report.json` |
| Maven | Eight modules, 16 main artifacts, 341 compiled classes | `maven/PUBLIC_PUBLICATION_REPORT.json` |
| npm CLI | Exact public tarball matches; `latest` and `next` are 0.4.15 | `npm/cli-public-integrity.json` |
| npm Web | Exact public tarball matches; `latest` and `next` are 0.4.15 | `npm/web-public-integrity.json` |
| Pub | Both packages published; 61/6 archive files match; empty-cache standard hosted install and analysis passed | `sdk/SDK_PUBLICATION_REPORT.json` |
| SwiftPM | Public exact-tag 160-file comparison, resolution and unsigned generic iOS consumer build passed | `sdk/PUBLIC_SWIFT_REPORT.json` |
| Four Android projects | Seven public resolution/build checks and six APKs passed | `consumers-four/closeout.json` |
| Web example | Public exact dependency, lock integrity, installed bytes and check/build passed | `web-consumer/WEB_CONSUMER_REPORT.json` |
| Local CLI and skill | Public npm install; 248 package files and two skill files match | `local/global-install-parity.json` |
| Fresh CLI/MCP | Shared 0.4.15 isolated Runtime, JavaScript concurrent reads and Python passed | `local/public-install/global-mcp-report.json` |
| Default shared Runtime | 0.4.15 loaded, client compatible; earlier records retained | `local/runtime-after-upgrade.json` |

Early npm/Pub propagation misses and the expired first Web `next` authentication
callback are retained in the evidence. Uploads were not repeated to repair
index propagation. Public npm labels were checked after successful updates.

The currently resident Codex MCP reported client package 0.4.13 against the new
0.4.15 Runtime. Installed-file parity and a fresh independent MCP process do
not prove that this old process has reloaded; that check remains open.

## Root OPPO regression

The selected device was `b46093e6`, OPPO PKR110, Android 16/API 36; `su id`
confirmed root and the screen was unlocked. No cashier device was used. The
test APK was built from public 0.4.15 Android/Gradle-plugin and hosted Flutter
dependencies, with resolved-artifact/file hashes checked before installation.
The first build's unrelated `kotlin-reflect:1.6.10` Maven Central TLS handshake
failure is retained; the ordinary retry passed without changing coordinates
or substituting local Bridge artifacts.

After reinstallation, these eight scenarios passed their functional checks
and independent backend state/journal assertions. Timings below measure CLI
Script/Intent submission to completion, rather than only time inside the source.

| Scenario | Submission time | Result |
| --- | --- | --- |
| Two fresh-seed Native order → H5 session/cart → Flutter query → Native flows | 10.992 / 12.492 s | One order POST/commit, pending payment, empty cart and one hotel query in each run |
| Same mixed flow with 180 ms service delay | 14.550 s | Business result and independent counts passed |
| Order response deliberately disconnected | 10.763 s | Unknown-result UI, then original order query; one POST/commit, no resubmission |
| Python UIA/H5/Flutter sequence | 12.104 s | UIA/screenshot coexistence and business result passed; final screenshot limitation below |
| HTTP 500, invalid screenshot destination and invalid dates, then explicit continuation | 12.867 s | Original failures preserved; successful subsequent operations and independent oracle |
| Autonomous Native/H5/Flutter Intent | 4.620 s | Original Intent completed and independent hotel query matched |
| Own Runtime killed after a device effect, then original-ID reconciliation and frozen-spec verify-only resume | Reported as recovery evidence, not a new speed claim | Original unknown fact retained, same operation/action identity, backend effect count stayed one |

The earlier 24.000-second failed startup sample is retained separately. The
user confirmed they were manually operating the phone during it; screenshots
and Activity state showed another App in front and the test App frozen in the
background. It is excluded from product-failure and performance comparisons,
not silently removed or overwritten.

The new private FactStore returned all ten original Script operations over four
inventory pages, without duplicates or cursor errors. Recovery reads for all
ten IDs passed. The crash case remained `needsInspection:true`, retaining its
original unknown outcome after successful verification-only continuation.

Visual limit: all five normal/delay/lost/Python `final-native.png` files retain
some exit-animation displacement or edge; Python's has a visible Flutter
remnant. They are not evidence of fully settled final frames; a later
current-state screenshot cannot retroactively prove those steps.
Order, H5 session/cart, Flutter query and deliberate unknown-result/error
screens were checked against the corresponding independent records.

Evidence is in `oppo/suite-status.json`, per-attempt `case-summary.json`,
`submission-timing.json`, `commands.jsonl`, `business-oracle.json`, original
screenshots and `oppo/readback/report.json`. The final report is
`oppo/OPPO_REGRESSION_REPORT.md`. The private test Runtime and backend were
stopped and the selected device's task-specific reverse removed; the shared
Runtime and parent task's power leases were preserved. This is a dynamic mixed-provider
test slice using preauthenticated sessions and empty hotel-query results. It
does not establish UI login, hotel booking, payment/refund, official Meituan or
full-App acceptance, and is not a version-to-version speed comparison.

## Why a new version

The 0.4.14 public Maven build failed while downloading dependencies: Maven
Central returned HTTP 429 before project source compilation. Its published
npm/Pub/SwiftPM/GitHub artifacts remain intact. A new version triggers a new
immutable build, but does not itself remove an upstream download limit.
The 0.4.14 failure log and partial publication status are retained.

## Retained-history follow-up candidate

The default long-lived store exposed a second pagination defect after the
public Runtime upgrade: `ui` and `action` had different retained starting
positions. A fresh mixed query ended its first page before the latter start,
so its new continuation was rejected as expired. This is distinct from the
unrelated-network-retention defect addressed in the published 0.4.15 package.
It affects long cross-page history reads, not the validity of completed device
actions, and does not justify replaying unknown actions.

The separate source candidate scans each selected partition with its own
signed continuation, preserves the initial global sequence boundary, checks
for actual eviction during the scan, and merges retained facts in order.
Related regressions passed 211/211. Independent review covered the original
false positive, a new-facts watermark counterexample, real eviction, cursor
tampering, large-record chunks, unknown outcomes and archive boundaries.

A consistent copy of the actual history reproduced the public 0.4.15 error.
The candidate returned all 14,682 retained `action`/`ui` facts with matching
sequence and payload hashes against the independent projection/CRC oracle;
all 401 original Script recovery views matched. Original-history incompleteness
remains explicit. This is a correctness result, not a speed comparison: a full
successful scan cannot be compared with the old early failure as a speedup.
The newly generated OPPO store also passed a separate consistent-copy check:
720 projection rows, the original four inventory pages and ten recovery views,
plus ten offline-verified archives containing 632 Script facts. The original
unknown action and missing Host receipt remain explicit. No phone operations
were replayed and no shared store was cleared or rewritten. The complete
candidate scope and evidence are recorded in
[retained-history pagination](RETAINED_HISTORY_PAGINATION_2026-10-15.md).

## Remaining gates and limits

- Deliver the validated retained-history source candidate in a subsequent
  immutable release. Public 0.4.15 still contains the additional pagination
  defect described above; the local public installation has not been silently
  replaced with unpublished source.
- Reconnect and verify the actual resident Codex MCP, separately from the
  installed files and the already upgraded default Runtime.

Windows physical display/sleep behavior remains deferred by the user. Earlier
iOS timing/permission usability limits, Android remote-test uncertainty and
deferred optimization experiments retain their original evidence boundaries.
This release does not introduce a new whole-App speed claim.
