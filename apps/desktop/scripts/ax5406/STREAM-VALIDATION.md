# 流式输出专项验证（2026-10-03）

> 后续定位已确认本负载的离底读数是绘制前中间态，实际绘制对照未复现离底。
> 下文先保留最初失败证据，最新结果见文末「绘制时序与修改前对照」。

本轮仅增加测试负载，没有修改生产代码。Windows Electron 41.10.3，AX 开启，
实际 MessageStream 与样式、合成分片、隔离窗口；没有模型／服务端调用。
不能代表完整安装版的端到端验证。

每轮三种尺寸：1000×760 Light、620×1000 Dark、1000×420 Light。
每种尺寸追加 400 个有序标记分片，包含中英文与基础 Markdown。
先以 30ms 间隔输出，真实滚轮上翻接管后继续输出；End 回底，再以 10ms 间隔输出，
最后结束流式状态并检查 400 个标记的完整性与顺序。不是复杂代码块／工具卡全组合测试。

| 产物 | 历史条数 | 几何采样 | 空占位／重叠 | 完整有序分片 | 高速阶段短暂离底采样 |
|---|---:|---:|---|---:|---|
| `tP0rva` | 500 | 2639 | 0 / 0 | 1200 | 1 次，32px |
| `v6zVVF` | 500，重复 | 2643 | 0 / 0 | 1200 | 0 次 |
| `1CpCps` | 1000 | 2719 | 0 / 0 | 1200 | 3 次，32px |
| `MmNxhv` | 1000，加密截帧 | 2713 | 0 / 0 | 1200 | 4 次，最大 184px |

合计 10,714 次采样、4,800 个分片；所有尺寸的上翻阅读锚点前后偏移均为 0px，
最终结束后的离底距离均为 0px。没有 JS／renderer console 错误或原生崩溃。

**不能宣称所有画面都正常**：8 次贴底阶段的非零差值均发生在高速恢复输出中，
距离为 32–184px，下一次采样即回到 0，相邻采样时间约 15–26ms。
有差值的三轮仍返回 `visual-failed`，未删除或放宽断言。
最后一轮追加截取恢复输出的首八张真实绘制帧；代表截图目检未见此前的空白正文。
但 setTimeout 几何采样可能落在 Markdown 节流提交和 ResizeObserver 补偿之间，
**尚未确认异常几何是否实际绘制到屏幕，也未与修改前源码作同负载对照**。
因此只能称为待定位的跟随时序疑点，不能认定是本次视口改动引入，也不能排除。

下一步应将逐帧绘制与 DOM 更新／高度补偿时序对齐，复测同负载的修改前对照。
本轮没有据此直接修改生产滚动逻辑。

产物在 `C:/Users/User/AppData/Local/Temp/cindy-ax5406-<产物>/`。
完整原始采样为 `stream-audit.json`，原生进程结果为 `report.json`。
四轮独立 Electron 已退出，各自临时 profile 已回收。
单文件截图报告：`C:/Users/User/AppData/Local/Temp/cindy-ax5406-MmNxhv/stream-report.html`。

```powershell
node apps/desktop/scripts/ax5406/run.mjs --scenario=component --workload=stream-tests --rows=500 --seed=5406 --ax=on --query=none --seconds=180
```

## 绘制时序与修改前对照

进一步通过 `--stream-probe=on` 记录文字 DOM 变化、rAF、scrollTop 写入及组件自己的
ResizeObserver 之后的状态。只在测试窗口的 content 容器底边添加 12×3px 紫色绝对定位
标记，不参与布局、不可交互、对 AX 隐藏；直接检查 Electron compositor 输出位图底部
是否包含该标记，避免把任务队列中的几何读数当成已绘制状态。

记录到的代表链路（`I2O75Z`）：

- 2557.7ms，Markdown DOM 更新，离底 40px；
- 2557.9ms，rAF 读到同样的 40px；
- 2559.0ms，已有跟随逻辑写入 scrollTop，离底归零；
- 2559.4ms，组件高度补偿之后的 ResizeObserver 读数仍为零；
- 实际输出图片的底边标记完整，未画出该离底状态。

根因是测试的 `rAF → setTimeout → measure` 与 Markdown 的异步节流提交交错：
任务队列可能在新 DOM 提交后、下一次 resize/绘制之前读取几何。
Markdown 的节流提交见 `MarkdownRenderer.tsx` 中 `useStreamingThrottle`，
贴底补偿见 `MessageStream.tsx` 的 content ResizeObserver → `pinToBottom`。
不需要为正常的绘制前过渡状态增加生产滚动补丁。

修改前对照使用 `--source=head`：构建插件只读取得 HEAD
`d656b0fc1ec3e04548cd018654cbd6486f6cf839` 的 MessageStream 与 globals.css，
未 checkout／覆盖／回退工作区。两个文件的 SHA-256 已与 git show 核对；
运行态确认为 80 个已挂载正文、content-visibility:auto。

| 产物 | 版本 | 贴底绘制帧 | 标记缺失帧 | 补偿后离底 | 上翻时标记消失的对照帧 |
|---|---|---:|---:|---:|---:|
| `I2O75Z` | 当前代码，定位轮 | 594 | 0 | 0 | 28 |
| `1kgwKb` | 修改前 HEAD | 635 | 0 | 0 | 28 |
| `QA86mJ` | 当前代码，修正判据后复测 | 591 | 0 | 0 | 26 |

两版都能读到中间态离底，两版捕获的绘制帧都正常，说明不能据此判为此次视口改动回归。
上翻时标记确实消失，证明检测器能区分真正离底与贴底；不是永远返回通过。
上述 1,820 张贴底帧均执行了位图检查，代表 PNG 另有人工目检，含 Light / Dark。

测试现在把中间态记入 `geometryWarnings`，不删除原始样本或历史失败产物。
仅在开启真实绘制探针时，以绘制标记缺失、补偿后残留离底、任一跟随／恢复／结束阶段
缺少帧、正反对照无效作为失败条件；空占位、重叠、稳态离底、阅读锚点及分片完整性
断言继续保留。未启用探针时仍保留原保守失败行为。

最终轮 `QA86mJ`：2,713 次几何采样，1,200 个分片完整有序；0 空占位、0 重叠、
176 次补偿后检查均贴底，0 renderer 错误、0 原生崩溃，退出 completed-no-crash。
其四个生产源文件哈希仍与工作区一致。本轮仅修改测试／诊断脚本，没有生产补丁。
测试进程均已退出，profile 已回收。

最新单文件图集：`C:/Users/User/AppData/Local/Temp/cindy-ax5406-QA86mJ/stream-diagnosis.html`。
结论只覆盖本次 Windows 实际组件、合成分片负载及所捕获帧，不等同于整包或所有平台验收。

```powershell
node apps/desktop/scripts/ax5406/run.mjs --scenario=component --workload=stream-tests --rows=1000 --seed=5408 --ax=on --query=none --seconds=180 --stream-probe=on
# 修改前对照额外传 --source=head；不会回退工作区。
```
