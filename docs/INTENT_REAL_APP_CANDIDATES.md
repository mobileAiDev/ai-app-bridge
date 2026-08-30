# Intent 系统真实 App held-out 验证候选

更新时间：2026-08-30

## 结论

第一轮不要再扩充自建 fixture 来代替真实 App。保留现有受控 fixture 做确定性回归，同时增加两套彼此独立、固定上游提交的 held-out App：

1. **Native 首选：Wikipedia Android**，固定到 `0777721523cb5ad76c1a01d560f4a5b185e1da15`。
2. **Hybrid/H5 首选：Moodle App 5.2.1**，固定到 tag `v5.2.1`、commit `66f26caf4b3a29727f10db5b76e493b6b4ccee90`。

这两项互补：Wikipedia 在不准备私有账号和后端的情况下就能覆盖真实搜索、动态列表、文章 WebView、预览弹层、阅读列表和复杂返回栈；Moodle 则提供真实登录、Angular/Ionic Shadow DOM、Cordova WebView、保留在 DOM 中的历史页面、课程列表、模态框和异步网络。Moodle 上游文档甚至明确警告：Ionic 会把已返回的页面继续留在 DOM，且大量依赖 Shadow DOM，普通“找第一个匹配元素”的自动化会误点不可见旧页面；这正是 Intent Implementation 必须面对的现实噪声，而不是人为构造的测试条件。[Moodle acceptance testing](https://moodledev.io/general/app/development/testing/acceptance-testing)

Nextcloud Android 和 Immich Flutter 保留为第二阶段备选。它们很有价值，但当前机器分别缺少一组 Android native toolchain 和官方 Flutter/server toolchain，不应挡住第一轮真实 App 实验。

> 本文完成的是候选选择、固定版本和接入/验证设计；不能把它表述为“两个上游 App 已构建和实机验证”。构建、安装、接 Bridge 和 Intent 跑分必须另行留下命令输出与设备证据。

## 选择标准

候选必须同时满足：

- 官方维护、源码和许可证可核验，并能固定到不可变 commit；
- 不是 demo UI，至少包含真实导航、动态列表、弹窗或底部弹层、异步网络与错误状态；
- 两个首选合起来必须覆盖 View/Compose、WebView/H5、Shadow DOM、输入法、滚动列表、页面返回栈和网络等待；
- 至少一套在不使用私有账号或私有后端时仍可跑有价值的端到端 Intent；
- 允许以 debug-only 方式接入 AI App Bridge，不把 Bridge 带入发行构建；
- 可在当前 macOS + Android 真机环境复现，而不是只能依赖上游 CI。

## 候选矩阵

| 候选 | 固定版本 | 真实复杂度 | 外部依赖 | 当前机器启动成本 | 结论 |
|---|---|---|---|---|---|
| Wikipedia Android | [`0777721`](https://github.com/wikimedia/apps-android-wikipedia/commit/0777721523cb5ad76c1a01d560f4a5b185e1da15) | Kotlin/Java，View + Compose + WebView，搜索列表、阅读列表、弹层、登录与公共 API | 搜索/阅读无需账号；登录成功需专用测试账号 | 只缺 Android SDK Platform 37 | **Native 首选** |
| Moodle App | [`v5.2.1` / `66f26ca`](https://github.com/moodlehq/moodleapp/tree/66f26caf4b3a29727f10db5b76e493b6b4ccee90) | Angular + Ionic + Cordova，Shadow DOM、历史页面残留、模态框、H5P、原生插件、真实登录 | 上游自带公开 demo 站和演示账号 | 需切换到 Node 22；JDK/SDK/设备已满足 | **Hybrid/H5 首选** |
| Nextcloud Android | [`stable-34.1.1` / `aa93b10`](https://github.com/nextcloud/android/tree/aa93b10326f493a09c10207a674aa7bc79876ebf) | 大型 native 文件客户端，View + Compose、Web 登录、权限、同步、证书/OTP/确认弹窗 | 完整成功路径最好配本地 Nextcloud server | 缺 JDK 21、SDK 37、NDK 29、CMake 4.1.2、Docker | 第二阶段 native/Web auth 压力项 |
| Immich Flutter | [`v3.1.0` / `8aa95c6`](https://github.com/immich-app/immich/tree/8aa95c67470a02a8ddedf03c2e52963af33065ff) | 大型 Flutter 相册，登录、照片网格、选择/弹窗、后台同步、WebSocket、原生插件 | 需要匹配版本的 Immich server | 上游要求 Flutter 3.44.8；本机是 3.35.8 OHOS fork，且无 Docker | 第二阶段 Flutter 压力项 |

GitHub API 在调研时返回的仓库 `size`（近似 KiB，并不等同于 shallow clone 后占用）分别约为 Wikipedia 423 MiB、Moodle 127 MiB、Nextcloud 601 MiB、Immich 314 MiB；都不适合直接复制进本仓库。维护上应保存“上游 URL + commit + 可重放 patch”，运行时按需 shallow fetch。[Wikipedia repo metadata](https://api.github.com/repos/wikimedia/apps-android-wikipedia) · [Moodle repo metadata](https://api.github.com/repos/moodlehq/moodleapp) · [Nextcloud repo metadata](https://api.github.com/repos/nextcloud/android) · [Immich repo metadata](https://api.github.com/repos/immich-app/immich)

## 首选一：Wikipedia Android（Native）

### 为什么适合第一轮

这是 Wikimedia 官方 Android App，Apache-2.0 许可证。[repository](https://github.com/wikimedia/apps-android-wikipedia) · [COPYING at pinned commit](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/COPYING)

它不是只包含几个按钮的测试壳：官方发布回归清单本身就要求覆盖 search、saved pages、reading lists、talk page、watchlist、history、主题和升级；官方开发文档还明确说 App 大量使用 WebView，并提供 Chrome WebView 调试方式。[release process](https://www.mediawiki.org/wiki/Wikimedia_Apps/Team/Android/Release_process) · [app hacking / WebView debugging](https://www.mediawiki.org/wiki/Wikimedia_Apps/Team/Android/App_hacking)

固定提交的源码同时包含：

- 真实登录 Activity 与网络错误分支：[LoginActivity.kt](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/src/main/java/org/wikipedia/login/LoginActivity.kt)；
- 文章/浏览 WebView 及自定义 WebView 客户端：[SingleWebViewActivity.kt](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/src/main/java/org/wikipedia/activity/SingleWebViewActivity.kt)、[ObservableWebView.kt](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/src/main/java/org/wikipedia/views/ObservableWebView.kt)；
- 大量业务弹层与阅读列表交互，例如 [SaveArticleSheetDialog.kt](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/src/main/java/org/wikipedia/readinglist/SaveArticleSheetDialog.kt) 和 [LinkPreviewDialog.kt](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/src/main/java/org/wikipedia/page/linkpreview/LinkPreviewDialog.kt)；
- View 和 Compose 混用；固定提交的 [app/build.gradle](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/build.gradle) 同时启用了 `viewBinding` 与 `compose`。

因此它还会主动暴露当前 Bridge 的能力缺口：仅递归 Android `ViewGroup` 可能只能看到 `ComposeView` 外壳，文章 WebView 内部又不是普通 native View 节点。真实验证应把这种情况记为能力缺口，不能用截图猜测后返回成功。

### 构建与真机条件

固定提交要求 compile/target SDK 37、min SDK 23、Java/JVM 17，Gradle wrapper 9.7.1；官方命令是 `assembleDevDebug` 和 `installDevDebug`。[app/build.gradle](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/app/build.gradle) · [gradle-wrapper.properties](https://github.com/wikimedia/apps-android-wikipedia/blob/0777721523cb5ad76c1a01d560f4a5b185e1da15/gradle/wrapper/gradle-wrapper.properties) · [official build commands](https://www.mediawiki.org/wiki/Wikimedia_Apps/Team/Android/App_hacking#Useful_Gradle_commands)

调研时机器已有 JDK 17、Build Tools 37 和 adb，但缺 Android SDK Platform 37；当时连接的 Android 真机为 API 36、`arm64-v8a`，满足 min SDK，适合真机安装。设备 serial 不写入仓库，运行时通过 `AI_APP_BRIDGE_SERIAL` 指定。

建议命令：

```bash
git clone --filter=blob:none --no-checkout https://github.com/wikimedia/apps-android-wikipedia.git wikipedia-android
git -C wikipedia-android fetch --depth 1 origin 0777721523cb5ad76c1a01d560f4a5b185e1da15
git -C wikipedia-android switch --detach 0777721523cb5ad76c1a01d560f4a5b185e1da15
git -C wikipedia-android submodule update --init --recursive --depth 1
git -C wikipedia-android rev-parse HEAD
cd wikipedia-android
./gradlew :app:assembleDevDebug
./gradlew :app:installDevDebug
```

### Bridge 最小接入

在 held-out clone 上应用一份可重放、debug-only patch：

1. 通过 composite build 或本地 Maven artifact 给 `app` 增加 `debugImplementation`，release configuration 不引用 Bridge；
2. 把启动代码和 manifest 都放在 `src/debug`：用一个 debug-only `ContentProvider` 或 AndroidX Startup Initializer 调用 `AiAppBridge.start(context)`。不要从 `src/main` 的 `Application` 直接 import Bridge，否则 release compile classpath 在只有 `debugImplementation` 时并不成立；
3. 不改 Wikipedia 业务 Activity、selector、文案或网络层；否则 held-out 属性被破坏；
4. 每次运行先记录上游 HEAD 与 patch diff，验证 release 依赖图不含 Bridge。

### 第一轮 Intent 场景

场景不能硬编码“第 N 个元素”，必须从观测状态选择可见目标：

1. **未知起点搜索**：可能从 onboarding、主页、文章页或弹窗开始；清理阻塞后搜索一个主题，从动态结果列表选择匹配标题，等文章 WebView 真正加载，再用标题/URL/网络和 UI 稳定状态证明完成。
2. **链接预览到文章**：在文章中选择一个可见链接，区分预览底部弹层与真正页面切换，再进入链接、返回并确认恢复原文章。
3. **保存到阅读列表**：处理“已有列表”和“需要新建列表”两种分支，包括输入法、重名/空名校验、确认弹窗和最终保存状态。
4. **阻塞与恢复**：在关键网络请求时断网或注入延迟，确认 Intent 不重复提交不可逆动作；网络恢复后从新观测状态重规划。
5. **登录负路径**：只验证空输入、错误账号和网络错误的正确归因；没有专用 Wikimedia 测试账号时，不把“登录成功”列为验收项。

## 首选二：Moodle App 5.2.1（Hybrid/H5）

### 为什么适合第一轮

这是 MoodleHQ 官方 App，Apache-2.0 许可证。[repository](https://github.com/moodlehq/moodleapp) · [COPYING.txt at pinned commit](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/COPYING.txt)

官方架构说明确认它是 Angular + Ionic + TypeScript 的 hybrid App，以 Cordova 编译 Android/iOS，并通过 Moodle Web Services 与站点交互。[Moodle App overview](https://moodledev.io/general/app/overview)

固定提交不是静态网页：登录页会先异步检查站点，动态切换密码登录与浏览器 SSO，处理空用户名/密码、离线、unsupported App、强制改密、invalid login、多次失败提示、loading modal 与 LOGIN event；这些分支可直接从 [credentials.ts](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/src/core/features/login/pages/credentials/credentials.ts) 和 [credentials.html](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/src/core/features/login/pages/credentials/credentials.html) 核验。源码还包含课程、测验、聊天、作业、H5P 和多种 modal 组件。[pinned source tree](https://api.github.com/repos/moodlehq/moodleapp/git/trees/66f26caf4b3a29727f10db5b76e493b6b4ccee90?recursive=1)

它无需先自建后端：固定提交的官方配置内含 `school.moodledemo.net` 和 student/teacher demo 账号；官方开发文档说明该测试站每小时重置，也可直接输入 `student` 或 `teacher` 作为快捷入口。账号属于公开测试数据，但仍应只在内存中传给 Intent，不写入 FactCache 明文。[moodle.config.json](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/moodle.config.json) · [working with a Moodle site](https://moodledev.io/general/app/development/development-guide#working-with-a-moodle-site)

### 构建与真机条件

固定提交要求 Node `>=22.17 <23`，依赖 Angular 20.3.18、Ionic 8.8.1、Cordova 13 与 `cordova-android` 14.0.1；Android 配置 min SDK 24、target SDK 36。[package.json](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/package.json) · [config.xml](https://github.com/moodlehq/moodleapp/blob/66f26caf4b3a29727f10db5b76e493b6b4ccee90/config.xml)

Cordova 官方平台表确认 Android 14.x 需要 JDK 17，支持 Android API 24 起；Moodle 自己固定的 target 36 高于该表中 14.x 的常规 target 35，因此第一次 build 必须如实记录是否只是 AGP warning 或真实阻断，不能先假定成功。[Cordova Android platform guide](https://cordova.apache.org/docs/en/latest/guide/platforms/android/)

当前机器已有 JDK 17、Android SDK Platform 36、Build Tools 35/37，当前真机 API 36；但当前 Node 是 26.3.0，不满足项目 engines，必须使用独立 Node 22 环境，不能用 `--force` 绕过。

建议命令：

```bash
git clone --filter=blob:none --branch v5.2.1 --depth 1 https://github.com/moodlehq/moodleapp.git moodleapp
git -C moodleapp rev-parse HEAD
cd moodleapp
# 用 nvm/fnm/mise 安装并锁定 Node 22；仓库 .nvmrc 为 lts/jod。
npm install
npm start
# 浏览器 smoke 通过后再进入 Android 真机。
npm run dev:android
```

这些命令来自上游 setup 文档；Android 首次运行会生成 `platforms/` 与 `plugins/`，不应把它们误当作上游源代码提交。[Moodle setup](https://moodledev.io/general/app/development/setup)

### Bridge 最小接入

Moodle 应同时跑两个观察层，但只把 Bridge 作为 debug 依赖：

1. **Android 层**：Cordova prepare 后，对生成的 Android 工程应用可重放 patch，加入 `ai-app-bridge-android` 的 debug dependency，并在生成工程的 `src/debug` 通过 debug-only provider/initializer 启动 Bridge。不要手改生成的主 Activity，更不要改课程、登录或 Ionic 组件。
2. **Web 层**：testing/development bootstrap 引入 `@mobileaidev/ai-app-bridge-web`，只在非 production environment 启动，用于 DOM、fetch/XHR、console 与 route 事实；production bundle 必须 tree-shake/排除。
3. **独立基线**：上游官方支持 Chrome Remote Debugging，另跑 CDP 观测结果与 Bridge 结果交叉校验，而不是让两者共享同一解析逻辑。[Moodle setup / remote debugging](https://moodledev.io/general/app/development/setup#running-the-app-in-android-and-ios)

真实项目会暴露至少四个不能忽略的 Seam：

- Ionic Shadow DOM：普通 `document.querySelectorAll` 不会自动穿透 shadow root；
- 返回后的旧页面仍可能留在 DOM：元素存在不代表可见、可交互或属于当前 route；
- H5P/外部内容可能位于 iframe 或跨域 frame，top document 快照不等于完整 UI；
- Moodle 使用 native advanced-http Cordova plugin，单纯 hook 浏览器 fetch/XHR 不能声称捕获全部网络。

这些情况都应返回明确 `capability-gap`/`inconclusive` 事实，触发另一 Adapter 或人工检查；绝不能降级成坐标盲点后仍回报成功。

### 第一轮 Intent 场景

1. **真实登录**：从未知起点处理 onboarding/已有站点/站点输入/加载层，连接官方 demo，输入 student demo 凭据；验证焦点、输入长度、登录网络结果、LOGIN event 与最终首页，而不以“点击登录按钮成功发送”替代登录完成。
2. **错误归因**：分别制造空密码、错误密码、断网、站点检查失败；Intent 必须区分本地校验、认证失败与网络失败，不能全部归为 `text required` 或超时。
3. **课程动态列表**：从 course overview 选择当前真实存在的课程，滚动虚拟列表，进入课程后基于当前可见活动继续导航，不能依赖固定索引或固定 demo 内容。
4. **模态/历史页面噪声**：在打开 modal、popover、side menu 和返回后的旧 DOM 页面时执行目标；验证只在当前可见层命中元素。
5. **H5P/iframe**：若 demo 当前存在 H5P 或外部内容，验证 frame 枚举、DOM 可见性与动作反馈；没有该内容时记为未覆盖，不伪造结果。
6. **异步与重规划**：站点检查、登录、课程载入中插入网络延迟和前后台切换；要求 Intent 在 runtime/route 变化后重新观测，且不重复登录提交。

## 第二阶段备选

### Nextcloud Android

Nextcloud 是很强的 native + Web auth 压力项。固定版本的认证 Activity 同时包含 WebView、Login Flow v2 轮询、外部浏览器/Auth Tab、一次性登录、OTP、证书错误弹窗与多个网络错误分支。[AuthenticatorActivity.java](https://github.com/nextcloud/android/blob/aa93b10326f493a09c10207a674aa7bc79876ebf/app/src/main/java/com/owncloud/android/authentication/AuthenticatorActivity.java) · [Nextcloud Login Flow spec](https://docs.nextcloud.com/server/stable/developer_manual/client_apis/LoginFlow/index.html)

但固定版本要求 Java 21、compile SDK 37、NDK `29.0.14206865`、CMake `4.1.2`；这些当前均未完整安装。[app/build.gradle.kts](https://github.com/nextcloud/android/blob/aa93b10326f493a09c10207a674aa7bc79876ebf/app/build.gradle.kts) · [ndk.env](https://github.com/nextcloud/android/blob/aa93b10326f493a09c10207a674aa7bc79876ebf/ndk.env) · [Gradle wrapper](https://github.com/nextcloud/android/blob/aa93b10326f493a09c10207a674aa7bc79876ebf/gradle/wrapper/gradle-wrapper.properties)

完整成功路径还需可控 server。官方 Docker image 可在测试场景用 SQLite + Apache 快速启动，但当前机器没有 Docker CLI；因此它排在第一轮之后。[Nextcloud Docker README](https://github.com/nextcloud/docker/blob/master/README.md#using-the-apache-image)

许可证也比两个首选更严格：仓库 README 说明历史代码 GPLv2，2016-06-16 后贡献视为 AGPLv3-or-later。仅作内部 held-out clone 没问题，但不要把 patched 全仓库 vendoring 到本项目，也不要在分发时忽略对应源码义务。[Nextcloud README / license](https://github.com/nextcloud/android/blob/aa93b10326f493a09c10207a674aa7bc79876ebf/README.md#contribution-guidelines--license-)

### Immich Flutter

Immich 是 Flutter provider 的优质 held-out 项：固定版本 mobile 端有真实 server 登录、照片网格、选择、多种 dialog/modal、后台同步、WebSocket 和原生媒体/权限插件；仓库也已有真实 login integration tests。[mobile login integration test](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/mobile/integration_test/module_login/login_test.dart)

但 `mobile/pubspec.yaml` 精确要求 Flutter 3.44.8，而当前机器只有 Flutter 3.35.8 的 OHOS fork；官方 dev-container 文档还建议至少 4 CPU、8 GB 内存、20 GB 磁盘，并需要 server/database/cache。应使用独立官方 Flutter SDK 和本地 Immich server 后再做，不要用 `--no-version-check` 假装兼容。[mobile/pubspec.yaml](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/mobile/pubspec.yaml) · [dev container](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/docs/docs/developer/devcontainers.md)

Immich 是 AGPL-3.0；同样建议外部 shallow clone + patch manifest，而不是 vendoring。[LICENSE](https://github.com/immich-app/immich/blob/8aa95c67470a02a8ddedf03c2e52963af33065ff/LICENSE)

## Held-out 运行规则

### 源码与许可证

- 不把上游完整仓库复制进 `examples/`。仓库内只保留 manifest（URL、commit、许可证）、fetch/build 脚本、debug patch 和结果；实际 clone 放在被忽略的 held-out workspace。
- 每次构建先断言 `git rev-parse HEAD` 等于固定 SHA，再断言除 Bridge debug patch 外没有修改。
- 上游更新只能以新增 pin 的形式进入新一轮，不允许 tag 漂移后覆盖旧结果。

### Bridge 接入

- 只改测试构建的依赖和唯一启动 seam；不添加 accessibility id、不改文案、不移除弹窗、不为 Intent 创建捷径。
- Bridge 与 external CDP/UIAutomator 观测必须保留独立实现，结果可比对但不能互相喂答案。
- 密码、token、cookie、app password 只以 secret reference 进入执行器；FactCache 只能记录长度、是否填写、结果类别和已脱敏网络事实。

### 最小验收矩阵

每个首选 App 至少执行以下矩阵，每格保留 `deviceSerial + package + runtimeEpoch + intentId + planRevision + observation cursor`：

| 维度 | 变体 | 必须证明的结果 |
|---|---|---|
| 起点 | 冷启动、停在中间页、弹窗打开、已有历史栈 | Intent 先观测再选择路径，不假定首页 |
| 目标 | 文本控件、动态列表项、图标/aria-label、WebView/Shadow DOM | 命中当前可见可交互实例，并回报实际目标 |
| 反馈 | 点击无变化、加载动画、路由切换、dialog、WebView URL 变化 | 区分“动作已送达”和“业务目标已完成” |
| 网络 | 正常、延迟、断网、认证失败、恢复 | 正确归因并有界重试，不重复不可逆动作 |
| 生命周期 | 前后台、Activity/route 重建、runtimeEpoch 变化 | 旧计划失效并重新观测，不跨 runtime 盲重放 |
| 存储 | 高频 UI/event/network/log 写入 | 不因事实落盘拖慢主操作；秘密不落盘；可按 intent 回放证据 |

第一轮结果不能只报成功率。至少同时报告：终态正确率、错误归因准确率、动作数、重规划次数、等待时间、selector/target 类型、误点/重复提交次数、设备 CPU、App/Bridge PSS、FactCache 写入量、UI checkpoint/patch 数、缺失能力及人工介入次数。

## 实际下载与构建顺序

1. 安装 Android SDK Platform 37；shallow fetch Wikipedia 固定 commit。
2. 不接 Bridge 先构建并安装 Wikipedia `devDebug`，手工完成一次搜索/文章/阅读列表 smoke，证明上游自身可运行。
3. 应用 debug-only Bridge patch，重复 smoke；若行为或性能明显变化，先解决接入污染。
4. 跑 Wikipedia 的 4 个无需账号 Intent，再跑登录负路径。
5. 建立隔离 Node 22 环境；shallow clone Moodle `v5.2.1` 并核对 commit。
6. 先 `npm start` + 官方 demo 做浏览器 smoke，再 `npm run dev:android` 做真机 smoke。
7. 给生成的 Cordova Android 工程和 development web bootstrap 应用可重放 Bridge patch，分别核对 native 与 web capability。
8. 跑 Moodle 登录、错误归因、课程列表、modal/旧 DOM、iframe/H5P 和网络重规划矩阵。
9. 只有两套首选都留下可复现实验结果后，才决定优先补 Compose semantics、Shadow DOM/frame、native HTTP、Intent planner 或存储层中的哪一项；不要根据自建 fixture 单独定架构。
