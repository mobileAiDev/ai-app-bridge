# NotallyX business migration sample

Upstream: https://github.com/Crustack/NotallyX

Frozen source: `03ff809f058dbcabd5f0d20f114546686dfc9cb5` (2026-08-24), version 7.11.2. Original GPL-3.0 license and source attribution remain in LICENSE.md and UPSTREAM-README.md. This directory is a modified development sample, not an upstream release.

The archived baseline changes only build/integration: isolated application ID `io.github.mobileaidev.notallyx.sample`, debug AI App Bridge SDK dependency, minSdk 23, Gradle 8.13 wrapper (the validated toolchain), reproducible debug configuration without upstream private release signing, translation/export/publishing plugins, or git-hook installation. Its business code, Room schema 11 and UI match the frozen source. Upstream reports data loss in the frozen README; baseline defects must be distinguished from migration regressions.

The current source contains the application data-boundary migration: 18 external DB/DAO consumers now use `NoteApplicationService`, with database lifecycle and storage maintenance coordinated separately. Room schema 11 and the business UI remain. See [migration scope and tests](validation/application-migration.md), [Intent-to-Script workflow](validation/INTENT_TO_SCRIPT.md), [regression instructions](validation/SCRIPT_REGRESSION.md), and [current validation status](validation/测试进度.md). Core-flow results are reported separately from the complete feature inventory.

Development priorities follow the [Bridge development status](../../docs/BRIDGE_DEVELOPMENT_STATUS_2026-09-07.md). This App is a validation sample; historical feature-expansion suggestions in its reports do not define the Bridge roadmap.

Build from this directory with `./gradlew :app:assembleDebug` (JDK 17 or 21, Android SDK 36). Run unit tests with JDK 21 (`./gradlew :app:testDebugUnitTest`): Robolectric SDK 36 requires Java 21. Local Bridge SDK source is resolved from the parent repository. Runtime artifacts belong under the repository build/ai_app_bridge_artifacts/notallyx-migration directory.
