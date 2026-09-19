# 改善版本 V1：公共返回合同与实现边界

日期：2026-09-19。状态：配套整体方案第 6 版，M0 接口基线已确认，可按工作包实施；下面均为 **0.4.0 目标行为，当前 0.3.8 尚不支持**。本文件是参数、返回、快照、预算语义的唯一设计来源；工作顺序和放行条件见 [整体方案](IMPROVEMENT_RELEASE_V1_2026-09-18.md)。完整测试与限额校准随 M2 实现完成，不要求先做一套完整原型再重做正式实现。

## 1. 公共请求

MCP `run` 与 CLI 的普通命令共享合同：顶层必填 `extract`，CLI 用 `--extract '<JSON>'`，不提取时显式 `--extract null`。公共 `extract`、`output` 与业务 `arguments` 分离，不进入设备动作参数、requestId 摘要或动作去重身份。缺字段、错误类型、非法选项均在派发前拒绝，不默认补 null。

CLI 在命令专属 `parseCliOptions` **之前**，先取出 `extract`/`output`，按 JSON 各解析一次并移出业务 options，再使用同一公共 schema 校验。`--extract null` 必须得到 JSON null；`--extract` 未带值（末尾或后接另一 flag）按缺少必填值拒绝，不能沿用当前 parseArgs 将无值 flag 变为 true 的行为。非法 JSON 与 JSON 字符串 `"null"` 均拒绝；MCP 已传 JSON，不再做字符串转换。

Script 的内部 `ctx.call`、Intent 内部观察/执行和 provider 调用沿用内部合同；它们不因此增加必填字段。公共 Script/Intent start、wait、status、result 都适用本合同，但 start 只处理当次启动响应，不能隐式等待任务结束。

`runtime status/stop` 和离线 `evidence verify` 等客户端本地路径同样经过公共验证和返回处理；verify 保持离线，不因提取启动 Runtime。独立 capabilities、CLI help/version 不要求 extract；它们的发现输出预算见第 5 节。

### 1.1 MCP run schema

下列完整工具声明用于 M0 大小基线和后续 schema 对照。复用现有 `shared-kernel/argument-schema.js` 的 `validateValue` 校验，其 oneOf/anyOf/allOf 已能表达本 schema，无需另建 extract 结构校验器。业务参数继续按所选 command/operation 校验，动态命令 schema 不整份塞进 tools/list。`maxLength` 是字符限制，源码另外执行 UTF-8 字节上限校验；重复 flags、正则编译、路径和解释器等语义预检仍须补齐，不能把结构校验通过等同于可执行。

```json
{
  "name": "run",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["command", "extract"],
    "properties": {
      "command": {"type": "string", "minLength": 1},
      "arguments": {"type": "object", "additionalProperties": true},
      "extract": {
        "description": "Required. Use null for this command's result within the output budget, or regex/script to extract a smaller result on the Host. Execution and control facts remain separate. On overflow or extraction failure, use a returned response ref to retry extraction; do not repeat the action.",
        "oneOf": [
          {"type": "null"},
          {
            "type": "object", "additionalProperties": false,
            "required": ["mode", "pattern", "inputPath"],
            "properties": {
              "mode": {"const": "regex"},
              "pattern": {"type": "string", "minLength": 1, "maxLength": 2048},
              "flags": {"type": "string", "pattern": "^[imsu]*$", "description": "Unique JavaScript RegExp flags. The Host returns all matches; g/y are not accepted."},
              "inputPath": {"type": "string", "description": "JSON Pointer to a string in the response. Empty string selects a text response."},
              "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 10000}
            }
          },
          {
            "type": "object", "additionalProperties": false,
            "required": ["mode", "language"],
            "properties": {
              "mode": {"const": "script"},
              "language": {"enum": ["javascript", "python"]},
              "source": {"type": "string", "minLength": 1, "maxLength": 65536, "description": "main(ctx). ctx.inputs contains kind, response, execution, control. Return a JSON value."},
              "sourcePath": {"type": "string", "minLength": 1, "description": "Resolve from the caller cwd and freeze source before dispatch. Exactly one of source/sourcePath."},
              "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 10000}
            },
            "oneOf": [{"required": ["source"]}, {"required": ["sourcePath"]}]
          }
        ]
      },
      "output": {
        "type": "object", "additionalProperties": false, "required": ["maxBytes"],
        "properties": {"maxBytes": {"type": "integer", "minimum": 16384, "maximum": 262144}}
      }
    }
  }
}
```

`extract` 的 required 和 description 必须随 MCP tools/list 暴露，不能只做服务端验证。提醒效果是待检验的行为假设；必填不等于模型必然选择提取。超预算反馈与按 ref 重读构成后续引导。

### 1.2 提取规则

| 模式 | 输入 | 输出与限制 |
| --- | --- | --- |
| null | 当前命令自己的响应 | 不运行提取器；保留查询过滤、compact、分页与原命令已有处理；不代表无预算或设备全部数据 |
| script / javascript | `main(ctx)`，沿用现有 JS 导出方式 | 返回严格 JSON 值；source/sourcePath 恰好一个，源码最大 64 KiB UTF-8；不存在隐式 stringify |
| script / python | `main(ctx)`，沿用现有 Python 函数方式 | 同一 JSON 输入/输出合同；返回的整数超出 JSON/JS 安全整数范围时，Host 报提取类型错误；需要字符串由脚本显式转换 |
| regex | inputPath 用 JSON Pointer 选中字符串；`""` 选根文本 | Node 的 JavaScript RegExp，允许不重复的 i/m/s/u；全部匹配，最多 1,000 项；无匹配为 `[]` |

regex 每项固定为 `{match, groups, namedGroups}`：match 是完整匹配；groups 为捕获组数组；namedGroups 为命名组对象，没有命名组则 `{}`；未参与的捕获为 null。零长度匹配按 Unicode 标志正确推进；g/y 由 Host 控制。指针不存在、非字符串、重复/非法 flags、正则编译错误、匹配数超限分别报错，超限不返回伪装完整的部分列表。匹配输出仍受输出字节上限约束。

脚本输入固定为 `ctx.inputs = {kind, response, execution, control}`，四项全部来自第 3 节固定的同一命令响应：kind 是源结果类型，response 对应快照 value，execution 是原命令执行事实，control 是其控制信息。即时提取和按 ref 重读使用同一输入；重读的 execution 输入仍是原命令事实，公共返回另表达本次读取是否成功。提取器无 Bridge 设备 RPC、progress、askAgent 或嵌套 Script 生命周期；控制区由 Host 保留，修改输入副本或返回 `{ok:true}` 都不改变原命令结果。拒绝 undefined、循环引用、非有限数字、函数和其他不支持的 JSON 类型，不静默替换。

提取返回值中的整数，包括嵌套数组/对象中的整数，必须在 `[-(2^53-1), 2^53-1]` 内，越界报提取类型错误并指出值路径，不自动转字符串。Python 的检查放在提取 worker（复用时为 `script-sdk.py` 的提取返回路径）调用 `json.dumps`、写出 IPC **之前**；JS `JSON.parse` 会把 9007199254740993 静默读成 9007199254740992，不能靠接收端事后检出。布尔值不按 Python int 子类误判，非有限数和非字符串对象 key 同样在序列化前拒绝；JS 提取返回按相同整数边界检查。调用方需要大整数文本时自行 `str()`/显式字符串转换。

sourcePath 按调用方 cwd 解析，CLI/MCP 必须明确传递该 cwd，Runtime 不能用自己的启动目录替代。读取、字节限制、解释器可用性及语法检查在业务派发前完成并固定源码。仅做解析/编译检查，不执行用户顶层代码进行所谓预检；路径内容之后变化不影响本次运行。基于实际结果类型的错误只能在拿到响应后报告。

JSON 与文本提取是首版范围。二进制/媒体本体不运行提取器：可事先判定的类型在派发前拒绝，运行后才确定的类型报告提取不支持并保留执行事实。已有 JSON 路径/元数据仍可提取。null 的 bytes 以 base64 放入公共 JSON；超预算时使用已有可验证的二进制产物引用，若不存在则 unavailable，不虚构 JSON 快照或改成 UTF-8。

## 2. 公共返回

公共对象字段如下；这是新公共响应合同，必须同时迁移 CLI/MCP 解析器。兼容信息由已有包版本、Runtime 身份及代码指纹提供，正文不再增加一套独立 protocol 标识。

| 字段 | 合同 |
| --- | --- |
| command | 本次公共请求的命令名 |
| execution | 原命令的 ok/error 与实际提供的 dispatched、ambiguous、settled、目标及动作回执；未知保持未知，不能从“未看到失败”推断成功 |
| control | operationId、status、revision、eventSequence、resultRef、等待/续跑所需字段、分页游标、来源/时间、采集截断、覆盖及 history；仅在命令提供时出现，按公开命令的既有字段建立小清单 |
| control.source | 本次响应身份、捕获时点和保存结果；persisted=true 时才有可读取 ref；保存失败带 error，未尝试写明 not_requested/offline 等原因 |
| extraction | status 为 skipped/succeeded/failed；模式、耗时、独立错误和有界诊断；null 为 skipped |
| delivery | status 为 inline/reference/unavailable，limitBytes、valueBytes，以及超限等 reason；最终正文字节另在测量记录中统计 |
| kind / value | kind 为 json/text/bytes；成功交付时 value 可以是合法 null；未交付时省略 value，由 delivery.status 明确区分 |
| failureStage | 仅发生公共失败时出现：validation/execution/extraction/delivery；多处失败按此前后顺序定位首要失败，三段具体事实仍保留；快照读取失败归 execution，不冒充原动作失败 |

以下原则约束具体编码，不允许 Adapter 再定义一套结构：

1. Runtime 的公共边界组装并序列化一次；本地路径使用同一个处理模块。CLI stdout 是该紧凑 JSON 加一个换行，MCP `content[0].text` 是该紧凑 JSON。预算不含 CLI 换行、JSON-RPC 转义和 MCP 固定外壳，这些另记传输指标。
2. MCP 不重复输出同一封套的 structuredContent、正文 `_history` 或 `_meta.history`；Runtime 独立 reply.history 只放进 control.history。Script/Intent 原 value.history 属于源内容，保留原位置，其页控制信息按 §2.1 单独保护，完整历史列表不复制进 control。普通 execute 的公共封套作为现有内部 reply.value 传递，复用 kind/value 编解码；CLI/MCP 取出这份公共封套交付，不把内部传输外壳再次输出。内部 status/stop RPC 沿用现状。不能把新字段挂在旧 reply.value 旁边导致丢失，也不为这次改动重建 Runtime 传输协议。
3. 原命令 `ok:false`、ambiguous 或未知结果不会因提取成功变成成功。异步 start 成功只代表该次启动请求成功，任务 status 仍在 control，不能当作业务完成。
4. CLI 退出码：0 为当次请求成功且结果按要求交付；1 为验证/执行失败或执行结果未知；2 为当次请求成功但提取或交付失败。多种错误并存优先保留 1。MCP 相应设置 isError；调用方用 failureStage 定位首要失败，再读 execution、extraction、delivery 判断动作事实及可用结果；三段信息不因快捷字段省略。
5. 提取超时/异常/超预算时，保留执行事实、错误和真实 source ref；不附带大原文兜底、不重新执行动作。源保存失败但提取成功且能 inline 交付时仍可退出 0，control.source 必须显示 persisted=false；“结果拿到了”与“可回看”是两个事实。
6. CLI/MCP 公共错误出口也要一致：包括校验拒绝、runtime_stopping、鉴权/连接失败、序列化和传输超限。内部 RPC 保持现有格式，公开交付前用同一模块封装一次。只有确定未派发才写 dispatched=false；派发后连接丢失等未知情况不能伪装成未执行。text/bytes 的 execution 根据命令完成事实确定，不能只因值没有 ok 字段而推断成功。

### 2.1 保留原 value，只保护必要控制字段

**`_feedback` 保留在原响应的 value 中，不强制搬字段。** null 的原 value 内容保持；提取脚本通过 ctx.inputs.response._feedback 读取原有反馈。execution/control 仅复制已有执行回执和后续操作必需字段，作为提取不能覆盖的独立信息；不把完整反馈树、日志、堆栈再复制进 control。完整源内容由快照保留，提取成功时 value 只交付提取结果。

M0 确认以下小清单，其余命令特有的分页/覆盖字段随 M2 用例补齐。仅复制对应返回族实际提供的字段，不补假值；正文中的任意业务同名字段不能冒充 Host 控制字段，未提取的原字段仍在源响应中。

| 响应族 | 受保护字段及来源 |
| --- | --- |
| 共用 execution | 当次请求的 ok/error/message/field/details；已有 dispatched、ambiguous、settled、executionReceipt(s)、exitCode；命令明确提供的 target、matched、verified、inconclusive。复用现有错误/结果映射，不取 executionOutcome 与 executionFields 的交集：交集会漏掉 ok/error/message 等事实 |
| 普通观察/动作 control | 现有 reply.history、source，以及命令已有分页游标、来源/时间和采集不完整信息；完整 `_feedback` 留在 value |
| Script control | operationId、status、pauseReason、eventSequence、resultRef；result 返回中的 persisted；wait 返回中的 timedOut/waitMs；history 页信息。待回答时 pendingQuestion 为当前问题的 `{requestId, revision, request}`，含原 question/context 等请求内容，不能只保留两个编号 |
| Intent control | operationId、status、revision、lastDecisionId、eventSequence、eventGap、droppedEvents、evidenceId、latestEvidenceIds、terminalEvidenceId、observationFailure、provider、observationTarget、deadlineMs、pendingOperations，以及已有 lastAction 小回执和 history 页信息。lastAction 表达历史动作事实，不覆盖本次 status/read 请求的执行结果；install-apk、permission-dialog 同样覆盖 |

Script/Intent 的 control.history 只复制原 value.history 的 lastSequence/hasMore/gap，不复制 items 或历次 summary。待回答问题由 Script supervisor 的当前未回答状态提供，不能仅在本次过滤后的 events 中寻找，否则 afterSequence/eventLimit 可能把仍待回答的问题过滤掉；复用现有问题状态，不建立新队列或生命周期。以上控制区同样受预算约束。

预算最低 16 KiB，为正常控制与错误留空间，但这不是已证明的所有控制大小上界。若保护字段本身不能放入预算，返回 `control_over_budget`、最小执行事实和真实源引用，明确 `controlComplete:false`，停止常规消费流程；不能悄悄截断身份或把缺字段视为成功。派发及结果未知标志始终 inline，其余完整字段只能从真实快照恢复。若快照也失败，明确 unavailable。验收须验证支持的正常响应族在最小预算下保留完整机器控制字段；此异常路径不能作为通过这些用例的替代。

## 3. 响应快照与重新提取

### 3.1 固定响应与原样保存

命令结果完成所有事实记录及 `_feedback.evidence/factCache/observer` 追加后，再分类控制字段并冻结一次。当前 UI history 在追加完成之前记录，不能直接当作这个快照；UI、network、logs 等普通返回均新增响应级记录，复用现有 FactStore、配额、淘汰和归档基础设施。

固定快照包含原命令的 kind、value、execution、control 及捕获身份；不含本次提取值、delivery 或快照自身的 ref，避免自引用。**提取直接使用命令实际返回的内容，不新增 UI 隐私处理、自动脱敏或按字段名改写内容。** 调用者通过查询参数和 extract 决定取哪些内容。快照沿用命令已有的公开 JSON/text 编码，再用固定的 canonical JSON 序列化为 UTF-8 字节；不另加 bigint/Date/Buffer 的替换规则，无法按公开类型合同编码时明确报错。二进制仍遵守第 1.2 节的范围。

即时提取从这份冻结字节构造四字段 inputs，持久化和校验复用同一内容。首版在现有 evidence 记录内新增 response 类型，用固定的 snapshotBase64 字段保存源字节，复用 FactStore 对规范 base64 字段的原样保存能力及已有 checksum 校验；不新增 encoding 选项、编码注册表或第二套存储。读取校验后解码，再构造同样的 inputs。编码约有 4/3 的体积开销，只是内部存储细节；外部仍只返回有界结果或 ref，不把 base64 快照整份塞入工具输出。

响应快照及其 evidence export 按源字节保真，与同次 UI 历史记录的正文可能不同；M2b 同步在 EVIDENCE_ARCHIVE.md 明确这一存储约定即可。规范 base64 字段原样保存是既有通用字段规则，不是 response 类型独有的处理例外，不新增相关开关或流程。

null 预算内交付、即时提取输入、按 ref 重读基于同一命令响应；取消 direct/projected 两套表示及 delivery.representation。A07 验证原响应值保真、存入与读回的解码字节完全一致，以及 JS/Python 即时/重读的 inputs 一致。ref.checksum 就是既有 evidence 记录的 checksum，覆盖含 snapshotBase64 和 committedAtMs 的记录正文；FactStore 外层记录头不在该校验范围，不再增加独立快照 checksum。这里的“原响应”指本次查询实际得到的内容，可能已受命令本身的过滤、compact 或分页影响，不表示重新取得设备全部数据。

普通命令的非 null 提取、null 超预算时尝试保存。**只有 `control.source.persisted:true` 才生成可供 response read 使用的 ref**；预算内 null 未尝试保存时写 `control.source.persisted:false`、`control.source.reason:"not_requested"`，不生成 ref，也没有可重读快照。response read 只复用调用方传入且校验成功的已保存快照，不会为未保存响应补采设备数据。保存结果与提取状态独立。快照不超过 8 MiB（编码前），超过或磁盘写入失败时明确保存失败；仍有合法内存输入时可以提取。引用沿用 evidenceId/checksum，加 namespace=response 和读取所需身份；不复制 Script 结果特有的双 hash/representation，不把 globalSeq 或临时文件名伪装成耐久引用，已生成引用仍受后续淘汰/到期约束。

### 3.2 读取入口

新增公共 `response` 命令，首版只提供 `arguments:{operation:"read",ref:<上次返回的ref对象>}`，并要求本次 extract。ref 对调用方是原样传回的对象，不由模型拼造。它读取并校验同一个快照，然后应用本次提取；设备执行器调用数必须是 0。

修正 extract 后重读只使用 response read。原 command 携带相同 requestId 再调用仍属于业务调用；当前去重缓存只有进程内默认 5 分钟、最多 2,048 项，过期、容量淘汰或 Host 重启后可能重新执行。extract/output 不进入动作摘要，但这不把 requestId 变成快照引用；无 ref 时不能给出“沿用 requestId 即可安全重新提取”的引导。

本次 execution 表达“读取是否成功”；control.origin 保留原命令及其 execution、目标、时间和操作身份，source 指向原快照。明确是历史观察，不据此刷新 UI revision、续租定位引用或发起动作。重复读取不再次保存公共封套，不形成快照套娃。过期/淘汰、损坏、未知 namespace/格式、checksum 不符分别失败。

响应快照纳入已有 FactStore 受限存储配置；保留期限以实际 profile/配额/淘汰规则为准，首版不虚设永久保存或固定 TTL 承诺。读取成功后使用固定内存输入，后续淘汰不影响本次提取；下一次读取可能 expired。M2 仅扩展现有 evidence 导出/校验以识别 response 类型，不新增归档命令、格式体系或恢复服务。离线本地路径无持久化服务时报告 offline，不启动 Runtime。

## 4. 工作进程和生命周期

公共返回模块接收“已完成的命令结果 + 已固定提取配置 + 预算”，依赖注入快照存储、runner、时钟与身份提供方。设备业务逻辑继续执行原职责；提取在动作锁释放后运行，复用 Host 的活动任务跟踪覆盖提取与保存阶段，shutdown 完成清理后再关存储。若把处理放在现有 host.run 返回之后，须同步调整跟踪边界，不能漏掉该阶段。本地路径使用相同模块及相同测试用例，避免额外执行一遍后处理。

JS、Python 和 regex 都在可终止的独立工作进程运行。复用现有语言探测、IPC、错误处理和清理基础设施，但与完整 Script 任务生命周期分开。首版每次独立进程，避免模块/全局变量/cwd/定时器及迟到输出污染下一次调用；不先引入常驻池。

输入沿用 stdin 的单行 JSON start 帧，源码继续使用本次固定的临时源码文件；不增加临时输入文件或第二种传输模式。通道独立限制 Host→worker 与 worker→Host 的完整帧字节，均含 JSON 外壳和换行，具体限额见第 5 节。现有通道将同一 maxFrameBytes 用于两个方向，且 runner 从输出预算推算它，不能原样复用；只扩大同一个限额也会把输出读取限制一并放大。帧超限归属 extraction 错误，保留原执行事实。

执行模型明确为 trusted-local-code。没有 ctx.call 不代表 OS 沙箱，普通 JS/Python 可访问本机能力；“不重放动作”保证 Bridge 不替调用方重新派发业务动作，不保证恶意脚本本身没有副作用。首版不声称具备完整后代进程、内存或 OS 隔离。

工作进程异常退出、超时、协议帧超限、非法 JSON、并发过载分别报错；终止后回收进程句柄和临时文件，迟到输出作废。首版只限制活跃提取进程数，不建立提取任务队列或新增排队状态/等待接口。没有空位时明确返回 extraction_busy；若动作已经完成，保留执行事实及可用 ref，后续只重读该 ref。regex 不在 Host 事件循环执行。断开客户端不等于撤销已经发生的业务动作。

现有 runner 的 mkdtemp 目录没有删除路径；复用时必须在本次进程结束后清理，仅删除本次创建的目录，不触及调用方 sourcePath。覆盖正常结束、spawn 失败、异常、超时和关闭路径，不新增后台临时文件清扫服务。Python 非有限数与越界整数同属序列化前的类型错误，不能等到 Host 收到非法 JSON 后笼统归为 malformed_frame。

## 5. 默认限额与发现输出

以下是首版实施默认值，不是当前实现的性能保证。M0 确认接口与计量口径，M2 按实际处理链校准数值；发布前冻结，修改须携带同一基线的对比数据并回写本表。

| 项目 | 首版值 | 测量/错误规则 |
| --- | --- | --- |
| 公共 JSON 正文 | 默认 96 KiB；可显式设为 16–256 KiB | 组装后紧凑 UTF-8 字节，所有 metadata/error/control 在内；恒等提取也受限 |
| 提取输入 | 固定响应快照最大 8 MiB | 独立于输出上限；含输入控制，不因要求小输出而拒绝正常大输入 |
| 提取 IPC 帧 | Host→worker 最大 8 MiB + 64 KiB；worker→Host 最大 256 KiB + 64 KiB | 含换行与协议外壳；64 KiB 留给帧元数据，不能占用结果值限额；两个方向分别在读/写通道强制检查 |
| 单响应快照 | 编码前快照最大 8 MiB | 存储 envelope 上限显式计入 base64 和元数据开销；不能把编码后体积错按 8 MiB 拒绝；全部计入存储总配额 |
| 源码 / regex | 源码 64 KiB UTF-8；pattern 2,048 字符；最多 1,000 个匹配 | 派发前可检查的先检查；运行时匹配超限明确失败 |
| 提取时间 | 默认候选 2,000 ms，可设 1–10,000 ms | 从进程创建到收到合法最终值，包含启动与输入传输；须完成下述最大输入测量才冻结默认值；预检单独受限，不包含业务动作耗时 |
| 提取工作进程结果值 | 最大 256 KiB 紧凑 JSON | worker 序列化时和 Host 接收后校验结果值；接收帧超限即停止读取并终止；最终公共封套仍按调用方预算检查 |
| stderr / stack | stderr 尾部 8 KiB；stack 最多 20 帧且 8 KiB | 有截断标志；诊断不能污染协议 stdout；受最终正文预算二次约束；首版不另建完整诊断日志的存储和引用 |
| 并发 | 每个 Host 最多 2 个活跃提取进程 | 无空位时 extraction_busy，不排队；此时原命令可能已完成，不能重新调用它；数量由 M2c 校准 |

M2c 用实际 worker 校准 **最大 8 MiB 输入 × JavaScript/Python × 记录配置的参考机**，至少包含一台普通配置的受支持机器，不能只测小响应。记录 OS/架构、CPU/内存、Node/Python 版本及样本 checksum，测冷启动、IPC 传输/解析、提取和总时长；样本至少包含大文本与多节点 JSON，返回小结果，重复运行报告 p50/p95、最大值及超时次数，同时覆盖单任务和默认并发 2。2000 ms 是否留足运行余量据此确定；发布前数据不足仍标未验证，必要时据数据回写默认值，不自动放宽调用方传入的超时。M0 不另做完整 worker 原型重复这组工作。

选择 96 KiB 的依据：实际现有 Intent worker 在合成 5k/10k 节点输入下，summary 为 65,476/65,485 字节，完整 start 状态已为 66,558/66,574 字节，64 KiB 连当前完整响应都放不下。96 KiB 留出约 31 KiB 空间；M0 用代表样本确认可行，M2 验证完整响应族、不同事件数量和最小预算控制区，不能从这两个样本推出普遍上界。原始大 tree 与宽 capabilities 仍会被主动挡在默认预算外。

Intent status 默认还附历史，其中可能重复包含完整 summary；96 KiB 不保证这类响应内联通过。范例应显式限制 history 的 limit，历史续页的 afterSequence 使用上次 history.lastSequence（交付后为 control.history.lastSequence），不能误用 eventSequence。limit 限制条数而非字节：600 节点样本在 limit=1 读到 summary 历史页时仍约 133 KB。只需状态/少量字段时用 extract；完整历史按正确游标读取，超预算的既有响应用 ref 提取或显式调整允许范围内的预算。默认值不为无界历史自动放宽，也不隐式截断原 history。

最终候选正文超预算时：舍弃 inline value，报告 output_budget_exceeded 和 attemptedBytes/limitBytes，交付受保护控制及真实 source ref；不存在可用 ref 时为 unavailable。提取成功但最后封套超限，extraction 仍是 succeeded，failureStage 为 delivery。错误回包也必须落入预算；不截断 JSON，不再尝试未知摘要算法。

0.4.0 的 capabilities 与机器可读 help/schema 复用预算检查，固定采用默认 96 KiB，不增加各自的 output 配置或 extract。宽发现响应超限返回 `discovery_output_too_large`、有效过滤维度和一条更窄示例，不创建 snapshot ref、不截断 schema、不静默删命令。默认命令目录保持可读；普通固定 help/version 文本保持简短，不套 run 的执行封套。

0.3.9 仅改紧凑序列化与发现引导，继续接受现有宽查询。发现硬预算是 0.4.0 行为变更。当前无缩进 `{command:"intent",operation:"decide"}` 为 51,605 字节，本身小于 64 KiB，不能列为默认必超限；`{command:"intent"}` 的 116,249 字节和 includeOptions:true 的 424,057 字节才超过拟定默认值。

## 6. M0 确认范围与实施验收

M0 只完成三项：确认本文件的请求/返回字段及普通命令、Script、Intent 的必要控制字段；用已有树/Intent 状态做代表性完整封套和大小样例；列清复用的编解码、runner、FactStore 接入点及调用方迁移清单。源码仍有疑问的接入点做最小离线探测，不先另写一套完整产品原型。

这三项已在第 6 版完成轻量确认；代表封套只是接口和大小样例，不是已实现的返回模块验收。实施按本基线开始，下面的正式测试继续属于对应工作包。

迁移包括：顶层 extract、MCP 由原顶层数据改读 value、公共状态与 CLI 退出码 2；value._feedback 保持原位置。Runtime 沿用 `aab.runtime/v1` 传输封套，公共正文放入其 reply.value；旧代码仍由既有身份检查拒绝。新增存储 namespace/记录类型 response，复用现有 evidence schema/checksum/归档版本，不再叠加独立的公共响应或快照版本标识。

真实 tools/list、CLI 解析、全部响应族、落盘重读、故障注入分别进入 M2a/M2b 的正式测试；最大输入/两语言/参考机性能进入 M2c，第 5 节数值在发布前据此确认。语义预检、无重放、预算和控制字段验收没有取消，只移到对应实现提交中做一次。修改已确定的接口需回写本文件；常规实现选择与实测限额调整记录在工作包内，不逐条增加审批步骤。
