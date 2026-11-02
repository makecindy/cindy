# 内置截图性能优化与回归（2026-10-28）

普通截图导出的主要开销来自额外的 Canvas 绘制、像素读回和通道转换。无标注、无需缩放且选区像素全部不透明时，改为从现有 ImageData 一次完成裁剪和 RGBA → BGRA 转换；保持原图不变，可继续取色或重试。标注、缩放、透明像素仍使用 Canvas 路径。

另移除了开始截图时重复的一次全屏 `putImageData`，保留 React layout effect 中的绘制与原有首帧确认。多屏冷窗口同时准备，全部就绪或超时后再统一定位和发送图片，保持显示顺序、取消、来源校验及故障降级行为。

## 性能实测

机器：XD-PC，Windows x64，Intel Core Ultra 7 265K；Electron 42.11.12 / Chromium 148.0.7778.280。基线为 `7fdb9dd0963794cf46bc026f240d34c568bac03f`，优化版为当前工作区源码。

每种尺寸、每个版本各采样 30 次；每批预热 3 次，按旧→新、新→旧交替运行。调用真实 `RegionScreenshotOverlay`，通过键盘选择选区并导出，使用程序生成的 BGRA 图，不读取用户截图内容。临时 Electron profile 和构建文件放在唯一临时目录，结束时清理。

下表测量从导出快捷键到 Renderer 把位图交给 bridge 的耗时，单位 ms。**不包含系统抓屏、原生窗口创建、IPC 传输、剪贴板写入或文件保存，不代表截图端到端耗时。**

| 原图尺寸 | 导出 P50：优化前 → 后 | 耗时下降 | 导出 P95：优化前 → 后 |
| --- | --- | --- | --- |
| 1920 × 1080 | 12.10 → 2.85 | 76.4% | 13.20 → 5.90 |
| 3840 × 2160 | 44.90 → 12.55 | 72.0% | 55.60 → 18.30 |
| 1600 × 10000 | 87.70 → 22.25 | 74.6% | 101.10 → 39.80 |

1600 × 10000 是大图处理样本，不是实际滚动采集总耗时。所有性能样本均为不透明、无标注、不缩放的完整选区；其它路径不据此宣称同等加速。

| 原图尺寸 | Renderer 开始截图的同步处理 P50：前 → 后 | 首帧确认 P50：前 → 后 |
| --- | --- | --- |
| 1920 × 1080 | 3.60 → 3.30 | 29.30 → 33.40 |
| 3840 × 2160 | 13.50 → 11.45 | 20.65 → 18.75 |
| 1600 × 10000 | 24.85 → 21.25 | 39.90 → 35.65 |

测量使用 1040 × 760 DIP、2x 密度的隔离 offscreen 窗口，像素缓冲区尺寸如表。首帧确认包含两次 animation frame，受垂直同步与 GC 影响；1080p 本次反而增加 4.1 ms，因此不宣称首屏展示全面加速。同步处理与导出是本次可靠的收益点。完整样本及 P95 见[原始 JSON](region-screenshot-performance-2026-10-28.json)。

每次初始帧写入从 2 次减为 1 次。直接导出减少一个额外 Canvas backing store（4K RGBA 一份约 31.6 MiB），这是按像素数计算的分配量，不是进程峰值内存实测。

## 功能回归

- 相关单测：10 个文件、114 项通过；覆盖窗口生命周期、首帧屏障、取消与迟到结果、IPC 来源、取色、位图、滚动拼接、录制、剪贴板和交给新任务。
- 新增多屏冷启动回归先在旧实现失败，再在新实现通过；一个冷屏不再阻止第二个屏幕开始准备，取消后不会发送迟到的 BEGIN。
- 直接裁剪单测核对跨行选区、颜色通道、源数据不变、重试、选区外透明像素、选区内透明像素回退及越界／非整数回退。
- Electron 像素回归：偏移选区、透明像素、混合 DPI 缩放和矩形标注，在 Light / Dark 下分别与旧代码结果对照，全部通过；同时检查实际显示画布，避免只验证内存导出而漏掉空白首帧。不透明像素逐字节核对；透明像素按预乘 alpha 的实际颜色核对（旧版 GPU/CPU 反预乘也存在 1 级取整差异）；重采样与标注额外核对旧／新完整输出 hash。
- `pnpm ui:check --page region-capture --case all --theme all --engine chromium`：16/16 通过，包含吸附、滚动截图、预览滚动、工具条拖动、WebM/GIF 录制、暂停、标注、保存及解码；已查看深浅色截图。
- `pnpm ui:check --changed --theme all`（Electron）：12/16 通过，截图相关场景全部通过。WebM 预览在 offscreen 宿主中超时，GIF 的独立解码页遇到 `Target.createTarget: Not supported`。通过 `--case 'video,gif' --theme light --compare=HEAD` 确认旧代码同样失败；未把这 4 项记为通过，录制部分以 Chromium 结果补充。
- 本次还修复了已有 UI 场景的视口污染：idle 场景把页面缩到 900 × 400 后，用 finally 恢复到 900 × 700，避免 Electron 复用页面时后续场景的尺寸断言全部失败。
- Desktop typecheck、涉及源码的 ESLint、test-hygiene 与 `git diff --check` 通过。

修改的单测单文件计时：`windows.test.ts` 的 Vitest 总耗时 1.85s、用例 43ms；`screenshotRendering.test.tsx` 最后一次 14.70s，其中 jsdom 环境初始化 11.55s、收集 2.69s、用例 206ms，超过 5s 预算。该文件必须真实渲染 React/Canvas 调用，不能去掉 DOM 环境；没有新增真实等待或模块重载。此前同一最终用例集合连同其余 9 文件共 2.26s 完成，因此记录这次环境初始化波动，不扩大 timeout 或删断言。

上述性能回归阶段未实测系统剪贴板／原生保存框及真实多屏；这些功能已在下述黑盒验收中补齐。仍未实测 macOS、物理混合 DPI，以及完整 Cindy 截图的端到端耗时；现有 macOS 模拟分支不等于实机验收。

## Windows 双屏黑盒验收补充

2026-10-28 在 XD-PC 启动当前工作区的完整开发实例，收到 `DESKTOP_DEV_VERDICT=ready`。命令为 `pnpm restart:desktop:remote -- --region=global --isolated=@worktree --mock`，为避免其它实例端口和快捷键冲突，测试实例使用 CDP 9337 和 `Ctrl+Alt+Shift+F9`。账号／任务使用模拟数据，截图、main/preload IPC、系统剪贴板、原生保存框及贴图均使用真实生产实现，无替身。两个物理显示器均为 2560×1440、100% 缩放，位于 `(0,0)` 和 `(2560,0)`。

屏幕上展示本次创建的原生测试窗口，使用固定红绿蓝色块和文字；没有把个人桌面内容写进证据。系统快捷键／保存框由 computer 工具输入，截图界面的键盘、鼠标操作由 Playwright 连接该独立实例完成；没有调用内部导出函数替代点击，也没有把期望像素传入截图实现。

完成 8 次真实截图会话及以下 12 类检查：

| 检查 | 结果 |
| --- | --- |
| 系统热键开启两屏浮层 | 两屏可见尺寸均为 2560×1440 |
| 左屏框选 → 系统复制 | 580×180，104,400 个像素逐个核对，差异 0 |
| 右屏框选 → Windows 另存为 → PNG | 580×180，104,400 个像素逐个核对，差异 0 |
| Dark 标注 → 撤销 → 重做 → 复制 | 矩形实际导出，1,840 个变化像素仅位于预期边界，其余像素不变 |
| 关闭两份预热浮层后冷建 → 右屏选区 → Esc | 两份浮层重新创建并可操作；结束无残留可见窗口 |
| R 重复上次区域 | 恢复正确的 580×180 选区 |
| 原生保存框取消 | 未生成新图片，可继续截图 |
| 右键重选／退出 | 第一次清除选区，第二次退出 |
| 贴到屏幕 → Esc | 贴图 580×180，全像素差异 0，正常关闭 |
| 空格全屏 → Esc | 正确选择 2560×1440 并退出 |
| 左屏原生元素吸附，Light / Dark | 两种模式全部通过 |
| 右屏原生元素吸附，Light / Dark | 两种模式全部通过 |

原生吸附专项复用 `apps/desktop/scripts/check-region-snapping.mjs`，以此次开发实例编译的 helper 分别运行 `--position=80,80` 和 `--position=2700,80`，墙钟 7.71s / 7.24s。它使用真实 Chrome、Windows helper、原生捕获像素与真实 Overlay，传输层由 fixture 适配；不将其冒充完整应用 IPC 验收。每屏每主题验证移动期间稳定、跨边界、按钮、文件区域、正文、浏览器外框、滚轮切换及单击锁定。四组移动画面样本数为 122 / 121 / 122 / 122，均符合独立几何断言。

原始结果见 [黑盒结果 JSON](region-screenshot-blackbox-2026-10-28.json)。本地图片及可预览的自包含单文件报告在 `artifacts/region-blackbox-20261028/report.html`，已目检浅色选区、深色标注和贴图。

验收过程中两处自动化适配已单独记录：输入应等待浮层可见且尺寸稳定，不能仅等待 Canvas 存在；Windows 保存框的 UIA `set_value` 未提交文件名，实际文件保存于默认图片目录，随后核对新文件并移入证据目录。导出或 Esc 会销毁辅助窗口，后续 CDP 查询／keyup 的 `page closed` 由产物与原生窗口列表交叉验证，不作为功能失败或忽略真实失败。初次启动有一次 `recordingPreview` 预热 `ERR_FAILED`，后续页面重建；本轮未验收真实系统滚动截图或 WebM/GIF 录制，也未验证 macOS 与物理混合 DPI，不对这些范围作通过承诺。本轮没有修改产品代码，也未更新安装版。

## 复跑

仓库根运行：

```powershell
node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline=7fdb9dd0963794cf46bc026f240d34c568bac03f --samples=30 --output=docs/acceptance/region-screenshot-performance-2026-10-28.json
pnpm --filter desktop exec vitest run src/main/region-screenshot src/renderer/features/region-screenshot src/shared/__tests__/regionScreenshot.test.ts
pnpm --filter desktop run typecheck
pnpm ui:check --page region-capture --case all --theme all --engine chromium
```

基准使用同一 fixture、分别编译基线和当前真实组件，不切分支、不覆盖源码。性能采样期间没有同时启动本任务的类型检查或其它测试。

设计依据：`docs/design-rules/DESIGN.md` §10 双模式、§14.4 性能与直接交互；此次不改变布局、主题颜色或文案。测试价值依据为 `docs/dev-rules/engineering-conventions.md` §3.2；新增用例并入原测试文件，严格性能计时与真实 Canvas 留在显式 benchmark/E2E 脚本。
