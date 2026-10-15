# 0.4.16 coordinated release verification

Status: preparation in progress. The retained-history correction is committed
and verified; no 0.4.16 public publication or local upgrade is claimed yet.

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
Android/iOS/Flutter/Web changes are coordinated version metadata, to be checked
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

These checks precede final packaging. Exact-package checks and public-download
verification are recorded separately below when they complete.

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

## Outstanding release gates

- Validate the exact CLI package, including real retained-history copies.
- Publish immutable tag and verify Maven, npm, Pub, SwiftPM and GitHub downloads.
- Upgrade the four Android consumers and Web example from public packages.
- Verify local CLI/skill, the default Runtime and the actual resident Codex MCP
  independently, retaining existing history across the upgrade.

Publication and installation do not imply a new whole-App speedup.
