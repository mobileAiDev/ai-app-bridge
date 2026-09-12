# Organic Maps：Intent 到固定离线业务 Script

2026-09-12，Organic Maps 的固定 P9 离线业务在 OPPO PKR110（`b46093e6`，Android 16）连续三次通过。每次包含 POI 搜索、详情、书签保存、步行路线预览与取消、无结果搜索、书签删除/恢复、单位修改/恢复和最终清理；13 项业务断言全部通过。独立读取 App 私有 KML 和 settings.ini，核对实际业务结果，未修改上游业务实现。

这关闭上述地图固定正向覆盖。实际导航、路线算法的独立正确性、全 App、四 App 总门禁及整机生产验收均不在本结论内。已通过且源码未变的地图流程停止重跑；下一业务主线转向 iOS 的真实 H5 提交、同屏多 WebView 与系统界面跨越。

## 固定身份与结果

| 项目 | 值 |
| --- | --- |
| 上游 | Organic Maps `2026.08.27-18-android`，提交 `3ef379196cca434cf17f4ee684f16aa99fd8985e` |
| 独立包 | `app.organicmaps.bridge_sample.web.debug`，原正式版保持独立 |
| APK SHA-256 | `41d68f202eef16b1c2a72b80e024d459e51a6fc60c7ba2076056c4ab26a618a6` |
| Script SHA-256 | `aa089352a5957c5134ea9d48a35d8c29b72e5da1b43698c76286eff92ca9beb1` |
| Host 代码身份 | `05ba942f176a4bab24a4429057f18a1eff1e9b8ae257ed667b239aa0a54484d9`，三轮一致 |
| Host 容量 | 每轮独立目录，显式 `1gb` |
| 地图 | 版本 `260826` 的 World、WorldCoasts、Monaco；每轮设备 SHA-256 与固定清单一致 |
| 初始与最终状态 | 中文 `zh-Hans-CN`、空书签、`Units=Metric`、`AutoDownloadEnabled=false`、地图主页 |

源码和前提见 [固定清单](../examples/organic-maps-sample/validation/offline-business.manifest.v1.json)、[Script](../examples/organic-maps-sample/validation/offline-business.v1.js)、[控制器](../examples/organic-maps-sample/validation/run-offline-business.js)及[独立读取程序](../examples/organic-maps-sample/validation/independent-oracle.py)。安装、引导和地图实际下载已由 Intent 准备；三轮没有注入业务文件来制造结果。

| 轮次 | Operation ID | 核心 | Script 主体 | start 至 terminal | 含导出/离线核验 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | `script-1789170401533-1` | 22.241 s | 61.541 s | 61.873 s | 63.276 s |
| 2 | `script-1789170466697-1` | 21.883 s | 60.724 s | 61.053 s | 62.471 s |
| 3 | `script-1789170531132-1` | 21.959 s | 61.085 s | 61.410 s | 62.791 s |

三轮同一 Script、控制器、oracle、APK、地图及 Host 代码身份；每轮 13 项通过、33 个原始动作回执、374 个连续进度事件、7 张截图、40 页手机持久证据、250 条归档记录。每轮最终实际 KML 为空、单位恢复，在线与离线 Runtime 均已停止。计时包括 UI 等待、独立业务读取和在线采证；最后一列另含归档和离线核验。源码构建、安装、引导、首次地图下载、前置文件哈希与启动准备不计入这些业务时间，不能外推整机耗时。

## 五类业务证据

| 方面 | 实际依据 |
| --- | --- |
| 正常操作 | 搜索 `Palais Princier` 后打开亲王宫；保存后的 KML 精确包含 `Palais princier de Monaco` 和 `7.420057,43.731165,0`。 |
| 路线与取消 | 用博物馆分类排除同名公交站，亲王宫至海洋博物馆的步行预览显示 `7 分钟 • 560 米`；截图与新树一致。取消后回主页，KML 书签保留；未点击开始导航。 |
| 无结果与恢复 | 固定未知 POI 显示明确无结果页面；书签列表核对后删除，实际 Placemark 为零；使用 App 的“恢复”恢复同一名称与坐标。 |
| 设置与清理 | “英里”选中状态与文件 `Units=Foot` 一致；恢复“公里”后文件为 `Metric`。自动下载保持关闭，最终删除测试书签并回主页。 |
| 证据与时限 | 每页检查目标、epoch、committed、gap、分页终点；截图实际字节与 SHA-256 相符。三轮引用闭包 complete、缺失引用为空，在 `ADB=/offline-no-adb` 的独立 Runtime 中 verified。核心和完整固定覆盖分别低于 5/10 分钟。 |

业务证据目录为 `build/ai_app_bridge_artifacts/organic-maps-script-20260912-frozen-01/`。`business-audit.json` 复核源码哈希、三轮 Host 身份、原始回执、连续事件、截图文件和页面范围；`report.json`、每轮 `recording/` 与 `archive/` 保留完整原始记录。截图与附近的 UI 树分次采集，不宣称原子同帧；归档只覆盖保留的 Host 记录与显式记录/查询的载荷，不代表全部 App 活动。

三轮归档 manifest SHA-256：

- `4522d61e2fa11b5cc88b861a8533f732fb408668c69d139fd98eaadb83609361`
- `57a27c16a2902cb7d7d950cdb6350c0cf1215e8cebd1ee794b2f1ab6c8148a9f`
- `62cc6cbc227f4c094396067c7c9b0c451c6b254f2ccb9d2d03070ad046854741`

## Intent 与保留的失败

完整 Intent `organic-maps-complete-20260912-03` 以 revision 64 完成，227 条记录的归档离线 verified，manifest 为 `294d6e640999f25ff3e2bbd9d6a245927b05353b0c98b2fd8bd75e26bb93642c`。目录 `build/ai_app_bridge_artifacts/organic-maps-business-20260912-02/` 保留独立 KML/设置读取、路线/无结果/设置截图及归档；独立截图未自动包含在该 Intent 归档中。

早期 `64mb` 运行器淘汰 UI 证据、导致完整导出被拒绝的失败保持原样，见[样例记录](../examples/organic-maps-sample/README.md#当前业务进度2026-09-12)。新 `1gb` 成功轮没有修补旧存储或改写旧失败。

Script authoring 01 在点击书签之后引用点击前列表证据，被 `evidence_action_window_stale` 拒绝；02 误等待“保存”而实际按钮为“恢复”，同时控制器将历史环形缓冲淘汰误认为增量事件丢失并取消了任务；03 在读取约 1.18 MB 的采证响应时因通道上限被误报 `child_crashed`。三轮原始文件和失败/取消归档均保留，02 的归档另存 `recovered-archive/` 并完成离线验证。04 首次开发成功为 56.167 秒，独立保留，未计入冻结后的三次验收。

## 推动的 Bridge 通用改动

- 公共 `input-text` 支持 Native 精确 selector 和空字符串清空，与 Intent 共用实际 View 绑定及 `/v1/action/input-target`，CLI/MCP/Script 使用同一契约；selector 与坐标互斥。41 项相关检查通过，地图 Script 真机使用这一入口。
- Script 通道保留最初的终止错误，并拒绝继续处理终止前排队的调用；Host 响应超限明确返回 `frame_too_large`。JavaScript/Python 真子进程反例先复现旧误报，修复后 12 项相关检查通过。固定脚本改为每页 100 条、完整遍历，而非截掉超过上限的证据。
- 控制器在相应动作之前断言列表，按连续事件序号核对增量读取；历史缓冲的 `gap` 与已持有的完整事件区分。修改前后失败均留证，不降低实际业务断言。

本轮未修改 Organic Maps 业务、没有启动实际导航，也没有重跑未受影响的其他 App 矩阵。Wikipedia 的联网文章/阅读列表仍未通过；iOS 和最终生产发布的剩余项见[当前总排期](BRIDGE_NEXT_GATES_2026-09-08.md)。
