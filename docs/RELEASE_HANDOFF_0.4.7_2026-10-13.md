# 0.4.7 publication and upgrade verification

Version **0.4.7 is publicly released** at commit
`e040114b3ac9339d596f9bb4e3b933a465c0d24f`.
The [GitHub release](https://github.com/mobileAiDev/ai-app-bridge/releases/tag/0.4.7)
is published as latest. Its tag remains fixed; the remote Web smoke consumer is
updated in a subsequent commit after the public package becomes available.

| Channel | Published packages | Verification |
| --- | --- | --- |
| npm | CLI and Web SDK, both `latest` and `next` = `0.4.7` | Public archives match the tested candidates byte for byte; 217 CLI and 6 Web files match tagged source. |
| pub.dev | `ai_app_bridge_flutter`, `ai_app_bridge_test` | Public archives contain 57 and 6 files matching tagged source. |
| JitPack | Android SDK, Gradle plugin and six test executors | All 16 POM/binary artifacts are public; 339 compiled classes match the locally verified release and 153 frozen source files match the tag. |
| GitHub / Swift | `AiAppBridgeIOS` at `0.4.7` | 39 public source blobs match the release commit. |

The Android SDK AAR is 703,023 bytes, SHA-256
`3459c3662e7176e099d861d96fcc059f542a60f1e2216192dc1c9ea042f21737`.
Its Flutter reflection keep rules and bytecode signatures were checked in the
public AAR. This is packaging verification; a minified application's runtime was
not tested. JitPack's status API supplies the exact commit; its build log could not
print Git metadata because of a container ownership warning, so source attribution
also uses the actual source and compiled-class comparisons.

The local global CLI was installed from public npm. All 217 installed files match
the public archive, and the local `ai-app-bridge-use` skill matches its two shipped
files. Codex, Cursor and Antigravity configurations resolve to that installation.
After Codex restarted, this chat's MCP reported a running `0.4.7` Host with
`compatible: true`. Actual JavaScript and Python programs completed, including
eight runtime commands from JavaScript and a Script question answered through
`decide` with `waitMs`. Both previously active fact-store configurations were
restored to a compatible Host; the previously stopped configuration stayed stopped.
Other applications' already-running MCP clients have not been independently
reconnected or verified by this check.

Recent consumers were upgraded across four repositories and six Android build
targets. All six resolved the same public SDK AAR and built successfully; the
Gradle plugin consumer also resolved the public plugin JAR. Seven version files
contain only the intended version-token changes, with other existing changes
preserved. Two initial evidence-collection failures and their successful retries
remain in the report. These consumer checks establish dependency resolution and
build success, without claiming installation or business-flow acceptance.

The final source passed 1,645 Host functional tests and 50 performance checks.
The packaged Web SDK passed 38 tests, Flutter passed analysis and 80 SDK tests,
and the Android SDK passed 214 tests in each of Debug and Release. UIA and plugin
checks reused unchanged Gradle results. Swift passed an unsigned generic iOS
build; **iOS runtime acceptance remains unperformed**.

The final mixed Android APK was then installed with existing data preserved on
the same API 36 emulator. The installed APK hash matched the validated final APK;
the public Host and App SDK both reported `0.4.7`. A single Script completed 11
commands in 4.819 seconds, including installation and hash checks. From the one
App launch, the SDK status became readable after 2.449 seconds and an operable Flutter tree took
3.468 seconds. Restoring the emulator itself took a separate 19.525 seconds.
An initial status read reached a retained old endpoint; bounded read-only waiting
observed the new endpoint without repeating launch or clearing data. The isolated
test Host was stopped normally. This verifies installation and the setup page's
observability, without extending the result to a complete complex workflow.

The [release scope and measured limits](RELEASE_NOTES_0.4.7_2026-10-13.md) remain
part of this handoff. Fresh-context Web discovery still took 394.947 seconds to UI
completion and 439.180 seconds through its independent database check. Unlocked
Android tests retained 21.178-second readiness and 26.292-second first-frame
outliers. Inner-command timings and prepared workflows do not establish that an
unfamiliar complex application can be tested within one minute. **That broader
performance goal remains open.**

Evidence is retained under `ai-app-bridge-release-evidence/0.4.7-2026-10-13/`:
`publication/public-version-matrix-final.json` links the public artifacts;
`local/connected-mcp-after-restart.json` records the current chat's actual replies;
`local/runtimes-after-codex-restart.json` records the preserved runtime settings;
and `consumers/final-report.json` links the build logs, APK hashes and preserved
working-tree changes. `final-installed-emulator-smoke/report.json` records the
final installation and setup-page observation. Pre-publication reports retain
their original timestamps and publication state; the publication matrix is the
later consolidated result.
