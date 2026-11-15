# GIF 编码响应性能与画质回归（2026-10-29）

本轮接续[截图工具性能分析](region-screenshot-performance-macos-2026-10-29.md)，处理复杂 GIF 画面编码阻塞 Renderer 的问题。保持原有 gifenc 1.0.3、256 色、rgb444 量化、逐帧调色板、索引映射、LZW 压缩、相同帧合并、帧延迟和循环设置，把整段 GIF 编码移到一个录制专属 Worker。没有降低分辨率、颜色数或采样精度，没有共享近似调色板或跳过变化帧。

## 性能结果

macOS 26.4 / arm64 / Apple M5，Electron 42.11.12 / Chromium 148.0.7778.280。基线 `8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0`；优化版为本工作区。输入为 960 × 540 高色彩变化合成纹理，每帧移动一个小白块。每个版本各两批 30 帧，按旧→新、新→旧交替，包含各次录制的首帧与 Worker 初始化，不另行预热 GIF。测量期间没有同时运行本任务其它检查。

下表合并同一版本 60 个样本，单位 ms；[完整原始数据](region-gif-worker-performance-2026-10-29.json)。

| 指标 | P50：前 → 后 | P95：前 → 后 |
| --- | --- | --- |
| Renderer 主线程单帧同步占用 | 112.85 → **0.50** | 119.30 → **0.60** |
| 同线程零延时定时器的实际响应延迟 | 112.90 → **0.50** | 121.30 → **0.60** |
| 等待整帧编码完成 | 112.85 → 113.35 | 119.30 → 119.20 |

主线程同步占用下降约 **99.6%**。这改善编码期间暂停、停止、拖动等交互的可响应性；并不表示 CPU 编码计算变快，也不表示复杂画面已经达到 10fps。新增定时器是事件循环响应探针，不是鼠标到屏幕呈现的端到端延迟。测量包含 Canvas 像素读取、交接与等待 Worker，排除系统抓屏和 IPC。独立 Worker 有启动与运行开销，本轮没有量测峰值内存。

## 顺序、取消与结果不变

- `LiveCapturePanel` 等待当前帧编码完成再采下一帧，最多一个在途帧；`CaptureRecorder` 也拒绝第二个并发提交，避免异步化后堆积像素。
- 像素缓冲区与最终 GIF 通过 transfer 移交，不进行大块结构化复制。Worker 保留上一帧用于原来的逐字节相同帧判定。
- 暂停消息与帧消息按顺序处理；停止等待在途帧并完成最后一帧；取消立即终止 Worker、拒绝在途 Promise。Worker 异常、消息错误及 15s 超时均会结束等待并释放线程资源。
- 时间戳仍由录制端提供，Worker 编码完成时间不替换帧时间；暂停恢复继续使用排除暂停时长的录制时钟。
- WebM 仍使用 MediaRecorder；本轮没有改变其编码参数、容器或输出。

真实 Electron Worker 与基线分别录制一段 64 × 48 动画：文字、静止重复帧、角落一个像素的变化、编码途中暂停/恢复、复杂色彩和半透明输入、完全换色、编码途中停止。两份输出的 **4,634 个字节全部一致**，不是只比较文件大小或 hash。

另用 Chromium 自身的 ImageDecoder 独立解码两份 GIF，逐字节比较五帧的全部 RGBA 像素（每帧 12,288 字节），以及尺寸、时间戳、时长和无限循环属性。帧时长分别为 **230 / 140 / 110 / 210 / 120ms**，总时长 810ms，全部一致。960 × 540 连续压力帧另外核对完整输出长度与 hash 一致。

最初直接在 HTTP 测试页使用 ImageDecoder 时不可用，验收因此失败，未跳过断言。最终在同一个隔离 Electron 测试实例中新建隐藏的本地文件窗口执行解码，随后销毁；未修改产品 CSP、关闭 webSecurity 或添加不安全源启动开关。

## 验证

- 截图相关 **10 文件、119 项单测通过**，1.86s。`captureRecorder.test.ts` 单文件 8 项，0.71s；新增覆盖在途帧暂停/停止、队列有界、取消、Worker error/messageerror 与超时，定时器用 fake timers。
- `pnpm ui:check --page region-capture --case all --theme all --engine chromium`：**16/16**，55.7s。实际 Worker、GIF/WebM 编码、暂停、预览、导出与解码均经过真实实现；帧来源和保存接收端为 fixture，不是原生抓屏/保存框验收。已目检 Light / Dark 的 GIF 播放窗口，图片没有上传。
- `pnpm ui:check --changed --theme all`：**12/16**。其余 4 项是前轮已用 HEAD 对照复现的离屏环境问题：WebM 预览超时，GIF 独立解码页 `Target.createTarget: Not supported`。本轮未将失败算作通过，录制 UI 由上述 Chromium 验证补齐，Worker 编码及逐帧结果由 Electron benchmark 验证。
- UI 单页构建器新增对 Vite `?worker` 的真实构建支持，包含 Worker 依赖的变更扫描、版本对照和资源指纹，没有把 Worker 换成同步替身。专用 E2E 自检验证隔离线程、buffer transfer 与依赖变更；完整自检 **5/5 通过**，17.94s，新 Worker 用例 4.76s。dev-docs 检查通过。
- Desktop typecheck 通过；Vite 的生产模式构建确认输出 `recorder.mjs` 与独立 `gifEncoding.worker-*.js`，未执行完整安装包构建。
- 新增/修改编码文件 ESLint、test-hygiene 和 diff 空白检查通过。`LiveCapturePanel.tsx` 常规 ESLint 遇到 HEAD 已存在的 `react-hooks/exhaustive-deps` 规则未注册错误；确认原注释未改后，用 `--no-inline-config` 执行该文件实际配置的规则，通过，未改 lint 配置。

测试价值依据为 `docs/dev-rules/engineering-conventions.md` §3.2。新增异步边界无法由旧同步编码测试覆盖；最小单测输入为一张 2 × 1 帧，覆盖实际 `CaptureRecorder` 入口的完成、取消和错误结果。真实 Worker、浏览器解码和性能采样保留在显式 E2E/benchmark，不增加默认单测的浏览器或进程成本。设计依据为 `docs/design-rules/DESIGN.md` §14.4，界面响应不能被长时间编码阻塞。

## 复跑

```sh
node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline=8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0 --samples=30 --output=docs/acceptance/region-gif-worker-performance-2026-10-29.json
pnpm --filter desktop exec vitest run src/main/region-screenshot src/renderer/features/region-screenshot src/shared/__tests__/regionScreenshot.test.ts
pnpm --filter desktop run typecheck
pnpm ui:check --page region-capture --case all --theme all --engine chromium
pnpm ui:check:selftest
```

未实测 Windows、真实系统采集下的五分钟长录制或峰值内存；不能把隔离编码阶段数据当成整个录屏链路的性能保证。当前工作区开发实例沿用 Renderer 热更新，未替换安装版。

同日后续继续优化精确量化复用、标注、采集帧和 PNG 保存，增量数据见[第二轮逐项优化](region-screenshot-next-performance-2026-10-29.md)。本报告的 Worker 对比保留为当时原始结果。
