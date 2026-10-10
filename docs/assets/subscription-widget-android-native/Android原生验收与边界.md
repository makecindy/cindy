# Android 原生小组件验收（2026-10-02）

本轮在用户明确接受 SDK 许可后完成 Android SDK 安装、完整 Cindy App 原生编译和实际 AOSP Launcher AppWidget 测试。延续 PR #5252，保持 draft；没有合并、发布、读取凭据或更改已确认 iOS 视觉。

## 安装与构建

工具均位于任务目录 `dist/quota-widget-tools/`：Temurin 17.0.20.1+1、Gradle 9.3.1、Android SDK 36、build-tools 36.0.0、platform-tools 37.0.1、官方 ARM64 emulator、AOSP API36 ARM64 r02。完整 Expo 构建使用 NDK 27.1.12297006，expo-updates 同时要求 27.0.12077973，均由官方 SDK 工具安装。未修改全局 Java、系统 Ruby、权限或防火墙。

完整生成工程命令（任务本地 SDK/JDK 环境已设置）：

```sh
cd apps/mobile/android
./gradlew :app:assembleDebug :cindy-quota-widget:testDebugUnitTest \
  -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
```

最终执行退出 0：**BUILD SUCCESSFUL**；734 tasks，35 executed、699 up-to-date。Android JVM **7 tests / 0 failures**。初次 SDK 尚未就绪的构建失败和后续修复日志保留，未把初次失败隐藏为通过。

完整 debug APK：`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。开发签名，仅本地安装，未改变生产签名。完整 App 已安装到专用 AVD，真实登录页能打开；系统 Widget picker 能发现 Cindy，添加空态后点击 Widget 返回真实 Cindy 登录页。该 debug 包运行依赖本任务 Metro（localhost:8088，专用 AVD reverse 8081→8088），**不是离线可分发安装包**。Metro/构建所属均为 `cindy/sweet-bohr` / 当前 worktree，无其他 session 的 Metro 复用。

## 实际设备与两类证据

- 新建隔离 AVD `cindy-quota-api36`，`emulator-5580`，Pixel9 profile；Android16 / API36，1080×2424px、420dpi。系统指纹 `Android/sdk_phone64_arm64/emu64a:16/BE2A.250530.026.D1/13818094:userdebug/test-keys`。这是 Android 模拟器，非物理手机；未启动 root。
- **完整 App**：`com.xd.cindy`，真实 Cindy 未授权登录页、系统添加、桌面空态、点击深链。未执行 Android 真实账号登录或源额度端到端。
- **额度状态**：`org.cindy.quota.validation` 隔离包，直接复用同一生产 Kotlin、RemoteViews 和生成资源，屏幕显式 Demo data。包含合成额度、计划与 Extra resets；不是正式账号数据，也没有在生产 App 注入测试入口。
- 可复现源码在 `tools/quota-widget-android-fixture/`；prepare 复制当次生产文件，独立包无网络权限、不接收凭据。实际设备 instrumentation **38 条检查通过**，包括三个 VectorDrawable 真正加载、未知/0/整数边界、源时间不前移、存储清空。

## Android 实现与确认规范

从旧文本兼容层补齐 RemoteViews 原生视图：生成的共享主题/token、42dp 同心环与4.5dp线宽、原 provider SVG 图形、12sp品牌/计划、32sp主百分比、14sp次级信息，小写 d/h/m 和5h。Codex Weekly沿用5h语义色，第三行Extra resets；没有重复Reset行。iOS SwiftUI与确认稿没有改动。

两列采用同一3行布局。实测全宽两列内容边界（1080px截图）：左列x81..498，右列x582..1000；主行y678..778、次行778..833、第三行833..880完全对应。文字框对齐与视觉基线已检查，100%+6d 23h未裁剪。缺计划保留计划区，长SuperGrok Heavy换两行；Grok只是边界fixture，不证明真实服务支持此周期。

Launcher实际格子与可用dp不等同iOS small/medium。支持横向拖窄后转纵向；不能容纳全部供应商时显示Enlarge for all。字体1.3和2.0实测保持系统缩放，不以缩小主字号掩盖空间不足。当前一次最多3个provider，实际显示数量受可用高度/宽度影响；不是所有尺寸都能同时展示全部provider。

本轮修复两个实际原生问题：旧 Kotlin sanitizer 少右括号导致编译失败；SVG 相邻arc flags在Android PathParser解析失败，生成时仅展开参数、不改图形。未授权状态现在隐藏旧窗口并显示Reconnect，防止旧额度误呈现。

## 覆盖与限制

| 检查 | 本轮结果 |
|---|---|
| 完整 App + 模块编译、安装、启动 | 通过；debug/Metro |
| 正式 App系统添加小组件、空态、深链 | 通过；未登录 |
| 合成正常/100%最长/0/unknown/Outdated/Offline | 实际AppWidget截图；非网络故障实验 |
| 缺计划、缺5h/Fable、未授权、长计划/三品牌图标 | 实际AppWidget截图；缺窗不补假环 |
| 清空缓存后桌面删除数据 | 生产clear函数隔离测试通过；不是用户实际退出 |
| Launcher横向缩放、字体1.3/2.0 | 实测；纵向缩放交互尚未完整确认 |
| 三品牌drawable、整数次数、旧快照、源时间 | 38设备内检查 + 7 JVM测试 |
| Mobile四文件回归 / 类型检查 | 63项通过 / 通过 |
| Android真实登录、账号切换、源同步、退出 | 未验证，无已授权Android登录态 |
| 物理断网/后台省电/厂商Launcher/实体手机 | 未验证；不把fixture当实测 |
| Duo、第二真实账号、Grok真实账号 | 延续原未验证范围 |
| 维护者设计/冷更批准 | 未获得；用户确认UI不代替该批准 |

完整源码构建与哈希清单记录于 `Android-Native-Evidence.json`；本次新增 Android 原生资源会改变 runtime fingerprint，需要冷更，不能对旧安装包宣称OTA即可获得。iOS视觉不变不等于新指纹已完成iOS重新签名发布验收。

## 下一步与责任

实现者继续补 Android 已授权账号端到端及实体机/Launcher矩阵；在没有该账号前不转移iOS或桌面token。维护者完成冷更/设计审阅，发布负责人决定签名与分发通道。iOS含Widget扩展的签名archive/export准备缺口仍按既有交接表处理，本轮不更改生产证书或上传商店。无需先买安卓手机，当前模拟器已能承担布局和原生契约回归。
