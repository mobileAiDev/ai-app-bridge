# Label mutation contract correction

The migrated service rejected duplicate additions and conflicting renames with `check`, which throws `IllegalStateException`. The existing ViewModel helper catches only `SQLiteConstraintException`. As a result, these expected business conflicts escaped the coroutine, and the UI completion callback never arrived.

The service now throws `SQLiteConstraintException` explicitly for these two conflicts, inside the existing Room transaction. The ViewModel retains its narrow catch and calls the existing `label_exists` UI path through `callback(false)`. No generic exception handler was added. The inherited helper maps every SQLiteConstraintException to false, so a non-duplicate SQL constraint also follows that existing error path; this patch does not introduce that broader SQL classification. Duplicate conflicts and SQL failures preserve the Label table, its ordering, all note references across NOTES/ARCHIVED/DELETED, and `labelsHidden`/`startView`. SQL failures after reference updates still roll back the whole transaction before preferences change. The Room transaction and subsequent preference commits do not form one crash-atomic transaction across database and preferences.

Successful rename updates all note references and then the corresponding preferences; delete removes the label association from the unique label arrays produced by the UI and resets a matching start view. Renaming a label to itself remains successful and does not move it. Labels keep SQLite’s existing exact name comparison.

Imported data with repeated copies of a label inside one note is a separate uncovered edge: the current Kotlin `labels - value` removes only its first occurrence. The independent regression oracle requires all references to a deleted label to disappear and deliberately fails that partial-deletion case. This patch does not correct imported duplicate references, and the current device result does not claim to cover them.

There is one deliberate correction to upstream behavior: at upstream `03ff809f058dbcabd5f0d20f114546686dfc9cb5`, duplicate insertion used `INSERT IGNORE`, so the ViewModel reported success for a no-op. Duplicate create now returns false and uses the already-present “label exists” message. This is an explicit business behavior correction, not a claim of byte-for-byte behavioral parity with that upstream edge case.

`BaseNoteModel` gained an internal constructor accepting the service so tests can execute the actual ViewModel methods against a real Room database. Its public Application constructor, used by the app, still obtains the production singleton service. Tests replace only external notification effects; the service, transaction gate, Room DAO, SQLite tables, ViewModel coroutine and callback are real.

The RED run executed five `LabelMutationContractTest` cases. Duplicate add and conflicting rename failed because no callback arrived; the test XML also records the escaping `IllegalStateException` from both coroutines. Successful rename/delete across all folders, same-name rename, and a real SQL abort-trigger rollback already passed. RED evidence is retained in `.tools/business-app-migration-2026-09-07/label-contract-red.log` and `label-contract-red-results/`.

Reproduce the targeted application tests and debug build from the repository root using JDK 21 and the Android SDK:

```sh
JAVA_HOME='/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home' \
ANDROID_HOME='/Users/macbook/Library/Android/sdk' \
examples/notallyx-sample/gradlew -p examples/notallyx-sample \
  :app:testDebugUnitTest --tests 'com.philkes.notallyx.application.*' \
  :app:assembleDebug --no-daemon
```

The corrected APK is archived separately under `build/ai_app_bridge_artifacts/notallyx-migration/candidate-v2/`; its manifest records the exact APK and changed source hashes. The earlier APKs and regression freezes remain unchanged. This document’s unit/build evidence does not replace a separate real-device verification of duplicate/conflict dialogs.

The corrected build passed 21/21 targeted application tests and the separate complete App suite passed 199/199 (zero skipped/errors/failures) with JDK 21.0.6. The complete suite log is `label-contract-full-app-tests.log`; XML and hashes are preserved under `candidate-v2/full-app-test-results/` and `full-app-test-manifest.json`. This invocation did not run SDK tests. APK SHA-256: `b4fe597c6154b5fdd119746226b235e7a207fa221cefde49cdb355053967c233`.

Subsequent real-device Intent traces on OPPO `FYZLAU49X8OVQGJ7` verified duplicate rejection, conflicting rename, successful rename, cancellation, deletion and restart against independent database snapshots. R9 then executed the frozen Script version of these flows with fresh evidence: 14 combined text/list/label phases, 59 UI checkpoints and 15 snapshots in 187.172 seconds. Its seven core templates passed, while the full 143-template App scope remains incomplete. See [SCRIPT_REGRESSION.md](SCRIPT_REGRESSION.md) and [LABELS_SUITE_PLAN.md](LABELS_SUITE_PLAN.md) for the actual scope and preserved failed histories.
