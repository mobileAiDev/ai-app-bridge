# NotallyX business migration sample

Upstream: https://github.com/Crustack/NotallyX

Frozen source: `03ff809f058dbcabd5f0d20f114546686dfc9cb5` (2026-08-24), version 7.11.2. Original GPL-3.0 license and source attribution remain in LICENSE.md and UPSTREAM-README.md. This directory is a modified development sample, not an upstream release.

The archived baseline changes only build/integration: isolated application ID `io.github.mobileaidev.notallyx.sample`, debug AI App Bridge SDK dependency, minSdk 23, Gradle 8.13 wrapper (the validated toolchain), reproducible debug configuration without upstream private release signing, translation/export/publishing plugins, or git-hook installation. Its business code, Room schema 11 and UI match the frozen source. Upstream reports data loss in the frozen README; baseline defects must be distinguished from migration regressions.

The current source contains the application data-boundary migration: 18 external DB/DAO consumers now use `NoteApplicationService`, with database lifecycle and storage maintenance coordinated separately. Room schema 11 and the business UI remain. See [migration scope and tests](validation/application-migration.md), [Intent-to-Script workflow](validation/INTENT_TO_SCRIPT.md), [regression instructions](validation/SCRIPT_REGRESSION.md), and [current validation status](validation/测试进度.md). Core-flow results are reported separately from the complete feature inventory.

Development priorities follow the [Bridge development status](../../docs/BRIDGE_DEVELOPMENT_STATUS_2026-09-07.md). This App is a validation sample; historical feature-expansion suggestions in its reports do not define the Bridge roadmap.

Build from this directory with `./gradlew :app:assembleDebug` (JDK 17 or 21, Android SDK 36). Run unit tests with JDK 21 (`./gradlew :app:testDebugUnitTest`): Robolectric SDK 36 requires Java 21. Local Bridge SDK source is resolved from the parent repository. Runtime artifacts belong under the repository build/ai_app_bridge_artifacts/notallyx-migration directory.

For independent UIA acceptance, `./gradlew :app:assembleUia` builds
`io.github.mobileaidev.notallyx.sample.uia` without the debug-only Bridge SDK
dependency. It uses the same current business source and an isolated app data
directory. `desktop/ai-app-bridge-cli/scripts/validation/notally/uia-regression.js`
drives this English-locale build through UIA and wrapped ADB key input, preserving
a screenshot and exported database for verification. The ASCII-input path does
not establish SDK-free Unicode editor support. Keep this result separate from
the SDK/instrumentation migration regressions above.

For long execution, run from the repository root:

```sh
node desktop/ai-app-bridge-cli/scripts/validation/notally/run-long-uia-regression.js SERIAL NEW_EVIDENCE_DIR normal
```

It performs three complete note journeys in one JavaScript Script, exports a
stopped-process database after each, and verifies that all preceding notes
remain unique with the exact edited body, Notes folder and pinned state. Select
`crash` instead of `normal` to terminate the worker after the first committed
checkpoint and resume the same operation for the remaining two notes. Sources,
calls, timing, screenshots and independent SQLite checks are saved in the new
evidence directory. This measures prepared long execution and recovery, not
first-use discovery or every feature of NotallyX.

The UIA build also contains `UiaRecoveryFixtureActivity`, a plain Android page
with no Bridge SDK. Its delayed button fsyncs an entry record, retains the real
accessibility callback for eight seconds, then records its effect. A test worker
armed through wrapped ADB terminates only the verified UIA runtime PID after
callback entry. Boot ID, epoch, process start ticks and command-line hash must
all match. The App's independent journal and visible counter detect duplicate
delivery; its original unsettled UIA record must remain unchanged.

Run this fault test from the repository root with a separate development Host
fact-store directory:

```sh
AI_APP_BRIDGE_FACT_STORE_DIR=/absolute/path/to/development-facts \
node desktop/ai-app-bridge-cli/scripts/validation/notally/run-uia-executor-loss.js \
  SERIAL NEW_EVIDENCE_DIR start business
```

Choose `force-reset` instead of `start` to exercise explicit UIA archival. Use
`fixture` instead of `business` to stop after verifying the old effect and one
new action. The business mode then performs the full existing note journey and
checks its exported SQLite row. Every run uses a unique journal and note title;
it does not clear App data. The runner verifies executable recovery hints,
Host identity, App survival, epoch replacement, retained unknown history and
exactly one application of each requested action. A missing original completion
remains unknown even when the App journal proves its visible effect. Prepared
execution time includes the deliberate eight-second stall and is reported
separately from build, installation and test-authoring time.
