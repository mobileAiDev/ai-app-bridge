# Kiwix 真实课程提交：Intent 到 Script

现有 Kiwix 内的 freeCodeCamp 课程已完成错误、正确答案的真实提交。固定 Script 连续运行 **20.999 秒**，6 项设备断言通过，外部读取原 App 判题状态的 14 项核对通过，3 张截图与离线归档校验通过。该结果包含明确声明的阅读容器高度修正，不是原样本布局通过，也不是整机回归时间。

## 范围与夹具

用户明确要求主线优先：复杂 App 操作 → Intent 证据 → 固定 Script → 独立业务结果。样本自身的问题只做必要小修；不简单的问题记为阻塞并继续其他已具备条件的主线。基础回归按实际 Bridge 改动执行。本项已完成，停止扩展布局排查。

原版 `.content` 使用 `calc(100vh - 2.2rem)`，在本轮 iOS 27 WKWebView 中超出实际可用高度。竖屏、沉浸阅读、横屏和收起侧栏均没有使 Run 正常可用。探索 Intent `intent-1789182534765-1` 以 `inconclusive` 结束，失败证据保留。

获用户允许后，[小范围夹具修正](../examples/kiwix-sample/fixtures/freecodecamp-viewport.js) 将固定容器高度按 `document.documentElement.clientHeight` 计算，窗口 resize 时同步更新。最终 Run 从 y=913.984 移至 y=701.984–743.984，状态为 `ready`，截图和正常点击均确认可用。第一次采用 `innerHeight` 的候选仍被遮挡，已重载页面后应用最终修正，候选证据保留。

修正只影响这个固定课程页面的阅读容器高度；ZIM 文件、题目、测试、编辑器输入、Run 回调及判题结果没有被替换。修正在业务 Script 计时前由显式 `ios-h5-eval` 完成，文档重载后失效。不能把修正后的结果记为原版布局已修复。

## 业务证据

业务 Intent `intent-1789183125690-2` 通过原有 Code / Run / Console / Close 控件执行：

- 错误答案 `9 + 10`：Console 输出本次 Intent 标记和 `19`，没有完成弹窗。
- 正确答案 `12 + 8`：出现完成弹窗；原 App 判题状态为 `[true,true]`、`cheatMode=false`，关闭后 Console 输出本次标记和 `20`。
- Intent 正常完成，归档 SHA-256 为 `a98523393ef15350e7e1e56cd297a8afae2e9cdfa4d647c7f8eb2f79450a2436`。

由上述观察编写 [固定 Script](../examples/kiwix-sample/scripts/h5-course-submission.js)，通过 [公开 CLI 控制器](../examples/kiwix-sample/validation/run-course.js) 连续运行。操作前重新观察并绑定当前页面、元素身份；Script 没有调用判题函数或直接写业务状态。

| 结果 | 本轮实测 |
| --- | --- |
| Script ID | `script-1789183779639-1` |
| 公开 start 到终态 | 20.999 秒，含两次外部判题读取等待；不含构建、探索、夹具准备和归档 |
| 终态与业务结果 | `completed`，`businessVerdict: passed` |
| 设备断言 | 6 passed / 0 failed / 0 inconclusive |
| 独立判题核对 | 错误 `[false,true]`，正确 `[true,true]`，两阶段各 7 项全部通过 |
| 进度与截图 | 78 条连续进度事件，3 张截图 |
| Script SHA-256 | `55d17dd9b9f5321d161836dcedda1fe24205565a377056bd2efa61acaa5089c0` |
| 夹具 SHA-256 | `b67f081c42ccb2fa39173f60fe472cbbfa00b5438af29bc00117e21eb869e434` |
| Script 归档 SHA-256 | `580f54244170724da5fbea2e09baa899545e08aefa6a51be5181b19c725ac11e` |

[独立读取器](../examples/kiwix-sample/validation/read-course-result.js) 只读取 App 原有 Vue/Pinia 判题状态，核对实际 solution、logs、hints、完成弹窗及 cheatMode。JSON 序列化将响应式对象转成 WebKit 可运输的数据；直接返回响应式对象的早期诊断遗漏了嵌套结果，不能作为判题明细通过依据。两份完整结果保存在外部文件，冻结哈希并关联 Script、Run actionId 和原页面身份。它们不是 Host 缓存，也不冒充设备 `ctx.assert` 证据。

## Bridge 改动及剩余范围

新增 `ios-set-orientation`，与 native Intent `setOrientation` 共用严格设备/App/进程/会话绑定和原 XCTest 完成回调。CLI/MCP/Script 共用同一能力入口；旧 Runner 明确拒绝。25 项针对性合同检查、WDA 真机签名构建、实际 Intent 横屏和 CLI 恢复竖屏通过。Script 旋转入口有受控集成测试；本轮真实业务 Script 没有重复旋转。

证据目录：

- 探索、构建、布局修正及业务 Intent：`build/ai_app_bridge_artifacts/ios-kiwix-run-20260912-01/`。
- 连续 Script、判题原始结果、截图及归档：`build/ai_app_bridge_artifacts/kiwix-course-script-20260912-01/`。

运行入口：`node examples/kiwix-sample/validation/run-course.js CONFIG.json`。配置包含新的 outputDir、显式 iOS target/WDA session、运行时 env，以及匹配当前文档的最终 fixtureReceiptPath。已有目录、旧文档夹具或未知控制器问题会被拒绝。

本轮关闭这个真实 H5 课程的实际提交关口。学习进度持久化、同屏多 WebView、全 iOS 业务及完整四 App/整机组合仍未验收；本轮读取的是原 App 运行中的判题状态，没有宣称持久保存。下一步复用已有固定 Script 推进组合执行与剩余真实业务缺口，不再重跑本项正向矩阵。
