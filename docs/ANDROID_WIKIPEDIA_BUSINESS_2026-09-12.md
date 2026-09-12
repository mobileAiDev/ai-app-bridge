# Wikipedia 真实文章与阅读列表证据

原 Wikipedia 样本的网络前提已恢复。真实搜索、文章/章节、收藏新建取消、保存与重新打开已有 Intent 和独立 SQLite 证据；接续已补充测试收藏清理、无结果、重复文章、主题与 Wikipedia 优先语言修改恢复。搜索中的同名节点和主题重建后的前台身份暴露了实际 Bridge 缺口，已分别补充精确 UIA 引用与 SDK 前台 Activity 跟踪。**固定业务 Script 01–06 均未通过且归档保留；05 已越过目录和语言恢复，停在新建收藏前的未派发 UIA 拒绝；06 停在页面切换时的只读 `no_current_activity`。07 已启动，结论待实际终态，完整 P9 和四 App 组合仍未通过。**

当前顺序统一见[后续关口](BRIDGE_NEXT_GATES_2026-09-08.md#2026-09-12-样本收敛与当前顺序)。下文分别记录已取得的结果与原失败；编写中的 Script 不计入通过。

## 样本与操作范围

设备为获授权 OPPO `b46093e6`，隔离包为 `org.wikipedia.dev.bridge_sample`。上游仍为 `r/50605-r-2026-09-08`、提交 `2fa2f9536e0d0120ef82638d9ea8086be821f3a3`；本轮没有修改 Wikipedia 业务源码。当前 Wi-Fi 与 VPN 并存，未为测试关闭 VPN。

所有以下相对证据路径均位于 `build/ai_app_bridge_artifacts/wikipedia-network-resume-20260912-02/`。公开命令由当前仓库 CLI 经共享运行时执行，设备与包名显式绑定。

| 已执行内容 | 实际依据与结论 |
| --- | --- |
| 官方搜索 | Native 搜索框输入 `月球`；`16-search-network.json` 的实际 prefixsearch 请求 483、484 返回 HTTP 200。`search-results.png` 展示结果，不再沿用先前网络失败的结论。 |
| 打开文章 | 修复后的 Intent 使用本次 UIA 观察的节点引用选中结果标题；`24-open-exact-moon-result.json` 成功，随后 H5 读取实际 `zh.wikipedia.org/api/rest_v1/page/mobile-html/…` 的月球正文。 |
| 目录与章节 | Native 打开目录并选择“名称和语源”；`30-section-h5.json` 读取实际文档，滚动位置为 `1836.6666259765625`。这是 Native 操作与 H5 读取，本轮未据此声称完成 H5 点击或输入。 |
| 取消新建收藏 | 在“新建收藏”输入 `AAB Intent Cancel 20260912-01` 后取消。UI 返回原收藏面板，独立数据库中没有该名称。 |
| 新建测试收藏 | 创建 `AAB Intent Moon 20260912-01`，描述为 `Bridge real article and persisted reading list`；实际 Snackbar 显示添加成功，独立数据库出现对应收藏及月球关联。 |
| 重新打开 | 显式启动 Wikipedia 主入口，经“已保存 → 收藏”打开该测试收藏；实际标题、描述和月球行由本轮 UI 读取。`saved-test-collection.png` 仍带一次性分享提示，不能把它当成无遮挡的文章行截图。 |

新业务 Intent 为 `intent-1789186151809-1`，终态 `completed`、revision 31，见 `62-complete-business-intent.json`。该终态只覆盖上述具名操作，不能替代完整 P9 验收。本轮结束时新建的测试收藏与默认收藏中的月球记录保留；后续测试收藏清理结果见下节接续证据。

## 本轮修复的 Bridge 缺口

同一搜索页的输入框、结果标题和描述都有“月球”。原 `selector: {text: "月球"}` 正确拒绝歧义，但公开能力无法指定已经观察到的那个节点，真实 Intent 因 `uia_selector_not_unique` 失败，见 `17-ambiguous-moon-result.json`。

现在 `uia-tree` 紧凑节点和 Intent UIA 摘要携带完整 `targetRef`；CLI/MCP/Script 可交给 `tap-uia`，Intent 可引用当前 revision 的 `nodeRef`。运行时按原 snapshot、节点、窗口和运行实例校验，并使用原 accessibility 动作回调。普通文本歧义仍然报错；没有用索引、坐标或隐式 provider 切换代替精确引用。合同见[公开命令说明](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md)。

验证分层如下：

- 70 项 Host 定向检查通过，覆盖严格参数、引用匹配、当前 Intent 以及受控 peer 上的公开 Script；原测试输出在执行记录中，未另存完整日志。
- `UiaActionEngineTest` 21 项、`UiaJournalTest` 22 项 JVM 检查通过，0 失败/错误/跳过，XML 在 `android/ai-app-bridge-uia/build/test-results/test/`。`uia-build.log` 为实际 runtime bundle 构建成功记录；新 DEX bundle SHA-256 为 `50287a3e533fa54f995a2e14dcf886d8746931232416bba8c9a10e9e16de0d32`。
- 真机 Intent 精确点中同名结果；随后旧引用由公开 CLI 拒绝为 `uia_stale_reference`，`dispatched: false`，见 `25-old-search-ref.json`。此负例证明过期引用拒绝，不能单独证明所有属性变化分支均经过真机验证。
- 本轮没有真实设备上的新业务 Script 结果。受控 peer Script 检查与真实业务 Script 分别记账。

## 独立持久数据核对

[read-reading-lists.py](../examples/wikipedia-sample/validation/read-reading-lists.py)只解出原 `wikipedia.db` 及其 WAL/SHM/journal 的本地副本，以 SQLite `mode=ro`、`query_only` 读取原 `ReadingList` 和 `ReadingListPage`，并核对源 tar 未变化。预期业务结果由验证者核对；读取器没有写入 App、手机数据库或伪造业务字段。

| 检查点 | 原数据库结果 |
| --- | --- |
| 初始基线 `baseline-reading-lists.json` | 两表均为空，integrity `ok`。初始复制有公开 freeze 回执，但没有保存 `/proc` 停止状态证明，不能追认这一更强条件。 |
| 取消后 `after-cancel-reading-lists/result.json` | 只有默认收藏及其月球关联；取消的测试名称不存在。App 点击“保存”后会先加入默认收藏，再让用户选择其他收藏，因此“取消新建收藏”不等于“撤销默认收藏”。 |
| 创建后 `56-saved-foreground-reading-lists/result.json` | 原默认收藏/关联保留；新增收藏 id 2，标题和描述精确匹配，新增月球页关联 `listId: 2`，创建时间在本轮。取消名称仍不存在；integrity `ok`、数据库版本 35。 |

最终 tar 为 `56-saved-foreground-databases.tar`，SHA-256 `57e798aad7932baed7f773c5e1678f05f5db00d1cf9f7f6682f0e4aac0ba3427`。配套 `56-saved-foreground-snapshot.json` 记录复制前后进程 3190 均为 `T (stopped)`，最后恢复成功。此前 `51-saved-snapshot.json` 未达到停止状态前提、没有复制归档，且 finally 已恢复，保留为失败的采样尝试。

数据库 `offline: 1` 和 UI 的离线容量只证明本轮实际记录与显示。本轮未断网重新打开文章，不能声称完成离线阅读验收。

## 归档及明确保留项

原运行时停止后，以下三份 Host Intent 记录在独立离线运行时核验为 `verified`；结果分别为同名 `*-offline.json`。离线验证运行时也已停止。这里的 `verified` 是归档完整性，归档自身不评估业务结论。

| Intent | 记录数 | 归档目录及 manifest SHA-256 |
| --- | ---: | --- |
| 网络准备 `intent-1789185115244-1` | 12 | `probe-archive/`；`839422f22bf02108a2f3179c428fdb5f55c879c2e10c8f4370d9b971c89169b6` |
| 同名失败 `intent-1789185243804-2` | 23 | `business-failed-archive/`；`8ea5f8213d09103c4789b09520b2c8bc29df73d434b0d20733977deb49718539` |
| 精确引用及业务 `intent-1789186151809-1` | 109 | `reference-business-archive/`；`dc890214cb3e72139e268ef558ba578dfca08c38a653d4b367185567a875922b` |

这三份 export 的 `recordedPayloads` 计数为 0。截图、网络读取和独立数据库证据位于上面声明的相邻文件，不能声称已包含在这三份 export 中。网络预检的终态保持 `inconclusive`，同名失败保持 `failed`，没有改写旧证据。

长文章 UIA 观察曾返回 `uia_tree_capacity_exhausted`，保留在 `47-created-list-sheet.json`；随后显式 Native/H5 观察继续业务，没有提高容量掩盖限制。页面返回曾离开 Wikipedia 回到 LocalSend，重新观察后显式启动 Wikipedia 主入口，未向错误 App 派发后续业务动作。

## P9 接续：清理、无结果与设置恢复

新增证据根目录为 `build/ai_app_bridge_artifacts/wikipedia-p9-intent-20260912-01/`，本节文件均相对该目录。以下是逐项证据核对，不能合并为一次完整成功的 Intent。

| 新增范围 | 实际结果与边界 |
| --- | --- |
| 清理上一轮测试收藏 | `18-after-test-cleanup-snapshot.json` 记录复制前后进程停止且最终恢复；只读数据库仅保留原默认 list 1/page 1，与上一轮取消后的默认记录一致。测试收藏已删除，默认月球关联保留。 |
| 无结果与再次打开文章 | `30-no-result-ui.json` 对查询 `AABNoArticle20260912QXZV` 显示两条“没有结果”，截图为 `no-results.png`。随后 `37-real-moon-h5.json` 读取实际月球正文；摘要有截断且 readyState 为 interactive，只证明已观察内容，不声明全文完整或新网络请求完成。 |
| 主题修改与恢复 | `50-light-settings.xml` 为 `colorTheme=0`、`matchSystemTheme=false`；`56-restored-settings.xml` 恢复为 `colorTheme=1`、`matchSystemTheme=true`。原 `41-before-settings.xml` 未显式存储 matchSystemTheme，上游 `Prefs.shouldMatchSystemTheme` 缺省为 true，因此恢复的是逻辑设置值，不能声称整份 XML 字节一致。 |
| 优先语言顺序修改与恢复 | 实际 Native drag handle 操作后，`82-language-changed.xml` 为 `languageApp=zh-tw,zh-cn`，`87-language-restored.xml` 恢复 `zh-cn,zh-tw`；`language-priority-changed.png` 和 `90-settings-settled.json` 对应真实 UI。这是 Wikipedia 的优先语言顺序，不是系统 locale 修改。 |
| 返回主界面 | `93-main-ready-1.json` 是新的 MainActivity 观察。最终 `intent-1789188115351-4` 在 `95-complete-settings-intent.json` 为 completed、revision 32，仅对应其设置恢复等具名范围。 |

前三次 Intent `intent-1789187648132-1`、`intent-1789187890055-2`、`intent-1789188052869-3` 分别保持 failed（63/45/21 条记录）：输入时编辑框仍不可见、匹配系统主题时浅色按钮被禁用、UIA 观察需更新，均在派发前拒绝。两次 Native `reobserve_required` 和入口不接受的旧参数也保留，没有重写为成功动作。

四份 Host 归档均已离线 verified，准确 ID、记录数和哈希在 `archives.json`。最终归档 106 条，manifest SHA-256 为 `ee43962bf04869c62c5d3b0563324cdaa68c37e06eccfce598f674c97b5f895d`；前三份失败归档完整保留。`phase-status.json` 冻结当时的六项核对、每次终态、拒绝类型与 `scriptStatus: awaiting_real_run`，不是后续 Script 的当前状态。`evidence-manifest.json` 对实际引用的 42 个旁路文件记录 SHA-256/字节数，并明确两项根目录外来源；它不包含自己，不递归打包 runtime/facts。这些文件仍不属于零 recordedPayload 的 Host export。原 Host 与离线 Host 已停止。

## 固定 Script 实跑：截至 06 尚未通过，07 待终态

每轮权威结果为 `build/ai_app_bridge_artifacts/wikipedia-business-script-20260912-0N/report.json`。以下均为独立运行，不把不同轮已经走到的步骤拼成一次完整通过；时间为各轮 `executionWallMs`，不是完整业务耗时。

| 轮次 / operationId | 耗时 | 实际终态与停止点 | manifest SHA-256 |
| --- | ---: | --- | --- |
| 01 / `script-1789189397484-1` | 21.506 秒 | failed；未等到预期 `search_text_view` 入口。 | `c3535b963d61f51de35b63c6277b1fd542d6f4756e4e33b98c79a9333e88a50f` |
| 02 / `script-1789189548523-1` | 15.650 秒 | failed；四项文章/目录断言通过，但本次搜索请求证据断言为 inconclusive，保留原结论。 | `d6f1f477ed56fd171c556896e9d61122850165f38c70ea7a478e9f2d820f4ba4` |
| 03 / `script-1789189857538-1` | 16.330 秒 | failed；Main 导航初始状态超时，未开始完整业务。 | `671342bf2cb48ae608dc681b46848b14b3763a9d4ef56294077ad44ef330a64a` |
| 04 / `script-1789190167371-1` | 28.923 秒 | failed；本次输入后的真实搜索网络、精确搜索节点、文章正文和目录四项断言通过；目录选择后的滚动增量等待超时。 | `e2391f36ceaf634049cd9e75ef0bbc732bd02927f43ac0629b27be689e326836` |
| 05 / `script-1789191180746-1` | 52.281 秒 | failed；16 项断言及 baseline/language-changed/language-restored 三次独立核对通过；新建收藏前 `uia_reobserve_required`，原回执为 `dispatched:false`。 | `2e35a03fcdb08223ed101306378404f3045f9f455333fd391ca53b7e9dc34eb8` |
| 06 / `script-1789191775407-1` | 22.716 秒 | failed；7 项断言和 baseline 独立核对通过；页面切换期间 `tree` 返回 `no_current_activity`，脚本当时将只读等待状态作为失败结束。 | `637c2354e7d8a38088feeb700cf612325576712318aff5b68cc8a0c5871111ec` |
| 07 / `script-1789191980907-1` | 待终态 | 已启动；本表尚未记录终态、完整断言或独立结果，不预告通过。 | 待导出和离线核验 |

01–06 原 Host、离线 Host 均已停止，各自归档离线 verified；该完整性结果不改变 failed 终态。04 的文章恢复了旧滚动位置，原谓词缺少固定初始位置；显式回顶后，05/06 已实际通过回顶和章节定位断言。这只关闭该定向问题，不代表完整 Script 通过。

原 Intent 的 Native 原始树显示：主题重建后仍可见文章工具栏，却将 activity 报为 MainActivity。已定位 SDK `onCreated/onStarted` 覆盖当前 Activity，后台 Main 重建抢走前台 Page 身份，H5 pageRef 同样受影响；这不是环境阻塞。SDK 已修正前台所有权与迟启动时首次焦点识别，`ForegroundActivityTrackerTest`、`FocusedActivityStartTest` 各 6 项通过（共 12/12）。新的 Native/H5 身份仍须由完整真实主题流程确认，不能以单测替代此项。

两次更新保持原 Wikipedia 业务源码，均通过公开安装 Intent completed、设备 APK SHA-256 一致和归档离线 verified，证据根目录为 `build/ai_app_bridge_artifacts/wikipedia-activity-owner-20260912-01/`。对应 `installed-proof.json` / `installed-proof-late-start.json` 和两份 build proof；最终 APK 为 `84e723bacaefdd3f5e06de11417d9987c41d12b55b61f093544fb4206eb72f18`。安装 Intent 为 `intent-1789191036408-1`、`intent-1789191695345-1`，归档 SHA 分别 `0e2c00af355eb55ad9f89f55f489f68f86d3d4e3d23dfcbdf2c0b97de244b81f`、`594584952721180199fb827e37c3ccd634ac0e103deb8258345430da140cd9fc`。

07 使用 Script SHA-256 `f755959577281270cc299ed7a243ff19a7bd8237ccf6a56d74fdbbeac8f761f3`：新增 UIA 稳定观察，只有原回执明确未派发时才允许最多三次新观察；页面切换的 `tree no_current_activity` 仅作为有界只读等待。原拒绝保留，不盲目重放已经派发或结果未知的动作。07 完整结果仍待原报告终态及独立核对后填写。

当前继续这条主线：**复杂 App Intent/证据 → 固定 Script → 当轮独立业务核验 → 同一 Host 的原四 App 组合实测**。先完成原 P9 固定范围及当轮数据库/设置核对，再接组合；只修阻碍该路径的产品缺口或很小的样本前提，不新增 App，不重跑无变化的已通过矩阵。现有 iOS 原生、H5、Flutter 及最终生产命令/可靠性/发行要求继续保留。
