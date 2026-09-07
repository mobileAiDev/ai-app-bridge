# 0.3.0-rc.1 本机独立目录安装验证

本文件记录本地 RC 的安装验证。2026-09-07 的冻结源码已经打包，并在本机新临时目录正常安装、现场编译原生模块，通过 MCP 与真实 Node Script 验证。没有执行 npm publish、提交或推送。

## 范围与条件

- CLI 版本为 `0.3.0-rc.1`，尚未公开发行。
- 生产包排除 `bin/script/fake-*.js`、`bin/script/p9-*.js` 和仅用于测试的 `bin/intent/intent-device-adapter.js`。保留源树中的测试替身和 P9 资产供研发使用。
- 原生 FactStore 作为 bundled dependency 携带 C 源码和 Node-API binding；安装时编译，不使用仓库内预编译 `.node` 文件。
- 验证目录由 `mkdtemp` 新建，未复用项目 `node_modules`。这是**同一台 Mac 上的独立目录验证**，不是干净机器验证；机器已有工具链和下载缓存。
- 本轮不连接设备。Script 检查仅执行显式 `scope: "code"` 的纯代码断言；设备通过数必须为零。

本机工具链：macOS arm64、Node `v26.3.0`、npm `11.16.0`、node-gyp `12.3.0`、Python `3.9.6`、Apple clang `21.0.0`，Xcode 路径 `/Applications/Xcode-beta.app/Contents/Developer`。安装需要可用的 Python、C 编译工具链和 npm 依赖获取条件；此处没有证明其他系统或 Node 版本的兼容性。

## 可复现命令

在 `desktop/ai-app-bridge-cli` 下执行；先创建自行选择的证据目录：

```sh
npm pack --json --pack-destination ../../.tools/implementation-2026-09-07/package-final-r2
node scripts/validate-installation.cjs \
  ../../.tools/implementation-2026-09-07/package-final-r2/mobileaidev-ai-app-bridge-0.3.0-rc.1.tgz \
  ../../.tools/implementation-2026-09-07/install-validation-final-r2
```

验证脚本在新目录执行的安装命令为：

```sh
npm install --no-audit --no-fund --foreground-scripts /absolute/path/to/mobileaidev-ai-app-bridge-0.3.0-rc.1.tgz
```

**没有使用 `--ignore-scripts`。** 必须检查 `npm-install.log` 中实际的 `node-gyp rebuild`、`CC`、`SOLINK_MODULE` 和正常退出，而不能只依据 `npm pack` 成功。

## 验证项目

1. 包版本为 `0.3.0-rc.1`，不存在被排除的测试替身/P9 文件；安装后的 Intent entry 可以实际加载，排除文件没有造成缺失依赖。
2. 原生 `NativeSegmentEngine` 同步写入一条带明确内容的事实，关闭，再创建实例打开同一目录，读取并精确比较保留内容；记录安装现场编译出的 binding 路径与 SHA256。
3. 通过安装后的 `ai-app-bridge-mcp` 实际 stdio JSON-RPC 完成 initialize、tools/list 和 capabilities；检查版本及 compact 模式 `capabilities`、`run` 两个工具。
4. 通过 MCP 的 Script 生产入口启动真实 Node 子进程，执行 `6 * 7 === 42` 的代码断言，读取 `script_completed` 事件中的返回值 42；结果要求 `completed`、代码通过 1、设备通过 0、设备调用 0。

## 支持边界

- 安装通过不能替代 Android 真机强证据闭环、性能及故障验证；这些需要独立设备报告。
- 此 RC 的设备强断言仅接受完整单页证据。多页查询和按 ref 取回可用，尚未提供多页合并强断言；分页未读完保持 `inconclusive`。
- Host 观察引用只在本次执行内有效，元数据有 128 条 / 256 KiB 上限，淘汰后不能用于强断言。Host 不保存手机四流 payload 副本。
- **iOS 新增强证据、持久查询及恢复不在本 RC 支持承诺内，也未经本轮真机验收。** 原有 iOS 命令仍保留。
- 没有验证干净机器、Linux、Windows 或其他 CPU 架构上的安装；没有执行公开发布。

## 最终快照记录

最终包：`.tools/implementation-2026-09-07/package-final-r2/mobileaidev-ai-app-bridge-0.3.0-rc.1.tgz`。

| 项目 | 实际结果 |
| --- | --- |
| tarball SHA256 | `45170f142e42e566c3b1063407a15b4d95303c400fff5ffb715a0db87baac153` |
| 包内文件数 | 74 |
| tarball / 解包大小 | 198,974 / 884,376 字节 |
| 排除文件残留 | 0；Intent 生产入口实际加载成功 |
| 安装 | exit 0；227 个依赖包；安装日志记录 18 秒 |
| 原生构建 | 实际执行 `node-gyp rebuild`、两次 C 编译、`SOLINK_MODULE`，`gyp info ok` |
| 原生写 / 关 / 开 / 读 | `NativeSegmentEngine`；写入 globalSeq 1；重新打开读取 1 条，payload 精确相等 |
| MCP | 版本 `0.3.0-rc.1`；真实 initialize / tools/list / capabilities 成功；compact 工具 `capabilities`、`run` |
| 真实 Node Script | `completed`；返回 42；scope=code 通过 1；scope=device 通过 0；设备调用 0 |

本次新安装目录：`/var/folders/15/h64hzjtj6pv23qdjs3wz624c0000gn/T/aab-install-rc-nvdYEE`。实际编译生成的 `segmented_fact_store.node` SHA256 为 `31938541a9875d11cae566d3d380330d728443611538a1ee0981b2544212308e`。

精确安装命令：

```sh
npm install --no-audit --no-fund --foreground-scripts /Users/macbook/Documents/CompanyProject/ai-app-bridge/.tools/implementation-2026-09-07/package-final-r2/mobileaidev-ai-app-bridge-0.3.0-rc.1.tgz
```

原始证据：`package-final-r2/npm-pack.json`、`package-final-r2/SHA256SUMS`、`install-validation-final-r2/installation-result.json`、`install-validation-final-r2/npm-install.log`、`install-validation-final-r2/mcp-stderr.log`，均位于 `.tools/implementation-2026-09-07/`。JSON 包含实际 capabilities、终态、作用域计数、完整安装及 binding 路径。此前试装记录保留为开发过程证据，与本次最终 tarball 分开。

本次 r2 保留前一份 `package-final` 包及安装证据，不覆盖历史记录。逐文件比较确认没有新增或删除文件，仅 `README.md` 和 `bin/mcp-server.js` 的错误说明文字不同；本次仍完整重做安装与运行检查。
