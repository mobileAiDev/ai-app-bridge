# Existing App business regression

This runner composes the existing VLC, Organic Maps and LocalSend Scripts in one
public CLI runtime. It does not install apps, reset private data or replace their
business assertions. Wikipedia remains an explicit unexecuted requirement; this
candidate cannot close the original four-app acceptance gate.

Run from the repository root on an authorized OPPO with the pinned APKs, map and
media fixtures already installed. The device locale is `zh-Hans-CN`. LocalSend
must start on Receive with the original device name, empty selection and baseline
theme/language settings. Its system file manager must be unlocked by the owner.
The current LocalSend no-peer fixture requires both SIM slots to be absent and
Wi-Fi initially connected. The controller changes only Wi-Fi at the two declared
empty-discovery checkpoints, records before/isolated/verified/restored OS state,
and verifies reconnection to the original Wi-Fi network. An active fixture is
also restored in `finally` after a failed or cancelled Script. A phone with an
active SIM needs a separately declared fixture; this runner fails that precondition.

```sh
node examples/device-regression/run-android-suite.js \
  build/ai_app_bridge_artifacts/android-suite-NEW b46093e6
```

Each output directory must be new. To investigate one failed case without
repeating the other apps, explicitly select its ID:

```sh
node examples/device-regression/run-android-suite.js \
  build/ai_app_bridge_artifacts/localsend-focused-NEW b46093e6 localsend
```

After an SDK upgrade, copy the suite manifest to a new file and pin the newly
built APK hash. Pass that file as the fourth argument, after the selected case.
Keep the original Script and oracle hashes and all acceptance gates. The runner
still requires an exact installed APK match and archives the selected manifest.

Focused reports list the other cases as unexecuted. No previous result becomes a
current pass. The suite retains each source and scenario manifest, installed APK
and data hashes, independent result reads, continuous execution events and full
archives. It checks the same runtime process across apps and the execution,
device and app identity of archived calls. After stopping the live runtime it
verifies each archive with unavailable ADB and a separate storage configuration.

`executedCasesPassed` requires every selected case to pass. `completeAcceptance`
remains incomplete while the declared four-app scope is unfulfilled. The original
Script result is preserved as `result` and `scriptVerdict`. Its final-preference
gate is necessarily pending until the controller reads persisted settings after
terminal. `finalAssessment` can resolve only the explicitly implemented external
gates, and requires all UI/mobile assertions, network fixtures, archive integrity
and wall-time limits to pass. Unknown or missing requirements stay unresolved.
Exit code 1 also represents incomplete selected acceptance; inspect `report.json`
for the actual failure, evidence gap or prerequisite.

`liveWallMs` includes preflight, app launches, sequential execution and archive
export. `totalWallMs` also includes runtime shutdown and offline verification.
Device preparation and installation before starting this runner are separate.
Individual or focused results must not be added together as a measured complete
suite time.

Results and remaining requirements are recorded in
[the combined business report](../../docs/DEVICE_BUSINESS_SUITE_2026-09-12.md).
The existing FreeOTP, Kiwix and Flexify iOS scenarios remain in scope. Joplin
integration is paused; this Android runner does not stand in for iOS acceptance.
