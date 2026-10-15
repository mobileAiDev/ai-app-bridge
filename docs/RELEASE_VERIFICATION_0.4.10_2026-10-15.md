# 0.4.10 release verification

Status: source and release artifacts are being finalized. Publication is not
confirmed by this preparation record. The immutable release commit, public
archive hashes and consumer checks will be recorded below after verification.

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
- Public Git/npm/Pub/Maven/Swift checks: pending publication.
- Local CLI/MCP, skill and four consumer upgrades: pending public artifacts.

Final review found and fixed two retained-evidence bugs: repeated recovery
could advance the default read boundary before a new program checkpoint;
inventory could omit an ambiguous receipt after its dispatch marker expired.
Focused regressions now reproduce and cover both. Effects are never replayed
to repair either view.
