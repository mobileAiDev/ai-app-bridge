# 0.4.16 coordinated release verification

Status: public packages, all npm labels, consumer builds, installed CLI/skill
and the default Runtime have passed. Reconnection of the existing Codex MCP
process remains open; its current process still reports client 0.4.13.

Evidence root: repository sibling
`ai-app-bridge-release-evidence/0.4.16-2026-10-15/`.

## Change and source boundary

The functional change is the Host evidence scan in commit `77b15e2`.
Fresh mixed `action`/`ui` pagination could reject its own continuation when
those partitions already had different retained starting positions. The new
scan uses each partition's signed continuation, fixes the initial sequence
watermark, verifies actual retention changes and merges the retained facts.

The global FactStore cursor contract, native binaries and disk format remain
unchanged. Archive bounds, CRC/chunk checks, original operation identity and
unknown outcomes are not relaxed. The fix is documented in
[retained-history pagination](RETAINED_HISTORY_PAGINATION_2026-10-15.md).
Android/iOS/Flutter/Web changes are coordinated version metadata, checked
against their frozen predecessor. The existing explicit Maven mirror route
is retained; no new cold-cache experiment or automatic repository fallback
is introduced.

## Already verified correction

- 211 related regression cases passed; independent review covered real
  retention gaps, signatures, large records, watermark injection, unknown
  effects and archive consistency.
- A consistent snapshot of the real long-lived store retained 14,682
  action/UI facts. Candidate sequence and payload hashes matched an independent
  projection/CRC oracle, and all 401 original Script recovery views matched.
  Public 0.4.15 reproduced the failure on a separate copy of the same snapshot.
- The completed OPPO private store provided 720 projection rows, four inventory
  pages and ten original Script IDs. Durable recovery views and ten archives
  containing 632 Script facts matched; offline verification passed. The
  original unknown action and absent Host receipt were retained.

These source checks precede the exact-package and public-download checks below.

## Preparation checks

- Coordinated metadata: 28 paths, 39 version checks; earlier changelog entries
  and the private FactStore/WDA versions remain intact.
- Maven: 168 frozen inputs, with only five version metadata changes from
  0.4.15. The explicit mirror and existing dependency cache produced the local
  reference in 34.684 seconds: eight modules, 16 main artifacts, 341 classes
  and two plugin markers verified. This is packaging, not remote-publication
  or a new test/Lint claim.
- SDK: 160 frozen inputs, 149 unchanged and 11 version/documentation changes.
  The 31 canonical iOS/Flutter and three WDA mirror checks passed. Both Pub
  exports passed dry-run checks without warnings, with 61/6 files. Current
  unsigned generic iOS consumers compiled through SwiftPM and Flutter
  CocoaPods in 17.951 and 27.540 seconds, including the private platform header.
  Earlier 82-case Swift and 82-case Flutter evidence is reused only after
  matching its implementation sources; these are not fresh device runs.
- Web: syntax/build check passed, and all six archive files and modes match
  the frozen source. Public install verification follows publication.

## Inherited device and platform evidence

The eight public 0.4.15 OPPO functional scenarios passed after reinstallation:
two dynamic Native/H5/Flutter flows, delayed service, lost order response,
Python/UIA, explicit continuation after failures, autonomous Intent, and
original-ID recovery after a private Runtime crash. No cashier device was
used. Five final screenshots have transition-frame limitations. These results
are inherited within the unchanged device/execution source boundary and do
not claim UI login, hotel booking, payment/refund or whole-App acceptance.
See [0.4.15 verification](RELEASE_VERIFICATION_0.4.15_2026-10-15.md).

Existing native Host acceptance follows
[Windows and platform validation](WINDOWS_HOST_VALIDATION_2026-10-15.md).
Physical Windows display/sleep checks remain deferred by the user. Remaining
optimization experiments retain the explicit decisions and limits in the
[optimization ledger](OPTIMIZATION_EXECUTION_2026-10-15.md).

## Exact package, public artifacts and consumers

- Release commit: `3fe4073912285dbcd9ab42abfdf337b89b795282`.
  Annotated tag object: `08b7ef54512ae867e81e0e6dd7eb6809f862ad21`.
  Tag, main and the working branch were atomically pushed and verified.
- The exact CLI archive passed clean installation, native loading without
  compilers/Python on PATH, CLI/MCP, JS/Python, original recovery and shutdown
  gates. Its 249 files match the source and installation; 24 native bundle
  files are unchanged from 0.4.15. The installed package also passed all
  14,682 real retained facts, 401 recoveries, two old-history archives and
  ten OPPO archives. An ordinary CLI process enumerated five pages/401
  operations and exported/verified original Script and Intent evidence.
- Public Maven built in 1 minute 45 seconds without HTTP 429. All 16 main
  downloads returned HTTP 200, with POM coordinates and 341 classes checked
  against the local reference. Both public plugin marker POMs also passed.
- CLI and Web npm uploads succeeded. Both exact public archives match the
  frozen SHA-256, SHA-512 integrity and SHA-1 shasum; both `latest` and `next`
  are 0.4.16 in the final independent public tag read.
  The first reads returned 404 during publication propagation; those attempts
  are retained separately from successful public verification.
- Both Pub packages are public at 0.4.16/latest. Their 61/6 archived files
  match the frozen exports. A standard empty-cache hosted install, lock
  integrity and analysis passed after two retained stale-index attempts.
- Public exact-tag SwiftPM resolution and unsigned generic iOS consumption
  passed in 27.630 and 39.403 seconds. All 160 source files match the tag.
  The first GitHub tag query timed out before consumer creation; no source
  or dependency constraint was changed to make the retry pass.
- GitHub Release is public/latest. Its two package archives and SHA256SUMS
  match the frozen assets. A first SHA256SUMS transfer hit an SSL connection
  error; the subsequent public download passed with the same artifact.
- POS, Reader, Duo and MeasureDevice have seven exact version references
  upgraded from 0.4.15 to 0.4.16. Seven public resolution/build checks passed,
  generating six APKs. Resolved SDK/plugin bytes match public Maven; the
  projects' HEAD, index and unrelated changes were preserved. No APK was
  installed by this consumer-build step.
- `web/remote-smoke` uses the public exact 0.4.16 package. Its lock integrity,
  all six installed files, consumer check and SDK build passed. Only its
  manifest and lockfile changed.

CLI archive SHA-256:
`ee59a5e3cbba25f25529d3e63df4f96aec6f64fb3a93ddb3f200ebbc6be9c7b6`.
Web archive SHA-256:
`6a95a9e831ceda6f7f5d551e7f4930d9ec9aecafb91d698a483c840a56cd4446`.

## Local upgrade and live retained history

The global public npm installation is 0.4.16; all 249 files and two installed
skill files match the public archive. A newly started isolated MCP and CLI
shared one 0.4.16 Runtime; Host diagnosis and JS/Python execution passed.

The default Runtime was switched from 0.4.15 to 0.4.16 after checking zero
active requests, execution sessions and Web sessions. Both remaining active
power leases belonged to this task. The first external cutover guard stopped
before mutation because it did not recognize this task's automatic Host
lease; the exact lease and its originating read-only ADB query were matched
before allowing the second attempt. This was a release harness correction,
not a product or shared-store modification.

The replacement Runtime is `5255f4cc-6f81-45a7-9203-ebfc91d3c655`, PID 36854,
code `8d9cd53ad674206b81e2659849831cc2115ea18b6e5474fd58a8c28cf7ccc824`.
It retains the original default fact-store directory. The public installed
client successfully read all five pages and all 401 original Script IDs from
that live history, then read an original recovery view. No history was
cleared and no operation was replayed.

Host idle protection was reacquired for the release closeout. OPPO was no
longer connected at this point; the ended transport's lease and bounded
expiry are retained, with no claim that a disconnected phone remains covered.

Evidence: `cli-package/CLI_PACKAGE_ACCEPTANCE.json`,
`maven/PUBLIC_PUBLICATION_REPORT.json`, `npm/*-public-integrity.json`,
`npm/final-public-tags.json`,
`sdk/SDK_PUBLICATION_REPORT.json`, `github-public/report.json`,
`consumers-four/closeout.json`, `web-consumer/WEB_CONSUMER_REPORT.json`,
`local/global-install-parity.json`,
`local/public-install/global-mcp-report.json`, and
`local/shared-history/report.json` under the evidence root.

## Outstanding release gates

- Reconnect the actual resident Codex MCP. A real call currently reports
  client 0.4.13 versus Runtime 0.4.16 and `compatible:false`. The separately
  launched new MCP passed, but does not stand in for this resident connection.

One CLI `next` verification expired with an npm callback 404. A fresh
verification and the Web verification subsequently succeeded; both final
public labels were checked. The package/latest were already public and were
not reuploaded during these tag retries.

Publication and installation do not imply a new whole-App speedup.
