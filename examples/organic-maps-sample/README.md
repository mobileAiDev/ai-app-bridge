# Organic Maps 真实离线业务样例

用于推进 Bridge 的 Intent → 固定 Script → 独立业务结果 → 离线证据验收。采用官方 `2026.08.27-18-android` 版本，接入 Bridge 的独立开发包；上游源码与构建产物位于被忽略的 `upstream/`、`build/`。

目标覆盖沿用 P9：引导、离线地图、固定 POI 搜索、详情、书签、路线预览与取消，再覆盖无结果搜索、书签删除/恢复和设置修改/恢复。完整 Intent 归档和固定 Script 已在这一范围通过；同源三轮为 61.873 / 61.053 / 61.410 秒，见[真实业务报告](../../docs/ANDROID_ORGANIC_MAPS_INTENT_SCRIPT_2026-09-12.md)。

设备已有 `app.organicmaps.web` 正式版。样例采用独立身份，后续书签与设置操作仅作用于样例。只修改构建与 SDK 接入配置，保留上游业务实现。

## 构建与固定地图

1. 克隆 [source.json](source.json) 中的标签和提交至 `upstream/`，初始化全部固定提交的子模块。浅克隆需要补足历史，直到 `tools/unix/version.sh android_name` 返回 `2026.08.27-18`。
2. 在本仓库根目录构建 `./gradlew :ai-app-bridge-android:assembleDebug`，再运行 `python3 examples/organic-maps-sample/integrate.py`。脚本要求上游工作区干净，拒绝覆盖已有修改或接入清单。
3. 在上游执行 `python3 tools/android/set_up_android.py --sdk <ANDROID_SDK>`；使用 Java 17、NDK `29.0.14206865` 和上游 Gradle `9.6.0`。Gradle 官方 SHA-256 已固定。
4. 在 `upstream/android/` 执行 `./gradlew :app:assembleWebDebug -Parm64 -Pnjobs=4 --max-workers=4`。独立包为 `app.organicmaps.bridge_sample.web.debug`，不会覆盖正式版。
5. 执行 `python3 examples/organic-maps-sample/prepare-maps.py <新的输出目录>`。脚本从固定上游复制 World、WorldCoasts，从官方服务器获取同一数据版本的 Monaco。使用上游 BLAKE3 实现逐一校验 `countries.json` 中的大小和摘要，再记录 SHA-256。需要本机 C 编译器；未通过校验的目录不能用于验收。

地图数据来自 Organic Maps / OpenStreetMap contributors。当前固定数据版本为 `260826`。Script 已依据实际 Intent 证据冻结；地图文件准备与业务验收分别核对。

## 当前业务进度（2026-09-12）

设备为已授权 OPPO PKR110，独立包通过公开安装 Intent 安装。当前 APK SHA-256 为 `41d68f202eef16b1c2a72b80e024d459e51a6fc60c7ba2076056c4ab26a618a6`；构建清单位于仓库忽略目录 `build/ai_app_bridge_artifacts/organic-maps-business-20260912-01/build-manifest-checkable-fix.json`。

| 流程 | 已取得的事实 | 验收边界 |
| --- | --- | --- |
| 离线基线 | App 实际下载 World、WorldCoasts 和 Monaco；设备上的三个文件与固定清单 SHA-256 一致。通过 Intent 关闭自动下载，并删除额外下载的上海地图，最终目录恰好包含三个固定文件。 | 安装、引导和基线归档已核验；这些是业务前提。 |
| 搜索、详情、书签 | Intent 搜索 `Palais Princier`，打开亲王宫并保存。独立读取 App 私有 KML，得到 `Palais princier de Monaco`、坐标 `7.420057,43.731165,0`。 | 固定 Script 三轮保存、删除、恢复及最终清理均与实际 KML 对应。 |
| 路线预览、取消 | 通过 Intent 选择亲王宫为起点，搜索并用分类限定选择博物馆，排除同名公交站；步行路线显示 `7 分钟 • 560 米`，随后取消并回到地图主页。 | 新的完整 Intent 与三轮 Script 归档均已离线核验。未启动实际导航，也未宣称路线算法已独立验算。 |
| 无结果、设置恢复 | 未知 POI 显示明确无结果；单位由公里切到英里再恢复，原生 checked 与实际 `Units=Metric → Foot → Metric` 一致。 | 每轮最终为空书签、Metric、自动下载关闭、地图主页；7 张截图与 40 页手机持久证据均保留。 |

两条早期业务 Intent 的终态均如实保留：

- `organic-maps-business-20260912-01` 在书签保存之后，对尚未显示的搜索框输入，被派发前检查以 `native_selector_not_found` 拒绝；归档 `business-first-archive` 离线完整性核验通过，操作终态仍为 failed。Script 需要依据新观察确认搜索页就绪。
- `organic-maps-route-20260912-02` 完成路线取消后，下一次观察报 `evidence_read_failed`，导出显示 `fact_store_read_failed / cursor_expired`。停下本轮 Host 后，在保存的存储副本上定位到已淘汰的 UI 块：sequence 265、segment 51；当前 UI 首个保留 segment 为 52。临时运行器显式配置了 `64mb`，UI 分区额度仅 12,058,624 字节，长页面原始树已经触发真实淘汰。原始存储、逐文件哈希、诊断结果和失败响应均保留；没有用磁盘副本补写成功归档。

该业务同时推动了 Bridge 的通用修复：Android Native 暴露可空 `checked` 状态，并把它纳入动作前的目标校验；摘要保留 false/true 控件，UIA 普通节点的默认 false 不再被当作复选状态。对应真机检查 1 项及 Host 摘要相关检查 14 项通过，Organic Maps 的实际设置页也分别验证了 Native 与 UIA 的关闭状态。

新的独立 `1gb` 目录已完成 `organic-maps-complete-20260912-03`（revision 64、227 条记录、离线 verified），并完成上述三次同源 Script。固定清单、运行器和 oracle 位于 `validation/`；原始证据位于 `build/ai_app_bridge_artifacts/organic-maps-script-20260912-frozen-01/`。旧 `64mb` 目录保持停止写入；更换配置不改变旧失败结论，也不替代最终容量边界验收。本固定业务停止复跑，下一主线为 iOS 剩余复杂业务。
