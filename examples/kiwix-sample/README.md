# Kiwix iOS Bridge sample

This sample uses upstream commit `c78d229dac2b836eaeeb7137c0852f54b10b2a7b`,
identified by `source.json` (3.6.0 development, before the libkiwix 14 update).
The upstream archive and license remain intact under ignored `upstream/`.
This revision uses native SwiftUI APIs and CoreKiwix 13.1.0-4. It avoids the
Swift 6.4 compiler crash in 3.4.0's Backports dependency and has no Apple Pay,
push, multicast or App Group entitlement. Reading features remain unchanged.

The acceptance target is Bridge's native and WKWebView Intent/Script support:

- Native library selection, search, tabs, bookmarks and settings.
- WKWebView article text, links, scrolling and navigation.
- Explicit native → H5 → native transitions and correct WebView targeting.
- Script replay based on fresh Intent evidence, with independent bookmark and
  reading-state checks against the App's actual persisted data.
- Wrong expectations and cancellation must not be reported as business success.

Use synthetic or open-licensed ZIM content as a fixed fixture. Do not change
Kiwix business logic to produce test outcomes. Building and installing the App
do not establish business acceptance. This sample does not cover Flutter or
replace the remaining dedicated native App and LocalSend transfer requirements.

Current state: the pinned source is integrated, built for arm64, signed with a
Personal Team and installed as `io.github.mobileaidev.kiwix.sample`. The real
offline Wikipedia fixture is pinned in `fixture.json` and copied to Documents
for Kiwix's upstream directory scan; file copying does not validate the import UI.
On 2026-09-11 XCTest authorization succeeded and a native Intent opened the archive.
A fresh H5 Intent navigated through the actual Climate change and Greenhouse gas
articles. `scripts/hybrid-reading.js` then completed 13 assertions, real scrolling,
H5 links and native back/forward with three screenshots in 17.237 seconds from
public start to terminal. `scripts/h5-wrong-article.js` rejected the wrong title.
Both Script archives passed public verification. The reading Script requires the
fixed Greenhouse gas page and an explicit WDA session; it does not include setup.
The same day's native bookmark Intents verified search, saving, cancellation and
reading a saved bookmark after process restart. `scripts/bookmark-regression.js`
then completed 18 assertions in 81.856 seconds: remove the existing bookmark,
search and save it again, navigate through H5, dismiss the second article's
bookmark sheet, restart the App and reopen the saved article. Four screenshots
and the archive were verified. A first failed Script is retained: WDA exposed
both the background article title and the search result title as visible. The
corrected Script binds the current result Button containing the exact title.

The bookmark Script requires the Climate change article's bookmark sheet open
with that single bookmark saved, plus an explicit WDA session. Use the existing
public controller `examples/freeotp-sample/validation/run-native.js` with a new
output directory, explicit `language` (`javascript` or `python`) and iOS target.
`scripts/bookmark-regression.py` implements the same frozen workflow through
the Python SDK's `ctx.call` and `ctx.assert_` interfaces. It performs a continuous run and
does not automatically retry failed actions. Installation, fixture preparation,
Intent exploration and external database copying are outside its timing.

For independent persistence verification, wait for a terminal Script, close
its exact WDA session, identify and stop the actual Kiwix process with devicectl,
verify the process is absent, and copy `Library/Application Support` from this
App's data container. Keep the SQLite, WAL and SHM evidence files together.
Run `validation/read-bookmarks.py --snapshot SNAPSHOT_DIR --output NEW_DIR
--expected examples/kiwix-sample/validation/expected-bookmarks.json`. The verifier
opens a separate read copy, queries the actual Core Data bookmark records and
archive relationship, checks exact contents, and verifies the originals remain
unchanged. Do not use SQLite's immutable mode: the saved records are in WAL.
Both the Intent and Script snapshots contained exactly Climate change; falsely
expecting the cancelled Greenhouse gas record failed independently.

The equivalent Python Script completed on the same iPhone on 2026-09-11:
79.210 seconds from public start to terminal, 18 passing assertions and four
verified screenshots. The independent database snapshot contains a new Climate
change record created during that run and no cancelled Greenhouse gas bookmark.
`scripts/expect-article.py` supplies the read-only negative run: set explicit
`expectedTitle` and `expectedURL` inputs to the wrong article and require
`expectedStatus: "failed"` plus
`expectedFailedAssertion: "expected local article title and URL"` in the
controller config. The actual wrong expectation failed and its archive verified.
The full result and the one-observation call-count difference from JavaScript are
recorded in `bookmark-python-20260911-01/business-audit-final.json` under the same
Kiwix artifact root. Timing covers this fixed workflow only.

The official freeCodeCamp Vue/CodeMirror archive is pinned separately in
`fixture-freecodecamp.json`. A native/H5 Intent and `scripts/h5-editor-bookmark.js`
verified empty and multiline Unicode editing across actual editor recreation,
native keyboard control, course bookmarking and reopening its exact SPA route
after App restart. The final continuous Script took 89.306 seconds with 26
passing assertions and three screenshots; external Core Data contains the new
course bookmark while the original Climate change record is unchanged.
The script requires the course's Code tab behind its saved bookmark sheet, both
bookmarks present, an explicit WDA session and the observed `keyboardHideLabel`.
Use `validation/expected-editor-bookmarks.json` for its independent DB check.
Both preceding Script failures remain archived: a wrong empty-placeholder
expectation and a pre-dispatch WDA target-change rejection. The later pass does
not establish the root cause of that transient target change.

`scripts/h5-tab-isolation.js` extends this to two real cached WKWebViews opening
the same course. Their URL, element ID and initial text match; the old page binding
is rejected before dispatch. Editing the second tab and closing it restores the
unchanged original editor. Hidden and closed WebViews cannot redirect to the active
tab. The first continuous run passed in 80.409 seconds: 28 assertions, two
screenshots and all three predeclared rejection cases. Begin on the saved course's
Instructions tab with the native toolbar visible and pass an explicit WDA session
and the observed `keyboardHideLabel` to the existing public run controller.
`validation/read-tab-isolation.py` compares external quiescent baseline/post-run
Application Support snapshots; supply `--active-tab` from the frozen baseline.
Seven checks passed, including one newly allocated and closed tab, both original
tabs preserved, and unchanged bookmarks and unvisited tab state. No App restart or
durable editor-code claim is part of this Script.

The original archive's Run button remains outside the actual WKWebView viewport.
On 2026-09-12 the user authorized a small layout repair to enable the business
test: `fixtures/freecodecamp-viewport.js` changes only the fixed reader height
to the document client height and is reapplied after reload. Grading and lesson
logic remain original. The preparation receipt must match the active document;
it is separate from Script execution and timing.

`scripts/h5-course-submission.js`, authored from fresh Intent evidence, then ran
wrong and correct submissions in 20.999 seconds: 6 device assertions, 14 external
grading checks, 3 screenshots and offline archive verification passed. The
external controller reads the actual App grader, including logs, both test flags
and `cheatMode:false`; it does not invoke grading or overwrite its outcome.
Run `node examples/kiwix-sample/validation/run-course.js CONFIG.json` with a new
outputDir, explicit target/WDA session, runtime env and fixtureReceiptPath.
The sample config and complete evidence are under
`build/ai_app_bridge_artifacts/ios-kiwix-run-20260912-01/course-config.json`.
See [actual submission results](../../docs/IOS_H5_SUBMISSION_2026-09-12.md).

Durable learning progress, simultaneously visible WebViews and full-App coverage
remain pending. Provider switching and explicit cached-WebView selection within
one Intent have separate real-device evidence. See [H5 editor results](../../docs/IOS_H5_EDITOR_BUSINESS_2026-09-11.md),
[current hybrid results](../../docs/IOS_HYBRID_BUSINESS_2026-09-11.md)
and [earlier native results](../../docs/IOS_NATIVE_BUSINESS_2026-09-10.md).

## 0.3.5 device revalidation (2026-09-14)

The sample was rebuilt, officially installed, and its live SDK verified as 0.3.5 on the iPhone 17 Pro Max. A fresh native/H5 Intent established the editor and bookmark baseline. The editor/bookmark Script completed 27 assertions in 99.615 seconds, including a new process, explicit bookmark-sheet navigation, and reopening the exact saved lesson. The earlier attempt remains failed: it assumed bookmarks would be visible automatically after restart, while the App restored the reader. The Script now explicitly opens Show Bookmarks; the saved-bookmark assertions are retained. External quiescent Core Data verification is recorded alongside the run under build/ai_app_bridge_artifacts/uia-035/. This covers editor state and bookmark persistence, not durable lesson progress or exercise grading.
