# Cindy 设置的 Agent 控制覆盖

状态：本分支实现与核查结果，2026-11-04；不代表已发布或所有设置已开放。

用户要求配置 Cindy 时，Agent 应先发现原生能力，不能因接口没有暴露而直接假定需要桌面操作。
权限档决定一次操作是否获准；提高权限不会生成尚未实现的接口。本变更不增加“AI 全开”开关。

## 入口与当前作用范围

第一步直接用 `cindy_helper.list_tools({query:"伙伴模型"})` 搜索；`{key:"appearance.wallpaper"}`
读取单项，`{name:"update_app_settings"}` 只读查询已发现操作的完整参数。原来的
`list_tools({category:"settings"})` 保留。普通任务与伙伴、三种 Harness 共用宿主服务。

`get_capabilities({scope:"control"})` 返回 14 个领域；`category` 浏览领域、`toolQuery` 搜索、
`key` 读详情、`operation` 只展开某一操作 schema、`cursor` 继续同一查询。搜索每页 5 条；
不能换身份或查询条件复用游标。目录说明会分别返回 `available`、`not_exposed`、
`unavailable_in_context` 等状态，不能把缺接口包装成没有权限。已注册但尚未整理成专题的
helper 操作仍可通过 `native.<tool-name>` 搜索，新增工具不依赖再次添加常驻提示。

Pi 先 `cindy_mcp_list_tools({server:"cindy_helper",tool:"list_tools"})`，再经
`cindy_mcp_call_tool` 执行返回的入口；调用 `call_tool` 前也按 Pi 原披露规则发现该 schema。
不绕过原权限与工具定义变更检查。完整说明不注入每轮上下文。
`list_app_settings` 返回实际已注册分类，`get_app_settings` 返回当前值及严格 schema，
`update_app_settings` 只改指定字段；支持整组恢复的分类才声明 `reset_app_settings`。
接口沿用原设置的默认值与覆盖存储，不建立第二份配置文件。

这批接口控制**运行任务的电脑**。手机远程继续该电脑上的任务可使用同一工具；并非修改手机
自身偏好。SSH 上执行的任务不暴露本机桌面设置入口，也尚无跨电脑 `device` 转发参数。
群成员、共享访客及伙伴自主行动继续受现有身份与任务授权约束。不给任意 IPC 或任意存储键入口。

## 已实现的直接控制

| 分类 / 工具 | 字段或操作 | 生效与恢复 |
| --- | --- | --- |
| `preferences` | 语言、明暗主题、主题家族、通知、发送快捷键、网页/本地链接打开方式、流式动效、消息导航、忽略目录显示、首页用量、输入建议 | 复用 Renderer 原 setter，保存并回读，立即生效；无整组 reset |
| `appearance` | 界面/代码/终端字体与字号、窗口缩放、内置壁纸、遮罩/可见度/模糊/动效 | 原外观持久化与广播；reset 删除原覆盖；不返回自定义壁纸资产 URL |
| `git-safety` | `mode`：关闭/已有 Git 项目/所有项目 | 下一轮；reset 跟随原默认 |
| `goal-defaults` | 轮数、token 预算、无进展轮数 | 以后启动的目标；null 不限；reset 删除覆盖 |
| `agent-resources` | 命令并发、进程优先级、工具链限线程 | 使用原资源设置；恢复 normal 对新进程生效；reset 删除覆盖 |
| `memory` | Cindy、Claude Code、Codex、Pi 记忆开关 | 复用忙碌时延迟生效；reset 只恢复开关，不删除记忆；Cindy 记忆接管时沿用原生开关互斥规则 |
| `subagent-models` | Claude 子代理模型与来源、Codex 智能调配 | 保留原生软重启/空闲应用逻辑；reset 删除覆盖 |
| `auxiliary-models` | 辅助模型优先与两级备用 | 使用原候选校验；空数组/reset 跟随自动选择 |
| `vision-bridge` | 总开关、目标模型、主/备用视觉模型 | 下一请求；reset 删除覆盖 |
| `get_app_default_model` / `set_app_default_model` | 默认模型、思考深度、Fast/Ultrafast | 可用目录校验并等待真实选择器保存回执；用于新任务，不替换当前运行任务 |
| `list_model_providers` | 全量安全模型目录、顺序、停用状态与显示覆盖 | 包含已关闭型号；不返回凭证 |
| `get_model_configuration` / `set_model_configuration` | 单模型选择器显示、上下文上限、压缩比例、图片输入、价格估算 | 与设置页同一服务；null 删除对应覆盖；价格只影响本地估算 |
| `configure_model_provider` | 改名、排序、停用/启用来源或型号、恢复默认开关、重新发现 | 组织管理与连接状态校验不变；remove/restore 仅管理已断开内置来源展示，不删除自定义连接或凭证 |
| `get_pi_runtime` / `update_pi_runtime` | 托管 Pi 版本/检查/准确版本安装 | 与设置页共用 PiKernelManager；不修改 PATH Pi，不重启 Cindy；在途进程不变，失败重新读状态 |
| `ssh_update_host` / `ssh_remove_host` | SSH 显示名、连接字段、移除托管连接 | 显示名不改 alias/连接/关联任务；只传变化字段；私钥保持在宿主；连接字段/删除沿用配置归属与任务引用检查；列表即时同步 |

## 设置页完整模块盘点

核查起点为 `settingsSearchCatalog.ts` 自动收集的 31 个 `*.settings-search.ts` 模块，
并查看实际设置组件的操作。以下是模块覆盖清单，**不是所有操作都已实现的声明**。
“缺接口”表示当前通用设置工具未接通，不能解释为不允许 Agent 做。

| 设置模块 | 本次或已有入口 | 仍缺的直接设置控制 |
| --- | --- | --- |
| GeneralSettings | 语言/通知/发送行为/资源/Git 设置已接通；伙伴使用已有伙伴工具 | 用户资料、窗口行为、实验项、新任务默认权限等未纳入通用写接口 |
| NotificationSection | `preferences.notifications` | 无新增缺口（系统通知授权另走系统） |
| WindowBehaviorSection | 无通用接口 | 保持唤醒、开机启动、菜单栏、关闭窗口行为、激活点击 |
| AgentResourceSection | `agent-resources` | 无新增缺口 |
| GitSafetySection | `git-safety` | 无新增缺口 |
| CollaborationSection | 已有协同执行工具不等于设置控制 | Worker 软/硬限制、空闲释放配置 |
| AppearanceSection | `preferences` + `appearance` | 导入自定义壁纸/本地主题、侧栏卡片/主列表模式 |
| PersonalizationSettings | 记忆、子代理、辅助模型、视觉桥、链接、建议已接通 | 用户提示词、终端 Shell |
| PersonalizationDetails | `preferences`、`memory`、`auxiliary-models` | 终端 Shell、兼容相关设置 |
| SubagentModelSection | `subagent-models` | 无新增缺口 |
| VisionBridgeSection | `vision-bridge` | 无新增缺口 |
| TipsSection | `preferences.promptRecommendations` | 无新增缺口 |
| ProvidersSection | 默认模型、模型目录/参数、供应商展示管理 | 新建/编辑/删除自定义连接、各供应商专属选项、组与分享管理仍需各自正式接口；登录输入走安全授权，不把密钥交模型 |
| LocalAgentSection | 既有连接/授权流程保持 | 本地模型安装、移除、运行参数等未接入本批设置工具 |
| RemoteControlSection | SSH 增/查/改/删/重读原生入口；已有设备查询/控制 | 远控总开关、中转配置、设备管理、SSH Agent Proxy/自动连接/远端 Agent 安装未接入本批设置工具 |
| BuiltinToolsSection | 已有 `request_mcp_setup` 打开同一 MCP 表单 | 通用内建工具开关、MCP 编辑/删除/全局启停仍缺直接适配 |
| ComputerUseSection | 已有能力发现/权限引导 | 浏览器、直控、Android 设置未接通；系统录屏/辅助功能授权仍需原生流程 |
| KeyboardShortcutsSection | 发送快捷键已接通 | 其它快捷键、配件映射 |
| VoiceInputSection | 无通用接口 | 语言、麦克风、润色/词典、静音/提示音、历史、快启、说话人过滤、快捷键 |
| AgentIslandSection | 无通用接口 | 开关、显示、皮肤、声音 |
| ImBotSection | 已有 `connect_account` 等连接流程、伙伴能力工具 | 各渠道全局配置与生命周期开关未由本批通用接口覆盖 |
| SessionImportSection | 已有扫描/导入工具 | 本批未新增导入器设置 |
| SettingsCatalogPanel | 已有插件工具独立管理 | 插件设置不并入任意配置键写入；按插件实际能力发现 |
| SharedTasks | 已有共享任务界面/身份规则 | 共享管理未由本批通用设置接口覆盖 |
| CindyMakeSection | 原有能力保持 | Maker 设置未纳入本批 |
| BillingSettings | 原账户/计费流程 | 充值/订阅等不由本批通用设置代为提交 |
| UsageHistorySection | 原用量查询保持 | 导出/历史管理未纳入本批 |
| StorageManagementCard | 原存储管理保持 | 清理/回收、数据库整理与告警阈值未接通 |
| WorktreeRecycleCard | 原回收机制保持 | 回收策略设置未接通 |
| AboutSection | 已有 `check_app_update` / `install_app_update` | 已有 `set_app_auto_update`；分析/调试日志开关、上报设置未接通 |
| HelpSection | 已有 `get_capabilities scope=help` | 以帮助查询为主，无新增配置 |

上述缺口未因这次基础设施接入自动完成；跨电脑设置转发与手机本地设置也未完成。
后续接通应继续复用各功能的保存/校验/通知链路，不退回修改 JSON 或点屏幕冒充原生管理。

## 验证记录

- 真实 MCP 客户端验证三 Harness 的发现、参数拒绝和受限访客拒绝；SSH 返回不带密钥。
- Desktop 定向测试 471 项、MCP 83 项通过；涵盖原模型服务、默认模型、SSH 生命周期与新设置服务。
- Desktop 与 MCP TypeScript 检查通过。
- 独立隔离 Desktop 实测：语言、主题、通知、链接、动效、字号保存并同步；重启后值保持。
- 原生模型服务实测：上下文上限修改/清除、模型停用/恢复、选择器隐藏/恢复、默认模型/思考/Fast 保存回读。
- 原生 SSH 服务实测：修改既有主机显示名，连接身份与地址未变，恢复原名成功；不连接或更改远端机器。
- 未在正式宿主安装本分支；没有为验收修改生产配置。手机仅消费同一电脑任务的工具，本次未实测 iOS/Android 客户端；未宣称手机本地设置已开放。


## 按需控制目录的实现边界

本次增加的是可查询的入口、原生操作绑定和 Pi 管理接线。目录包含伙伴、自动化、例行任务等
独立界面，但不等于任意普通任务已经拥有任意伙伴的资料写入口。返回的作用对象以原工具
schema 为准；当前伙伴工具不伪装成任意 botId 接口。

全产品字段迁移、跨设备统一 target、手机本地设置、文件草稿事务、统一 revision/CAS 与
撤销记录仍是完整设计中的未实施部分。本目录不承诺全局事务，也不把 reset 当撤销。
所有未接通领域继续列在上面的覆盖清单，不能声称全产品配置已统一完成。

新增回归通过真实 MCP 传输验证查询→详情→schema→保存、查询无副作用、访客拒绝、
无效游标、显式缺口；真实 Pi 二进制接真实 helper 服务验证两层网关和原审批身份。
该 Pi 测试使用脚本化模型响应，证明调用链可达，不证明模型每次都会自主选择该工具。

本轮最终验收（2026-11-04）：MCP 150 项、Desktop 374 项、真实 Pi 网关 1 项通过；
Desktop/MCP/maker-core 类型检查、相关 ESLint、文档与测试卫生检查通过。真实 Codex
首用只给自然语言需求，第一步主动调用 helper query，8 次工具调用均属 helper，未操作
桌面或写入设置。隔离版原生 helper 修改壁纸/字号并回读、拒绝非法值、完整恢复原状态；
Pi 管理入口读得托管版本 1.4.0，未实际安装升级。临时任务已关闭归档，测试实例正常退出。

伙伴核心说明同步（2026-11-04）：能力面板保持五项，任务摘要说明控制范围与跨电脑前查询，
「了解与设置 Cindy」概括设置控制，不逐项列字段或增加开关。Desktop 12 语种及远程资源摘要同步。
核心把设置操作导向 helper query，界面帮助保留 help；任务细节不再把全部控制误写成仅限自己开启的任务。
核心正文默认 4537→4533 字符，共享原文 4618→4614；无 helper 的变体不变。
没有新增预加载、设备扫描、轮询、网络调用或模型调用逻辑，拼接本地微基准前后约 0.0012 ms/次。
伙伴相关 57 项、helper 44 项回归通过，Desktop 类型检查及 i18n/术语/文档/相关 ESLint 通过。
核心页中英文 × 深浅色 × 两种宽度共 8 项单页检查通过；隔离 Desktop 真实打开能力→核心页→原文，
确认摘要和按需入口均已加载。手机未单独实机目检，远程资源内容通过原 handler 回归；没有新增测试记录。

送审前同步主干后补验（2026-11-04）：Desktop 11 个相关文件 438 项、MCP 3 个文件
150 项通过，包含主干新增的壁纸缓存/读取/通知回归；无冲突。前述未受影响的真实运行证据继续有效。
本 PR 仅保留功能覆盖与验证记录，helper 类设置的长期规范按用户要求在本 PR 合并后另行提交。

Review 修复验收（2026-11-04）：preferences 目录不再声明整组 reset；真实 helper 读到的操作
仅 get/update。组合 memory 修改先保存同一请求的 native 最终值，Codex 热推只进入既有
空闲回调。隔离 Desktop 实际运行 Codex 时提交 maker:false/codex:false：保存值 false、
回执 codexRestartDeferred=true、忙碌时运行值仍 true；任务完成后运行值 false，与存储一致。
随后 reset 恢复原四个开关及空覆盖标记，复用的临时任务关闭归档，未创建新任务或伙伴。
