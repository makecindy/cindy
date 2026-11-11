# Windows 窗口恢复对照

为 [Cindy #5627](https://github.com/makecindy/cindy/issues/5627) 提供不依赖提报者的
Electron 渲染实验。生产 Electron pin 已升级到 42.11.12；候选版本只安装到独立临时目录。

## 假设与版本选择

[Electron #42378](https://github.com/electron/electron/issues/42378) 报告了 Windows 上
最小化期间关闭后台节流、恢复后等待 5～10 分钟才出现空白的路径。
[修复 #52844](https://releases.electronjs.org/pr/52844) 已进入 43.4.1，矩阵使用该系列
43.7.9 与 Cindy 当前的 41.10.3 对照。它修复的是窗口、view 和 compositor 的显隐同步，
尚不能据此认定 Cindy 的这一次黑屏已经解决。

不在此改动中直接跨到 44：该系列还涉及剪贴板 API 迁移和 macOS 最低版本变化。
后续的 [#54311](https://releases.electronjs.org/pr/54311) 修复“重新开启节流后仍继续绘制”，
与本实验的关闭节流方向不同，43.7.9 不能被当作包含所有相关修复。

## 手动运行

保留独立脚本供有明确新证据目标时手动运行，不提供 GitHub Actions workflow 或标签触发。

脚本中的 41.10.3 与 43.7.9 组合是 2026-10-09 已完成的历史对照，不是当前生产 pin；当前生产 runtime 为 42.11.12。
在 Windows PowerShell 中，从仓库根目录运行一组对照（需 Node.js 22 与 npm）：

```powershell
$probeVersion = '41.10.3' # 另一候选版本为 43.7.9
$env:RENDER_PROBE_ELECTRON_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ('cindy-render-electron-' + [guid]::NewGuid())
npm install --prefix "$env:RENDER_PROBE_ELECTRON_DIR" --ignore-scripts --no-audit --no-fund "electron@$probeVersion"
if ($LASTEXITCODE -ne 0) { throw 'Electron package installation failed' }
node "$env:RENDER_PROBE_ELECTRON_DIR/node_modules/electron/install.js"
if ($LASTEXITCODE -ne 0) { throw 'Electron binary installation failed' }
$env:RENDER_PROBE_SCENARIO = 'minimize' # 或 hide
$env:RENDER_PROBE_SURFACE = 'window' # 或 view
$env:RENDER_PROBE_IDLE_SECONDS = '900'
$env:RENDER_PROBE_HIDDEN_SECONDS = '3'
node apps/desktop/scripts/render-recovery/run.mjs
```

- 默认恢复后保持 900 秒不操作；`RENDER_PROBE_HIDDEN_SECONDS=8100` 可覆盖约 2 小时 15 分钟隐藏。
- 完整对照为 8 组：2 个 Electron 版本 × hide/minimize × BrowserWindow/WebContentsView。
  Windows 使用无边框 Acrylic 窗口；WebContentsView 用例对应上游修复的直接回归形状。
- 独立安装 Electron，不安装整仓依赖，不加载 Cindy、账号、任务、UU 或真实业务内容。
  不关闭 GPU、不改变系统设置；记录运行环境的实际 GPU 功能状态。

执行顺序：先证明基线色块和原生输入正常，再隐藏/最小化、关闭节流、等待隐藏时长、恢复，
然后保持 15 分钟不截图、不注入输入、不 resize、不刷新。最后读取页面状态，先保存截图，
再做一次 rAF 探针和点击检查，避免主动请求新帧提前唤醒画面。页面普通 timer 只增加内存
计数，不更新 DOM，也没有常驻动画。
避免探测动作维持渲染，掩盖延迟帧回收问题。

每组在输出目录保存合成页面的 `baseline.png`、`after-idle.png`、`events.jsonl` 和 `report.json`。
报告包含原生显隐、节流值、renderer 身份、页面可见性、timer、rAF、截图色块及输入结果。
输入前后检查承载窗口焦点；失焦时 `inputResponded=null`，不把无效输入探针判为失败，
也不主动聚焦来唤醒画面。像素正常但输入无法判断时为 `inconclusive`；真实像素不匹配仍为 `failed`。
截图来自 `capturePage()`，**不是物理显示器或 UU 远控画面的采样**；采集/输入本身也可能唤醒
停滞的 surface，因此保留采集前后的分项观察，不能用最后一张截图证明此前从未黑屏。

## 如何判读

| 状态                    | 含义                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| `passed` / exit 0       | 本轮最后的色块、输入、rAF 检查通过；不等于原故障已修复                            |
| `failed` / exit 1       | 基线正常，但恢复后的色块或输入检查失败                                            |
| `inconclusive` / exit 2 | 基线不具备检测条件、窗口操作未生效、仅 rAF 超时、进程退出或探测超时；不能记为通过 |

- 41 失败、43 通过：支持接入上游修复，接着验证完整 Cindy 的升级兼容性。
- 两版都通过：没有复现，不能关闭 #5627；先确认环境覆盖与新证据目标，不重复运行等价对照。
- 两版都失败：先看截图、原生状态和退出记录，区分测试环境限制与候选版本仍有问题。
- Windows runner 是虚拟机，不能代表提报者的 Windows 11、显示驱动、多显示器或 UU 环境。
  测试用注入的原生输入，不证明远程软件或真实鼠标输入链路正常。

升级后仍需完整 Cindy 的启动、原生 SQLite/PTY、内嵌浏览器、远控检查。
42 的兼容性检查重点还包括 Electron 二进制安装时机、macOS 通知签名要求、
offscreen 默认缩放、`NativeImage.toBitmap()` 色彩空间和文件对话框默认目录变化。
本轮实验和诊断修正不引入自动重载，也不改变后台任务运行策略。42.11.12 保留 #52844 的回移修复，
并包含 42.10.0 起提供的 GHSA-qmv3-fv6v-rmhq 安全修复；不再使用受影响的 42.9.2。
但本实验的 8 组软件 GPU 结果不能证明 Windows 硬件 GPU 合成路径或提报者的远控环境已修复。

## 已完成的实验

2026-10-09 的 [Windows 对照 run 37922969329](https://github.com/makecindy/cindy/actions/runs/37922969329)
使用提交 `02c6f362f82288f9d2df1c9eb69ec9a2af17c17a`，8 份报告已逐份核验：
41.10.3 与 43.7.9 各 4/4 通过，恢复后实际静置 899.993–900.025 秒，
基线与恢复后的像素、rAF、输入焦点及点击响应均正常，未观察到恢复差异。
8 组均为 `gpu_compositing=disabled_software`、`rasterization=disabled_software`，
没有覆盖硬件 GPU 合成路径；这不是 #5627 已修复或应升级生产 Electron 的证据。

实验完成后移除了专用 workflow，保留手动脚本与本节结论。原始截图和报告仍受历史
Actions artifact 的保留期限约束；对应运行的默认保留期为 14 天。

## 本地检查脚本

在仓库依赖已安装的情况下，使用当前开发 Electron 跑短流程（Mac 只能验证脚本本身）：

```sh
RENDER_PROBE_IDLE_SECONDS=2 RENDER_PROBE_HIDDEN_SECONDS=1 \
RENDER_PROBE_OUTPUT=/tmp/render-probe-local \
node apps/desktop/scripts/render-recovery/run.mjs
```

用 `RENDER_PROBE_SCENARIO=hide` 或 `RENDER_PROBE_SURFACE=view` 切换场景。
设置 `RENDER_PROBE_ELECTRON_DIR` 可使用另一个临时 npm 安装目录中的 Electron；
先执行该包的 `install.js` 准备二进制。每次创建独立临时 userData，并在进程结束后清理。
未指定输出目录时，在系统临时目录创建独立结果目录，并打印其路径。复用指定输出目录会
清除本脚本上轮生成的报告、事件和两张截图；其他文件保留。截图采集、转换或写入异常
归为 `inconclusive`，不能据此认定色块不匹配。
短流程不覆盖延迟回收时间，不作为长时回归通过的证据。

watchdog 生产侧复用 `onWindowHiddenChange`，网页隐藏或原生隐藏时均停止探针。
原生状态未知时明确记录 `null`，不会把未知记成已确认可见；HMR 保留最近的原生状态。
告警通过既有日志 IPC 在 main 补充真实 sender 的窗口 ID、PID、节流值和显隐状态，
不采集窗口标题、URL、任务或对话内容。
