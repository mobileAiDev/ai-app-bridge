# Wikipedia 真实弹窗与工具栏业务（2026-09-12）

本轮从真实 Wikipedia 暴露的弹窗问题继续推进 Intent → Script。修改的是 Bridge 的通用窗口和触摸实现；Wikipedia 上游业务源码没有改动。文章搜索、正文及阅读列表仍因实际网络请求失败而未通过，工具栏路径不能替代整个 P9 验收。

## 已修复的执行缺口

1. **指针操作与键盘焦点分开判断。** 可触摸且不获取焦点的窗口，可以在同一 application window token 的所属窗口仍聚焦时接收指针操作。快照新增 `focusable`、`touchable`、`focusOwnerWindowId`。仍只选择最上层可见窗口，保留原 View/window 引用，不穿透浮层。Native 输入仍要求目标窗口本身聚焦。
2. **正确保留两套触摸坐标。** `nativeTouchEvent` 以屏幕坐标创建 MotionEvent，再偏移为窗口内坐标。点击、滑动、长按和取消共享这条路径；`rawX/rawY` 保留屏幕位置。真实 Balloon 1.7.6 的外部触摸拦截器读取 rawX，旧实现把弹窗内坐标当成 rawX，导致点击被吞掉。
3. **窗口变化报告准确原因。** 手势中途换窗、失去可操作性时，向原窗口发送 CANCEL，报告 `native_gesture_window_changed`，不改投新窗口。滚动容器裁剪也使用统一的屏幕坐标。

原 `aab.native-target/v1` 引用与 managed action 身份继续有效。CLI、Intent 和 Script 调用同一 SDK 实现；这轮没有另建弹窗专用入口。

## 真实业务与独立证据

设备为 OPPO `b46093e6` / PKR110。App 为固定 Wikipedia 提交 `2fa2f9536e0d0120ef82638d9ea8086be821f3a3` 的隔离开发包 `org.wikipedia.dev.bridge_sample`。

- 最终 APK SHA-256：`63020e3cf50ec14d5537a0236dc74ffba580279895d5816ba4c3db3c958f476b`，116,690,775 bytes，设备读取值与冻结文件一致。
- 最终 AAR：`b682a19a8416ebb684ab79df49f34c97b278703bea1d71f05d36237203d7e054`。
- 最终 instrumentation APK：`b2879cd34a31e0fcc03bdd9c2e615f3e6acec85d904936e0bc5fa2d636787c71`。

Intent `wikipedia-toolbar-intent-20260912-01` 完成：

1. 在实际非聚焦引导弹窗点击“知道了”，弹窗消失；独立 `run-as` 文件读取确认 `showCustomizeToolbarTooltip=false`。
2. 从“更多选项”进入“自定义工具栏”，选择“保存”所在行的拖动手柄，实际拖拽改为 `[1,0,2,3,4]`。
3. 退出设置并重开，界面和磁盘仍保持新顺序。
4. 滚动真实列表，点击“重置为默认设置”，工具栏恢复 `[0,1,2,3,4]`，菜单保持 `[5,6,7,8,13,9,10,11,12]`。

ID 与默认值来自未修改的 `PageActionItem.kt`、`Prefs.kt`；结果来自真实 SharedPreferences XML，而非 Bridge 内存或合成接口。`preferences-oracle.py` 只读三个相关键与文件哈希。Script 中的每次独立读取进入 checkpoint，并与 UI 断言分别保留。

固定 Script 由以上 Intent 证据编写，拖动距离来自当次观察到的行 bounds，入口固定 `provider:native`。每次操作都要求原 managed Native 回执；业务成功额外要求新界面与精确磁盘值。等待只读状态，不重放未确认的动作。

一次性引导重放需要显式测试准备：控制器停止隔离测试包，仅将 `showCustomizeToolbarTooltip` 置为 true；验证其余偏好完全相同，记录前后哈希。排序基线必须已经为默认值，控制器不会通过写入排序值制造通过。冷启动等待实际弹窗出现，因此耗时包含真实文章请求的网络超时。

最终相同源码、相同输入连续三次完成，源码 SHA-256 为 `9e788ca75286437eadfc4c26262bcbcfcd280c17550b65d0510c561b2c791fa8`：

| Script | 用时 | 业务断言 | Native 原始回执 | 截图 |
|---|---:|---:|---:|---:|
| `script-1789148600318-1` | 23.007 秒 | 6 passed | 9 | 3 |
| `script-1789148625403-2` | 22.690 秒 | 6 passed | 9 | 3 |
| `script-1789148650102-3` | 22.823 秒 | 6 passed | 9 | 3 |

每轮独立读取均记录提交过程及最终值，控制器再次读取最终偏好确认恢复。三份 Script 归档均使用 manifest hash 离线验证通过，运行后 Runtime 明确停止。本轮共 6 份 Intent、2 份编写阶段失败 Script、3 份最终成功 Script 归档通过离线验证。

收尾发现证据导出也会使用并启动共享 Runtime，因此仅在导出前停止不够。控制器已补上导出后的 finally 停止；本次所有目录的实际停止结果另存为 `runtime-stopped-after-export.json`。这属于收尾修正，三轮业务 Script 源码及其执行结果没有改变，执行时的控制器快照也保留。

## 缺陷复现与定向验证

- 初始 SDK 对真实弹窗拒绝 `native_window_not_focused`，`dispatched=false`，失败 Intent 保留。
- 首次放开非聚焦指针后，真实点击回执为派发成功，但弹窗与偏好未改变；这轮主动取消，未算业务通过。
- 两个 offset popup 触摸测试在旧坐标构造上均失败：屏幕 X 应为 420，实际 rawX 为 240；修复后点击与完整 swipe 事件均通过。
- 新增 Native/H5 非聚焦 popup、旧 popup 引用、不可触摸浮层 4 项实机通过。既有输入、点击、Dialog 与 H5 遮挡 6 项定向通过。
- 坐标修复相关 6 项第一次有 1 项窗口切换错误分类失败；修正后该项及 popup swipe 定向复验均通过，其余 5 项此前已通过。没有把首轮失败计为全绿。
- Native 窗口与目标契约 JUnit、最终 SDK/APK 构建通过。

Script 编写过程也保留：第一次准备器 stdin 传输超时，未创建 Script；第二次初始 8 秒等待短于实际网络超时，Script 失败；第三次 UI 换序早于磁盘提交，独立断言失败。已修正准备器传输、初始观察期限和持久化只读等待。第三次失败后的基线通过单独恢复 Intent 的真实重置按钮恢复。

## 文件与下一项

- `build/ai_app_bridge_artifacts/wikipedia-popup-20260912-01/`：SDK 修复前及中间失败、安装、实际窗口树与截图。
- `build/ai_app_bridge_artifacts/wikipedia-toolbar-20260912-01/`：最终 APK/AAR、实际 Intent、独立偏好与安装哈希。
- `build/ai_app_bridge_artifacts/wikipedia-toolbar-script-20260912-01/` 至 `-03/`：编写阶段准备/执行失败，已运行的失败 Script 也导出并离线核验。
- `build/ai_app_bridge_artifacts/wikipedia-toolbar-script-20260912-04/`：最终三轮固定脚本、checkpoint、截图、独立复核和离线归档。
- `examples/wikipedia-sample/validation/`：固定业务 Script、公开 CLI 控制器、只读 oracle 和显式测试准备器。

工具栏路径验收后，下一项回到既定 P9 的 VLC 本地媒体业务，用本地媒体 fixture 覆盖操作、状态变化与恢复。Wikipedia 的文章/阅读列表保留为网络恢复后的独立未通过项。不再复跑已关闭的 LocalSend 或固定存储矩阵。
