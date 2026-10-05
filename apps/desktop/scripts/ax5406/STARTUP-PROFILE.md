# #5406 首屏耗时分析

2026-10-03。仅分析隔离的真实 MessageStream 组件 fixture；没有连接后端、使用用户数据，
也没有修改正在运行的 Cindy。生产修复仍为停用行级 content-visibility:auto。

## 1004ms 的口径

此前三轮修复版首次内容绘制中位数为 1004ms，旧版为 768ms。
这是从页面导航起计的 FCP，包含独立页面模块加载、初始化、字体、React 首次挂载及排版。
不包含 Electron 启动的全部时间，也不是正式应用切换任务的延迟。
fixture 构建关闭压缩；MessageStream JS chunk 约 9.64MB，common chunk 约 1.33MB。
不能把该冷加载成本直接推广到已加载模块的正式客户端。

纠正先前表述：当前源码默认尾窗立即挂载最多 80 个条目。15 条首帧限制用于锚点恢复等路径，
不限制默认尾窗。源码明确说明，默认尾窗先挂 15 条再补到 80 条会引起可见滚动补偿。

## 录制轨迹的归因

`run.mjs --trace=on` 仅对独立实例录制 Chromium 轨迹，随后由 `analyze-startup.mjs`
按 navigationId 和 renderer 主线程筛选首屏前事件。优先归类 GC、样式/布局、绘制，
再归类包住它们的 JS，避免将同步布局同时计入 JS。各类别是不重叠的时间区间。

**轨迹有额外开销，以下不能当成原始 1004ms 的精确分账，也不能按比例回推。**

| 首屏前区间（ms） | 旧版 auto，wBGzrO | 修复 visible，oU6lwa |
|---|---:|---:|
| JS 执行，扣除其触发的下列工作 | 367 | 403 |
| 样式计算、布局、样式表解析 | 127 | 397 |
| 主线程绘制准备、绘制、分层和提交 | 15 | 41 |
| GC | 28 | 29 |
| 其他主线程工作 | 61 | 90 |
| 不在所记录主线程任务内的间隔 | 403 | 453 |
| 轨迹 navigationStart → FCP | 1000 | 1413 |

最后一类包含加载、后台工作、调度等待等，**不能全部叫作字体或磁盘加载**。
绘制类别也不是所有 GPU / 栅格线程 CPU 时间之和。页面 Performance API 的 FCP
分别为 1000ms 和 1416ms，与 trace 使用的时间戳存在小幅取整差异。

确认的具体热点：

- 修复版首个 React `performWorkUntilDeadline` 在约 613ms 开始，持续约 617ms；
  这是包含样式和布局的总时间，不能与上表再相加。
- `useUserMessageAutoCollapse` 在 `useLayoutEffect` 中读取 `getComputedStyle(el).lineHeight`
  和 `el.scrollHeight`。轨迹中该 `measure` 触发一次约 81ms 样式计算及约 139ms 布局，
  后者涉及 14,960 个布局对象。其后还有多次同源样式计算。
- 80 条长消息的正文、Markdown 和长用户消息测量镜像一起增加了首屏 DOM / 排版工作。
  触发布局的读操作是同步结算点；139ms 并不等于“删除这个读操作即可节省 139ms”，
  浏览器最终仍需对可见内容排版。
- 修复前后录制对照中，样式/布局差异最大，与停用布局跳过的机制相符；单组轨迹不构成稳定差值估计。

## 不带轨迹的减量对照

复用同一修复版冻结构建 BwfjZy，AX off、query none、seed5407、每帧更新末条、
不滚动，各 5 秒，三组交替串行运行。均正常退出，无 JS 错误，profile 已清理。

| 数据量 / 实际挂载 | 三轮 FCP（ms） | 中位数 |
|---|---|---:|
| 200 条 / 80 条 | 992 / 1008 / 1008 | 1008ms |
| 15 条 / 15 条 | 580 / 596 / 580 | 580ms |

差值 428ms，约 42%。这是**减少总输入与挂载量**的敏感性试验，不是保留同一组 200 条
消息、仅修改窗口后的等价 A/B。具体文本也不同，因此只支持“首屏工作量值得优化”，
不能承诺正式补丁一定节省 428ms。没有把默认窗口改成 15 条。

## 可落地的后续方向

1. 减少首帧需挂载和排版的条目，按视口与内容预算决定窗口。收益空间最大，但必须保留
   滚动锚点、稳定占位与补载行为，验收任务切换、贴底、向上滚动、搜索跳转和无障碍读取。
   不应简单将 80 改成 15 后异步补回。
2. 优化长消息测量，研究集中读取后统一更新、减少重复镜像与非必要同步读。需保持首帧折叠正确，
   避免先展开再收起的闪动；不能直接删除测量或改成粗略字符数判断。
3. 冷启动模块拆分/预热另做真实客户端性能测量。fixture 的未压缩大 chunk 是该实验的成本，
   不能仅凭此证明正式产品也加载了同样体积或会取得同样收益。

这些方向尚未实现；本轮只增加诊断开关、轨迹分析脚本及文档，纠正既有注释，未改变生产运行逻辑。

## 本机证据

所有产物位于 `C:/Users/User/AppData/Local/Temp/`：

- `cindy-ax5406-oU6lwa/startup-trace.json`、`startup-analysis.json`：修复版轨迹及互斥归因。
- `cindy-ax5406-wBGzrO/startup-trace.json`、`startup-analysis.json`：旧版轨迹及归因。
- `cindy-ax5406-oU6lwa/row-count-comparison.json`：减量对照六轮完整路径与 FCP。
- 80 条挂载产物：N9mU4e、M2HKy5、61aeuH；15 条：NiRfhC、Gr1R9s、7CkgxO。

可复核命令：

```powershell
node apps/desktop/scripts/ax5406/analyze-startup.mjs C:/Users/User/AppData/Local/Temp/cindy-ax5406-oU6lwa
```
