# NotallyX 应用数据与业务边界迁移

本轮以官方固定提交 `03ff809f058dbcabd5f0d20f114546686dfc9cb5` 为基线，保留 Room schema 11、原 Kotlin namespace 与业务数据格式；安装包使用隔离 applicationId `io.github.mobileaidev.notallyx.sample`。迁移的是生产调用边界和复合业务操作，没有新增数据库引擎。本说明覆盖源码、构建和 JVM/Robolectric 证明；真实设备结果见 `测试进度.md` 及带 APK hash 的运行报告。

## 已实现的边界

- `NoteApplicationService` 是笔记业务入口。编辑保存、批量移动/删除/复制/置顶/颜色、标签重命名与删除、任务父子勾选、附件导入删除、提醒编辑、外部导入及恢复导入集中在这里。复合 SQL 在 Room 事务内执行；通知、Widget、闹钟和文件删除在提交后执行。需要复合后效应的命令从事务开始一直序列化到后效应结束。
- `DatabaseSession` 持有 Room 句柄和维护生命周期。消费者得到值、LiveData 或 Flow，不持有 DB/DAO。维护在主线程解除 LiveData 源，关闭旧句柄，验证新句柄；失败执行回滚并尝试重新打开原数据。恢复过程不被调用方取消中断。同步存储读必须在后台运行。
- `StorageOperationGate` 使用可取消的协程信号量。串行嵌套操作可跨 dispatcher；并行子协程冒用同一嵌套所有权时明确拒绝。同步读同样检查真实 Job 归属，不再允许兄弟协程绕过互斥。
- `StorageMaintenance` 拥有数据库复制、存储目录切换、SQLCipher 切换与 schema 后数据修复的协调。WAL 检查点必须报告全部帧完成，才能复制主数据库文件。目录切换只复制 Images/Files/Audios 三个子目录并校验 SHA-256，保留源文件；同向重复切换是 no-op，源目标相同明确拒绝。加密前原件一直保留到新句柄打开成功之后；重开失败会恢复原件和锁设置。
- 备份与导入通过服务进入同一操作边界。保存后的备份不再创建无归属 MainScope，调用方会等待备份尝试完成；原增量 ZIP 损坏重试在锁内递归的问题改为当前锁内直接完整重建。
- 恢复 UI 不再删除数据库后再读导入源。它先完整解析，拒绝带不可读条目的恢复源，再在单一 Room 事务中替换笔记和标签。因此不再存在 public 模式误删内部数据库的问题。
- 附件补偿只在 SQL 未提交时删除新文件；提交后通知失败不会误删已入库附件。删除时按存储路径检查剩余引用，复制笔记共享的附件在最后一个引用消失后才删除；可访问的私有和公共副本一起清理。

静态计数必须区分口径：基线有 21 个生产文件包含 NotallyDatabase/DAO 依赖，其中 18 个是外部获取 DB/DAO 的消费者，另外包含 DB/DAO 自身和常量引用。当前生产依赖只在 application 的三个协调类以及原 Room/DAO 两个内部文件中，18 个外部消费者均已清零。Application、Activity、ViewModel、Widget、Receiver、Worker 不再持有 DB/DAO 或永久 DB observer。全量笔记 `Cache.list` 的生产读写也已移除。

## 有意义的行为修正

这次迁移并非只更换依赖名称。它消除了标签更新一半失败、移动后效应晚于删除而重建旧提醒、父子勾选并发丢更新、附件复制失败却切换活动目录、错误地把整个公共媒体根里的旧数据库复制回活动数据库、同向并发切换把源当目标覆盖、保存附件后通知失败误删文件等具体风险。测试使用真实 Room 行与文件内容判断结果，不以方法被调用或 HTTP 成功作为业务通过标准。

上游主分支的数据丢失公告仍是独立问题；没有证据证明本次边界迁移解决了公告所述的全部原因。

## 验证

冻结候选 APK：`.tools/business-app-migration-2026-09-07/notallyx-architecture-candidate.apk`。

SHA-256：`8252b6c0a4d36ce1a38c4056ba2bb5becfa63ca18803e7dde42de3116cb80836`。

命令从 AI App Bridge 仓库根运行，使用根 wrapper 8.13：

```sh
JAVA_HOME='/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home' ./gradlew -p examples/notallyx-sample :app:assembleDebug :app:testDebugUnitTest --max-workers=4
```

完整结果为 194 / 194 通过，0 failed、0 error、0 skipped，其中 178 项原测试、16 项新增测试。新增覆盖：

- 标签 SQL 中途失败时笔记/标签/偏好不产生半更新；无效任务位置不提交也不触发后效应。
- 两个任务子项并发勾选；移动的提交后效应与后续删除保持顺序。
- 维护异常后原数据重开、LiveData 换句柄、同一个搜索条件的 Flow 在重开后继续收到数据。
- 第一次新句柄打开失败后执行回滚再打开原库；非法恢复源保留原数据。
- 公共→私有→新编辑→公共的真实文件数据库往返；两个同向并发迁移仍保留最新数据库；附件目录不夹带数据库副本。
- 通知后效应抛错仍保留已提交附件；共享附件直到最后引用删除，两个模式副本都被删除。
- 独立操作序列化、取消等待者及时退出、串行跨线程重入、并行嵌套明确拒绝、第二个附件复制失败和内容校验失败仍保留全部源。

独立审查另用纯 JVM probe 验证并行同步读不能绕过 owner。日志与原始 XML 保留在 `.tools/business-app-migration-2026-09-07/architecture-build-tests-06.log`、`architecture-tests-06/`；源补丁、依赖审计与候选 manifest 在同目录。35 份业务源码/测试与临时实现 clone 逐字节一致，未改本轮 Gradle/SDK 接入文件。

## 范围与未证明项

这是一轮完整的应用存储依赖边界迁移，不是把整个 App 改为 Android 无关的纯领域层：Room entity、Parcelable、LiveData 和 Android 业务模型保留；CommonDao 内原有导入去重/链接重映射实现仍作为存储内部实现使用；编辑器富文本和列表 UI 状态仍在展示层。Application 的进程级偏好观察者也保留，不能概括成全 App 没有 observeForever。

尚未由本轮 JVM 证明：真实设备生物识别和 SQLCipher enable/disable、SAF 授权撤回、真实磁盘空间不足、老系统行为、杀进程/断电发生在加密文件替换中间的自动恢复。文件系统、偏好和 SQLCipher 替换没有新增持久维护日志，因此不声称跨断电事务原子性。目录迁移保留源附件会增加磁盘占用，后续只在确认无引用时清理。提交后外部通知失败不会回滚已提交业务数据，错误仍可向调用方传播。

完整业务是否保持、旧数据库原地升级后是否可用、备份/恢复和真实加密链是否成立，必须继续用冻结基线和候选的同一真实数据完成真机验收，不能用这 194 项测试替代。
