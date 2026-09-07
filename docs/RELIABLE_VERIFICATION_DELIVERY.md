# 可靠验收最小交付

日期：2026-09-07。基于当前 `codex/script-intent-isolated-rebuild` 工作区，保留既有未提交修改；不回退、不发布。

## 路线与边界

主线是稳定设备桥、可选连续 Script、可靠证据接口。现有观察与动作能力继续复用；Intent 是外部 Agent 的探索协议，不自动生成 Script 或报告。近期不扩展消费者助手、端侧模型或新的存储引擎。

此交付按路线评估中发现的实际反例修正原计划的验收范围。`SCRIPT_INTENT_RUNTIME_CAPTURE_MASTER_PLAN.md` 与 `MOBILE_CAPTURE_STORE_UNIFICATION_PLAN.md` 仍定义运行时隔离、移动事实所有权、Legacy 并发等合同；历史 Gate 的通过不能覆盖这里尚未验证的生产缺口。

## 完成条件与当前状态

| 工作 | 必须证明 | 状态 |
| --- | --- | --- |
| 工作区保护 | 原有文件与修改均可追溯恢复 | 完成：`.tools/implementation-2026-09-07/before-worktree.zip`、manifest、diff |
| 真实执行恢复 | 缺 provider 明确失败；prepare/receipt/terminal 持久化；不重复不确定副作用；恢复保持 target/permissions | 已修复；真实 Node child 与故障注入回归通过，非真机栈恢复承诺 |
| 设备断言 | Host 签发本轮证据；旧、伪造、缺失证据不能 passed；纯代码断言独立统计 | 已修复；负例通过，Host 仅保留有界 metadata/hash |
| Android 持久查询 | 实际四流 HTTP 读取已提交磁盘事实；分页、epoch、窗口、stable refs 与 clear 语义一致 | 0.3.0-rc.1 实现、113 项 Android 测试及下述真机生命周期通过 |
| Host 生产接线 | CLI/MCP/Script/Intent 传递相同窗口与目标，保存真实响应元数据 | 已接通实际 HTTP/CLI/MCP；拒绝 Intent 查询目标覆盖及读端口动作注入 |
| 验收资产 | P9 不使用操作前树判操作后成功，不以 completed 默认所有业务通过 | scorer/fixture 已修正；未重跑的历史 App 成绩保持未验证 |
| 真机闭环 | UI → 请求/状态 → 结果 → ref 重查；淘汰、重启、运行时不可用、clear 与负例有证据 | sample 4 正向 + 3 负向通过；6 生命周期检查通过；clear 后重新完整闭环通过。未物理拔 USB/断电 |
| 公平对照 | 相同任务比较既有 batch、普通 JS、Script，区分探索/编写与回放；至少一个未参与实现流程 | LocalSend 新链接接收/返回流程，3 轮交错共 9/9 正向、9/9 错误期望拒绝。无模型费用结论 |
| 包与迁移 | 测试 Fake 不在生产默认或发布包；版本、支持范围、独立目录安装执行 | 本机独立目录 native 编译/重开/MCP/Script 通过；最终包身份见安装报告，无公开发布 |
| 平台合同 | Android/Flutter 按实测声明；iOS 旧能力保留，新强证据按相应验证范围声明 | iOS 强查询明确 persistence_unavailable；24 项 macOS Swift 定向检查通过，无 iOS 真机承诺 |

## 明确的验收语义

- `completed` 只表示执行终结，不等价于业务验收通过。
- `scope: 'code'` 是纯代码断言；默认设备断言要求 Host 签发的可追溯观测。通过的谓词仍由脚本作者依据需求定义，Bridge 不理解任意布尔表达式的业务含义。
- UI 观测按获取时点与动作序列绑定。截图与树各证明相应内容，不能用新截图给旧树背书。
- 移动四流的 live/history 从手机在线读取。Host 不用断连前的 payload 假装当前结果。磁盘提交、保留完整性与分页是否结束分别表达。
- `view: 'decision-window'` 面向本轮；`view: 'connected-history'` 面向连接状态下的持久历史。未指定 view 的 Legacy JSON 外观保持原合同。
- 移动 SDK 签发 `runtimeEpoch`、`watermarkCursor`、`nextCursor`、`mobileFactId`。Host 原样保留实际 query window、coverage 与错误，不根据请求回显发明成功证据。
- 前置观测的 `watermarkCursor` 可在动作后以 `factCursor` 查询；它定义时间顺序边界，`afterActionId` 只提供动作关联，业务因果需要匹配实际请求或业务字段。
- 启动挂接持久后端前丢失的记录会保留 loss fence。用手机 `status.updatedAtMs` 建立新 `sinceMs` 窗口，并在后续 cursor 查询中保留该值；cursor 本身不会抹掉历史 loss fence，新窗口内丢失仍为 partial。
- `restartPolicy: 'none'` 默认不跨 Host 恢复。checkpoint 恢复只支持显式可重入模板；尚未纳入 checkpoint 的副作用、未匹配 prepare/receipt 或无法确知提交结果必须先 reconcile，禁止自动重放。
- 已完成/取消的执行不允许通过 resume 再次触发副作用。恢复目标与权限以持久记录为准。

## 验证与证据记录

后续每项补充实际命令、结果、代码版本/工作区标识及产物位置。模拟 provider 的真实 child/文件重开测试能证明执行协议，不能代替真机业务验收；HTTP 集成测试能证明参数和响应接线，不能代替手机磁盘生命周期验证。

设备范围锁定为 Android `b46093e6`（OnePlus PKR110，Android 16）；只使用项目 sample 与已纳入验收的 debug App。iOS 或更多设备必须另行记录实际目标。任何尚未执行的检查保持未验证状态。

## 已复现并修正的集成缺口

- 生产存储 open/maintenance reopen 必须通过实际生命周期回调挂接；`status.capturePersistence` 公开真实 open code/message、attachment 和 lifecycle 状态。
- 原 C 写入的 sealed segment 可以有小于帧头长度的全零尾部。真实旧 sample 文件有 2545 个有效帧和 16 字节零尾，新 Mapped reader 曾误判 torn tail；现接受合法零尾，非零短尾仍拒绝。旧 manifest 和两段原文件已只读取证，不宣称完整旧 store 已重开验收。
- 四流查询按所属分区读取，并正确遵守全局 afterSequence；不扫描不相关的 logcat 分区。仍未完成所有保留规模和设备上的性能验收。
- UIA 读取曾在 dump 失败时返回旧文件，导致首页被判成旧链接页；现在清除旧文件并检查本次 dump 结果。失败对照记录保留，不能用重跑覆盖。

## 尚不承诺的能力

- 多页结果合并成强设备断言；当前仅完整单页可参与强断言，分页读取和 exact ref 重读是独立能力。
- 任意断电前未 flush 事实不丢、恢复任意 JS/Python 调用栈、未核对副作用自动重放。
- iOS 新持久证据链、所有 App/Android 版本/机型的验收，以及干净机器和多操作系统安装。
- 旧 hot-query 延迟门槛已达标。最终 Android JVM 1000 条盘查 p95 约 39.94 ms；它不是手机时延，也不是热缓存命中。
- Script 必然比 batch 或普通脚本快、节省模型调用或降低总开发成本；需要相同任务的实际测量。

## 本轮完成判断

本文件定义的可靠验收最小交付已完成，阶段提升为可内部验证的 Android 本地 RC；不等价于旧主计划所有平台、性能和发布 Gate 全部通过。完整命令、失败记录、真机范围和下一步决策见 `RELIABLE_VERIFICATION_RESULTS_2026-09-07.md`，包身份见 `INSTALLATION_VALIDATION_2026-09-07.md`。
