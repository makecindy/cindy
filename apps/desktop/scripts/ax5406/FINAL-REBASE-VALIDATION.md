# #5406 最终 rebase 与完整复测

2026-10-04，Windows，分支 `cindy/witty-feynman`。

**阶段结论：rebase 完成，dev 关键路径复测通过。下文保留当时的原始结果；其中 40 项失败及随后发现的 7 项原生集成失败已在后续修复，提交前状态见下面的补充记录。**

## 提交前补充验证（2026-10-04）

- 原 40 项失败逐项复测通过。修正 Windows 链接与路径写法、数据库测试夹具及过期源码断言，未删除或放宽产品行为断言。
- Desktop unit：47,465 通过、148 既有跳过、0 失败；Desktop DB：1,896 通过、6 既有跳过、0 失败；maker-core unit：5,169 通过、37 既有跳过、0 失败。另有 guard 与行为定向回归 323 项通过。
- 原生集成的 7 项失败全部通过：Claude 测试等待子进程实际关闭后再恢复或清理目录；Pi 旧版 API 路径遇到子任务缺少 settings.json 时使用默认设置，仅捕获 ENOENT，仍上抛权限错误与损坏配置。
- 六个原生集成测试文件共 86 通过、11 既有跳过、0 失败（真实原生程序与本地模拟上游）；Pi bridge 相关回归 671 通过、4 既有跳过、0 失败。Desktop 和 maker-core 类型检查通过。
- 这些是对受影响测试范围的后续复测，并非在最后一处修复后重新执行整仓默认矩阵。下文 dev 视觉验收对应消息渲染实现；后续产品代码仅修改 Pi bridge 的缺失配置处理。
- 本机详细证据：`C:/Users/User/AppData/Local/Temp/cindy-baseline-test-fixes-P0fAwt/REPORT.html` 与 `C:/Users/User/AppData/Local/Temp/cindy-native-integration-b59e2a55/REPORT.html`；这些临时路径仅供本机核查，不是仓库附件。

## 版本与改动保护

- 从 `25388846915a9640341c4de5feb804b3a948c8f2` rebase 到本轮 fetch 的 `origin/main`：`09de409253734af65e63e0d77b7402b9c7071e19`，新增 6 个主干提交，无冲突。
- 原有 86 个已修改／未跟踪文件先复制备份并记录哈希，再 stash、rebase、apply。保留备份 stash `98894031d45a523ff1fbfc3d3bcf79bf79120981`。
- 自动合并的 preload 和类型声明已复核；main 新增接口与本地无障碍接口均保留。
- 主干包含 #5445 历史分页读取优化；其 `historyViewReader` 41 项测试全部通过。
- 本轮新增修正仅涉及验证接入：重新生成设计库存以纳入新增聊天文件；将转储解析测试接入 Vitest 并更新运行命令，原断言保留。没有修改产品实现。

## 完整测试矩阵

实际执行 `pnpm test:all`。首次根级测试被过期设计库存阻断；修正后执行 `pnpm test:runner` 和原入口后半段 `node scripts/test-workspaces.mjs --all`，完整覆盖同一默认矩阵。另行执行 Desktop DB 层和真实 dev 冒烟。

| 检查 | 本轮结果 |
|---|---|
| 根级 runner | 562 通过，10 跳过，0 失败 |
| Desktop typecheck | 通过 |
| Desktop unit | 47,457 通过，148 跳过；6 项链接测试失败与 main 一致。另有转储测试最初未被 Vitest 收集，修正接口后该项单独通过 |
| Desktop guard | 33 通过，6 失败，与 main 一致 |
| maker-core unit | 5,167 通过，37 跳过，2 失败，与 main 一致 |
| maker-remote-ssh unit | 首次因找不到 Bash 失败 11 项；仅为测试进程补充本机 Git Bash 的 PATH 后，整包 238 通过、3 跳过、0 失败 |
| 其余默认矩阵 | 全部通过，包含 Mobile、device-link、共享包与设计 token 等。默认矩阵共 30 个执行目标；首次 26 通过、4 失败；SSH 环境修正后剩余 3 个目标仍含 main 已有失败 |
| Desktop DB | 130 文件：122 通过、8 失败；1,869 测试通过、26 失败、6 跳过。8 个失败文件在 main 对照得到完全相同的 26 项失败 |
| 源码与差异检查 | dev 验收期间 7,483 个源码文件哈希未变化；`git diff --check` 通过 |

DB 层原命令触及 Windows `cmd.exe` 参数长度限制。使用临时适配脚本保留同一 manifest、前置检查、测试文件与排除项，直接由 Node 启动 Vitest，实际跑完全部 130 文件；没有删减测试。初始失败日志和完整参数保留。

### main 对照失败

对照 worktree 为 `D:/projects/cindy/.ab-worktrees/witty-feynman-main-5406`，detached HEAD 同为 `09de4092`。复跑失败文件并比较测试名称，不以“未改到这些文件”替代对照证据。

- **6 项 Desktop unit**：`mobilePageAssets`、`skillSlot`、`botWorkbenchHandover` 的链接创建报 `EPERM`。已核对仓内使用 Windows junction 的跨平台测试写法；当前失败用例的目录链接未采用该写法，文件链接也不能直接替换为 junction。未扩大本修复范围去改插件／交接测试。
- **2 项 maker-core**：`bot-own-skills-mount` 的技能枚举受本机已安装技能影响，实际列表超出测试预期；main 同样失败。
- **6 项 guard**：`makerSendToSessionOrdering` 按源码字符串检查旧实现，与 main 当前实现不匹配；main 同样失败。
- **26 项 DB**：测试夹具缺少 `list_preview` / `codex_plan_json` 等字段、路径分隔符及导入预期问题。失败文件见原始 `db-baseline-files.json`；逐项名称对照为一致。

这 40 项仍应按既有故障处理，不能记成通过；本轮没有新增 skip 或弱化断言。

## rebase 后真实 dev 复测

使用 `pnpm restart:desktop:remote --region=global --isolated=@worktree --passive`，收到 `DESKTOP_DEV_VERDICT=ready`，沙盒 `witty-feynman-6e38a1`，测试 PID `46128`。正式版未重启，未使用正式 profile。测试期间普通模式无障碍开关为 false。

| 关键路径 | 结果 |
|---|---|
| 浅／深主题 × 1280×800、960×640、1100×1000 | 480 次慢滚、快滚、反向滚动采样，0 可见占位空白、0 重叠；回底距离均为 0 |
| 查找、全选、恢复 | 查找命中、正文全选、输入框全选、退出后恢复按视口挂载通过；逻辑消息 key 保持；切换任务后阅读锚点偏差不超过 2px |
| 连续原生窗口缩放 | Win32 `SetWindowPos` 作用于真实客户区，120 次 resize、387 帧；AX 始终 false，离屏占位 50–54 行，0 可见占位、0 重叠；恢复尺寸后锚点偏移 0px |
| 跨历史窗口定位 | 三尺寸共 6 次 qa5406-100 / qa5406-470 定位，加 6 次补充定位；目标正确，5 秒观察期末稳定，无可见占位。生产 `requestChatTaskFocus` 通道集成测试 |
| 已加载范围内定位动画 | 从 store 验证目标已加载后，三尺寸双向共 6 次、每次超过 1,000px；实际观察到多个动画位置，稳定约 178–367ms；可见轨迹反向位移 0px，0 可见占位 |
| 真实 OpenAI GPT-6-Luna 流式输出 | 451–480 共 30 节、9,517 字符、结束标记完整；73 次采样、15 次 AX 树读取；稳定回看 11 次采样期间锚点漂移 0px，回看总期间内容增长 732px；回底后继续跟随，结束距离 0 |
| 变更文件卡片 | 双主题、两轮 5／7 文件，展开、离屏返回保留同一 DOM 与状态，48 次滚动采样无空白 |
| 独立“本条消息生成的文件”列表 | 双主题 × 三尺寸，7 文件完整、无横向溢出；96 次离屏采样、展开状态、切换任务、刷新后唯一清单均通过 |
| 本轮修改文件树 | 双主题 × 三尺寸，旧轮仅 5 个 note 文件、新轮仅 7 个 file-list 文件；逐项选中、切换任务后的范围正确 |
| 大表格查找 | 双主题，横向滚动后命中可见且未被覆盖，逻辑窗口保持 |
| 分享选择 | 当前逻辑窗口正文补齐，全选、滚动保持选择、取消通过 |

跨历史窗口跳转的可见／稳定时间约 66–405ms，但新 main 的分页边界会使目标成为窗口首行，不能拿这组数据宣称动画或一般冷启动性能提升。上表单独记录了确认真实动画推进的已加载范围补测；没有做新的 main 性能 A/B。

检查真实 `PrintWindow` 截图，浅色卡片、浅色文件列表和深色文件树未见内容缺失、重叠或截断。几何采样与关键截图不能证明物理屏幕每一刷新帧都没有闪动。

## 边界与证据

- 本轮完整测试指仓库 `test:all` 默认矩阵，加 DB 和上述 dev 关键路径；没有执行所有 manifest 中标为 manual 的 Git 集成、migration replay、真实 Codex 二进制 E2E 或 DB 性能层。
- 原生窗口尺寸调整通过，但本轮没有重试鼠标拖动边框；上一轮 Windows 锁屏限制仍未解除，未覆盖系统拖拽 sizing loop。
- 没有重新执行文件撤销／重做、分享图片导出／剪贴板、macOS、正式安装包、真实屏幕阅读器长期使用、50k 压力性能。
- 原 #5406 现场转储仍缺失，因此不能宣称已证明并消除全部原始闪退原因。
- 本轮测试 dev 已请求正常退出；最终进程／端口清理结果见产物 `cleanup.json`。

全部原始日志、main 对照、JSON 轨迹、真实截图、备份与自包含手机报告：

`C:/Users/User/AppData/Local/Temp/cindy-5406-rebase-final-eU1oig/REPORT.html`

目录内 `SUMMARY.json`、`workspace-outcomes.json`、`db-baseline-comparison.json`、`unit-baseline-comparison.json` 对应上述结论。之前基线的报告保留，不能替代本轮证据。
