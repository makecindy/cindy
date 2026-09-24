# Xcode 27 Native 兼容验证（2026-09-22）

本次恢复 Native H.264 画面加速及连续单指、双指触控。
精确登记位于 [`compatibility-matrix.ts`](../packages/ios-simulator-runtime/src/compatibility-matrix.ts)，
registry version 为 2，旧 Xcode 26.4 记录保留。

| 轴                           | 本次登记值                                               |
| ---------------------------- | -------------------------------------------------------- |
| Darwin release               | `27.0.0`                                                 |
| macOS（环境记录）            | `27.0` / `26A428`                                        |
| Xcode                        | `27.0` / `27A266a`                                       |
| iOS runtime                  | `com.apple.CoreSimulator.SimRuntime.iOS-27-0` / `24A434` |
| 架构                         | `arm64`                                                  |
| Sidecar / H.264              | `eligible`                                               |
| continuousInput / multiTouch | `eligible`，功能 App 已验证送达、取消和崩溃恢复         |

## 根因与启动条件

这不是“安装多个 Xcode 就不能使用 Native”，也不是“没有进入名单就禁止启动”：

1. 原 Helper 硬链接旧的 SimulatorKit 目录，而本机两份 Xcode 27 都将框架放在
   `Contents/SharedFrameworks`，导致旧 Helper 在握手前被 dyld 终止。
2. 修复加载后，旧 HID 代码仍把目标写死为 `0x32`。Xcode 27 的 SimDisplayView 根据
   screen properties 使用 `0x40000000 | screenID`（间接显示使用 target 1）。本次
   iPhone 的实际 screenID 为 1，必须发往 `0x40000001`；固定 target `0x32` 会被
   legacy client 接受，却不送达 App。改成固定 screenID 0 同样不正确。
3. 旧实现没有接完成回调，底层发送错误可能被当成成功；现在以有时限的完成回调传播
   发送失败/超时，但回调成功仍不等于 UIKit 已处理，因此保留功能 App 的触控断言。

产品运行时未登记的组合仍是 `unknown`：满足平台、架构、制品信任、资源策略且没有明确
`ineligible`，就可以启动 Helper，按握手探测分别激活视频与输入。只有发布验收使用
`requireVerifiedCompatibility: true` 要求精确登记。这次没有收紧为版本白名单。

## 实现边界

- Host 按显式配置、`DEVELOPER_DIR`、`xcode-select -p` 的顺序解析 Xcode，支持带空格的路径及
  `.app` 形式的环境变量；不会切换机器级选择，也不会搜索、借用另一安装来掩盖选择失败。
- 构建和 helper 同时识别 `Contents/Developer/Library/PrivateFrameworks` 与
  `Contents/SharedFrameworks`。helper 不再硬链接构建机的 SimulatorKit 路径，启动后使用
  `dlopen` / `dlsym`；Swift getter 仍通过原有架构 ABI shim 调用，缺失符号返回能力不可用。
- 沙箱 profile v2 仅增加所选 Xcode 的 `SimulatorKit.framework` 读取/映射和路径元数据权限。
  DYLD 注入变量仍被剥离；签名、摘要、Hardened Runtime 与 packaged artifact trust 门保持不变。
- 环境检查解析一次 Developer 目录，并将后续版本/设备探测固定到该目录；路径与版本一起
  传给 WDA 构建、启动、Native 沙箱及 Helper。即使启动期间全局 Xcode 选择变化，同一实例
  及其恢复仍使用原绑定；新实例的新环境检查才读取新选择。未提供路径的旧内部调用保留
  启动时解析行为，不修改机器级选择。
- HID 目标根据所选 SimulatorKit 的屏幕 API 与实际屏幕属性推导，和 framebuffer 绑定
  同一 screenID，不按版本号特判。旧 API 缺少 `screen` selector 时保留 legacy target；
  新 API 存在但属性缺失/屏幕身份不匹配时关闭输入能力，不盲发 legacy target。
- Indigo 构造器内部也维护接触状态，因此串行范围包含消息构造、提交和完成；完成等待
  最多 1 秒，回调独立队列执行，NSError 原始内容不进入 Host 协议。
- 完成等待超时会在释放串行锁前永久隔离该 Helper 的输入注入器；排队及后续的触控、取消、
  `releaseInput` 均在构造消息前拒绝，迟到/重复回调不重新开放输入；随后结束该 Helper，
  由现有进程退出处理触发 WDA 回退并提供 Native 恢复入口。恢复重启 Helper 后才重新建立
  输入状态；不自动重放失败手势，也不重启 WDA 或模拟器。

## 真实验证结果

测试均使用脚本自建临时设备，结束后停止并删除；没有替换已安装 Cindy 的 helper。
下面命令在仓库根执行，默认 `xcode-select` 指向 Xcode 27.0：

```sh
pnpm --filter @cindy/ios-simulator-runtime native:build
CINDY_IOS_SIDECAR_OUTPUT_MODE=helper pnpm --filter @cindy/ios-simulator-runtime native:build
CINDY_IOS_SIMULATOR_RUNTIME=27.0 pnpm --filter @cindy/ios-simulator-runtime native:compatibility-probe
CINDY_IOS_SIMULATOR_RUNTIME=27.0 pnpm --filter @cindy/ios-simulator-runtime native:h264-fallback-smoke
CINDY_IOS_SIMULATOR_RUNTIME=27.0 pnpm --filter @cindy/ios-simulator-runtime native:hid-smoke
CINDY_IOS_SIMULATOR_RUNTIME=27.0 pnpm --filter @cindy/ios-simulator-runtime test:real-smoke
```

| 检查                         | 结果                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Raw binary / Helper.app 构建 | 通过；`otool -L` 不再包含 SimulatorKit 加载项                                                                    |
| Required sandbox framebuffer | 通过，1206×2622 BGRA，stride 4864                                                                                |
| H.264 编码                   | 通过，3 帧、至少 1 个 IDR keyframe                                                                               |
| Hardened Runtime             | 对新建 raw helper 使用本地 ad-hoc + runtime 签名后，required sandbox probe 仍通过                                |
| H.264 → WDA JPEG → H.264     | 触控修复后重跑通过；前后首帧均为 IDR，602×1310；JPEG 17349 bytes，回退 1634 ms                                   |
| Native HID functional App    | **通过**：单指 moved +2 / ended +1，实时拖动 moved +1 / ended +1，双指 maxTouches 2 / ended +2                  |
| 输入取消与崩溃恢复           | **通过**：实时取消、路径 abort、精确 PID SIGKILL 后重启均释放接触，activeTouches 0，恢复后下一手势送达           |
| 边缘返回诊断                 | 现有 fixture 未通过；不据此认定系统不支持，也不声明系统 bezel/Home/back 手势等价                                 |
| WDA 综合 smoke               | **失败**于锁屏等待超时；不能宣称全量 WDA 或 `compatibility:smoke` 通过                                           |

触控 fixture 原先没有 Scene 生命周期，iOS 27 会在
`UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` 终止它。本次更新 fixture 为
SceneDelegate 后才可确认测试 App 已显示 detail 页面。旧 target 在有/无沙箱下均没有触控，
修正为实际屏幕 target 后，同一 required sandbox 下原功能断言全部通过；没有扩大沙箱权限。
新增 Vitest 编译并执行 Helper 共用的 Swift 源码，覆盖 legacy target、不同屏幕 ID、身份
错配、属性缺失、间接显示、异步完成、发送错误、超时及晚到/重复回调。

H.264 fallback fixture 原先轮询 latest-frame 后断言它为首个关键帧，繁忙主机上可能已经读到
后续 P-frame。本次使用 pump 的 `onFrame` 保存初始及恢复的真正首帧，再执行相同 IDR 断言；
同时补上 required sandbox，保证验证路径与产品一致。繁忙主机上曾因 `ps` 枚举超时失败，
重跑完成上述完整回退结果，没有放宽生产超时或恢复边界。

## 旧 iOS 26.x 运行时补测

用户所指的旧版是模拟设备运行的 iOS 26.x，不是 Xcode 26.x。内置模拟器无需打开
Xcode IDE，但并非完全脱离 Xcode：设备启动由 `simctl-lifecycle.ts` 调用
`xcrun simctl boot` / `bootstatus`，Native helper 加载所选 Xcode 的 SimulatorKit，
WDA 基线还通过 `xcodebuild` 构建和运行。iOS runtime 与宿主工具链是两个独立的兼容轴。

本轮使用 Xcode `27.0 / 27A266a`、Darwin `27.0.0`、arm64，并复用此前同一份
本地 ad-hoc Hardened Runtime helper，没有针对旧 runtime 重编译或改变系统默认 Xcode。
helper SHA-256：`41fbe6634abe26d302186c76e3937a97de2cbe91816d24deb4d789700a29319d`。

| iOS runtime | Native HID 功能 App | H.264 → WDA JPEG → H.264 |
| --- | --- | --- |
| `26.4 / 23E244` | 前轮已通过单指、双指、取消、崩溃恢复 | 本轮通过，602×1310，前后首帧均为 IDR；JPEG 14878 bytes，回退 516 ms |
| `26.1 / 23B80` | 本轮通过：单指 moved +2 / ended +1，实时拖动 moved +1 / ended +1，双指 maxTouches 2 / ended +2；取消及崩溃恢复后 activeTouches 0 | 本轮通过，602×1310，前后首帧均为 IDR；JPEG 88241 bytes，回退 727 ms |

以上均要求 OS sandbox。26.1 的现有边缘返回诊断仍为 false，不据此声明系统 bezel
手势等价，也不将 fixture 失败等同于底层系统限制。测试只创建和回收自己的临时设备，不操作已有设备或
替换已安装 Cindy。这证明修复版支持本机这两个旧 runtime 的上述能力，不代表整个
26.x 系列、旧 Xcode 二进制、所有 WDA 功能或最终签名包均已验收。两组补测组合仍保持
release registry 的 `unknown`，产品运行时可按既有策略探测 Native，不需要登记后才启动。

```sh
CINDY_IOS_SIMULATOR_RUNTIME=26.4 pnpm --filter @cindy/ios-simulator-runtime native:h264-fallback-smoke
CINDY_IOS_SIMULATOR_RUNTIME=26.1 pnpm --filter @cindy/ios-simulator-runtime native:hid-smoke
CINDY_IOS_SIMULATOR_RUNTIME=26.1 pnpm --filter @cindy/ios-simulator-runtime native:h264-fallback-smoke
```

### 明确留待独立 PR 的历史问题

只读检查发现：现有 `touchEdge` 将 left/top 的 Indigo 编号对调；查看器实时触摸未传递
边缘标记；边缘返回 fixture 使用普通 pan，并在识别进入 began 后才记录当前位置作为
起点，不能可靠判定最初触点是否在左边缘。这三处在本次兼容改动前已存在。
按用户确认，本 PR 不修改这些行为；后续应独立修复并分别验证 App 内返回与系统边缘手势。

## 其它安装与发布限制

自动化检查已通过：仓库根 `pnpm test:unit:related` 因本地 `origin/main` 较旧自动回退全量，
runner 与全部 required workspace 单测通过；Desktop typecheck、Runtime `build`（`tsc --noEmit`）、
两个修改过的 smoke 脚本的 strict TypeScript 检查、`git diff --check` 均通过。
额外验证了 Forge 使用的纯 Node helper 构建入口，以及 x86_64 ABI shim 的交叉汇编；
交叉汇编不代表 x86_64 原生运行兼容已验证。

- 同一份未重编译的 helper，在非默认目录的 Xcode `27.1 / 27A9269` 下通过
  iOS `27.0 / 24A434` 的 sandbox framebuffer、H.264 与 transport probe；触控修复后，
  同一份本地 ad-hoc Hardened Runtime helper 的 required sandbox HID smoke 也通过，
  包括单指、双指、取消和崩溃恢复，证明框架路径与输入寻址跟随所选 Xcode。
  此组合尚未完成 H.264 fallback 等全部验收，**保持 unknown，运行时仍可探测启动**。
- Xcode `27.0 / 27A266a` 搭配旧 iOS `26.4 / 23E244` 的完整 HID smoke 同样通过，
  包括单指、双指、取消和崩溃恢复；后续视频回退及 iOS 26.1 补测见上节，未外推发布门禁。
- 没有外推到 iOS 27.1、其它 OS/Xcode/runtime build 或 x86_64。旧目录布局有路径回归测试，
  本轮未找到 Xcode 26.x 安装，未声称重新完成旧 Xcode 工具链的原生实测。
- 未运行最终 Developer ID 签名、公证后的 packaged native release gate。本地 ad-hoc
  结果不能代替该门禁，也不能把 WDA 锁屏 smoke 的失败标成通过。
  发版仍按 [正式发版说明](ios-simulator-release-guide.md) 重建、签名与公证整个应用。
