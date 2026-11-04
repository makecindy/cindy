# Mac 截图录制按需编码性能验证（2026-10-29）

环境：macOS 26.4、Apple M5 / arm64。保留前轮截图、GIF 与 PNG 优化，在此基础上只为本地 Mac GIF／视频录制启用按请求 JPEG 编码。没有直接裁选区后压缩，也没有更换编码器、降分辨率或调整录制采样周期。

## 优化依据

原生流最多 30 次/秒更新，每次更新都做整屏 JPEG；录制端按 100ms 周期且有背压消费，最多约 10 次/秒，未取用的 JPEG 仍消耗资源。因此只在本地录制端请求画面时编码，减少未被消费的计算。

## 实现与取舍

`RegionVideoCapture` 创建 `NativeDesktopCapture({ encodeOnRequest: true })`，仅 Mac 的本地录制使用新私有参数 `cursor-overlay-demand`。默认远程桌面、单窗口拍照、Windows 与 Linux 仍走原参数和路径；helper 与客户端同包更新，不涉及跨端线协议或 relay。

原生串行队列只保留最新一张尚未编码的 IOSurface；收到 `f` 才用原算法编码，静止时复用已编码 JPEG。按照 [Apple 的缓冲生命周期合同](https://developer.apple.com/documentation/coregraphics/cgdisplaystreamframeavailablehandler?language=objc)，同时 retain 和增加 use count，避免回调结束后系统重用像素；替换、编码完成、空白画面和销毁均释放。没有建立帧队列、复制整屏原始像素或媒体临时文件。

代价是单次请求需要等待编码，且等待期间持有一张原始画面的系统缓冲。系统采集仍在工作，不能把“暂停时无 JPEG 编码”说成“暂停时没有任何 CPU／GPU 开销”。不保证总内存按像素大小下降。

## 原生算法对照：相同输入、完整字节比较

入口：`node apps/desktop/scripts/benchmark-macos-demand-capture.mjs`。

使用真实 CVPixelBuffer / IOSurface、生产 `CaptureFrameStore` 和 CoreImage JPEG 编码器。旧编码体从 `8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0` 的生产源码原样提取（该原生文件在前轮未改），不是重新手写参考算法。3 次画面更新后请求一次，前后后前各 20 次，即每侧每场景 40 个样本；每批新建 CIContext，保留首样本，但进程此前已执行字节对照，不代表冷进程启动。性能采样时没有并行跑类型检查或测试。

| 输入 | 每轮全部处理时间 P50 前→后 | P95 前→后 | 累计 CPU 时间前→后 |
| --- | --- | --- | --- |
| 1920×1080 渐变／色块 | 12.88→3.70ms | 17.37→7.30ms | 200.98→69.26ms |
| 3840×2160 渐变／色块 | 29.57→8.78ms | 40.65→13.43ms | 440.07→142.20ms |
| 3840×2160 高细节纹理 | 129.70→43.99ms | 142.16→51.84ms | 1,644.36→586.01ms |

每侧每场景编码次数 **120→40**；模拟暂停后 30 次画面更新的编码次数 **30→0**。这是 3:1 更新／消费比例的算法对照，不是实测整机 CPU 百分比、功耗或真实录制 FPS。旧路径在请求前已编码，取缓存近乎零等待；新路径请求等待 P50 为 3.70／8.78／43.98ms。不能只报总工作量下降而省略这一代价。

18 组对照（3 种画面 × 3 帧 × 2 个大小预算）经真实按需帧槽返回，与旧实现 **全部 JPEG 字节相等**；100KB 小预算覆盖原有降低质量和缩放降级。验证最新帧替换、静止重复、首帧前请求、空白失效、恢复、释放以及编码失败后恢复。首次夹具直接创建的 IOSurface 无法被 CoreImage 编码，前后均返回空；修正为 CVPixelBuffer 创建后执行以上检查，没有放宽非空或相等断言。

原始数据：[region-macos-demand-performance-2026-10-29.json](region-macos-demand-performance-2026-10-29.json)。

## 真实 Mac 采集进程

入口：`node apps/desktop/scripts/benchmark-macos-live-capture.mjs`，显式实机测试，会短暂覆盖一个屏幕显示合成动态图案；不移动鼠标、不激活其他应用。测试结束关闭自己启动的图案与采集子进程。

本机屏幕 1470×956 DIP、2×。真实编译运行旧／新 helper，顺序为前后后前；每次首次取帧后按 100ms 周期取 30 帧，再暂停 1 秒并恢复，最后验证同一静止画面可重复读取且 JPEG 一致。四次运行都正常通过 EOF 退出。`/usr/bin/time -l` 计量对应原生进程，包含启动、采样、暂停与静止读取。每侧合计 60 个稳定取帧样本、2 次独立进程；不是长时间功耗测试。

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 累计 CPU 时间 | 1.49s | **0.59s（减少约 60.4%）** |
| 取帧等待 P50 | 5.21ms | 15.73ms |
| 取帧等待 P95 | 12.76ms | 22.61ms |
| 实际请求／取帧速率 | 9.952 帧/s | 9.947 帧/s |
| 两进程中较大的最大 RSS | 32.89MiB | 31.84MiB |

CPU 包含 1 秒暂停，不能把 60.4% 直接套到持续录制或整个 Cindy。RSS 样本不足以证明稳定内存收益，实际依旧需保留一个系统缓冲。首次取帧耗时前两次约 615／583ms、后两次约 129／153ms，有系统冷启动影响，不宣称启动变快。

真实连续桌面受系统调度影响，跨运行的画面序列和 JPEG 校验值不保证相同；第一轮静止摘要也与其余三轮不同，未据此声称不同运行的全部帧相等。精确画质保证来自上一节相同输入的字节对照。本节只验证真实采集、暂停恢复、静止复用和取帧速率，不包含 Electron 裁剪、GIF／WebM 编码与最终播放；没有据此声称真实 5 分钟录制完全相同或全流程验收完成。

原始数据：[region-macos-live-performance-2026-10-29.json](region-macos-live-performance-2026-10-29.json)。

## 回归与边界

- 原生算法／IOSurface 生命周期检查通过，arm64 与 x86_64 helper 编译通过；arm64 真实采集通过，未在 Intel Mac 实机运行。
- 定向单测 10 文件 98 项通过，1.32s，包含原 GIF 帧合并、时长、暂停和结束测试；本次新增 Mac 私有调用参数、迟到帧取消与本地区域裁剪回归。另单独运行修改的两个文件：`macNativeCapture.test.ts` 1.16s、`liveCapture.test.ts` 430ms，均满足 5 秒预算。
- Desktop 类型检查、定向 ESLint、test-hygiene（359 文件基线）、dev-docs（10 项）、`git diff --check` 通过。本轮未改 Renderer、界面或录制帧间隔，沿用前轮 UI 结果，不声称重新进行了所有 UI 验收。
- 同时修正前轮 PNG 优化中的动态 `import('sharp')`：遵守仓库 main 静态依赖规则，复用已有静态依赖；编码失败仍回原 PNG。画质／透明图／JPEG 回归通过。前轮保存基准保留为当时版本数据，首次懒加载耗时不代表当前版本；本次不追加 PNG 提速结论。
- 未实施直接区域原生压缩；它会改变 JPEG 边缘／分块与预算行为，需要另作画质约束。Windows 实机和安装包未验证，长时间 GIF／视频录制未单列测量数据。
- 已重启本 worktree 的 Global 隔离开发版，`DESKTOP_DEV_VERDICT=ready`，pid 1425，沙箱 `amazing-morse-0de7eb`。
- 2026-10-29，用户在开发版更新后反馈“验收通过”，本轮 Mac 优化人工验收通过；反馈未另行细分用例与录制时长。
- 提交前精简了实机基准夹具的标题文字；上述实机数据保留采样时结果，未因文案整理重跑或改写数值。

复现：

```bash
capture_report=$(mktemp -t cindy-demand-report)
live_report=$(mktemp -t cindy-live-report)
node apps/desktop/scripts/benchmark-macos-demand-capture.mjs --samples=20 --output="$capture_report"
node apps/desktop/scripts/benchmark-macos-live-capture.mjs --output="$live_report"
```

上述脚本内部均用 `mkdtemp` 创建并清理独立目录；`--output` 是调用者指定的报告位置，复跑时应选择自己的唯一文件名。
