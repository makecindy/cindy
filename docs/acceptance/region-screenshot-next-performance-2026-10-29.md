# 截图工具第二轮逐项优化（2026-10-29）

本轮在 macOS 选区修复、滚动匹配优化和 GIF Worker 已完成的工作区上继续优化。前后基准均包含上一轮改动，不将旧收益重复计入。本轮保留笔迹路径复用、采集帧减少复制、GIF 精确量化复用、大 PNG 异步编码；启动合并查询未改善冷启动，撤回。

后续增量见 [Mac 按需编码实测](region-macos-demand-performance-2026-10-29.md)：新增本地录制按请求编码，保存模块依赖改为仓库要求的静态加载。本页数字保留当时版本的实验结果，不把后续变化混入前后基线。

环境：macOS 26.4 / arm64 / Apple M5，Electron 42.11.12 / Chromium 148.0.7778.280。性能采样与本任务类型检查、UI 验证分开执行。P50 为样本中位数，P95 为排序后第 ceil(N×0.95) 个值。

## 1. 标注

生产绘制入口 `drawAnnotations` 的笔迹曲线改为复用 `Path2D`，以不可变点数组为 WeakMap 键。移动、草稿更新会产生新数组，撤销重做可以复用旧路径；释放标注后缓存不保留它。绘制顺序、透明度、模糊、马赛克、导出路径及主题均保持原样。

4K 画布，8 个模糊/马赛克区域、40 条各 500 点的笔迹，外加每次变化的荧光笔草稿。绘制指令提交 P50 **0.4→0.2ms**，P95 **0.5→0.3ms**。包括完整画布读取在内的耗时约 **17ms**，没有稳定改善，不能把提交耗时减半描述成整帧提速一倍。

[标注专项原始数据](region-next-annotations-2026-10-29.json)；[整套 Renderer 原始数据](region-next-renderer-2026-10-29.json)。验证包括透明输入、重叠荧光笔、边缘模糊、重排、撤销、移动、取样比例和源图变化；默认 Canvas 与频繁读回两种模式、1.5/0.75 倍缩放及分数偏移均与基线像素一致。

未保留的方案：只缓存模糊/马赛克中间图没有稳定收益；整层位图复用及局部裁剪重绘在透明/模糊重叠处出现像素差异。没有放宽像素断言。

## 2. macOS 采集帧处理

删除相同尺寸的 `NativeImage.resize`；`toBitmap()` 已返回独立副本，完整 ArrayBuffer 直接建视图，避免复制第二遍。若返回的是切片或非 ArrayBuffer，则仍复制，防止 IPC 序列化带出选区之外的底层字节。

| 阶段 | P50 前→后 | P95 前→后 |
| --- | --- | --- |
| 3200×2000 滚动选区的裁剪/像素准备 | 4.312→1.961ms | 4.564→2.704ms |
| 1920×1080 视频选区，含整屏 JPEG 解码 | 25.105→24.238ms | 26.403→24.632ms |

滚动帧每次少一次 **25.6MB** 的显式像素复制；这不是整个应用峰值内存下降 25.6MB 的测量。视频收益远小于滚动帧，整屏 JPEG 解码仍占主要开销。小/大 GIF 选区批次波动，未宣称稳定提速。

[原始数据](region-next-native-2026-10-29.json)中 `capture` 是最终采集实现；其中 `save` 是被弃用的初始 PNG 参数实验，最终保存数据见第 5 节。该基准用真实生产 `captureLiveRegion` / `RegionVideoCapture` 与 Electron NativeImage，源图为合成图，替换系统采集与 helper。包含 4K JPEG 解码、裁剪、缩放与 BGRA 提取，不包含真实系统抓屏、跨进程 IPC 和磁盘。

前后每个返回像素逐字节相等，另补[透明像素与混合 DPI 对照](region-next-native-parity-2026-10-29.json)。没有改 30fps 原生采集配置、录制采样周期或取帧顺序，也没有先裁剪再压缩；因此不引入录制帧时刻和压缩边缘变化。

## 3. 截图启动：实验撤回

尝试把窗口列表、前台进程和屏幕刘海信息合并到一次 helper 响应。真实启动原生进程，前后各 30 次、交替批次：

| 指标 | P50 前→候选 | P95 前→候选 |
| --- | --- | --- |
| 新进程启动到快照完成 | 44.724→44.689ms | 57.456→53.739ms |
| 已启动进程的第二次查询 | 0.646→0.648ms | 1.013→4.866ms |

冷启动中位数基本不变；第二次查询也都在约 0.65ms，不值得扩大协议和生命周期复杂度。候选已撤回，原先并行抓屏和查询、窗口预热、会话结束即释放 helper 的策略不变。原始批次包含数百毫秒离群值，没有剔除。

[原始数据](region-next-startup-2026-10-29.json)。`benchmark-region-startup.mjs` 在临时目录重建这个被撤回的候选，生产源码不包含合并查询。这不是完整截图打开的前后对比：没有计时系统抓屏与浮层打开，不声称整次截图已缩短。

## 4. GIF 真实编码计算

gifenc 的 rgb444 量化输入由每个颜色分组的计数、R/G/B 整数总和决定。只有 **4096 组的全部 16384 个整数完全相等**才复用量化结果，不用 hash 判等，不近似共享调色板。每一变化帧仍调用原始 `applyPalette` 和 GIF 编码器，保持颜色首次出现顺序的映射行为。逐字节相同帧的合并、暂停、时长与循环规则保持不变。

每个编码器增加两份 64KiB 的统计数组，共 **128KiB**，只在本次 Worker 生命周期内保留。

| 960×540 输入，各版本 60 帧 | P50 前→后 | P95 前→后 |
| --- | --- | --- |
| 颜色分布完全相同、颜色位置连续移动 | 114.25→15.90ms | 120.90→19.40ms |
| 高色纹理中小白块移动，颜色统计持续变化 | 114.80→115.10ms | 123.20→129.70ms |

第一种是可命中场景，计算等待降低约 **86.1%**；第二种没有稳定收益，并付出统计扫描开销，不能把前者推广到任意录屏。两者包含首帧量化和 Worker 启动，不预热 GIF；主线程仍约 0.5ms/帧。本表不包含系统抓屏、JPEG 解码和 IPC，不能推断真实录制帧率。

[原始数据](region-next-renderer-2026-10-29.json)的 `gifMotion` / `pipeline`。移动序列前后均为 18,438,016 字节，完整流校验值一致；另在单测中将空间移动、同组 RGB 总和变化、alpha 变化和暂停后的完整 GIF 字节，与每帧重新量化的独立基准逐字节对比。Electron Worker 小动画继续验证全部 4,634 字节及独立解码的 5 帧 RGBA、230/140/110/210/120ms 时长和循环属性一致。

## 5. 大图 PNG 保存

只对至少 200 万像素、完全不透明的 PNG 使用已有 sharp/libvips 后台线程池；在自有 `toBitmap()` 副本上原地交换 BGRA/RGBA。采用无损 PNG，移除已确认全为 255 的 alpha 通道。透明图、小图、JPEG 保持 Electron 原编码；可选原生库加载或编码失败也回到原路径。磁盘仍只写用户在原生保存框选择的位置，取消不编码、不写文件。没有修改媒体入仓、复制或交给新任务的路径。

| PNG 尺寸 | 主线程同步 P50 前→后 | 同步 P95 前→后 | 总编码 P50 前→后 |
| --- | --- | --- | --- |
| 1920×1080 | 12.725→1.705ms | 13.009→2.986ms | 12.726→17.467ms |
| 3840×2160 | 50.536→7.208ms | 50.972→8.757ms | 50.545→65.722ms |
| 1600×10000 | 99.698→13.948ms | 100.658→15.110ms | 99.702→135.997ms |

这是**降低主线程阻塞约 86%**的取舍，总编码时间增加约 5/15/36ms。零延时定时器探针也确认 4K 的 P50 响应延迟由 51.073 降为 7.307ms、长图由 100.465 降为 14.062ms；不是实际鼠标到屏幕的呈现延迟。

[最终保存原始数据](region-next-save-2026-10-29.json)。每个尺寸/格式/版本 20 个新建 NativeImage，避免 `toPNG()` 的已有编码缓存掩盖首次编码成本。包含异步库首次加载，未过滤首个样本。源图为确定性的高压缩比合成图，不代表所有照片内容。

PNG 文件字节不是相同的压缩流，但 Electron 独立解码后的全部 BGRA 像素相同。对应文件大小为 35,922→35,920、141,572→141,497、279,889→289,381 字节；长图约增加 3.4%。透明 PNG 和 JPEG 的编码字节保持相同。默认 PNG 参数曾导致文件明显变大，已经弃用，没有隐去该实验。

内存另用两个隔离 Electron 进程，分别连续处理 20 次 1600×10000 PNG，用 macOS `/usr/bin/time -l` 记录峰值 RSS：**740.8→721.2MiB**（[前](region-next-memory-before-2026-10-29.json) / [后](region-next-memory-after-2026-10-29.json)）。包含合成图、NativeImage 和编码器缓存，且各版本只有一次进程级采样；没有据此声称实际 Cindy 峰值内存下降。新增异步路径仍需要自有像素副本和 libvips 工作内存。

## 验证与范围

- 相关单测 11 文件、125 项通过，1.82s。新增 `encodeImage.test.ts` 4 项单独运行 2.28s；验证真实 PNG 编码像素、透明/小图/JPEG 保持原路径以及可选编码器失败回退。`liveCapture.test.ts` 增加底层切片不得跨 IPC 暴露的结果验证；GIF 补精确统计复用和失效的字节对照。均为 unit，不做真实等待或文件 I/O。
- Chromium Light / Dark 全部 16/16 通过，63.7s，包含真实 Worker、GIF/WebM 录制、暂停、预览、导出与独立解码。帧来源与保存接收端为 fixture，不等同于真实系统采集或原生保存框验收。
- Electron 离屏 UI 为 12/16；其余为此前已在 HEAD 基线复现的 WebM 预览超时和 GIF `Target.createTarget: Not supported`。没有标成通过，已由 Chromium 补验。已查看本地 overview 与播放图，没有上传截图。
- 定向 ESLint、test-hygiene、dev-docs、diff 空白检查通过。Desktop 类型检查通过（首轮发现测试替身类型和 ArrayBuffer 类型边界，修复后重跑通过）；修正后的 10 项采集/PNG 单测再次通过。
- 未实测 Windows、真实系统采集下的五分钟录制、混合 DPI 实体显示器。Windows helper 主路径保持不变，共用回退路径有单测；不把 Mac 数据当成 Windows 验收。
- 本轮没有提交、推送或发布，也没有替换用户安装版。

## 复现增量基线

增量基线是 HEAD `8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0` 加上一轮已完成改动。其[生产源码差异补丁](region-next-baseline-2026-10-29.patch)已保存；在临时目录从 HEAD 解包后应用补丁，验证重建的所有源文件与本轮开始前快照逐字节相同。它仅用于显式基准，不是产品要应用的补丁。

```sh
repo_root="$PWD"
perf_baseline=$(mktemp -d "${TMPDIR:-/tmp}/cindy-perf-baseline.XXXXXX")
git archive 8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0 apps/desktop/src/renderer/features/region-screenshot apps/desktop/src/shared/scrollCapture.ts apps/desktop/native/remote-desktop/macos-capture.m apps/desktop/native/region-screenshot/macos-snapshot.swift apps/desktop/src/main/region-screenshot | tar -x -C "$perf_baseline"
git -C "$perf_baseline" apply --no-index "$repo_root/docs/acceptance/region-next-baseline-2026-10-29.patch"
cat > "$perf_baseline/baseline.json" <<'JSON'
{"head":"8c15788c0a4c20cf9dcd20f2ccd8c63a857faeb0","description":"Working tree after GIF Worker optimization, before this round"}
JSON
node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline-dir="$perf_baseline" --samples=30
node apps/desktop/scripts/benchmark-region-screenshot.mjs --baseline-dir="$perf_baseline" --only=annotations --samples=30
node apps/desktop/scripts/benchmark-region-native.mjs --baseline-dir="$perf_baseline"
node apps/desktop/scripts/benchmark-region-startup.mjs --baseline-dir="$perf_baseline"
node apps/desktop/scripts/benchmark-region-native.mjs --baseline-dir="$perf_baseline" --only=save --memory=true --side=before
node apps/desktop/scripts/benchmark-region-native.mjs --baseline-dir="$perf_baseline" --only=save --memory=true --side=after
rm -rf "$perf_baseline"
```

计时运行不要与本任务其它检查并发。各脚本支持 `--output=<路径>` 保存 JSON；运行器自建的 profile、bundle、原生候选和中间文件均在唯一临时目录，结束清理。benchmark/E2E 不进入默认单测。设计依据为 `docs/design-rules/DESIGN.md` §14.4；测试价值与预算依据为 `docs/dev-rules/engineering-conventions.md` §3.2。
