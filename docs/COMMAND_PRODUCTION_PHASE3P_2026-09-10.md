# 第三阶段 P：iOS 持久采证接线

本批交付是 Bridge 的 iOS 公共存查能力。Android 两款复杂 App 的固定矩阵已在 3O 检查点 9 关闭，本批没有继续跑这些套件，没有修改样例业务逻辑。

源码接线、本机真实磁盘测试及 iOS 编译已通过；真机公开接口、进程重启及 iOS Intent/Script 同义执行仍未验收，整体生产关口未通过。

## 本批改变

- `MobileCaptureStore` 从开始就要求真实后端。启动中或存储不可用时拒绝写入；不再用内存记录返回成功。生命周期每次成功打开才接线，停止和迟到回调不会接回旧 store。
- 四类 POST、SDK 采证、App 自动日志只写一条原始持久记录。删除四类采证向观察存储的重复写入；其他 UI 观察及独立 device-log 分区保留自身用途。
- 公开查询从分段存储直接分页读回。`mobileFactId` 包含内容摘要与持久命名空间；清理代次、target、runtimeEpoch、窗口、缺失和原引用一起返回。强查询不再固定返回 `persistence_unavailable`。
- 写入回执区分“排队接受”和“刷盘后读到”。刷盘与提交边界在同一个写入队列操作内完成，防止后来尚未刷盘的写入进入已提交页。续页固定上界，空筛选页也可以有限推进。
- iOS Flutter MethodChannel 不再挑字段重组；将完整载荷送入同一个采证入口，保留 `actionId` 并返回真实回执。HTTP 的错误 JSON、错误参数和非法 actionId 不再被当成空的成功采证。
- 更新 Flutter 携带的 iOS SDK 源码，删除两份内存后端、旧回执原型和旧查询 facade。修复 iOS 编译时暴露的 NSLog 可空 C 指针处理。

公开字段与边界以 [COMMAND_CONTRACT](../desktop/ai-app-bridge-cli/docs/COMMAND_CONTRACT.md#ios-persistent-capture) 为准。

## 验证与证据

证据目录：`build/ai_app_bridge_artifacts/command-production-phase3p-2026-09-10/`。本批源文件及删除项相对 3O 检查点 10 固定在 `checkpoint-01`，不覆盖以前的冻结材料。

| 检查 | 本批结果 | 原始记录 |
| --- | --- | --- |
| Swift SDK 集成 | 58 项通过、0 失败；其中持久采证 17 项 | `swift-integration-final.log` |
| Host 采证接线 | 12 项通过、0 失败 | `host-capture-integration-01.log` |
| iOS 真正的 arm64 App 编译 | 通过，未签名、未安装 | `ios-device-build-final.log` |
| Flutter iOS 插件与完整 SDK | 使用 Flutter 3.41.9 的真实 iOS 框架类型检查通过 | `flutter-ios-typecheck-final-result.json` |
| SDK 发行源码镜像 | 单测逐字节核对通过，旧文件已移除 | `SegmentedFactStoreSourceMirrorTests` |
| iOS 真机 | 尚未执行；已通知接入设备 | `ios-devices-before-user-connection.json` |

真实磁盘测试覆盖：四流每次只写一次、原引用关闭后重开读回、历史分页固定上界、空过滤页推进、运行时变化与同 epoch 重开、时钟倒退、state 投影、淘汰缺口、清理后的引用失效、队列满、原写入失败不借后续成功回执、元数据损坏、迟到挂载取消、大记录分块、刷盘失败、刷盘期间新写入和挂载前未知丢失。

初次测试发现的分区游标误用、大记录缺少分块索引，以及随后定向复现的刷盘/提交边界竞态，均保留原失败记录并已修复。`ios-commit-race-red-01.log` 的原错误为第二条未刷盘记录进入第一次提交结果，最终测试要求第一次只含第一条，第二次才含两条。

本机重开测试实际关闭 C 存储并创建新 Swift Store/Backend，不能代替 iOS App 的真实进程重启。当前 Mac 没有可用的模拟器运行时；设备清单只有不可用的历史配对记录，未把缓存设备资料计为连接或真机验收。

## 退役和范围

删除的 G0/G1/Shadow/G8 iOS 测试断言的是内存后端、双写期间比较、旧字段 facade 或其耗时，不能作为新后端生产证据。其有效存查要求已转为上述真实磁盘测试；旧的内存性能数字不继承到新后端，iOS 持续负载、UI 响应和设备资源指标仍需独立验收。Host 的 iOS 源码正则冻结也随旧实现退役，保留跨端 MethodChannel 和公开查询接线检查。

本批不代表四 App/整机回归，不代表 iOS 远端动作取消、未知结果恢复或 Web 边界已完成。Android 既有固定场景的结果继续使用 3O 冻结证据，不因本批 iOS 改动重新跑矩阵。

## 下一关

1. 用户接入 iOS 设备后，锁定真实 UDID、bundle、签名、SDK 二进制及运行时，从公开接口验证四流、原引用、App 真实进程重启与失败语义。先用现有 iOS SDK sample 验证 Bridge 接线，不扩展样例业务。
2. 同时推进显式平台 target：必须贯穿 schema、标准化/哈希、占用、provider、回执和归档。现有 Intent/Script target 仍以 Android serial/packageName 为入口，不能只加一个 iOS 字段就宣称支持。
3. iOS 动作绑定、取消/期限与原结束回执通过后，才开放该平台的 Intent/Script 最小同义闭环。之后继续既定可靠性、Web、持续负载和四 App 关口。
