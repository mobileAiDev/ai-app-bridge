# Android 公共 Maven 发布

本项目当前由 JitPack 从不可变 Git tag 构建并发布标准 Maven 制品。本文固定发布方法与故障判断；各渠道和设备验收进度见[版本发布记录](RELEASE_VERIFICATION_0.4.15_2026-10-15.md)。

## 构建依赖从哪里下载

[根 settings](../settings.gradle.kts)和[独立 Gradle plugin settings](../android/ai-app-bridge-gradle-plugin/settings.gradle.kts)均接受显式 Gradle 属性 `aiAppBridge.centralRepositoryUrl`，同时用于插件解析和普通依赖解析。

| 调用方式 | Central 下载源 |
| --- | --- |
| 未设置该属性，包括普通本地构建 | 原有 `mavenCentral()` |
| 显式设置该属性 | 指定 URL 替换该处 `mavenCentral()` |
| 当前 JitPack 构建 | `https://maven.aliyun.com/repository/central` |

这是调用方选择下载源，不是遇到失败后自动换仓。Google Maven 和原有 Gradle Plugin Portal 保持独立配置；该属性并不将它们一并替换。阿里提供的是[公共 Maven 代理仓库](https://developer.aliyun.com/mirror/maven)，不是本项目新的发布仓库。消费者仍从 JitPack 获取 Bridge 制品。

[jitpack.yml](../jitpack.yml)使用 JDK 17，实际执行：

```sh
./gradlew --no-daemon -PaiAppBridge.centralRepositoryUrl=https://maven.aliyun.com/repository/central clean publishToMavenLocal
```

普通本地验证不传该属性，仍走官方 Central。建议隔离 Maven 输出，避免随后消费者误用本地产物；运行环境需要 JDK 17 和 Android SDK 35：

```sh
publication_repo="$(mktemp -d)"
./gradlew --no-daemon -Dmaven.repo.local="$publication_repo" clean publishToMavenLocal
```

需要验证 JitPack 的仓库选择时，在该本地命令中显式增加同一 `-PaiAppBridge.centralRepositoryUrl=...` 参数。`publishToMavenLocal` 只完成本机编译、打包和 POM 生成；源码相关测试、设备验收及公共发布分别核验。

## 发布顺序与完成条件

1. **冻结候选。** 同步各端版本，保存 commit、发布源码清单与 SHA-256；完成变更所需测试，再从该源码生成本地参照产物。不要因纯版本调整重复无关设备回归。
2. **推送新 tag。** 核对远端 tag 指向冻结 commit。保留旧 tag、旧制品及失败日志，不移动或覆盖已发布版本。
3. **触发并检查公共构建。** 请求目标版本的 POM，保存 HTTP 状态、响应和退出码。随后查看状态 API 与构建日志，确认实际 commit 和最终构建结果。
4. **下载并核验公开制品。** 本地构建成功、状态 API 为 `ok`、单个 POM 可读，都不能替代全部产物核验。
5. **升级消费者。** 公共产物核验通过后才更新依赖，实际解析、构建，并将解析产物 SHA 与公开下载的 SHA 对照。保留消费者已有改动；不能用本地 Maven 产物替代公共验证。

以 `0.4.15` 为例，可用以下命令触发和查询。30 秒是 HTTP 客户端等待上限，不是远端构建期限：

```sh
release_version=0.4.15
publication_evidence="$(mktemp -d)"
curl --fail-with-body --silent --show-error --location --max-time 30 \
  --dump-header "$publication_evidence/trigger.headers" \
  --output "$publication_evidence/android.pom" \
  "https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/ai-app-bridge-android/$release_version/ai-app-bridge-android-$release_version.pom"
trigger_status=$?
printf '%s\n' "$trigger_status" > "$publication_evidence/trigger.exit-code"

curl --fail --silent --show-error --location --max-time 30 \
  "https://jitpack.io/api/builds/com.github.mobileAiDev/ai-app-bridge/$release_version"
curl --fail --silent --show-error --location --max-time 30 \
  "https://jitpack.io/com/github/mobileAiDev/ai-app-bridge/$release_version/build.log"
```

查询应留出构建时间，不连续重发触发请求。未完成时的日志可能只是当前快照；只有最终结果才能判定构建成功或失败。

当前发布包含八个模块：`ai-app-bridge-android`、`ai-app-bridge-gradle-plugin`，以及 `ai-app-bridge-test-{core,instrumentation,espresso,espresso-web,compose,uia}`。每个模块核验一份 POM 和一份 AAR/JAR，共 **16 份主产物**；Gradle plugin 另有两个插件 marker POM。公开坐标为 `com.github.mobileAiDev.ai-app-bridge:<module>:<version>`；普通本地发布使用 `io.github.mobileaidev.aiappbridge`，二者需按各自发布配置核对。

公开验收包括 HTTP 200、正确坐标和内部依赖版本、ZIP 完整性、SDK 内嵌版本及各 `.class` 的 SHA-256 与冻结本地参照一致。`0.4.15` 共 **341 个 class**；以后按当版源码生成清单，不把这个数量写成永久常量。整包 SHA 因 ZIP 时间戳不同而变化时，应记录差异并比较解压内容，不能直接宣布一致。

## 出错时如何判断

| 现象 | 判断与下一步 |
| --- | --- |
| 下载依赖返回 HTTP 429 | 记录具体仓库、坐标、时间和日志；这是下载限流。检查缓存与共享出口，减少重复冷下载，不先归因为源码编译错误。 |
| 触发 POM 的请求超时，例如 curl 28、HTTP 000 | 只说明本次 HTTP 请求未取得结果。远端可能已开始构建；查状态和日志，不立即重复发布。 |
| 状态暂为 `none`，日志已经显示正确 commit 和构建命令 | 构建已开始，状态元数据尚未反映最终结果，继续低频查询。 |
| 日志出现编译器诊断、失败任务和 `BUILD FAILED` | 按具体失败任务调查；`BUILD FAILED` 也可能由依赖下载失败引起，不能仅凭这一行判定产品代码有错。 |
| `BUILD SUCCESSFUL` 或 API `ok`，但有产物无法下载或内容不符 | 公共发布验收仍未通过；保留构建结果及下载失败，继续核对公开制品。 |

**换版本只会建立新的发布身份，不会自动解除限流。** Central 会根据共享网络、CI 或其他基础设施的聚合流量限流；应优先复用缓存、减少重复下载。时间过去很久，也不能单凭这一点认定限制已经解除。[Sonatype 429 说明](https://central.sonatype.org/faq/429-error/)

## 0.4.15 的实际证据

2026-10-15，发布 commit 为 `458c7d79a87f81d847daa3d53ee0d743d6fd1d85`：

| 验证 | 结果 |
| --- | --- |
| 显式镜像、全新 Gradle 依赖/transform 缓存的本地构建 | `clean publishToMavenLocal` **351.274 秒**通过；复用既有 Gradle 8.13 分发包和 Android SDK，并使用显式本机代理网络路径。 |
| 代表性下载内容 | `kotlin-reflect:2.0.21`、`kotlin-stdlib:2.0.21`、`kotlin-stdlib-jdk8:2.1.0`、`annotations:13.0` 共 **8 份 POM/JAR** 与官方来源内容逐字节一致。 |
| 镜像构建与原本地构建对照 | **16 份主产物内容、341 个 class 一致**；15 份整包 SHA 一致，Gradle plugin JAR 的 21 个 ZIP 条目时间戳不同，所有解压条目内容一致。 |
| 本地下载日志 | 352 次 Ali Central 下载、无直连 Central URL、无 HTTP 429；Google/Plugin Portal 仍独立使用。 |
| 真实公共 JitPack 构建 | **2 分 25 秒**通过，**0 次 HTTP 429**；公开 16 份主产物和 341 个 class 核验通过。 |
| 四个消费者 | 7 项解析/构建检查和 6 个 APK 通过，实际解析产物与公开 SHA 一致；不等同于新一轮设备验收。 |

证据位于仓库同级 `ai-app-bridge-release-evidence/0.4.15-2026-10-15/`：`maven-mirror-experiment/COLD_BUILD_ARTIFACT_REPORT.json`、`maven/PUBLIC_PUBLICATION_REPORT.json`、`maven/jitpack/artifacts-report.json`、`consumers-four/closeout.json`。这次冷缓存实验用于验证新的镜像配置，**不是每次发版必须清空全部缓存重新下载**；后续按仓库选择、工具链和依赖变化决定需要补哪些验证，并保留正常缓存。

## fat AAR 与直接上传 Maven bundle

现有发布已经是编译后的 AAR/JAR，配套 POM 描述坐标和依赖。AAR 本身不包含完整 Maven 依赖元数据；标准仓库发布让消费者继续使用依赖解析和版本冲突处理。[Android 官方发布说明](https://developer.android.com/build/publish-library/upload-library)

把运行时依赖合进 fat AAR，不能省掉构建它所需的 Gradle、AGP、Kotlin 编译器和插件下载。这次 429 出现在构建依赖下载阶段，因此 fat AAR 不是该故障的解决措施；是否合并运行时依赖，应另按消费者需求评估。

**在本地或 CI 构建一次，再直接上传标准 Maven bundle，是另一种可行发布架构。** 它能避免 JitPack 再从源码构建一次，仍需做好第一次构建的缓存与依赖下载。若选择 Maven Central，需要发布账号、已验证的 [namespace](https://central.sonatype.org/register/namespace/)、[签名及制品要求](https://central.sonatype.org/publish/requirements/gpg/)，并通过上传、验证、发布和公共下载核验；上传成功不等于已公开。[Central Publisher API](https://central.sonatype.org/publish/publish-portal-api/)

本项目目前仍使用上述 JitPack 路线，尚未切换到 Central bundle 发布，也未更改消费者坐标。
