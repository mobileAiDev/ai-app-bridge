# Wikipedia Android Bridge sample

This sample uses the [official Wikipedia Android source](https://github.com/wikimedia/apps-android-wikipedia)
at release `r/50605-r-2026-09-08`, commit
`2fa2f9536e0d0120ef82638d9ea8086be821f3a3`. `source.json` records the
version and toolchain. Upstream source and generated artifacts are ignored;
the original Apache-2.0 license remains in `upstream/COPYING`.

The goal is real native search, article WebView interaction and persistent
reading-list operations through Intent, followed by evidence-authored Scripts
and independent database verification. Existing P9 core/acceptance coverage
still applies; a successful build or one article does not pass that matrix.
No account, public edits or replacement article service is part of this sample.

From the Bridge repository root:

```sh
git clone --depth 1 --single-branch --branch r/50605-r-2026-09-08 https://github.com/wikimedia/apps-android-wikipedia.git examples/wikipedia-sample/upstream
./gradlew :ai-app-bridge-android:assembleDebug
python3 examples/wikipedia-sample/integrate.py
cd examples/wikipedia-sample/upstream
./gradlew :app:assembleDevDebug
```

Configure the local Android SDK with `upstream/local.properties` or the normal
Android SDK environment variable before building. The integration requires a
clean checkout at the exact commit; it does not reset existing work. It adds the
current local runtime AAR, the current debug instrumentation plugin and a debug
package suffix. The upstream public dev Google Services configuration is copied
to the devDebug variant with the matching package ID. Business code is unchanged.
`build/integration.json` records every modified input and the runtime AAR hash.

The isolated package is `org.wikipedia.dev.bridge_sample`; the previously
installed `org.wikipedia.dev` is a different app. Install through the current
public `install-apk` Intent and bind each operation to the authorized serial and
this exact package. Freeze the installed APK, initial state and accessible
article before writing a Script. An unreachable real article or missing target
must remain a failed/inconclusive gate. Network requests and database contents
need independent evidence in addition to screenshots and action receipts.

For a newly built SDK revision, copy the business manifest to a new file, pin
the actual APK SHA-256 and choose unused synthetic collection names. Pass that
manifest as the optional third argument to `validation/run-business-script.js`,
after the new output directory and authorized serial. The original Script and
oracle source hashes and all business checks remain required; the runner saves
the selected manifest with its evidence.

## Current business evidence: 2026-09-12

The real official search/article network now works on the authorized OPPO. Intent
opened the observed Moon search result, read the actual article H5, selected a
native table-of-contents section, cancelled creation of a test collection, created
a named test collection and reopened it. Independent copies of the original
SQLite tables verify the cancelled name is absent and the new collection contains
Moon. The sample business source was not changed.

The duplicate search labels exposed a Bridge capability gap. Observed UIA nodes
now expose a bound `targetRef`, accepted by public `tap-uia`; Intent can select the
current observed `nodeRef`. The real precise click passed and an old reference
was rejected before dispatch. Ordinary duplicate text remains an explicit error.
The completed business Intent has 109 retained Host records and an offline-verified
archive; screenshots, network reads and database copies are separate companion
files, not payloads inside that export.

**Fixed business Script runs 01–06 remain failed; run 07 has started and its final
result is pending.** Run 05 passed 16 assertions and three independent stages,
then stopped before collection creation on an explicitly undispatched UIA
re-observation rejection. Run 06 stopped when a read-only tree had no current
Activity during a page transition. Both archives are offline verified.
The SDK now fixes background Activity recreation taking foreground ownership and
late-start focus discovery; 12 targeted checks and two public install/hash checks
passed on the original sample. The complete real theme flow remains unverified.
Run 07 uses stable UIA observations, at most three fresh observations only after
an original undispatched receipt, and bounded read-only transition waits.
Full P9 acceptance remains open. Details, exact artifacts, failed attempts and
remaining scope are in [the business report](../../docs/ANDROID_WIKIPEDIA_BUSINESS_2026-09-12.md).
The P9 continuation also verified test-collection cleanup, no-result search,
repeat article reading, effective theme restoration and Wikipedia preferred-language
order restoration. Its three failed Intent attempts remain failed; the final
settings Intent completed with 106 records and an offline-verified archive.
`wikipedia-p9-intent-20260912-01/phase-status.json` freezes the earlier Intent-stage
results and its then-current `scriptStatus: awaiting_real_run`; it is not the
latest Script status. `evidence-manifest.json` hashes the explicitly
cited companion files separately from the Host exports. This is not a single
combined successful Intent, a system-locale change or byte-identical settings XML.
The execution order is maintained in [the current gates](../../docs/BRIDGE_NEXT_GATES_2026-09-08.md#2026-09-12-样本收敛与当前顺序).
Keep the mainline: real App Intent/evidence → fixed Script → independent business
verification → the original four-App run in one Host. Fix only product gaps that
block that path or small sample prerequisites; do not add Apps or repeat unchanged
passing matrices to stand in for completing it.
The dated sections below preserve historical results; their old network state and
next-App directions are not the current plan.

The read-only database tool consumes an archive copied while the App was verified
quiescent; it does not stop the App or assert the intended business outcome:

```sh
python3 examples/wikipedia-sample/validation/read-reading-lists.py \
  --archive /absolute/path/to/databases.tar \
  --output /absolute/path/to/new-reading-list-read
```

The caller must record device/package identity, stop and verify each App process,
copy the SQLite files coherently, and resume the App in `finally`. The reader
checks SQLite integrity and archive identity, and writes the actual original
`ReadingList`/`ReadingListPage` rows for independent comparison.

## Historical preparation and network failure

On 2026-09-11/12 the pinned sample built successfully with Gradle 9.7.1 and the
current Bridge runtime and instrumentation plugin. The public installation
Intent completed on the authorized OPPO `b46093e6`, and an independent phone APK
hash matched the build: `cff5ae7b1ba371e1abd753fb7e04f1c014862f4f61f7ba24d55c91b2675a450e`
(112,153,008 bytes, versionCode 50605). Evidence is under
`build/ai_app_bridge_artifacts/wikipedia-business-20260911-01/`.

Intent operated the actual Compose onboarding through explicit UIAutomator
observations, switched to Native for the bottom search tab and real editable
search field, and entered the synthetic query `月球`. The runtime captured the
corresponding real official API URL and connection errors. The UI independently
displayed the connection failure. At that stage article and reading-list acceptance was
inconclusive; that preparation run did not demonstrate successful search or a
Wikipedia Script replay.

The first launch returned `launcher_ambiguous` with the real Wikipedia launcher
and LeakCanary launcher as candidates. An explicit call selected the observed
Wikipedia `org.wikipedia.DefaultIcon` component. One onboarding action was
rejected as `uia_reobserve_required`, with `dispatched=false`; the failed Intent
was retained and a new observed Intent continued. Compose-only onboarding has
no semantic nodes in the Native View snapshot, while UIAutomator exposes it.

At this preparation stage, Android H5 was a confirmed Bridge gap: `intent observe` with provider
`h5` returned `unsupported_android_intent_provider` before attempting page access.
It still required observed page/element binding, the public Intent adapter and
matching Script operations. The network capture entries do not carry the
original search action ID; their query and timing corroborate the search, but do
not prove automatic asynchronous action attribution. Both limitations were open
at that stage; later H5 implementation and current article evidence are recorded
above. `phase-status.json` preserves the exact boundary, and three Intent archives
cover installation, the stale-target failure and the network/H5 limitation.

## 2026-09-12 Android H5 接线更新

同一上游提交已接入最终新版 AAR 并经安装 Intent 更新，设备 APK 哈希与构建一致。Android H5 Intent 能力已实现并通过受控真实 WebView 的跨入口与 Script 验证；本 App 的文章 summary/mobile-html 请求仍超时，文章业务未通过。真实工具栏引导暴露非聚焦 popup 适配缺口，下一步处理该浮层。实际 article Intent 为 timeout，留在 `build/ai_app_bridge_artifacts/wikipedia-h5-20260912-01/`，没有把网络失败当成成功。详见 [完整本轮结果](../../docs/ANDROID_H5_INTENT_SCRIPT_2026-09-12.md)。

## 2026-09-12 真实弹窗与工具栏完成

Bridge 已修复非聚焦浮层的指针归属及屏幕/窗口触摸坐标。真实 Intent 完成“知道了”引导、工具栏拖拽换序、退出重开和恢复默认；独立 SharedPreferences XML 检查每个结果。业务源码保持不变。

由这些证据编写的固定 Script 连续三次通过，用时 23.007、22.690、22.823 秒，每轮 6 个业务断言、9 个 Native 回执和 3 张截图。Script 和两类失败过程均保留并离线核验。文章与阅读列表仍未验收。详见 [本轮范围和证据](../../docs/ANDROID_NATIVE_POPUP_BUSINESS_2026-09-12.md)。

在已安装本轮 APK、完成 onboarding、工具栏已处于默认顺序的隔离测试包上复跑：

```sh
node examples/wikipedia-sample/validation/run-toolbar-script.js \
  build/ai_app_bridge_artifacts/wikipedia-toolbar-new-run b46093e6
```

输出目录必须为新目录。控制器显式停止测试包并只恢复一次性引导标记，不写入排序结果；所有业务变更由 Script 经 Bridge 执行。它对同一源码和输入运行三次，独立读取磁盘，归档、离线核验并停止自己的 Runtime。该工具栏固定矩阵已经完成；当前继续原 Wikipedia P9 的文章与阅读列表等范围，不因这份历史说明重跑 VLC 或工具栏。
