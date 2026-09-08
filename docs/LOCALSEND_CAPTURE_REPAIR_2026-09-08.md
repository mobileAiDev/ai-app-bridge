# LocalSend 暴露的 Android 当前窗口采证问题

本轮交付对象是 Bridge。LocalSend 的业务代码和独立作者冻结的 v1.0.5 Script 没有修改；修复的是 Android 手机事实读取及游标边界。完整手机业务采证仍取决于 Flutter 动作关联等后续关口。

## 原问题与根因

在 PGFM10 `FYZLAU49X8OVQGJ7`、独立包 `org.localsend.localsend_app.bridge_sample` 的原进程中，`GET /v1/status` 用时 70 ms，但 `events?sinceMs=当前时间-1000&limit=200&view=decision-window` 用时 10056 ms，返回 `capture_scan_deadline`。同样的 logs/state 查询也耗尽约 10 秒；旧的事件游标查询则在 147 ms 返回一页。原进程最初保留约 108 MiB 手机证据。

原因是 `SegmentedCaptureBackend` 虽然收到了时间下界，仍从当前 attachment 的起始 sequence 扫描并解析载荷，再检查时间和流类型。共享分区中的普通日志也被反复读出后排除。SDK 的 10 秒扫描截止仍会触发，Host 的 HTTP 超时不会由 `limit=200` 自然消失。单线程 HTTP 服务会占用同一个请求处理线程；本轮没有把所有历史 20 秒 Host 超时都单独归因。

另一个问题是历史 loss 判断只看时间和 capture ID，未识别已经发给调用方的新 watermark。直接用旧的 sequence 判断也不足以修复：一次 enqueue 丢失可能没有推进任何 committed sequence。

## 实现和契约

- 新增 `CaptureReadIndex`：仅保存当前 attachment 各流的前缀最大时间、最大 capture ID 和 committed sequence，每 128 条或 64 KiB 建一个位置记录，每流最多 512 个。它不保留 payload，不替代磁盘事实，也不在 Host 建手机数据副本。
- 位置记录只在真实 writer 提交回执后更新。查询在同一 writer barrier 截取 committed 上界、读取位置和 loss 状态，跳过已经证明不符合当前时间/ID 窗口的前缀。时间或 ID 倒退时仍使用前缀最大值，保证不会漏掉符合查询条件的记录。
- 没有该流 capture 记录的当前窗口可越过共享分区的普通记录。历史/ref 查询保留原有磁盘范围；本轮没有宣布无界历史扫描性能通过。
- Android 发出的 opaque cursor 升级为 `cf3`，绑定 writer barrier 观察到的 loss revision。新丢失会改变 revision，即使 sequence、历史时间最大值、capture ID 最大值都没变化，也会继续报 gap。分页的 `nextCursor` 不确认尚未读完的窗口损失。
- 旧 `cf2` 游标明确返回 `invalid_capture_cursor`。升级、清理或进程重启后，应从新的有界 pre-action 页面取得 watermark；不得手改游标。持久化事实身份和旧归档不重写。重新 attachment 不沿用旧进程的 loss 确认；历史 loss 元数据仍保留。
- `run-evidence-reuse.js` 现在要求显式 `--apk-sha256`，每轮核对实际安装包，避免拿旧 APK 固定值验证新 SDK。Script 动作、预期和作者归属保持不变。

## 回归测试

真实 mapped store 的回归先得到三种失败，再修复通过：最近 3 条事件查询读了 1201 个物理记录；新游标被历史 loss 污染；大记录场景读了 23 个载荷而不能控制额外扫描字节量。

最终 Android 全量 119/119 通过，Host capture 相关 28/28 通过。覆盖近期读取、普通共享分区记录、大小载荷、倒退时间、乱序 ID、同 sequence 新丢失、回退时间/ID 的新丢失、分页 loss、真实分段淘汰、清理、重启、并发写入和确切 ref 读取。没有增加 App 业务功能。

证据根目录：`build/ai_app_bridge_artifacts/localsend-capture-repair-2026-09-08/`。最终构建清单及源码副本分别是 `build-freeze-final.json` 与 `final-source/`。

| 冻结项 | SHA-256 |
| --- | --- |
| 最终 APK | `80e2174f7c89fdf904e99f00501d2fbe222d0f2385d07c55daf4df8af2d9ec66` |
| Android AAR | `9111c1b7c6151d5ae0015370405c2a22de3843d4a6fd303b3994be086c393560` |
| 独立 Script v1.0.5 | `e193188913c89c76cd30769e09c70887cec74c2df5bed60475cf8937a29aa985` |

## 最终 APK 的真机读取检查

`final-sdk-stress/report.json`：同一 PGFM10、相同数据目录，runtime epoch 为 `1788850723017-61f3ac01-7632-4476-8953-d7ac26637ec9`。本轮没有清数据。再次发出 2500 次、每条含 16 KiB 填充的合成事件 POST；这表示实际 HTTP 回执数，不表示逐条全量离线验收了 2500 个事实。随后按末条记录的真实时间和 ID，从 committed 磁盘页核对其完整载荷，耗时 45 ms。

5 轮 `events/state/logs` 各执行时间窗口和原样返回的 watermark 游标窗口，共 30 次，全部为 `complete / gap:false / committed:true / hasMore:false`，最小 12 ms、P95 58 ms、最大 84 ms。合计 31/31 检查通过。原进程追加负载后的三个时间窗口分别为 10020、10071、10046 ms 且返回扫描截止。

这些是经 ADB 转发的 HTTP 小样本端到端测量；P95 58 ms 仍不能宣称达到总计划中的 50 ms 查询目标，更不替代长时间运行、并发请求或跨设备性能验证。存储命名空间及 generation 保持原值，旧 loss 元数据没有清空；新游标确认的是当前 watermark 之前已发生的 loss。

## 冻结 Script 的实际回归

`build/ai_app_bridge_artifacts/localsend-script-2026-09-08-matrix-4/report.json` 使用上述最终 APK 和原 v1.0.5 Script，6 轮都符合 UI/控制/恢复/归档门禁。

| 运行 | 用时 | UI 断言通过/失败 | 手机读取页完整/请求数 | 手机断言未定 |
| --- | --- | --- | --- | --- |
| core | 55.762 秒 | 69 / 0 | 6 / 6 | 2 |
| 正向 1 | 1 分 40.007 秒 | 143 / 0 | 18 / 18 | 7 |
| 正向 2 | 1 分 43.217 秒 | 143 / 0 | 18 / 18 | 7 |
| 正向 3 | 1 分 38.305 秒 | 141 / 0 | 18 / 18 | 7 |
| 故意错误预期 | 0.443 秒 | 1 / 1，预期失败 | 0 / 0 | 0 |
| 检查点取消 | 24.015 秒 | 39 / 0 | 6 / 6 | 3 |

合计 66/66 手机页面为 complete、committed、无 gap，没有 HTTP/采证读取失败。归档包含 67 个手机页面项目；这是各次读取的项目计数，未宣称全局去重的业务事实数。实际检查动作后非空 events，读到的是 `ui.interaction`、`ui.stable`、`ui.animation.started`、`ui.changed` 等触摸/UI 观察事实，不能因此宣称 Flutter 设置语义或业务日志已经具有正确 actionId。

三个正向各有 3 个独立偏好检查点。总计 21 份偏好读数和 6 份完整 MCP 执行事件在 `matrix-4/portable-settings-and-events-review/` 通过复制、哈希、取值、目标及检查点时间核验；该报告 SHA-256 为 `c1f30228f224cae83df6579160d2841210c76074d25cfe68970619a6068c15ab`。这些外部文件是独立伴随证据，不冒充 Bridge 导出内容。

6 份 Bridge 归档在原 Host 退出后，使用复制目录、新 MCP、不可用 ADB 和不可打开的 Host FactStore 完成核验。错误设备名在 0 次变更前被识别；取消之后没有新设备调用；6 轮前后偏好都与固定基线一致。最终独立 Intent `intent-1788851371462-1` 恢复了接收页，真实截图和偏好读数保存在 `localsend-script-2026-09-08-restore-7/`。清理归档 SHA-256 为 `67ccae2da8680a7169dabe33cedf3d6b87958adc317e9cb4612fa9dece4eaece`，亦通过离线核验。随后原始时间/游标检查再次 6/6 通过，耗时 10–40 ms。

完整采证结论仍为 **inconclusive**，原因已从读取超时推进到业务语义证据和跨包关联。上述耗时仅属于冻结的 LocalSend 场景，不是全 App、整机回归或 Intent/Script 对照基准。

## 保留的诊断过程

- `before-query-repro.json`、`before-comparison.json`：原进程的最小失败和游标对照。
- `regression-before.xml`、`large-fact-regression-before.xml`：三项修复前失败；`android-final-test-results/` 是最终测试结果。
- `old-sdk-stress/`：完成 2500 次合成事件 POST 后，检查器因本机 Python 3.9 不支持 `hashlib.file_digest` 退出，尚未做读取断言；没有将其记作 SDK 读取失败。修正检查器后，`old-sdk-after-load/` 的三个当前窗口都实际返回扫描截止。
- `new-sdk-stress/`：第一版修复的 30 个时间/游标窗口全部成功；单独的 `sinceId` 末条记录检查仍有启动 loss 的 gap，整份报告保留失败。该 loss 没有已知当前 epoch 的 ID 上界，不能用较大的 ID 擅自忽略。检查器随后为“末条记录的时间窗口”显式使用该记录的真实时间和 ID，`new-sdk-stress-2/` 的 31 项通过。没有改 SDK 的 gap 结论。
- 后续针对大载荷的额外扫描修复独立冻结了最终 APK；上述中间 APK、源码和报告均保留。

所有合成事件都带 `bridge-validation/capture-window-stress` 标记，仅用于存储压力和真实写入载荷检查。它们不是 LocalSend 的业务行为或 Flutter actionId 关联证据。覆盖安装保留了原数据；新旧 APK 的 runtime epoch 不同，因此毫秒对照不是同一进程的严格性能基准，也不是 Intent 与 Script 的速度比较。

## 下一关口

继续补 Flutter actionId 的真实因果作用域并验证业务事件，不得把后台事件统一标成最近一次 action，也不得用新增一条“Bridge 已执行”日志充当设置变更事实。独立偏好读取和 UI 结果仍需保留。手机证据链收口后再进入 iOS；受控无 peer 网络、真实文件传输、执行中动作取消及整机组合仍沿[总关口](BRIDGE_NEXT_GATES_2026-09-08.md)推进。
