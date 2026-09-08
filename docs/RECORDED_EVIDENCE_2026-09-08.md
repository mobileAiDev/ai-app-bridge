# 显式证据文件采集与离线归档

本轮已完成 Bridge 的显式采证扩展及公开入口真机验证。交付对象仍是 Intent → 证据 → Agent 编写 Script → 重复回归这条链路；没有修改 NotallyX 业务源码或冻结的作者 Script。整体路线与下一轮边界见 [Bridge 后续关口](BRIDGE_NEXT_GATES_2026-09-08.md)。

## 本轮改动

- `script start` 和 `intent start` 可显式指定新目录 `recordingDir`。默认不采集额外文件。
- Script 在 Host 返回 child 前保存完整调用结果、请求参数/options 和 Host 断言结果；截图按当次 SHA256 立即复制，不依赖原路径之后仍存在。
- Intent 保存已有 `require` 查询取得的完整 capture pages/items，关联到已持久化的 raw-tree observation。未请求的流不额外采集，Intent 不自动新增截图。
- Host FactStore 增加轻量 `attachment` 引用，手机载荷只保存在明确请求的单次文件输出中；live/history、断连和恢复路径均不读取这些副本。
- `evidence export` 的 `includeRecordedPayloads: true` 生成 v2 可搬移包；`verify` 重新校验文件、来源绑定、断言关联和手机 item/ref 字段。JSON 沿用凭据脱敏，并区分原始/脱敏后 hash。

没有新增常驻归档服务、手机离线查询库、自动生成 Script 或报告的业务命令。容量、重启、失败与完整性范围见[公开契约](../desktop/ai-app-bridge-cli/docs/EVIDENCE_ARCHIVE.md)。Script 采证当前仅接受 `restartPolicy: none`；已淘汰的附件引用、未查询事实、在途调用和内存事件不重建。

## 最终真机回归

设备 PGFM10 / `FYZLAU49X8OVQGJ7`，Android 16；APK 和初态沿用已有夹具：

- APK SHA256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。
- 冻结 Script SHA256：`1ea38097ca7607ed1380103946978e79e225cd0a956e7b4edc4bf55fe4187f77`。
- 初态 snapshot：`5d50312d-9d71-44dd-87b8-5f03272613f8`。
- 最终产物根目录：`build/ai_app_bridge_artifacts/recorded-evidence-2026-09-08/`。

正式搜索回归为 `script-runs-final/report.json`，五轮完整控制器耗时 **152.081 秒**，包含前置核验、执行、证据导出、运行后独立业务数据库比对及两次新进程离线核验。

| 运行 | Script 执行耗时 | Host 断言 | 独立结论 |
| --- | ---: | --- | --- |
| positive-1 | 26.496 秒 | 84 passed | 通过 |
| positive-2 | 26.803 秒 | 84 passed | 通过 |
| positive-3 | 26.426 秒 | 84 passed | 通过 |
| wrong-expectation | 6.093 秒 | 18 passed / 1 failed | 错误预期被拒绝，后续业务动作未执行 |
| cancel | 10.480 秒 | 35 passed | 等待 Agent 时取消，后续业务动作未执行 |

共归档 **507 个调用、306 个断言结果、77 次截图引用、276 次树读取**，包含 895 条 Host 持久记录、36 个动作。包内载荷文件共 63,216,508 字节（包内相同 SHA 的截图复用同一文件，77 是调用引用数）。调用 envelope 与冻结作者自行保存的结果逐一相等，断言/截图数量一致。五轮前后业务数据无差异，未忽略字段。

两次新的 MCP 进程在 FactStore 目录不可用的情况下对五包完成公开 `verify`，然后执行原有动作顺序、参数与终态独立审查。归档文件未变化。手动查看了 positive-1 包内的 6 张 PNG：唯一标题、正文搜索的三页、空结果与返回首页；五个预期标题并集和终态一致。首页 FAB 遮挡最下方卡片的一部分是既有样例布局限制，未扩大为 App 修复任务。图片清单及 SHA 见 `visual-review.json`；未声称逐图复核其余截图。

## 真正的手机 capture 载荷

`mobile-capture-final/report.json` 为当前代码的公开 MCP 验证，耗时 7.947 秒。手机库就绪后，经返回桌面并重新进入 App 产生真实 `ui-observer` 事件，没有用 HTTP 注入合成事件。

- 当前 epoch：`1788833121431-b44ecb91-9d42-4e08-9305-d7043019990e`。
- 实际事件：`ui.changed`，captureId `23`，timestampMs `1788833128109`。
- Script：保存两次 events 调用，一次真实载荷读取 passed；不存在的 mobileFactId 保持空载荷和 inconclusive，执行正常结束。
- Intent：在本轮观察中保存同一条实际 item/ref，并关联到 raw-tree observation。
- 两个包复制到新目录后，经两次全新 MCP 离线核验，使用不可用 FactStore 路径和没有 ADB 的 PATH；内容及统计与原 export 一致。
- 此处证明的是 events 载荷。样例没有产生可用的业务 logs/network/state 事实，本轮不把空流计作三条额外真机证明。

公开复跑入口：

```sh
node desktop/ai-app-bridge-cli/scripts/validation/recorded-capture.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial FYZLAU49X8OVQGJ7 \
  --package io.github.mobileaidev.notallyx.sample \
  --out /absolute/existing-parent/new-capture-run
```

## 保留的失败尝试和范围

- `script-runs/` 在正式执行前被重接 USB 后的系统弹窗挡住；原前置检查拒绝继续。公开 keyevent 关闭弹窗，重新从固定数据起算；未改脚本绕过前置条件。
- `script-runs-r2/` 是中间实现的完整通过记录；`script-runs-final/` 才是最终代码的五轮结果。
- 手机采证最初碰到 `attachmentState: opening`，只有内存 items、没有 refs；随后就绪但当前 epoch 尚无持久事件。验证工具增加显式就绪等待和真实生命周期切换。一次工具漏授 `capture.read` 也被 Host 明确拒绝，已修正工具权限。
- `mobile-capture-r4/` 在手机 `1gb` profile 下，无游标的 `connected-history + mobileFactId` 请求约 20 秒后发生 HTTP timeout。根因尚未定位，不能仅凭 profile 推断实际历史规模或磁盘问题。该失败原样保留；最终验证明确使用当前 `decision-window`，不宣称历史查询已通过。归档导出本身不重新查询手机，此问题归入下一阶段可靠性关口。
- v2 包的完整性不等于整个执行历史完整，更不等于业务全部通过；Host 判定的条件仍是脚本作者提供的条件。动作执行中取消、物理断连、iOS 真机和多 App 泛化仍是后续工作。

## 软件检查

- Host：`npm test -- --test-concurrency=1`，**756/756** 通过，日志 `.tools/recorded-evidence-2026-09-08/host-tests-final.log`。
- 样例验证工具：**138/138** 通过，日志同目录 `validation-tests.log`。
- 新检查覆盖事件裁剪后的全调用保存、截图覆盖/损坏/缺失/symlink、来源与手机引用错配、脱敏 hash、错误断言保留、写入失败阻止后续动作及不支持的采证重启。
- `npm pack --dry-run` 包含 82 个文件，确认新增两个归档模块和公开文档随包交付；未发布 npm 或推送 Git。
