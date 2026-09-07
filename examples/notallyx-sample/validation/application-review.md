# NotallyX application 边界独立审查

范围：只读 `/tmp/aab-app-selection-notallyx` 中正在迁移的 application 层与调用点；没有设备操作或业务文件编辑。以下是迭代期间发现及已发送实现代理的结果，不能替代迁移 APK/设备验收。

| ID | 发现与必要负例 | 复核状态 |
| --- | --- | --- |
| APP-01 | `move/update/changeColor/cleanupMissingAttachments` 先释放事务 gate 再执行 effects，可出现删除后旧 move 重新调度提醒。应把 commit→effects 全阶段放在 operation 内。负例阻塞 move effect，再并发 delete。 | 已看到外层 operation 修复及对应测试源码；未代跑 Android 测试。 |
| APP-02 | 旧 `migrateAllAttachments` 每个 copy 后删源，返回 failed 数却被忽略；中途失败会部分搬迁。 | 已改 VerifiedFileCopy 保留源并核对 SHA；纯文件故障测试源码已加入。 |
| APP-03 | 新 copyTree 若遍历整个 public media root，会包含该根下的 NotallyDatabase/WAL；下一次往返可能用过期附件目录副本覆盖最新 DB。 | 已看到只复制 images/files/audios 三子目录；仍需 public→private→编辑→public 往返业务负例。 |
| APP-04 | `moveData` 相等检查和 previousPublic 读取位于 gate 外，并发同向请求可能第二次 source==target，Kotlin copyTo(overwrite) 删除活动源库。 | 已看到整体 operation、gate 内状态检查及 canonical source/target guard；仍需存储往返/同向并发集成负例。 |
| APP-05 | `importAttachments` 把含 post-commit effects 的 update 包在清理 catch 中，effect 失败会删除数据库已引用文件。 | 已看到 SQL-only catch 与后续 effect 分离；需 effect 抛错→已提交文件 hash 仍存负例。 |
| APP-06 | 原 Gate 的 ThreadLocal owner 被子协程继承，两个 nested operation 同时进入；Java Semaphore 等待不能取消。 | 纯 JVM 复现先得到最大并发2、cancel不能及时join；修后并行 operation fail-fast、最大并发1、取消可join，串行 withContext 重入正常。 |
| APP-07 | Gate 改后同步 `read` 仍只锁短 monitor，不核对叶 Job；兄弟 read 可与持有 gate 的 operation 同时执行。 | 修为 OwnerElement 传递实际 Job 后，纯 JVM 重跑 readDuringSiblingOperation=false、parallelSiblingReadRejected=true；合法串行嵌套仍通过。 |
| APP-08 | 主文件备份/迁移依赖 checkpoint，但原实现丢弃 busy/frame 结果。 | 已看到检查 busy==0 且 frame 完整；需持有 reader→新写→备份负例，失败必须明确不可视作完整副本。 |
| APP-09 | public 模式 resetForReimport 仍只 deleteDatabase(内部名)，可能删错旧内部库后重导入活动公共库。 | 已移除 reset 路径，改先解析完整输入、再同事务 replaceFromDatabase；需 public+坏输入保留原库负例。 |
| APP-10 | 加密 transform 在 maintenance block finally 删除原库备份；若后续 reopen/ping 失败，默认空 rollback 无法恢复，锁元数据与文件不匹配。iv/key 初始化也在 gate 外。 | 已看到备份生命周期跨越 maintenance、rollback 恢复原文件及锁状态、enable/disable 外层 operation；open 失败注入测试由实现代理补充。 |

观察者方面，原 observeForever 路径已改为 lifecycle-aware MediatorLiveData/observe(owner)，没有凭源码认定仍存在相同泄漏。`DatabaseSession.observeFlow` 通过 LiveData.asFlow 异步切换，Main 上写 null 并不证明所有旧 Room Flow 查询已完成取消；这里是**待验证风险**。建议保留活动 Search/Label flow，令查询进行中触发 maintenance，保持同一 keyword 不重新输入，确认恢复后能收到新句柄数据且旧 observer 数归零。不能以 postValue(null) 作为“已排空查询”的证明。

Main deadlock：gate 内等待 Main detach 时，另一个 Main 同步 read 若阻塞 gate 可死锁。实现已增加 DatabaseSession.read 的 Main fail-fast，并保持 Main 同步 detach；现有同步查询调用点主要在 IO/Binder。需保持 exports 等新调用点的 IO 边界。

纯 JVM 证据：`GateProbe.kt`、`run-gate-probe.py`、`review-StorageOperationGate.kt`、`gate-probe-compile.log`、`gate-probe-result.log`。最新六个输出为：parallelSiblingRejected=true、nestedSiblingMaximum=1、sequentialNestedRead=true、readDuringSiblingOperation=false、parallelSiblingReadRejected=true、cancelledWaiterJoinedBeforeRelease=true。只编译隔离复制的 Gate，没有构建/安装 App。结果针对该 snapshot，不自动代表后续源代码。
