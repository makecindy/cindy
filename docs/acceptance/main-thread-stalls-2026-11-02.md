# 主线程卡顿优化验证（2026-11-02）

## 结论与范围

本次修复减少插件通知发现、Codex 历史定位和批量路径搜索的阻塞，并把 Claude CLI
登录状态查询放到工作线程。输入框展示用的插件目录偏好改为异步读取；麦克风权限在
preload 初始化时同步取得一次，后续读取使用由 main 推送更新的快照。

大目录合成场景的三项耗时中位数分别下降约 90%、79% 和 55%。**普通 mock 主界面的
任务切换与输入仍有长任务和明显波动，不能据此宣称整页交互稳定变快或用户卡顿已全部修复。**

基线提交：`a6d577b14225740bc5a8a3911258ff9d888f9591`。优化版为该基线上的本次工作区修改。
测量平台为 Windows，Node `v24.14.1`。全部轮次见
[原始数据](main-thread-stalls-2026-11-02.json)；该数据保留本次中断前已经完成的测量，
后续收尾检查没有覆盖或重新挑选测量结果。

## 大目录与插件通知

[基准脚本](../../apps/desktop/scripts/benchmark-main-stalls.mjs) 打包实际生产模块，
对基线与修改版使用同一组临时数据：6,000 个历史文件、10,000 个工作区文件、300 个
待解析路径、30 个插件、连续 12 条通知。先预热，再按 before / after / after / before /
before / after 交替执行，每版 3 轮；准备、构建和预热不计入耗时。

| 场景 | 优化前中位数 | 优化后中位数 | 耗时下降 |
| --- | ---: | ---: | ---: |
| 插件通知批量触发 | 306.91 ms | 30.01 ms | 90.2% |
| Codex 历史定位 | 54.02 ms | 11.58 ms | 78.6% |
| 批量路径搜索 | 75.76 ms | 34.34 ms | 54.7% |

1 ms 定时器观测的最大事件循环间隔，取各轮中位数：插件通知从 306.90 ms 降到
13.84 ms，历史定位从 53.99 ms 降到 1.60 ms，路径搜索从 1.89 ms 降到 1.27 ms。
这是事件循环可响应性的近似指标，不是界面帧耗时。

每轮插件扫描从 12 次减少为 1 次，仍投递全部 12 条通知；历史定位对无关 rollout 的
同步 stat 从 5,999 次减少为 0 次。脚本同时断言找到目标历史、路径匹配数量和通知投递数量。
宿主服务使用替身，数据库不参与本组测量；结果不能外推为真实账号所有路径的性能。

## 完整 mock 主界面

[操作脚本](../../apps/desktop/scripts/benchmark-mock-navigation.cjs) 在独立 `--mock`
实例上切换 4 个固定任务，每轮循环 3 次，共 12 次切换；每次输入并清空同一段文本。
切换耗时包含自动化点击、等待目标 URL 和两次 animation frame，不等于纯 React 渲染时间。
表中偶数样本的中位数取中间两项的平均值。

| 轮次 | 切换中位数 | 切换最大值 | 长任务数 | 最长长任务 | 最大事件处理前等待 |
| --- | ---: | ---: | ---: | ---: | ---: |
| before-clean | 87.31 ms | 108.13 ms | 12 | 105 ms | 14.30 ms |
| after-first | 86.95 ms | 109.11 ms | 14 | 124 ms | 53.60 ms |
| after-final | 96.54 ms | 156.13 ms | 15 | 124 ms | 112.70 ms |
| after-idle | 670.28 ms | 1,162.71 ms | 12 | 168 ms | 21.50 ms |
| after-repeat | 102.89 ms | 127.55 ms | 15 | 138 ms | 124.30 ms |

事件等待来自 PerformanceEventTiming 的 `processingStart - startTime`，包括指针、点击和
键盘事件，不能单独称为输入延迟或 INP。保留 after-idle 异常轮次；现有数据不能确定其根因。
普通 mock 缺少真实用户的大量插件和历史文件，且只有一轮基线，以上结果不足以证明整页改善。

## 行为约束与验证

- 插件通知只共享尚在执行的扫描；下一批重新读取。异步返回后校验账号代次，投递前重新
  查安装状态和批准标识，避免账号切换、禁用或替换安装后收到旧通知。
- 展示用目录偏好不再同步等待 main；旧目录的迟到响应不能覆盖新目录。发送时的现行策略
  检查仍保留。同步接口继续兼容既有调用者。
- 历史 fallback 异步遍历目录，只 stat 精确匹配 ID 的候选；保留索引优先与只读行为。
  这不代表模块内所有 SQLite、配置读取都已变为异步。
- CLI 状态查询 worker 仍执行内置 CLI 的 `auth status --json`；保留超时、失败退避和旧状态
  回退，不读取或转移 CLI 凭证。工作线程实际启动、失败和超时路径已在前序验证中检查。
- 麦克风快照覆盖重复读取和权限撤销；初始化仍有一次同步 IPC，不能称为完全消除同步 IPC。

收尾定向验证命令：

```powershell
pnpm --filter desktop exec vitest run src/main/cindy-brain/__tests__/subscriptionGateway.test.ts src/main/maker-host/__tests__/claudeNativeCli.test.ts src/main/maker-host/__tests__/managed-skills.test.ts src/main/__tests__/codexLocalSessions.test.ts src/main/__tests__/pathResolver.test.ts src/renderer/cindy-brain/__tests__/useInstalledGhosts.test.tsx src/preload/__tests__/microphonePermissionSnapshot.test.ts --maxWorkers=2
pnpm --filter desktop run --if-present typecheck
pnpm check:test-hygiene
pnpm check:dev-docs
node --check apps/desktop/scripts/benchmark-main-stalls.mjs
node --check apps/desktop/scripts/benchmark-mock-navigation.cjs
git diff --check
```

已核验：7 个定向测试文件、308 项用例通过，Vitest 总耗时 10.74 秒；测试规范检查通过。
新文件 `microphonePermissionSnapshot.test.ts` 单独运行的 Vitest 耗时 0.283 秒
（命令工具墙钟 1.69 秒）。既有 `codexLocalSessions.test.ts` 含 127 项用例和文件／数据库
fixture，本轮执行测试部分 6.71 秒；未把这一整文件耗时误报为新增单用例耗时。
Desktop 类型检查通过；文档检查 10 项全部通过；两个基准脚本的语法检查和
`git diff --check` 通过。另已核对报告内链接及原始数据的全部 11 轮记录。

前序单页 `ui:check --changed --theme all` 被 PDF worker 导入错误阻断，不能登记为通过；
前序已使用完整 mock 实例查看 Light / Dark。收尾未重新启动实例或重做实机目检。
macOS、正式打包产物、真实用户数据下的整页性能和完整 CI 尚未在本轮验证。

## 复跑方法与剩余验收

在仓库根运行大目录对比（输出可保存到仓库外临时目录）：

```powershell
node apps/desktop/scripts/benchmark-main-stalls.mjs a6d577b14225740bc5a8a3911258ff9d888f9591
```

完整主界面需先按 [Desktop 开发规则](../dev-rules/desktop-development.md) 启动隔离 mock，
确认 `DESKTOP_DEV_VERDICT=ready`，并核对连接端口属于该 mock 实例，再运行操作脚本：

```powershell
$env:XDT_CDP_PORT = '9347'
pnpm restart:desktop:remote --region=global -- --mock --isolated=@worktree
node apps/desktop/scripts/benchmark-mock-navigation.cjs after <仓库外输出目录> 9347
```

操作脚本会修改草稿并截图，只能连接已核实的 mock 实例；脚本注释本身不是自动识别 mock
的保护。基线与修改版应使用相同脚本、数据、窗口和前台状态；不要并行构建或跑测试。
本次没有重启或更换用户正在使用的 Cindy。

剩余验收：对整页切换与输入保留多轮交替基线／修改版测量，定位剩余长任务和 after-idle
异常轮次；在 macOS 与正式打包 Windows 中验证新增 worker 的装入与退出。达到这些条件前，
本报告的性能结论仅限上述已测路径。

## BWG3-D6PR 补充修复与验证

另一份同版本录制的插件扫描、语音同步 IPC 和路径搜索与前述问题重叠，但还显示两次
键盘事件经过 `flushSync` 并触发大范围布局。录制没有具体按键，不能把这两次事件断言为
Tab；两份发行版录制也不能互相当作优化前后基线。

本次补充改动：

- `GhostManager` 同一次投影把已读取的批准凭据传给来源投影，避免 `instanceProjection`
  再同步读一遍；不跨调用缓存凭据。`ghost_list` / `ghost_info` / 手册读取 / `ghost_call`
  的初始发现走异步扫描，保留逻辑名称歧义和未登录原因。后续授权重验只读取所选物理
  实例，仍检查当前安装目录、namespace、批准 revision、停用与工作目录策略。
- 语音 `getDataSnapshot` 从 preload 本地快照读取；主进程推送、旧数据迁移和账号切换
  更新快照。账号切换刷新失败时清除旧值并让读取报错，不继续返回前一账号的数据。
  初始化和认证边界仍有同步 IPC，不能称为全部异步。
- Tab / Shift+Tab 只展开通往下一个可聚焦控件的消息行；不阻止浏览器默认 Tab，也不
  代替浏览器移动焦点。编辑器和弹层先处理按键，已交互消息保留状态。Ctrl+A、浏览器
  查找、选择文本及无障碍模式继续保留完整文本访问。

补充验证使用同一基线上的工作区，Windows 隔离 mock 沙箱 `bwg3-perf`，启动回执为
`DESKTOP_DEV_VERDICT=ready`，Global，进程 48048；没有操作安装版或真实账号。

| 验证 | 结果 |
| --- | --- |
| GhostManager、ghostVisibility、focusTraversal | 353 通过、3 个既有条件跳过；73.77 秒，主要为既有文件系统 fixture |
| 消息虚拟化、语音 renderer 数据、preload 快照、focusTraversal | 57 通过；3.19 秒 |
| ghostWorkdirGate 最终版本 | 264 通过，1 项在 fixture 创建文件符号链接时 `EPERM`，未执行到产品逻辑；7.19 秒 |
| 新增 voiceInputDataSnapshot 文件单独运行 | 3 通过；Vitest 0.379 秒，命令墙钟 1.81 秒 |
| Desktop typecheck、test-hygiene、dev-docs | 通过；文档 10 项通过 |
| 完整 mock 主界面 | 输入框 Tab 能进入按钮；Light / Dark 内容与输入框已截图目检 |
| 原生浏览器键盘＋生产 MessageViewport | 80 行合成消息，Tab 依次进入 0、1、2；Shift+Tab 依次进入 79、78、77；挂载行数依次为 7、7、7、8、10、10 |

原生键盘复跑入口：

```powershell
node apps/desktop/scripts/check-mock-message-tab.cjs 9347
```

[脚本](../../apps/desktop/scripts/check-mock-message-tab.cjs) 需连接已核实的隔离 mock，
通过正在运行的 Vite 导入实际生产组件，在临时 DOM 内提供 80 行 fixture；退出恢复页面，
不写数据库。这验证真实浏览器默认焦点移动，**不是 80 条真实复杂消息的整页性能对比**。
普通 mock 任务只有两行消息，不以其代替长历史验证。截图留在本地临时目录
`cindy-bwg-ui-TFAMgK`，不把个人路径写入仓库。

`ui:check --changed --theme all` 再次被既有 `PdfPreview.tsx` 中
`pdfjs-dist/build/pdf.worker.min.mjs?url` 缺少 default export 阻断，未登记为通过。
符号链接用例未删改或新增跳过，需要在有文件 symlink 权限的 Windows 或 Linux CI 补验。

剩余边界：原生全文全选仍会挂载历史；本次没有证明报告中两次未知按键长任务全部消失。
技能列表的多秒耗时尚无分阶段测量，消息读取耗时也不能归因为 SQL；均不能宣称已完全解决。
上方 90% / 79% / 55% 是补充修复前已经保存的合成场景结果，不作为本节三项新增改动的
性能数值。仍需修改版重放用户操作，并按技能准备／同步／扫描阶段定位剩余等待。

## 更新 main 后的 PDF worker 检查器修复

随后按用户要求 fetch 并 rebase 到 `origin/main` 的
`b8bc98fe727b4ce292a956b878a1bb3e79c2de85`（相对原基线新增 97 个提交）。原有未提交修改
及新增文件经 stash 保存后恢复，无冲突；上方性能数据仍对应原基线，不重新标为新 main 的数据。

该 main 的 `PdfPreview.tsx` 与单页构建器仍有同样的问题：组件使用 Vite 的
`pdf.worker.min.mjs?url`，但单页检查器的 esbuild 未实现 `?url`，把资源解析成普通模块，
因而报缺少 default export。这是检查器与产品构建方式不一致，并非 PDF worker 文件缺失，
也不能据此推断安装版 PDF 预览失效。

修复在 `scripts/ui-page/build.mjs`：解析包路径和相对路径的 `?url`，原样输出资源并返回 URL，
保留源文件改动扫描、指纹和 `--compare` 的内容替换。Electron 与 Chromium 两种检查模式
均为 `.mjs` 提供 JavaScript MIME；没有修改产品 PDF 组件、替换 worker 或放宽 CSP。

回归先在新 main 上复现两个缺少 default export 错误，再验证修复后的真实 PDF 模块装入、
相对路径 worker 通信和对照资源变化。新增用例归现有 integration/E2E selftest；单独运行
8.29 秒（包含构建和启动 Electron）。完整 `ui:check:selftest` 为 7 通过、1 个 Windows
SIGINT 既有跳过，50.21 秒。PDF 预览、目录插件状态、Codex 历史共 149 项定向测试通过；
Desktop 类型检查、test-hygiene、dev-docs 与 diff 检查通过。

原先被导入错误阻断的 `ui:check --changed --theme all` 现能完成构建和执行：134 个变体中
126 通过、8 失败，293.1 秒。失败都来自 `markdown-preview-find` 的 `nested-mermaid`、
`outside-focus`、`fullscreen-video`、`toolbar-tooltip` 四类场景的双主题版本；两类断言失败、
两类等待超时。用 `--compare origin/main` 对这四类浅色场景复核，改前与改后均出现同样失败，
62.3 秒；因此不归因于 PDF worker 修复，也不登记为全量 UI 通过。

本地证据：`artifacts/ui-check/changed-yPUp2V/summary.json` 与
`artifacts/ui-check/markdown-preview-find-LOVfMD/summary.json`。已查看全量检查的
`overview.png` 和 `overview-21.png`，未逐张验收全部 23 张总览。`NewMakerDraftRoute.tsx`
及类型声明仍显示 `UNCOVERED`。Markdown 四类既有失败需沿各自 fixture／焦点和全屏行为
继续排查；本节不宣称其已修复。PDF 专项验证以真实 worker 的新增 selftest 为准，
不以 stub 了 PDF 组件的 Markdown 场景代替。

## 最终基线复测与技能校验补充

本节重新对照 `b8bc98fe727b4ce292a956b878a1bb3e79c2de85` 与恢复后的未提交工作区，
不沿用最初基线的百分比。新增技能列表完整性异步校验：仍逐文件验证全部指纹，固定读取
开始时选中的版本，结束时重新核对清单、活动链接和目标目录身份；不缓存或延长信任。
托管技能列表与 IPC 的身份投影使用异步入口，同步身份判断入口保留。

性能录制新增四个固定阶段名：项目链接、全局准备、扫描、身份校验。不开录制时直接执行
原操作；只记录固定标签和耗时，不记录目录、技能名称、正文、参数或返回结果。

### 主进程大目录对比

同机 Windows / Node 24.14.1；每侧三轮，顺序为前、后、后、前、前、后。
历史 6,000 文件、工作区 10,000 文件及 300 查询、30 插件及 12 通知。
技能校验使用实际内置技能包，另加 600 个 4 KiB 合成参考文件。
准备夹具、构建和预热不计入测量；只替换列出的基线生产模块，共用依赖来自当前工作区，
因此这是定向基准，不是两个完整发行包的对照。

| 路径 | 总耗时中位数：前 → 后 | 每轮最大事件循环间隔的中位数：前 → 后 |
| --- | --- | --- |
| 插件批量通知 | 764.07 → 41.63 ms（降低 94.6%） | 764.05 → 23.68 ms |
| Codex 历史定位 | 57.79 → 14.03 ms（降低 75.7%） | 57.75 → 1.57 ms |
| 文件路径搜索 | 86.22 → 46.92 ms（降低 45.6%） | 2.94 → 3.79 ms |
| 技能完整性校验 | 317.07 → 375.61 ms（增加 18.5%） | 317.04 → 4.72 ms |

插件扫描次数仍为 12 → 1，通知均送达 12 次；无关历史文件 stat 为 5,999 → 0。
技能校验改善的是主线程响应，不是总加载速度。路径搜索本身原已让出事件循环，本轮的
最大间隔没有改善。新版基准同时使用基线／修改版 GhostManager，并启用来源投影回调，
覆盖了补充修复的重复凭据读取；因此插件数字不能与旧基准直接混用。

### 完整界面与长历史键盘

先 stash 保存全部修改和新增文件，确认干净 main，启动 `bwg3-perf` 隔离 mock；
两轮测完再完整恢复工作区并重启同一沙箱，测两轮修改版。两次启动均获得
`DESKTOP_DEV_VERDICT=ready`，Global；没有重启安装版。每轮重新加载并预热，随后切换
同样四个模拟任务三遍，逐次输入并删除相同草稿。没有同时运行构建或测试。

| 轮次 | 切换中位数 | 最慢切换 | 长任务次数 | 最长长任务 |
| --- | --- | --- | --- | --- |
| main 第 1 轮 | 87.50 ms | 103.35 ms | 13 | 95 ms |
| main 第 2 轮 | 85.99 ms | 98.65 ms | 11 | 108 ms |
| 修改版第 1 轮 | 87.81 ms | 96.06 ms | 12 | 90 ms |
| 修改版第 2 轮 | 85.62 ms | 159.92 ms | 12 | 93 ms |

**普通 mock 的切换和输入没有证明稳定提速。** 最慢切换的异常值保留，不剔除。
另外单独采了一轮 renderer CPU profile，未混入上表；主要可命名业务采样涉及 ChatInput、
CCAgentSessionContent 和 WindowsSelectionReplacement，开发版 React 渲染也占明显成本。
这些是下一步定位入口，不能仅凭累计采样就归因为单个组件缺陷或推断发行版耗时。

另用生产 MessageViewport + MarkdownRenderer 在临时 DOM 中渲染 80 条合成格式化消息，
每条八组段落与列表。每种按键三轮，原生焦点与全选结果同时断言；不写数据库或剪贴板。

| 操作 | 到两帧后墙钟中位数：前 → 后 | 挂载消息：前 → 后 | 三轮最大长任务：前 → 后 |
| --- | --- | --- | --- |
| Tab 进入第一条消息 | 288.18 → 40.43 ms | 80 → 2 | 257 ms → 无 ≥50 ms 长任务 |
| Ctrl+A 全选 | 308.54 → 312.92 ms | 80 → 80 | 256 → 265 ms |

Tab 墙钟降低约 86.0%，包含自动化调用与两帧等待，不能当作纯按键处理耗时。
两版 Ctrl+A 每轮均选中了全部 80 条消息，但其同步展开卡顿**仍未解决**。
初版脚本另存的 `keys` 监听计时会漏掉先注册的基线捕获处理器，已弃用；上表只用不受
该问题影响的墙钟、浏览器 long-task、挂载与选择结果。保留的 JSON 明确记录这一限制。

### 技能列表实际阶段与验收边界

修改版隔离实例开启本地性能录制后，依次调用 Pi、Claude、Pi、Claude，均成功：

| 调用 | 全局准备 | 扫描 | 身份校验 | renderer 总等待 |
| --- | --- | --- | --- | --- |
| Pi 首次 | 214.52 ms | 324.17 ms | 21.40 ms | 563.60 ms |
| Claude | 0.18 ms | 34.00 ms | 20.28 ms | 57.60 ms |
| Pi 再次 | 0.19 ms | 31.72 ms | 19.26 ms | 53.90 ms |
| Claude 再次 | 0.15 ms | 32.93 ms | 22.65 ms | 59.10 ms |

项目链接阶段均不足 0.1 ms（无工作目录）。这里只列出 5～6 个技能，且开启采集，
不能据此宣布原报告的 5～10 秒等待已消失；现在具备了按阶段复现定位的依据。
录制完整、只保存本地，没有上传。

新增／扩展验证覆盖异步完整性判断的七类损坏与校验期间清单变化；相关技能和性能录制
86 项单测通过（3.82 秒），Desktop 类型检查通过。此前 PDF worker 专项结果继续有效。
扩大到技能 IPC 边界与消息虚拟化的最终定向验证为 127 项通过（3.70 秒），
test-hygiene 通过（357 文件基线），三个基准脚本语法检查与 diff 检查通过。
开发文档门禁 10 项通过；本轮未重跑全部 UI 场景，前文登记的既有失败仍保留。

原始数值在同目录 JSON 的 `finalBaselineComparison` 中。复跑主进程基准时将基线参数改为
上述 `b8bc98fe…`；长历史入口为 `scripts/benchmark-message-keyboard.cjs`，参数与普通导航
脚本一样，需连接已核实的隔离 mock。未完成项仍包括全文全选、真实大技能目录的分段录制、
发行包与 macOS 验证；这些限制不因单项基准改善而解除。

### PR 截图复核

提交前单独运行 `pnpm ui:check --page companion-composer --case 'default,narrow' --theme all`，
4 个变体全部通过，14.3 秒；已目检一张包含全部场景的 Light / Dark、宽／窄窗口总览。
截图使用合成数据，覆盖真实 ChatInput、编辑器和按钮；不验证真实麦克风、账号、模型服务或
主进程响应速度。此项补充不改变上述全量 UI 检查中 8 个既有失败的结论。

## PR #8493 审查后的补充修复

审查提交 `81a7279f35` 后确认三项反馈有效：

- 语音浮窗和词典提示窗口共用 preload，但不是 app-content。改为独立的麦克风只读登记表，
  两类窗口创建时登记，主窗口保留原读取能力；不授予辅助窗口文件、安装或进程等权限。
  同步拒绝也返回结构化结果，所有路径只设置一次 `event.returnValue`；推送前重验当前地址，
  未登记窗口、子 frame、已导航或销毁窗口不能继续收到状态。
- 批量路径 BFS 每次取出目录后清空已消费的数组项，释放路径及其附带数据；保留游标和
  原来的遍历顺序，避免恢复逐次 `shift()`。
- 异步技能指纹校验记录每个文件和目录的设备、inode、类型、大小、mtime 与 ctime。
  内容全部读完后，不再让出事件循环，逐项核对元数据，拒绝先读的技能在后续扫描中被
  同大小改写、增加子文件或替换目录。清单与活动版本的核对仍保留，不跨请求缓存信任。
  结束阶段只读元数据、不重新同步哈希内容，但仍有与条目数相关的同步成本；这不是
  文件系统事务，也不承诺返回后文件永远不变。

验证：技能、路径、语音 IPC、全局快捷键、preload 共 200 项通过（21.98 秒）；其中既有
全局快捷键文件 90 项耗时 21.53 秒，未新增其中用例或真实等待。技能文件测试部分 2.437 秒，
包含三个在后续技能读取期间修改前一技能的时序回归。新增 IPC 文件覆盖真实登记与
frame／地址闸，而旧 preload 测试替换了整个 IPC，无法覆盖这条故障；最终单独运行
6 项通过，Vitest 0.346 秒、命令墙钟 1.62 秒。类型检查最初发现测试夹具循环类型，
修正后 Desktop typecheck 通过；test-hygiene 和 dev-docs（10 项）通过。
本轮未重新启动完整 Electron 浮窗或验证 macOS；不能把 IPC 夹具通过等同于实机验收。

为核对收尾元数据检查的成本，类型检查结束后独立重跑同一基准（同一 main 基线、夹具、
每侧三轮、前后后前前后顺序）。本轮数据独立于前文轮次，不能交叉拼成前后对比：

| 路径 | 总耗时中位数：main → 审查修复后 | 最大事件循环间隔中位数：main → 审查修复后 |
| --- | --- | --- |
| 插件批量通知 | 569.69 → 30.86 ms | 569.67 → 14.23 ms |
| Codex 历史定位 | 54.54 → 10.53 ms | 54.52 → 1.65 ms |
| 文件路径搜索 | 69.96 → 31.80 ms | 1.91 → 1.21 ms |
| 技能完整性校验 | 216.20 → 299.38 ms（增加 38.5%） | 216.18 → 5.19 ms |

技能校验仍是以总耗时换取主线程响应；本轮没有重新测 Tab 或完整界面切换。
原始六轮在同目录 JSON 的 `reviewFollowupComparison`，前文数据完整保留。
