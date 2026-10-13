# Memos Web 业务样本

目的：用真实 Memos 的 React 表单、CodeMirror 编辑器、搜索、菜单及取消删除验证 Bridge 的 Intent 和 Script，并独立核对 SQLite。样本不承担 Memos 产品功能开发。

## 固定来源

[source.json](source.json) 固定上游 commit、源码压缩包和官方 darwin arm64 二进制的 URL、大小与 SHA-256。`upstream/`、`build/`、`data/` 均被忽略；账户、数据库和浏览器状态只存本地。

本轮使用源码 commit `2036c1ffc1b0a1e1fa6a473738c2a5ef520df67f` 对应的 Memos 0.30.0 发行物，未修改上游业务代码。准备顺序为：从 manifest 的 URL 下载两个压缩包，核对全部校验值，将源码解压到 `upstream/`、二进制解压到 `build/`。不使用最新版本代替固定版本。当前 Mac 的已校验压缩包保留在仓库 `.tools/memos-web-0.30.0/`，缺少 Go 或 Docker 不影响该二进制运行路径。

从仓库根目录启动独立本地实例：

```sh
examples/memos-sample/build/memos \
  --addr 127.0.0.1 --port 18881 \
  --data "$PWD/examples/memos-sample/data" --log-level warn
```

已运行的同一实例直接复用。新实例的首次账户通过 Intent 操作注册页面创建；服务不会由业务 Script 自动重置。

## 一条命令验收全新环境

[run-end-to-end.js](validation/run-end-to-end.js) 串起已经验证的 Memos 策略：新建服务器与 data、独立 Host/Chrome/SDK、Intent 注册新测试账户、JavaScript 连续五轮完整流程、Python 一轮完整流程，以及独立只读 SQLite 核对；结束后正常关闭本次资源。不需要中途模型决策，也不下载依赖。这是已知策略的新环境重跑，不包含陌生 App 的页面发现或策略编写。

准备好按 `source.json` 校验的本地 Memos 二进制、Node、Python 3、Playwright 模块和 Chrome，然后从仓库根目录运行一条命令：

```sh
node examples/memos-sample/validation/run-end-to-end.js \
  --memos-binary "$PWD/examples/memos-sample/build/memos" \
  --playwright-module /absolute/path/to/node_modules/playwright \
  --chromium-executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --output "/tmp/memos-e2e-$(date +%s)"
```

输出目录必须不存在，父目录须已存在。控制器选择空闲 loopback 端口，固定测试上下文语言为英文，使用新生成的合法测试用户名；不会复用个人浏览器或账户。所有业务 UI 都经公共 Bridge；Playwright 只负责上下文、SDK 注入与截图，SQL 只读核对。

`report.json` 给出从控制器进入到全部业务/核对结束的 `endToEndMs`，资源清理另列 `cleanup.elapsedMs`，两者合计为 `totalIncludingCleanupMs`。公共 RPC 按实际 MCP transcript 和 CLI replies 计数，包含连接准备、业务、关闭；另列 MCP initialize 和通知，不能只报告一个业务 Script RPC。`source-sha256.json` 固定全部相关源码/运行时文件，报告另记录实际 SDK、Host 和本地 Memos 二进制哈希。原始失败不会被重跑覆盖。

2026-10-13 的唯一一轮全新环境控制首跑通过：准备、注册、JS 五轮、Python 一轮、各独立 SQLite 核对及最终截图/源码复核共 **10.382 秒**，清理 **0.255 秒**，控制器合计 **10.638 秒**；额外模型轮次 0，公共命令 RPC 7（另 MCP initialize 1）。系统外层进程时间单独保留于验收证据。这不覆盖或替换此前首次准备和故障恢复中的分钟级 Agent/控制器耗时。业务范围和已知编辑后 checkbox 刷新差异仍见本页末尾说明及验收报告。

## 打开隔离的 Bridge 浏览器

需要 Node、Playwright 模块和已安装的 Chrome。显式指定模块及浏览器路径；本 harness 不下载浏览器、不使用用户的 Chrome profile，也不替代 Bridge 执行业务。

```sh
export AAB_PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright
export AAB_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node examples/memos-sample/validation/open-browser.js \
  --output "$PWD/build/ai_app_bridge_artifacts/memos-new-run" \
  --session memos-new-run
```

输出目录必须是新目录。`--headed` 可显示浏览器；`--storage-state /absolute/browser-state.json` 显式复用样本登录状态，省略则创建全新上下文。初始化只注入当前源码 SDK、连接当前源码 MCP Host、打开页面并读取 DOM，不做业务点击。

stdout 给出 `target`，相同内容保存在 `target.json`。保持该进程运行，通过 stdin 每行发送一个 JSON 对象；所有业务命令均经公共 `run`：

```json
{"name":"observe-01","command":"web-dom","arguments":{"sessionId":"从 target.json 读取","runtimeEpoch":"从 target.json 读取","targetId":"main"}}
{"name":"screen-01","screenshot":true}
{"close":true}
```

每条命令使用新的 `name`，工件不覆盖；`screenshot` 是独立浏览器 harness 工件，不是 Script 自带截图证据。结束时保存新的 `browser-state.json` 到本轮目录。目录含 Web 连接 token、私有账户状态及原始请求，仅限本地使用。

## 固定业务 Script

[memos-flow.js](validation/memos-flow.js) 和同义 [memos-flow.py](validation/memos-flow.py) 通过公开 `ctx.call` 观察和操作；每次写入携带原 `pageRef` 和 element identity。它们会等待真正可交互的控件，遇到重复文本或变更目标明确失败。Python 使用 `language: "python"` 和对应的 `sourcePath`，其余业务输入一致。

流程为创建笔记→保存→搜索＋Enter→编辑→保存→删除确认→取消→验证仍保留。`case-js.json` 是已执行的冻结用例；复跑应复制为新文件，统一替换 marker、tag、原始和编辑内容中的标记，避免与已有笔记冲突。复跑前清空样本的 UI 搜索条件并确认无编辑/删除弹窗。Script 不会删除旧业务数据来制造“初始状态”。

当前 JS/Python 流程会点击实际观察到的 `Remove filter`，移除上一轮搜索条件。Memos 清空搜索输入框后仍可能保留已应用的筛选器；只清输入会让下一条已保存笔记不可见，造成无意义的等待。不会因此重复点击保存。

已连接的样本可以直接运行下面的控制器；每次使用新的输出目录。它们自动生成独立 marker、保存数据库基线、提交一次带 `waitMs:60000` 的 Script，并执行只读 SQLite 核对：

```sh
node examples/memos-sample/validation/run-current.js \
  /absolute/browser-run /absolute/memos-data /absolute/new-js-run javascript
node examples/memos-sample/validation/run-current.js \
  /absolute/browser-run /absolute/memos-data /absolute/new-python-run python
node examples/memos-sample/validation/run-long.js \
  /absolute/browser-run /absolute/memos-data /absolute/new-long-run 5
```

`browser-run` 是仍在运行的 harness 输出目录，需要其当前 `target.json`，以及仅供本地测试账户使用的 `credentials.json`（权限 0600）。页面刷新后通过 `web-sessions` 取得新 document identity，再更新目标；恢复提示提供这一选择，不会重放旧动作。三个控制器只用于本样本的已知流程；连接、发现页面和编写策略的时间单独保留。

向同一 harness 提交公开 Script start，完整合同见 [SCRIPT_AUTHORING](../../desktop/ai-app-bridge-cli/docs/SCRIPT_AUTHORING.md)。核心字段如下：

```json
{
  "command": "script",
  "extract": null,
  "name": "script-start",
  "arguments": {
    "operation": "start",
    "waitMs": 60000,
    "recordingDir": "/absolute/new-recording-directory",
    "script": {
      "schemaVersion": "aab.code-script/v1",
      "name": "memos-fixed-flow",
      "language": "javascript",
      "sourcePath": "/absolute/repo/examples/memos-sample/validation/memos-flow.js",
      "entrypoint": "main",
      "target": {
        "platform": "web",
        "sessionId": "实际 session",
        "runtimeEpoch": "实际 runtime",
        "targetId": "main"
      },
      "inputs": {
        "marker": "新 marker",
        "content": "原始完整内容",
        "editedContent": "编辑后的完整内容",
        "credentialsPath": "/absolute/repo/examples/memos-sample/data/bridge-credentials.json"
      },
      "permissions": [
        "app.read",
        "app.interact"
      ],
      "policy": {
        "timeoutMs": 180000,
        "restartPolicy": "none"
      }
    }
  }
}
```

实际 stdin 请求写成单行 JSON；复制用例字段构造 `inputs`，不要把 `credentialsPath` 指向个人账户文件。凭据文件只用于已有样本账户的登录页，格式为 `{"username":"...","password":"..."}`，权限设为 0600。已登录状态不会重新登录。

`start` 已完成且带有结果时直接检查结果，不再补一次 `wait` 或 `result`。仍在执行时才使用原 `operationId` 调用 `script wait`，以前页 `eventSequence` 作为下页 `afterSequence`。需要 Agent 决策时处理当前问题并继续原操作。检查实际状态和 assertion verdict；`ok:true` 仅表示控制请求成功，不代表业务断言通过。需要移交完整记录时，再执行公开 `evidence export`（`includeRecordedPayloads:true`）与 `evidence verify`。

## 独立数据库核对

在 Script start 前，通过只读 SQLite 查询保存 baseline JSON：`{"rows":[...]}`。每行应包含 `memo.id, uid, creator_id, content, visibility, memo.row_status, memo.created_ts, memo.updated_ts, payload, username`（`memo JOIN user ON memo.creator_id=user.id`，按 `memo.id` 排序）。记录 start 时间和事件中的 terminal 时间。

```sh
python3 examples/memos-sample/validation/read-memo.py \
  --database examples/memos-sample/data/memos_prod.db \
  --case /absolute/new-case.json \
  --baseline /absolute/database-before-script.json \
  --output /absolute/new-oracle-directory \
  --username SAMPLE_USERNAME \
  --started-at-ms START_TIMESTAMP --finished-at-ms TERMINAL_TIMESTAMP
```

校验器从只读连接复制一致性快照，再查询封存快照；验证精确内容、用户、私有状态、取消删除、新增数量、旧记录不变、本轮时间和标签/任务属性。它不调用 Bridge，不改原始数据库。

用 `negativeOnly:true` 和不存在的 marker 执行同一源文件，可以验证错误预期确实 failed。该失败保留独立录制和归档。

## 任务勾选与恢复

[task-toggle.py](validation/task-toggle.py) 复用 Intent 观察得到的真实任务控件。执行前将页面搜索条件固定到唯一 marker，确认该笔记恰有两个可交互 checkbox，一个已勾选、一个未勾选。Script 从本轮 DOM 选择唯一未勾选节点，保留其真实 elementId，点击后核对同一节点及其兄弟节点；不会把隐藏的原生 companion input 当成可点击目标。

Script 在勾选后通过 `ctx.askAgent` 暂停，由控制器执行独立 SQLite 核对，再用公开 `script decide` 提交 `{"restore":true}`。`requestId` 与 `revision` 从本轮 `agent_question_created` 事件读取。Script 重新观察并恢复原节点，结束后再做一次数据库核对。这个校验点是验证安排，不计作无人值守速度成绩。

使用 [read-task-state.py](validation/read-task-state.py)，提供 `--database`、上述完整 `--baseline`、`--case`、`--state checked|restored` 和新的 `--output` 目录。case 格式为 `{"marker":"...","checked":{"content":"勾选后的精确全文","hasIncompleteTasks":false},"restored":{"content":"原始精确全文","hasIncompleteTasks":true}}`。它核对原主键、全文、任务属性、标签、所有权/可见性、记录数与其他笔记不变。Memos 的 proto3 布尔默认值经 `protojson.Marshal` 序列化时被省略，因此全部勾选后的 payload 必须省略 `hasIncompleteTasks`，不会把任意缺失字段当作 false。

Python 固定业务和任务点击/恢复已取得真实 DOM 与独立 SQLite 证据。后续保存流程已接通 Web capture-window、同步动作身份和有界二进制正文；通用异步来源归属、跨页断言聚合与 Script 自有截图仍开放。实际结果和原始失败见 [WEB_MEMOS_BUSINESS_2026-09-11.md](../../docs/WEB_MEMOS_BUSINESS_2026-09-11.md)。

## 编辑保存与完整网络采证

启动 `validation/open-browser.js` 时显式加 `--capture-bodies`，开启本地样本的请求与响应正文采证。以 [memos-save-capture.js](validation/memos-save-capture.js) 运行固定业务，permissions 包含 `app.read`、`app.interact`、`capture.read`；inputs 使用上述 case，并补充 `memoName: "memos/实际UID"`。Script 自身包含固定 Memos Protobuf 协议的只读解码器，无外部模块依赖。

流程通过当前 DOM 打开既有笔记、编辑和保存；使用保存前水位查询实际请求响应，核对 memoName 和完整 content，再核对同步 Save 事件和页面复选状态。在 `saved-completed-tasks` Agent checkpoint 由独立控制器执行 `read-task-state.py --state checked`，通过后回复 `{"restore":true}`；结束时另验 `--state restored`。

9 月保存专项的历史结果为 8 项通过、1 项页面期望失败，Script 如实 failed，原文与其他笔记均保留。不能因数据库保存正确就将页面检查改为通过，也不能将缺失的 `aria-checked` 当作 false。这是用于验证 Bridge 能否操作、采证并识别真实差异的业务样本，不在本阶段修改 Memos 产品逻辑。当前工作树的完整流程、失败轮次与耗时另见 [WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md](../../docs/WORKFLOW_PERFORMANCE_PLAN_2026-10-12.md)，不以新的成功记录覆盖旧失败。
