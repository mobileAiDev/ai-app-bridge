# Duplicate-label rejection source increment

This separate, immutable source increment preserves the old device crash and the corrected APK's duplicate-create rejection. It does not alter the existing `source-evidence` bundle, Script, runner, or R5–R8 frozen runs. No label regression Script has been added.

The old operation `intent-1788751052004-2` is a retained failure: step 15 dispatched the save tap, step 16 could not observe the crashed app, and the original device log identifies `IllegalStateException` in `addLabel`. The new operation `intent-1788752668874-1`, selected steps 1–13 only, completed its narrow rejection goal on OPPO `FYZLAU49X8OVQGJ7` with APK SHA `b4fe597c6154b5fdd119746226b235e7a207fa221cefde49cdb355053967c233`.

The saved PNG visibly shows “标签已存在”; this text was checked visually, not inferred from a successful tap or OCR. A later fresh Intent observation proves the app still responded. The independent business reader compares the R8 baseline snapshot `efabebce-b713-45c9-a653-7bad28d42ba2` with the subsequent rejection snapshot `31bc8892-b7ad-4f9d-8b8c-77b11905ab35`. Notes, all persisted fields, label rows/order, preferences and attachment metadata are identical with `ignoreFields: []`. Their run IDs differ intentionally. The R8 baseline was produced by Script and is associated with the new Intent only as its precondition evidence.

The index maps this to a **partial** `labels.manage.negative` authoring source. Rename conflict, cancellation and all remaining template requirements are pending. It adds no passed template or coverage slot to the 51-feature / 143-template / 396-slot denominator.

The manifest includes 27 indexed source files and 10 required snapshot dependencies, preserving original bytes and original absolute references. Dependency paths resolve through the portable manifest; replay does not read the original ignored `build` tree. Outer file hashes do not independently validate every historical durable Intent envelope checksum. Source provenance is distinct from current-run acceptance.

From the repository root:

```sh
node examples/notallyx-sample/validation/verify-labels-source.js
node --test examples/notallyx-sample/validation/test/labels-source.test.js
```

The replay uses Python 3's standard-library SQLite reader on temporary database/WAL copies. It performs no device operation. Tests also relocate the bundle and verifier to a temporary directory with no `build` directory, reject a changed WAL, and verify that stale or unregistered snapshot evidence is inconclusive. The code does not automatically verify the visual toast's text.
