# 同一冻结 Script 的两台手机验证

**PKR110 上三次正向、错误期望和取消负例全部符合预期。** 与此前 PGFM10 的运行相比，作者 Script、Bridge 运行时和 APK 均未修改。现在可以确认本搜索流程已在两台获授权手机上重复执行，并完成独立数据比对和公开证据归档核验。

这一步承接 [公开证据归档](EVIDENCE_ARCHIVE_2026-09-08.md)，没有改 NotallyX 业务功能或为新手机修改脚本动作。

## 固定输入与来源

- 新运行设备：PKR110 / `b46093e6`，公开 status 返回 manufacturer `OnePlus`、SDK 36；截图为 1080×2376。
- 对照设备：PGFM10 / `FYZLAU49X8OVQGJ7`，使用上一轮公开归档回归结果。
- 应用：`io.github.mobileaidev.notallyx.sample`，`7.11.2-aab-baseline` / 71120。
- 两边 APK SHA256：`ecf83a99cd3875fad0755e8254f1b31aaf2e56c84f9735f0e49830957fff623c`。
- 两边作者源码 SHA256：`1ea38097ca7607ed1380103946978e79e225cd0a956e7b4edc4bf55fe4187f77`。
- 74 个 Bridge runtime 文件与 PGFM10 成功运行的 hash 清单完全相同；PKR110 运行结束后再次核对一致。

PKR110 使用此前真实复制、读回核验并独立采集的固定夹具，snapshot 为 `3812eb2c-d0ae-436a-aefc-57b939682c64`，fixture SHA256 为 `5f25c1a6aa1e4c2092a6ff0f27bd00b028057367921c1c4f5c3b0450a25247f4`。没有重装 APK、重新导入数据或改写历史采证归属。

PKR bundle 的 105 个文件与 PGFM bundle 的 102 个文件均逐项通过 bytes/SHA 核验。两边查询与预期结果相同；执行输入只改变设备身份，fixture-summary 只改变 serial 与对应真实 snapshotId。10 条笔记、11 个标签、偏好和 APK 均相同。原始探索证据继续保留 PGFM10 身份。

## 运行结果

| 场景 | PGFM10 Script 耗时 | PKR110 Script 耗时 | PKR110 结果 |
| --- | --- | --- | --- |
| 正向 1 | 24.938 秒 | 20.613 秒 | completed，84 passed |
| 正向 2 | 24.965 秒 | 20.870 秒 | completed，84 passed |
| 正向 3 | 25.113 秒 | 20.812 秒 | completed，84 passed |
| 错误期望 | 5.862 秒 | 4.563 秒 | failed，18 passed + 1 次预期设备断言失败 |
| 等待决策时取消 | 10.357 秒 | 8.661 秒 | cancelled，35 passed，后续业务动作停止 |

两台设备的所有场景均无 inconclusive；错误期望仍是业务断言失败，只是负例验证按预期通过。

PKR110 正向中位数为 **20.812 秒**；五轮控制器包含实际 APK/初态核验、冷启动、前台 UIA、运行后数据库采集、公开导出和离线校验，共 **114.453 秒**。这是本搜索流程的实际记录，不外推全 App 时间，也不作为普遍设备性能结论。

两个设备的唯一标题、五个正文匹配标题并集、空结果、清空和首页恢复均通过对应 UI/Host 证据验证。点击和滚动依据当次观察到的节点与视口，首页恢复使用当次实际可读锚点；本轮没有为较短屏幕放宽检查或修改作者源码。

每轮都先核验实际安装 APK 和固定业务夹具，确认前台 UIA 属于样例且键盘关闭。五轮运行后的 10 条笔记、11 个标签、偏好和附件范围均与固定基线精确一致，没有忽略字段。

PKR110 五轮公开导出共 **82 条 Host 持久记录、36 个动作**，两个全新 MCP 进程在 FactStore 不可用的环境中完成离线 verify，并执行原有动作顺序、参数和终态独立审查。各归档文件保持不变。另存 77 张截图、275 次树读取；与 PGFM10 的树读取数不同是等待轮次的实际差异，不强制凑成相同数量。

独立代理实际查看 positive-1 的 9/21 张关键 PNG，确认唯一标题、五个正文结果及匹配正文、空结果、清空和首页恢复锚点。首页悬浮按钮遮挡部分标签、边缘卡片不完整的范围已明确排除，不当作完整可读证据。该次运行的 668 个输入文件在审查前后 path/bytes/SHA 均未变化；其余轮次由上述自动验证器核验，没有声称逐图人工复核全部 77 张截图。

## 结果文件与复现

本轮材料根目录为 `build/ai_app_bridge_artifacts/pkr-replay-2026-09-08/`：

- `runs/report.json`：五轮结果，`ok:true`。
- `runs/durable-review/report.json`：公开导出与双进程离线核验，`ok:true`。
- `comparison.json`：两机源码、APK、runtime、预期结果、负例和业务不变量对比，`ok:true`。
- `visual-review.md`、`visual-review.json`：实际 9 张截图的独立视觉复核、SHA 与覆盖限制。
- 各 trial 的 `initial-data-oracle.json`、`final-data-oracle.json`、`independent-ui-oracle.json`、`archive-export.json` 和截图/调用证据。

```sh
node examples/notallyx-sample/validation/run-intent-search-reuse.js \
  --server desktop/ai-app-bridge-cli/bin/mcp-server.js \
  --serial b46093e6 \
  --apk build/ai_app_bridge_artifacts/notallyx-migration/candidate-v6/notallyx-backup-count-v6.apk \
  --fixture build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/transfer-baseline/fixture/fixture.json \
  --source examples/notallyx-sample/validation/intent-evidence-search.js \
  --bundle build/ai_app_bridge_artifacts/intent-reuse-2026-09-08/execution-bundle-v2 \
  --out build/ai_app_bridge_artifacts/pkr-replay-2026-09-08/new-run
```

输出目录必须是新目录。本轮没有修改运行时代码，复用了 `3725fcd` 上已验证的实现；没有为文档更新重复全量软件测试。

下一步补齐外部截图、Script 调用结果/断言、手机 capture 载荷的统一证据归档和明确关联，再扩展另一业务流程或 App。当前证明范围仍为搜索回归；等待 Agent 决策时取消不能替代动作执行中取消、物理断连或重启恢复的验证。
