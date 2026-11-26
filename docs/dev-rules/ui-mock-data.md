# UI 模拟数据：免登录看真实界面

> **读取时机**：要在 Desktop 或 Mobile 上检查界面、截图、做 UI 回归，又不想登录真实
> 账号或碰真实数据时；新增或修改模拟任务、`--mock` 启动参数时。
> **适用路径**：`packages/maker-shared/src/uiMock*.ts`、
> `apps/desktop/src/main/localDb/uiMockSeed.ts`、
> `apps/desktop/src/main/companion-cloud/uiMock.ts`、
> `apps/desktop/src/main/maker-ipc/botGroupUiMock.ts`、
> `apps/mobile/src/debug/visualMock.ts`、`apps/mobile/src/debug/*VisualFixture.ts`

Desktop 与 Mobile 共用一套模拟数据：展示项目、不同状态的回归任务和它们的消息。开发版
加 `--mock` 启动后直接进入主界面：不登录 Cindy 账号，任务与消息来自模拟数据，不读写正式
profile。适合检查任务列表、任务页、消息渲染、深浅色和多语言这类只关心界面的改动；登录、
发送、跨设备、真实 Agent 运行仍要用真实账号验证。

> **`--mock` 不阻止 Desktop 调用真实模型。** 它只替换界面里的任务数据，不关模型。Desktop
> 开发版会沿用这台电脑上 Claude Code 与 Codex 命令行的登录（见
> [Agent 启动入口](desktop-development.md#agent-启动入口)），新建的模拟沙箱第一次启动时就可能
> 自动用上，伙伴随即可能用它写一条邀请问候；之后在模拟界面里发送消息，或伙伴、定时任务运行，
> 都会调用真实模型、消耗这些登录的额度。只把 `HOME` 换成临时目录也挡不住：Claude 的登录在
> 系统钥匙串里。2026-11-11（UTC）的一次巡检实际发生过，记录见
> [Host 无头运行计划的更正](../host/headless-runtime-plan.md#第-0-批通道覆盖度量2026-11-12)。
> 只为看界面时不要在模拟界面里发送消息；要确认有没有发生调用，看沙箱数据库的
> `daily_model_usage` 表。Mobile 的 `--mock` 只在 App 进程内存里，不运行 Agent。

| 端            | 启动                                                                     | 数据落在哪                                      |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Desktop       | `pnpm restart:desktop:remote -- --mock`                                  | 独立沙箱 `ui-mock`（与 `dev` 沙箱、正式版分开） |
| Mobile 模拟器 | `pnpm mobile:sim:start -- --mock`（`whoami`、`rebuild` 同样加 `--mock`） | 只在 App 进程内存里                             |

## 一套数据，两端共用

正本在 `packages/maker-shared/src/uiMock.ts`（`@cindy/maker-shared/ui-mock`）：

- `UI_MOCK_PROJECTS`：`orbit-garden-zh` / `orbit-garden-en` 展示项目，以及原有
  `cindy-demo`、`design-system` 回归项目和对应文件。
- `UI_MOCK_TASKS`：运行中、等待确认、排队、置顶、超长标题、英文、无文件夹对话、自动化、
  已归档等任务；`登录页窄窗口错位排查` 一条覆盖标题、表格、代码块、列表、引用、思考与工具
  调用。
  两条 `插件模型：…` 任务覆盖新任务选了插件模型后的说明行（选了模型、插件没回应）。
- `buildUiMockRows()`：按 Desktop 数据库行的格式生成任务与消息。Mobile 平时从电脑收到的
  也是这些行，所以两端看到的是同一份内容。

`visual-*` 开头的任务 id 被 Mobile 用来叠加运行时状态（运行中、权限确认、排队消息）；
这些状态在 Desktop 上来自真实 Agent，不在数据库里，所以 Desktop 只把它们显示成普通任务。
Mobile 另外保留双端一致性测试用的 `session-primary` 与 Orca 两条任务
（`SHARED_REMOTE_CONTROL_FIXTURE`）。

要加一种界面状态，就在 `UI_MOCK_TASKS` 里加一条任务，两端会一起出现。只用 Desktop
已有的消息格式（`user`、`assistant`、`thinking`、工具调用与结果），不要为模拟数据新增
数据库字段或协议。

## Desktop

登录服务的非 JSON 网络错误用 `XDT_LOGIN_SCENARIO=providers:non-json-418` 验证：
它只在开发构建将登录方式 GET 替换为合成的 418 HTML 响应（`server` / `via` 为
`scenario-proxy`），经过真实 auth client、诊断脱敏与登录页；不代表复现了报告人的网络。
此场景属于登录流程测试，不加会跳过登录页的 `--mock`。正式构建仍由同一 fixture stub 排除。

```bash
pnpm restart:desktop:remote -- --mock
pnpm restart:desktop:remote -- --mock --isolated=<名字>   # 另开一份模拟沙箱，可与别的 worktree 并行
```

- 默认沙箱名 `ui-mock`，其余规则与「Agent 启动入口」的隔离沙箱完全一致；仍以
  `DESKTOP_DEV_VERDICT=ready` 为启动成功的唯一依据。
- 新沙箱首次启动直接进入免账号的「未登录」模式（相当于点过一次「跳过登录」）。之后在
  沙箱里自己登录或切换模式，以你的选择为准。
- 每次本地数据库就绪时补齐缺失的模拟任务；已存在的任务不覆盖，测试中改名、归档、删消息等
  改动会保留，删掉的模拟任务下次启动重新出现。演示项目写在沙箱的 `ui-mock/projects/`。
- 想回到初始状态：退出这个实例后删除沙箱目录（启动日志里 `Isolated dev user data` 一行
  给出的路径），再启动一次。
- 生效条件同时满足才会写入：源码运行（非安装包）、`--mock`、隔离沙箱、免账号的本地数据
  所有者。`--mock` 与 `--shared`、`--preserve-running` 组合直接拒绝；安装包或共享
  profile 里即使环境变量残留也会被忽略。实现见 `apps/desktop/src/main/index.ts`、
  `localDb/uiMockSeed.ts`。
- 单个组件的改动仍优先用 `pnpm ui:check`（几秒出全部场景截图）；`--mock` 用于需要完整
  主界面、真实路由和侧栏交互的检查。
- 外部工具的重复连接提醒在隔离 `--mock` 中只读取沙箱内
  `ui-mock/claude/.claude.json` 的 `mcpServers`，不读取真实 Claude Code 用户配置。
  可写入虚拟 HTTP/SSE 地址，再通过设置添加对应的 Cindy MCP，验证选择与持久化。
  该文件只用于设置页验收，真实 Agent 的连接装配仍按实际运行环境解析。
- 伙伴资料恢复：在隔离沙箱的 `ui-mock/companion-profile.json` 写入合成 JSON
  `{"soul":"…"}`，重启后从伙伴列表打开「资料恢复验收」。12001 个非空白字符
  展示资料校验失败，点击重试仍保留错误和云端记录；点击「修改资料并重试」，在真实表单里
  缩短到 12000 字符以内并保存，经真实 runtime、备份和本机资料写入入口恢复。
  此场景替换该合成伙伴的 Chat Server 传输，并预置合成主任务，不访问账号或服务器、不运行模型；
  资料校验、原文备份、资料写入、历史导入和恢复状态使用真实入口，更正同步回合成文件。
  删除该合成文件并重启即退出场景；再次验收时重写合成输入并重启。
  输入另加 `"failHistoryOnce":true` 可让恢复时第一次历史读取临时断开：保存更正失败后关闭表单，
  从原恢复入口重试应沿用已保存的更正并成功，不需要再次输入，原文仍只备份一次。
  输入另加 `"currentHome":true` 可预置未降级的本机伙伴，打开更正表单后可将沙箱内该伙伴的
  `SOUL.md` 临时设为只读，验证真实文件写入失败时表单保留草稿；解除只读后直接保存应成功。
  只对该合成文件施加故障，验收后恢复文件属性并关闭沙箱。

Desktop 群告警：隔离沙箱 `ui-mock/group-alert.json` 写入 `{"status":"waiting"}`，
重启后从群列表打开「群告警验收」。使用真实「结束分工」入口后，合成计划变为 stopped，
失败步骤仍保留，群行告警消失。将文件中的 `newFailure` 或 `pending` 设为 true，重新打开
主界面可分别检查另一执行失败和待决定状态；不发送消息、不运行模型。该场景只替换合成群的
服务输入，没有原执行 Session，真实服务器停止动作由生产服务入口回归测试覆盖。

同一文件加 `"composer":true` 可验收群聊发送快捷键：真实输入框、发送队列与话题面板照常运行，
该合成群的文字发送和话题回复由内存服务响应，不访问服务器或运行模型。消息只保留到本次
测试进程结束；不用于验证真实投递、附件或伙伴执行。

## Mobile 模拟器

自动化模拟记录包含发送前保存点超时和原始额度错误，分别打开任务
`ui-mock-rich-answer` / `visual-automation-unread`，在历史失败提示中展开错误详情，
检查原因传递后的文本与 Light / Dark 可读性；均为合成数据，不运行模型。

```bash
pnpm mobile:sim:start -- --mock
pnpm mobile:sim:whoami -- --mock --json
```

- 只换 JS bundle 的环境变量 `EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK=1`，不改原生指纹，已装的
  开发包可以直接用。
- 开关是 Metro 环境的一部分：在真实数据和模拟数据之间切换时，`sim:start` 会提示 Metro 是旧
  环境，加 `--takeover` 重启；`whoami` 不带相同的 `--mock` 会判定环境不一致。
- App 里是一台在线的模拟电脑和一台离线电脑，任务、消息、插件演示、文件浏览都由
  `apps/mobile/src/debug/visualMock.ts` 在内存里提供，写操作只在本次进程内生效，重启即还原。
- 项目设置：手机首页项目行右侧设置按钮使用真实设置页；名称、线性图标、Emoji、字母及上传图片保存在 mock 进程内存中（支持 profile 组合保存和按项目读取图片），返回列表即时显示，重启还原，不连接真实电脑。
- 模拟电脑支持协同：任务或新建任务的「+」面板 →「协同模式」可以直接打开开启协同的表单，角色清单
  （含添加、长按移除）读写的是模拟电脑上的那一份，只在本次进程内生效。
- 生效条件是开发构建（`__DEV__`）；正式包不包含这条路径。
- 复古皮肤：`cindy://retro-skin-preview`，可加 `?skin=thinkpad` 等已有外观标识以直接比较各款键盘；在折叠屏竖向半折叠姿态下，使用正式的外壳、键盘及窗口几何显示原生预览；按键事件仅显示在屏幕内，不连接远程电脑。用于检查屏幕边界、素材拼接及真实触摸反馈，不代表远程连接已验证。
- 设备画面连接页：`cindy://devices/desktop/cindy-visual-mock-mac?liveScreen=cindy-simulator%7Cpreview`。
  mock provider 保持远程桌面请求等待，真实页面展示连接中、等待较久及原有超时状态，供返回按钮与明暗主题截图；不连接真实电脑。
- 插件市场：插件页切到「插件市场」即读模拟电脑上的虚构 Demo 市场（`apps/mobile/src/debug/pluginMarketVisualFixture.ts`），
  走真实的分页、详情、确认面板与安装回执；Demo Glossary Translate 演示下载失败，Demo Uncertain Sync 演示结果待确认（安装后
  离开插件页再回来，或在「安装到」切到另一台电脑，顶部一直有待核实提示，「查看」打开记录面板：核实结果、不再跟踪；
  配合 `market=lateConsent` 它在 begin 回包丢失、第一次查询协议错误后交给记录，核实时出现「电脑正在等你确认 · 查看并决定」；
  `market=lateResult` 核实出成功并出现「打开」；`market=unreadResult` 核实出成功但第一次已装读取失败，出现「重新读取」），
  Demo Notes 是同标识冲突。确认面板的对照：Demo Device Simulator（官方，有高风险 `node:execute`）、Demo Agenda
  （官方，无高风险）、Demo Shift Calendar（社区，回执带 `communityMarket`）、Demo Repo Tools（Demo Git Market 自定义市场，
  可正常安装，有高风险，确认面板显示仓库 github.com/demo-org/demo-git-market）、Demo Auto Agent（官方，没有 Node，但有后台 Agent 与派活取件两项高风险）、
  Demo Vault Bridge（官方，五类高风险同时出现：Node 常驻、4 个凭证绑定（每个 16 个方法，摘要合成一行）、运行 Node 程序、后台 Agent、派活取件，用来看高风险摘要的高度上限和滚动区里的完整方法列表）、
  Demo Legacy Tools（Demo Legacy Market，模拟不提供仓库身份的旧 Host：行内与详情的「安装」不可点并说明原因）、
  Demo Long Repository Tools（长仓库名带 ref 的自定义市场，五类高风险同时出现，看仓库一行与固定摘要的换行）、
  Demo Folder Tools（本地文件夹市场，确认面板显示「本地文件夹」）。已安装列表里预置
  Demo Weather Board、Demo Secret Sync、Demo Vault Upgrade、Demo Moved Source、Demo Moved Folder、Demo Moved Long Repository、Demo Reading List 与 Demo Legacy Sync 的 1.3.0，详情里「管理插件 → 更新到 v版本」会出现更新确认：
  Weather Board 新增运行 Node 程序、Secret Sync 已有 Node 只新增凭证绑定（两者都显示高风险固定段）、Vault Upgrade 是升级版的极端情况（新增五类高风险、
  4 个凭证绑定 × 16 个方法）、Moved Source 的升级来源与已装实例不同（回执带 `originSourceChanged`，按首装给出完整权限，含两类高风险；Git 来源，提示句请用户核对上面显示的仓库）、
  Moved Folder 是本地文件夹市场的同类换源（不显示仓库，提示句不提仓库）、Moved Long Repository 用来稳定触发确认面板紧凑档（长仓库名带 ref、换来源提示、五类高风险；
  在最矮屏加最大辅助字号下更新它，应为一个滚动区加固定按钮，打开时第一屏是身份块开头）、Reading List 只新增通知
  （没有固定段）、Legacy Sync 来自旧 Host 的自定义市场（没有来源，手机上不能更新：已装详情点「更新到 v版本」后提示先在电脑上更新 Cindy 并刷新市场、仍不行就在电脑上更新这个插件）。
  市场详情与电脑一致：Demo Shift Calendar（公开的社区作者插件）显示社区声明、不显示作者；官方插件的「来源」为「公开市场」，团队共享插件为「组织」，
  版本带 v。
  整页状态用 `cindy://plugins?market=<场景>`：`outdated`（电脑版本太旧）、`unavailable`、
  `organization`、`customPartial`、`empty`、`readFailed`（首次读取失败，重试恢复；同一深链重发不重新造失败。要看列表的「重试」按钮，重载 App 后直接进这个场景；先 `normal` 再 `readFailed` 时列表已经读到，只有下拉刷新才失败，表现是保留列表并加一行「未能读取插件市场」、没有按钮，再下拉一次提示消失）、`twoComputers`（多一台在线的
  CINDY Second Mock Mac，可在「安装到」里切换）、`offline`（离线模拟电脑变成可选且不应答，选中后显示离线状态）、
  `hold`（确认后的安装、更新一直停在「进行中」，不自动完成：用于截「进行中时其它入口不可用、顶部提示可见」，例如 iPad 宽屏
  打开 Demo Weather Board 详情点「更新到 v版本」并允许，再在旁边切到市场；换回 `normal` 后下一次查询即完成），
  `normal` 回到默认。插件页已打开时再发带不同 `market` 参数的深链，场景已经切换，但要在插件页下拉刷新一次
  才会重新读取（twoComputers / offline 改的是电脑列表，同样下拉刷新）。
  装好或升级后的 Demo 插件只在本次进程内保留，可在详情里卸载；不连接真实电脑或市场。
- 插件页待核实记录与管理提示，状态 → 入口（开发构建，打开即处于该态，不依赖时序或手速）：

  | 状态 | 入口 |
  | --- | --- |
  | 进行中（顶部「…操作还没结束」） | `cindy://plugins?checks=running` |
  | 结果待核实（「核实结果」可点） | `cindy://plugins?checks=waiting` |
  | 待核实 + 电脑离线（「核实结果」不可点并写原因） | `cindy://plugins?checks=offline`（记录在不在账号列表里的 CINDY Away Mock Mac 上） |
  | 电脑正在等你确认（「查看并决定」） | `cindy://plugins?checks=awaitingYou` |
  | 成功 + 打开 | `cindy://plugins?checks=succeeded` |
  | 成功但实例未核实（「重新读取」） | `cindy://plugins?checks=unread` |
  | 失败 | `cindy://plugins?checks=failed` |
  | 已不再跟踪 | `cindy://plugins?checks=untracked` |
  | 多条记录（「2 项插件操作还没结束」） | `cindy://plugins?checks=many` |
  | 成功，正在确认电脑上的插件（「已完成，正在确认电脑上的插件…」） | `cindy://plugins?checks=readingBack`（之后的已装读取一直不回） |
  | 成功，但插件之后又有变化（未能证实，没有「打开」） | `cindy://plugins?checks=changed`（提交后模拟电脑换成同一插件的旧版本，记录 `unattributed`；形状不完全贴合真实 Host：真实电脑上从本地文件装旧版本可能落到 `conflict`，结论同样是不打开） |
  | 已卸载 | `cindy://plugins?checks=uninstalled`（Demo Weather Board 的卸载） |
  | 「查看并决定」被占用挡住（说明要等另一项结束） | `cindy://plugins?checks=decideBlocked`，列表里两条：点 Demo Agenda 的「查看并决定」（Demo Device Simulator 正在同一台电脑上安装；电脑在 Simulator 拿到位置之后才回答 Agenda 的确认，页面中途的查询不会让 Agenda 先拿回位置） |
  | 卸载回执过期，无法确认（显示还装着、只有「不再跟踪」） | `cindy://plugins?checks=unprovableUninstall`（面板打开后自动核实一次即出现） |
  | 更新完成且回执过期后核实（「已安装」+ 打开） | `cindy://plugins?checks=updateGone`（Demo Reading List 的更新） |
  | 成功，但未能证实（本机换装同版本，`unattributed`，没有「打开」） | `cindy://plugins?checks=reinstalled` |
  | 成功，但电脑端版本较旧（两个归属字段都没有，没有「打开」，有「去已安装」） | `cindy://plugins?checks=legacyHost` |
  | 成功，但电脑上现在没有这个插件（之后被卸载） | `cindy://plugins?checks=goneSince` |
  | 成功，只推进了目录版本（条目「可更新」，`self` ＋ 原号，仍可「打开」） | `cindy://plugins?checks=catalogAhead` |
  | 确认与选择不一致（只能拒绝） | 没有模拟入口：模拟电脑的确认都与所选一致（`pluginMarketVisualFixture.test.ts` 逐场景核对）；组件测试覆盖 |
  | 来源变化（更新预检） | `cindy://plugins?market=updateSourceChanged`，已安装里 Demo Moved Source 详情「管理插件 → 更新到 v版本」 |
  | 版本变化（更新预检） | `cindy://plugins?market=updateReleaseChanged`，已安装里 Demo Weather Board 详情「更新到 v版本」 |
  | 读取失败（更新预检） | `cindy://plugins?market=updateReadFailed`，同上 |
  | 市场安装成功但没能读取（「已完成，但没能读取」，交给记录列表） | `cindy://plugins?market=readbackFailed`，在市场里安装任一未装插件并允许：装好后紧接着的三次已装读取失败，市场行以「已完成，但没能读取」结束，顶部提示与记录面板列出这条（「重新读取」）；点「重新读取」后读到，面板里显示「已完成」与「打开」（要再截先发 `market=normal` 再发这个） |
  | 市场详情读取失败（「重试」） | `cindy://plugins?market=detailReadFailed`，打开任一未装插件的市场详情（每个插件第一次读取失败，「重试」后正常；同一深链再发一次不重新造失败，要再截失败先发 `market=normal` 再发这个） |
  | 在电脑上完成配置 | 没有界面入口：已装详情的状态行只提供「连接电脑」「重试」（主干现状），`settings` 分支的这句提示点不到；`preview=1`（Missing API key）只显示状态 |
  | 进行中停住（其它入口不可用） | `cindy://plugins?market=hold`，安装或更新并允许后停在「进行中」 |
  | 资料值折两行 | 市场里 Demo Long Repository Tools 详情的「作者」 |

  `checks=` 用真实 controller 在模拟电脑上发起操作（按操作号预设回答），交给待核实记录后打开记录面板；每次都从模拟电脑的初始
  状态开始（已装插件复原、没有操作）。成功、读取失败、失败、不再跟踪、已卸载、无法确认、更新回执过期这几态在面板打开后才发生，面板里看得到
  结束的那一条。模拟电脑的市场记录按契约 V2.10 给归属：这台手机远程装的是 `self` 加操作号，其余已装的是 `unattributed`，`checks=legacyHost`
  之后按旧 Host 两个字段都不给。任务设置保存、页面批准两个入口的模拟数据
  还没有（只有组件测试）。
- 邮件阅读页：`cindy://mail-preview?deviceId=cindy-visual-mock-mac&sessionId=visual-running&url=<编码后的地址>`，
  地址取 `apps/mobile/src/debug/mailVisualFixture.ts` 的 `VISUAL_MAIL_URLS`（宽版营销邮件、三封往来邮件），均为合成数据。
- 写邮件卡片：`cindy://sessions/visual-mail-draft?deviceId=cindy-visual-mock-mac`（仅手机端的模拟任务，含一张回复草稿卡）。
- Agent 安装插件确认卡：`cindy://sessions/visual-plugin-install-card?deviceId=cindy-visual-mock-mac`，与 Host
  `buildGhostInstallConsentInteraction` 同形的 `cindy.plugin.install` 卡（自定义市场首装、长仓库名带 ref），看仓库一行、
  展开详情不显示原始来源字段；允许或拒绝后卡片消失，不连接真实电脑。缺来源的同类卡：
  `cindy://sessions/visual-plugin-install-card-unverified?deviceId=cindy-visual-mock-mac`（自定义市场、卡上没有 `source`，
  只能拒绝，并说明在电脑上处理）。
- 反馈确认：`cindy://sessions/visual-issue-confirm?deviceId=cindy-visual-mock-mac`，合成反馈草稿、署名与环境，覆盖预览、编辑和展开详情；不提交。Desktop 对应 `pnpm ui:check --page issue-confirm --case all --theme all`，两端均加载实际组件。
- 代输入：`cindy://sessions/visual-input-handoff?deviceId=cindy-visual-mock-mac`，一条英文的电脑 App 登录请求（长目的、Agent 补充、邮箱与密码），点「填写」打开实际的 iOS 原生面板；用于在 iPhone Duo 折叠／展开、短屏与常规机型上检查对齐和高度。合成数据，「继续」不会提交到任何电脑。
- 群聊点名：`cindy://companions/groups/mention-qa?deviceId=cindy-visual-mock-mac`，合成成员覆盖显式身份、唯一名称回退、重名、未知及群体提及。沿用实际群聊组件与成员身份 sheet，只用于界面验收；话题入口另由直连 Chat Server 的组件回归覆盖。
- 群列表告警：模拟电脑的伙伴群列表包含「已结束分工」「另一执行失败」「仍需回复」三行，
  由真实共享状态判据生成无提醒、错误、待回复状态，验证失败历史不等于仍需处理。只用于列表目检。

- 群内执行：`cindy://companions/groups/execution-qa?deviceId=cindy-visual-mock-mac`；后缀 `-work`／`-talk` 查看长分工与讨论队列，`-member`／`-legacy` 查看普通成员与旧宿主的默认停止，`-peer` 查看无操作权限的群友仍可见的公共 Cindy 消息与两条独立执行。仅合成内存回执，不访问真实权限或模型。
- 窄屏正文：`cindy://group-execution-preview?width=320&groupId=execution-qa`（`width` 可选 `393`）。复用真实群聊页，把正文容器限宽；设备窗口、系统安全区和原生导航栏仍取当前模拟器，不将它当作另一机型的整屏验收。

## 可复用的展示项目：Orbit Garden

共享目录现在包含 `orbit-garden-zh` / `orbit-garden-en`：同一个虚构独立游戏的中英文
演示项目。数据定义在 `packages/maker-shared/src/uiMockShowcase.ts`，原有边界/异常回归
任务保持不变。用现有 `--mock` 入口即可加载，不需要导入个人聊天或访问真实账号。

| 场景 ID 后缀（前缀 `ui-mock-showcase-`） | 内容                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| `feedback-zh` / `feedback-en`            | 240 条合成反馈、四轮引导完成率、图表与复盘报告        |
| `plan-zh` / `plan-en`                    | 可调人数/范围，实时计算工作量和制作天数；没有发送动作 |
| `review-zh` / `review-en`                | 合成代码审查场景，明确不是实际测试结果                |
| `release-zh` / `release-en`              | 未发送的试玩邀请草稿                                  |

项目中的 `data/feedback.csv`、`data/completion.csv`、`reports/playtest.md` 与
`plans/next-build.md` 和回答使用同一组数字。Desktop 创建这些小文件；Mobile 的 mock
文件浏览通道读取同一目录，支持子目录、预览和搜索。两端仍是独立回放，**不代表已验证
真实设备同步、远程桌面或 Agent 执行**。

Mobile 只对 `UI_MOCK_SHOWCASE_PROJECTS` 中的展示项目启用这套文件读取；旧的
`cindy-demo`、`design-system` 保留原有 Markdown 长文、翻页文件与媒体缩略图回归场景。

建议截图分工：桌面显示任务＋回答＋文件侧栏；笔记本聚焦回答；手机显示单栏；Duo 用真实
展开布局显示任务与回答。不要裁掉错误提示后把结果当作验证通过，也不要将屏幕拉伸成
另一种设备的布局。网页标注「真实界面 · 示例数据」。

复用时记录源码版本/dirty 标识、场景 ID、区域、语言、主题、窗口尺寸或模拟器 UDID。
切换界面语言不会翻译消息，需选择对应语言的任务。Desktop seed 不覆盖已有内容；修改
文案后使用新的专用沙箱，不清空他人常用开发环境。截图只导航/查看/调整本地控件，不点
发送；Desktop `--mock` 不是阻止真实模型调用的防火墙。

数字与富回答协议回归：`packages/maker-shared/src/__tests__/uiMockShowcase.test.ts`。
手机文件一致性回归：`apps/mobile/src/__tests__/visualMock.test.ts`。

## 数据边界

手机 B2B 回归入口（仅 `--mock`）：
`cindy://sessions/visual-teammate-b2b?deviceId=cindy-visual-mock-mac&resourceCollectionId=teammates&resourceKind=bot&resourceId=visual-bot-b2b`。
该合成场景按收件、处理工具、发件、主人后续回复排列，内部助手正文 `B2B-INTERNAL-HIDDEN` 必须不可见；
收发入口与处理记录沿正文左侧对齐，入口可打开两条完整往来并返回。用于 iOS/Android 真实界面及交互验收，
不代表已验证真实设备同步或 APNs/FCM 送达。

- 模拟数据只用于开发与界面验收，不进安装包逻辑，不上传，不触发真实 Agent。
- 不在模拟数据里放真实姓名、邮箱、路径或聊天内容；要用真实数据预览手机界面时用
  `apps/mobile/scripts/export-realdata-visual-snapshot.mjs`，它导出的是敏感数据，按脚本
  里的限制使用。
- PR 截图来自模拟数据时要写明，不能当作真实账号、真实 Agent 行为已验证的证据。

空响应暂停回归场景 `ui-mock-silent-stop`（「空响应续跑暂停」）由两端共用，包含预算、频控、任务保护及两种派发失败的历史错误和尾部错误。主提示应保持中性，展开详情可见实际原因；点击诊断仅检查预填内容，不发送消息。
