# macOS 截图工具性能分析与优化（2026-10-29）

用户已实机验收本分支的 macOS 选区识别修复，见[选区验收记录](macos-region-snapping-2026-10-29.md)。本轮在此基础上检查打开、鼠标交互、编辑导出、滚动拼接和录制链路，实际优化滚动匹配与放大镜绘制，不改变截图精度、拼接置信规则、选区命中或鼠标控制。

## 实测收益

环境：macOS 26.4 / arm64 / Apple M5，Electron 42.11.12 / Chromium 148.0.7778.280。基线为 `8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0`，优化版为本工作区源码。完整数据见[原始 JSON](region-screenshot-performance-macos-2026-10-29.json)。

使用隔离 Electron offscreen 窗口、1040 × 760 DIP、2x 密度和程序生成的像素，不采集用户桌面内容。截图每种尺寸、每个版本各 30 次；滚动匹配和 GIF 每个版本各两批 30 次，旧→新、新→旧交替。截图与滚动每批预热 3 次；GIF 连续编码包含首帧，不另做预热。下表将同一版本两批原始样本合并后取分位数，单位 ms。

| 960 × 1600 滚动匹配 | P50：前 → 后 | 耗时下降 | P95：前 → 后 |
| --- | --- | --- | --- |
| 前进 240 像素 | 5.40 → 1.30 | 75.9% | 6.20 → 1.80 |
| 回退 240 像素 | 9.30 → 2.80 | 69.9% | 9.70 → 3.40 |
| 无法匹配的帧 | 32.05 → 7.60 | 76.3% | 33.80 → 7.90 |
| 完全静止 | 0.60 → 0.60 | 无变化 | 0.70 → 0.80 |

匹配阶段提前停止读取已经不可能胜出或造成歧义的候选行。各行误差非负，部分误差之和除以总采样行数是最终均值的下界；允许匹配的最大得分为 3、最大歧义余量为 1.5，超过 4.5 的候选可以提前停止。90% 以上行保持静止时仍保留完整候选评分，因为这条路径允许零位移得分超过 3。既有独立逐行校验、前后滚动、固定页眉页脚和透明背景重试均保留。

放大镜每次鼠标移动原来都会给 Canvas 的宽、高重新赋值，即使尺寸没有变化也会重置上下文与 backing store。现在仅在像素尺寸变化时赋值，每次仍完整填充背景并绘制采样像素与十字线。真实 Playwright 鼠标移动 60 次，尺寸赋值从 **120 次降为 0 次**；这测量的是重置次数，不代表已测得延迟或峰值内存下降。Light / Dark 下中心、两侧边缘与返回中心的完整像素 hash 均与基线一致，边缘没有残留旧像素。

## 全链路观察与剩余开销

| 环节 | 实测或源码结论 | 本轮处理 |
| --- | --- | --- |
| 打开截图 | 用户刚才验收的 10 次真实日志中，并行准备抓屏与原生窗口快照为 67–603ms；浮层打开多数为 7–13ms，另有 39ms、167ms | 瓶颈主要在准备阶段；日志没有拆分系统抓屏和原生查询，不能把这个数字全归因于系统 API。保留既有并行准备、预热与首帧屏障 |
| 悬停吸附与放大镜 | 吸附查询已有一个在途请求与最新待处理点，避免鼠标移动堆积；放大镜存在无效画布重置 | 去掉重置，保留吸附调度与坐标换算 |
| 普通编辑与导出 | 1080p / 4K / 1600 × 10000 导出 P50 分别为 3.00→2.90 / 9.25→9.05 / 17.55→16.40ms | 本轮未改导出链路；这些差异视为波动，不宣称加速。保留已有不透明选区直裁剪、带标注/缩放/透明像素的 Canvas 路径 |
| 滚动采集与拼接 | macOS 采集使用系统抓屏；预览只读取可见行，最终导出才组装完整图；无匹配帧的匹配计算约占 32ms | 优化匹配搜索，未降低采样精度或改变系统鼠标位置；没有测量真实网页自动滚动的端到端帧率 |
| GIF | 960 × 540 高色彩变化的合成纹理，每帧移动小白块；编码 P50 112.55→111.80ms，P95 117.90→116.20ms | 这是剩余热点，编码本身超过 100ms 采样周期，不能保证这种画面达到 10fps。既有完全相同帧合并仍有效；本轮未改变编码、画质或帧时长 |
| WebM | 使用浏览器 MediaRecorder，实际采样等待上一帧完成，不无限排队；macOS 原生录制帧经 JPEG 解码、裁剪后送 Renderer | 本轮做功能回归，未测原生采集/编码端到端吞吐量，不宣称提速 |
| 保存、复制、贴图、交给新任务 | PNG/JPEG 编码与系统剪贴板在 main 侧；磁盘写入异步；这些路径不在 Renderer 导出计时内 | 检查实际实现和既有回归；未计时系统保存框、磁盘、剪贴板、IPC 或媒体入仓 |

真实打开日志中的 `(captureMs, openMs)` 原始值为 `(603,9)、(165,13)、(148,12)、(126,167)、(78,8)、(109,12)、(184,10)、(67,39)、(169,7)、(97,8)`。这是同一次用户验收的观察数据，不是控制变量的优化前后对比。

GIF 后续值得单独把调色板生成和编码移出 Renderer 主线程，并保证暂停、停止、帧顺序、时长与在途队列有界；这会改变异步生命周期，需要专门的交互和取消回归。本轮没有通过降低颜色数、降低画质或复用不适用的调色板获得表面提速。

同日后续已完成上述 Worker 优化及完整 GIF 字节、逐帧像素和时长对照，详见[GIF 编码专项验收](region-gif-worker-performance-2026-10-29.md)。本节数值保留为该优化之前的原始观察。

## 验证与复跑

- 截图相关 10 个单测文件、114 项全部通过，1.49s；覆盖窗口生命周期、迟到结果、取色、导出、前进/回退、固定页眉页脚、局部重绘、固定壁纸、重复段落、录制、剪贴板和交给新任务。复用现有充分覆盖，不增加源码字面量或重复用例。
- 原生 macOS 选区脚本通过，6.40s（与类型检查/UI 检查并行，含编译）；涵盖冷启动、焦点与系统鼠标保持、内容区域、标题栏、遮挡、排除浮层、系统透明命中语义及第二次会话。
- Electron 性能脚本调用真实生产组件、匹配器与 GIF 编码器；核对前后匹配决策、拼接图像和 GIF 输出 hash，以及偏移裁剪、透明像素、混合 DPI、矩形标注和放大镜的深浅色像素。全套通过，采样期间未并发本任务其它测试或类型检查。
- Electron 离屏 UI 检查为 12/16：截图场景全部通过；WebM 两种主题预览超时，GIF 两种主题独立解码页报 `Target.createTarget: Not supported`。未把失败记成通过，另用基线对照和 Chromium 补验。
- `--case video,gif --theme light --compare=HEAD` 复现未修改基线的相同超时/协议错误；真实 Chromium 全场景 Light / Dark **16/16 通过**，96.7s，包括滚动、预览、工具条拖动、标注、WebM/GIF、暂停、保存和独立解码。此处保存是 fixture 接收导出数据，不等于系统原生保存框验收。已目检深浅色选区与放大镜，图片仅留本地，没有上传。
- Desktop typecheck、两处生产 TypeScript 的 ESLint、test-hygiene、dev-docs 与 `git diff --check` 通过。开发实例仍来自本 worktree，`desktop:whoami --all` 返回 `DESKTOP_DEV_VERDICT=ready`；本轮只改 Renderer 所用代码，沿用已有实例热更新。

```sh
node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline=8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0 --samples=30 --output=docs/acceptance/region-screenshot-performance-macos-2026-10-29.json
node apps/desktop/scripts/check-macos-region-snapping.mjs
pnpm --filter desktop exec vitest run src/main/region-screenshot src/renderer/features/region-screenshot src/shared/__tests__/regionScreenshot.test.ts
pnpm --filter desktop run typecheck
pnpm ui:check --changed --theme all
pnpm ui:check --page region-capture --case video,gif --theme light --compare=HEAD
pnpm ui:check --page region-capture --case all --theme all --engine chromium
```

性能/E2E 验证扩展了已有显式 benchmark，不进入默认单测。依据为 `docs/dev-rules/engineering-conventions.md` §3.2 和 `docs/design-rules/DESIGN.md` §10、§14.4：验证真实生产入口，量测直接交互成本，保持两种主题与像素结果一致。新覆盖补上既有 benchmark 没有的实际鼠标移动、滚动搜索和连续 GIF 编码；最小代表输入是两张 960 × 1600、相差 240 行的图，以及一张含边缘取样的真实放大镜画布。

上述量测不等于整个截图工具已达到某个端到端时延目标。本轮未实测 Windows 性能、物理混合 DPI、多屏、真实自动滚动的鼠标移动/停止验收或完整录制链路；共享算法不含平台分支，但 Windows 仍需实机复跑，不能沿用历史 Windows 数据作为本次证据。
