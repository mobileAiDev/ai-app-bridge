# VLC：Intent 探索到固定 Script 的真实业务验收

2026-09-12，VLC 本地视频的 P9 固定场景在 OPPO PKR110（`b46093e6`，Android 16）连续三轮通过。每轮包含媒体扫描、播放/暂停/跳转、播放位置保存与恢复、重复播放/返回、空目录、主题切换与恢复，以及两次实际 App 重启。每轮 11 项业务断言通过，证据导出后通过离线校验。

这是 VLC 的上述固定场景验收结果。四 App 总门禁、完整产品生产验收仍未完成；下一条业务主线为 Organic Maps 的离线地图、搜索、书签和路线预览取消。

## 冻结身份与执行结果

| 项目 | 冻结值 |
| --- | --- |
| 上游 | [VLC Android 3.7.1](https://github.com/videolan/vlc-android/tree/baeb1edae0678927ebe16d482d979e9c7e75ead6)，提交 `baeb1edae0678927ebe16d482d979e9c7e75ead6` |
| 实际包名 | `org.videolan.vlc.bridge_sample.debug` |
| APK SHA-256 | `9dd12dc1f6157f1bd9d389af21844617c88f8de761a3c61c9ffd43d686c57df4` |
| Android AAR SHA-256 | `70bb223502a568b2fb7409be9e08dd687432bdaeafa08b8dbb447dc0c4ae2477` |
| Script SHA-256 | `6732aa55523e6dec69a2d5d48654e10aefd75ec7c3608c000722f455bff3dd32` |
| 独立 oracle SHA-256 | `f53edca337ecbb1dda43077b6f54ff90555ef18694b011f114ad4b8d9b75557e` |
| 视频 | `Bridge Video Fixture.mp4`，180 秒，SHA-256 `24ab98e36355234d4f91ea00fece07ceee357a207cda293965b9bbfdd497aa1c` |
| 初始状态 | 中文、引导及权限已由 Intent 完成、仅扫描固定目录、主题跟随系统 |
| 终态 | 固定视频列表可操作，`app_theme=-1` |

| 轮次 | Operation ID | 核心 | Script 验收 | 含启动/等待的 wall | 业务断言 | 动作 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `script-1789155413081-1` | 21.009 s | 61.931 s | 62.251 s | 11/11 | 38 |
| 2 | `script-1789155477964-1` | 20.863 s | 60.861 s | 61.176 s | 11/11 | 38 |
| 3 | `script-1789155541722-1` | 20.340 s | 60.547 s | 60.865 s | 11/11 | 37 |

三轮使用同一源码、APK、媒体与独立 oracle。第三轮少一次滚动即可在设置列表看到“界面”，其余动作和目标断言相同。每轮均为 6 张截图、18 页手机持久证据；所有动作保留原始执行回执。每轮独立 Host profile，结束后 Runtime 均已停止。

计时包含当前业务的 UI 等待、独立结果读取和在线证据查询；不含源码编译、APK 安装、首次引导准备、末尾证据导出和离线校验。已学习的核心与验收分别满足 5 分钟和 10 分钟门禁。此前首次开发成功轮为 54.272 秒 wall，独立保留，不计入这三轮冻结结果。

## 五类证据

| 验证面 | 本轮观察与独立依据 |
| --- | --- |
| 正常业务 | 固定视频名称和 3:00 时长出现；真实 MediaSession 进入 PLAYING；暂停后进入 PAUSED；截图能看到合成视频时间码 |
| 状态与恢复 | 三轮 seek 均落在 58.605 秒，暂停期间保持不变；恢复播放后再次暂停分别到 62.734、62.984、62.734 秒；返回列表后磁盘位置与暂停位置一致；重新打开与磁盘位置偏差不超过清单允许的 1.5 秒 |
| 边界与分支 | `BridgeVLCEmpty` 的空 UI 与实际目录为空对应；重复播放/返回后视频列表仍可操作；控件自动隐藏时先观察并显示控件 |
| 重启与设置 | 主题通过 UI 改为亮色再恢复系统模式；直接读取 SharedPreferences 确认值；两次重启均更换 SDK runtime epoch；三轮共六次主进程 SIGKILL，与重启确认动作相隔 3–402 ms，符合 VLC `UiTools` 对话框调用 `killProcess` 的实现；该区间未出现 CRASH/ANR 退出记录 |
| 证据与时限 | 查询使用 SDK 设备时间建立本轮边界；重启后等待持久存储 attached；逐页检查 committed、gap、目标和 epoch；三轮离线验证均为 verified，引用闭包 complete |

业务结果的独立来源是 Android MediaSession、隔离 App 磁盘 SharedPreferences、媒体 SHA-256 和目录列表。`state/events/logs` 的完整查询窗口不替代这些业务断言。MediaSession 播放期间的原始 position 可能不更新，因此比较真实暂停位置，不使用宿主推算时钟作为播放进度证据。

## 由真实业务推动的通用能力修改

1. **Native 语义容器。** VLC 播放器根容器内的被动 SurfaceView 曾被误判为遮挡。SDK 允许选中容器的被动后代承接命中；可交互子控件和无关覆盖层仍拒绝。6 项真机定向测试通过，VLC 实际显示控件、暂停和 seek 验证通过。
2. **精确 Native 点击。** 新增共享 `tap-native`，CLI、MCP、Script 共用 Native selector 契约，包括 `within`。执行前检查唯一性、同一 View 身份和前台归属，保留原始 Native 回执；已替换、歧义、无绑定目标在派发前失败。相关 wire、selector、命令契约测试通过。
3. **启动记录交接。** 内存暂存记录在持久存储挂接时按顺序交接，保留启动时多次状态变化；真实溢出按流保留缺口。暂存历史受记录条数和字节预算限制，Legacy 投影剩余记录中每个键的最新值。持久存储未就绪时，强查询明确返回 `capture_not_persistent`；共享 Host 查询端也为 unavailable 返回明确错误。8 项启动/重读/Legacy 定向单测及 21 项共享查询测试通过。
4. **自动日志的启动边界。** 真机复现了旧 Logcat 缓冲重放；它占用共享写入队列，使约 1 KB 的新 UI 事件遭遇 `QUEUE_FULL`。`ProcessLogcatSource` 以本次采集的唯一标记和进程身份确定起点，旧缓冲在入库前被排除。关闭源时先终止进程以释放阻塞读取。真机边界测试以及 3 项 collector 单测通过，随后完整 VLC 三轮均未出现证据缺口。

自动日志采用标记边界，也适用于仓库声明支持的 API 19；该版本 [AOSP Logcat 源码](https://github.com/aosp-mirror/platform_system_core/blob/android-4.4.4_r2/logcat/logcat.cpp) 尚无 `-T` 时间跟随选项。Android 19 的实际设备测试未在本轮执行。

VLC 业务代码未改动。接入脚本只调整隔离包名、debug 最低 API、SDK/Gradle 插件与依赖；三个上游构建文件的哈希均核对。APK 的 76 个远程控制前端资源与上游前端构建结果逐文件一致；原有 `org.videolan.vlc` 保持独立。

## 保留的失败与计时边界

- `vlc-script-20260912-authoring-01`：首个主题重启后的强状态查询早于持久存储挂接，返回 unavailable；整轮失败。
- `vlc-script-20260912-authoring-02`：两次主题操作完成，但恢复主题后的 events 出现真实缺口；整轮失败。
- `vlc-script-20260912-authoring-03`：加入写入诊断后，亮色主题重启时明确记录 `QUEUE_FULL`；整轮失败。
- 上述失败各自导出并通过完整性校验；`verified` 只证明证据完整性，不改变它们的失败结论。`authoring-04` 与三轮冻结结果分别保留。

`closeout.json` 从事件起止时间分解了 provider 调用、证据查询、独立 oracle 读取、active/wall、Agent 等待和暂停。JS 内部 sleep、子进程启动与编排开销尚未单独埋点，`businessWaitMs` 为 unavailable；这仍是全 P9 性能报告需要补齐的一项。三轮总 wall 的测量和时限判断不受此限制影响。

## 复核入口

- 样例与构建说明：[examples/vlc-sample/README.md](../examples/vlc-sample/README.md)。
- 冻结清单：[vlc-local-media.manifest.v1.json](../examples/vlc-sample/validation/vlc-local-media.manifest.v1.json)。
- 固定 Script：[vlc-local-media.v1.js](../examples/vlc-sample/validation/vlc-local-media.v1.js)。
- 执行器：[run-local-media.js](../examples/vlc-sample/validation/run-local-media.js)，执行输出目录中冻结的 oracle。
- 三轮完整原始报告：`build/ai_app_bridge_artifacts/vlc-script-20260912-frozen-01/report.json`。
- 精简结果、时序关联与退出检查：同目录 `closeout.json`、`app-exit-info.txt`。
- Intent、构建与安装：`build/ai_app_bridge_artifacts/vlc-business-20260912-01/`，最终包清单 `build-manifest-startup-fix.json`。
- 定向测试日志与红/绿证据：`examples/vlc-sample/build/` 中 `native-container-*`、`capture-handoff-*`、`logcat-boundary-*`、`native-tap-*`、`vlc-p9-manifest-tests.log`。

后续使用同样的 Intent 探索、冻结 Script、独立业务结果与离线证据链，推进 Organic Maps。Wikipedia 的文章/reading-list 未完成项仍保留，四 App 总门禁不以本轮结果替代。
