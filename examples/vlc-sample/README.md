# VLC Android 真实媒体样例

用于验证 Bridge 的 Intent → Script 业务链路。上游固定为官方 VLC Android 3.7.1，源码和两个原生/远程控制依赖的提交见 [source.json](source.json)。构建使用独立包 `org.videolan.vlc.bridge_sample.debug`，不会覆盖手机已有的 `org.videolan.vlc`。

`integrate.py` 只调整包名、接入本仓库 Android SDK/Gradle 插件，并将开发包最低 Android API 改为 Bridge 要求的 19；不修改 VLC 业务实现。`upstream/` 与构建输出均被忽略。

## 构建约束

1. 克隆 `source.json` 中固定的 VLC 提交至 `upstream/`；克隆并检出固定的 `libvlcjni/` 和 `application/remote-access-client/remoteaccess/` 提交。
2. 在仓库根目录构建 `./gradlew :ai-app-bridge-android:assembleDebug`，然后运行 `python3 examples/vlc-sample/integrate.py`。脚本拒绝覆盖已有源码修改。
3. 在 `upstream/local.properties` 指定 Android SDK。工具链版本见 `source.json`，Gradle 9.2.1 下载文件必须先校验该文件中的 SHA-256。
4. 在远程控制前端目录执行 `npm ci` 和 `npm run build-android`，随后运行 Gradle 的 `:application:app:assembleDebug`。最终 APK 必须包含与 `remoteaccess/dist/` 逐文件相同的 `assets/dist/`，不能把缺失前端资源的构建作为完整样例。
5. 使用 Bridge 公共 `install-apk` 入口开启安装 Intent，观察并处理系统安装界面。安装后拉取设备 APK，比对冻结产物的 SHA-256。

## 固定媒体与独立验证

`make-media-fixtures.py` 生成 180 秒带可见时间码的视频，以及 90 秒 PCM 音频。依赖固定为 `imageio-ffmpeg==0.6.0`，使用 macOS 系统 Menlo 字体；生成器记录媒体、字体、FFmpeg 的哈希。两个文件只推入 `/sdcard/Movies/BridgeVLCFixture`，另建空目录 `/sdcard/Movies/BridgeVLCEmpty`，逐文件校验手机上的哈希。

`validation/independent-oracle.py SERIAL` 直接读取 Android MediaSession 和隔离 App 磁盘上的 SharedPreferences，不经过 Bridge CaptureStore。系统可能只在状态改变时更新播放位置，因此不能把播放期间不变的 MediaSession 原始位置当作播放器卡住，也不能把宿主推算的位置当作真实进度。应比较暂停时的位置、恢复播放后再次暂停的位置，并结合可见视频时间码。

首次启动通过 Intent 授予媒体和通知权限，选择自定义扫描目录。跨入系统授权界面时，必须在 `target.foregroundPackages` 明确声明 `com.android.permissioncontroller`。根据观察到的前台身份执行；发生页面切换时重新观察，不重放已经派发的动作。

## 验收范围

- Core：首次引导/授权（准备完成后可跳过）、固定媒体扫描、打开视频、播放/暂停/跳转、返回列表。
- Acceptance：包含 Core，另验证空目录、播放进度恢复、反复播放/返回、设置更改与恢复。
- 只有真实业务断言、独立结果和证据导出均通过，才能计为成功。安装和编译成功不等于 VLC 完整验收通过。

2026-09-12：Intent 业务探索已完成，固定 Script 在 OPPO PKR110 上连续三轮通过。核心分别为 21.009、20.863、20.340 秒；整轮 wall 分别为 62.251、61.176、60.865 秒。每轮 11 项业务断言、37–38 次具备原始回执的动作、6 张截图和 18 页持久证据，均通过离线校验。脚本根据可见节点决定设置列表的滚动次数，第三轮少滚动一次即可找到“界面”；业务步骤与断言保持相同。覆盖范围是上述本地视频验收场景。

冻结身份、媒体和步骤见 `validation/vlc-local-media.manifest.v1.json`；执行器核对 Script、oracle、已安装 APK 和媒体的哈希，并运行输出目录内冻结的 oracle。已准备同一基线的设备可执行：

```sh
node examples/vlc-sample/validation/run-local-media.js \
  build/ai_app_bridge_artifacts/vlc-local-media-NEW b46093e6 3
```

输出目录必须不存在，设备须已完成清单中的授权和目录准备。首次引导不计入已学习的重复 Script 时间。Script 使用 SDK 的设备时间建立本轮查询边界；重启后等持久存储 attached，再检查各页 coverage/commit/ref/epoch。恢复播放允许最多 1.5 秒的系统状态采样偏差。

完整报告见 [VLC Intent / Script 验收](../../docs/ANDROID_VLC_INTENT_SCRIPT_2026-09-12.md)。过程证据在 `build/ai_app_bridge_artifacts/vlc-business-20260912-01/`，三轮冻结证据在 `build/ai_app_bridge_artifacts/vlc-script-20260912-frozen-01/`。三个失败的开发轮次独立保留。
