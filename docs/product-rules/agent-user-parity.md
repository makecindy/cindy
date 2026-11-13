# Agent 与用户同权：工具能力不以「Agent 不该做」为由少给

2026-10-14 裁决。用户本人能对自己的任务、定时任务、项目、伙伴做的操作，Agent 也要有对应工具，
包括操作用户另一台电脑上的数据。

## 规则

- **能力全面放开**：用户在桌面、手机或远程控制里能做的，Agent 工具也能做。不再因为
  「这件事不该让 Agent 做」而不提供工具，或只提供本机版本。
- **限制放在别的维度**：能不能执行由任务的权限档决定——bypass 完全不限制；自动审核（Auto）
  主要依赖 AI 审阅。不在工具层另加一道「Agent 专用」的收窄。
- **不在放开范围内**：群成员、共享任务访客等「不是用户本人」的身份，沿用各自规则里的既有边界
  （见 [`shared-task-mode.md`](shared-task-mode.md)、[`bot-group-chat.md`](bot-group-chat.md)、
  [`cindy-bots-runtime.md`](cindy-bots-runtime.md)）。
- **插件任务**：插件创建的任务及 Worker 按普通任务权限使用工具；创建来源不改变 Agent 的工具权限，
  插件消息标签不额外设限。原本要求用户当场输入的操作仍按通用规则判断。插件直接调用的 `cindy.tasks` 仍限自己的任务。
- **第一时间能发现**：Agent 在工具索引的第一步（类目总览）就要看到每类工具的用途和作用范围
  （本机 / 可跨电脑）。工具说明写清作用范围，不用「所有」「全部」这类看不出边界的说法。
  只查了本机时，结果要自带「仅本机」，不能让 Agent 把「本机没有」读成「哪台电脑都没有」。

## 新建任务的项目归属（2026-10-30）

2026-11-11：`device` 指向另一台电脑时，项目、目录及默认模型在目标电脑解析；不继承来源电脑的项目路径。用 `list_projects(device)` 选目标项目；未选项目时仅按目标 `working_dir` 匹配已有项目，否则不绑项目。下述来源继承规则适用于本机创建。

Agent 新建普通独立任务（`send_to_session` create；伙伴专用的 `start_session_task` 已于 2026-11-08 移除）省略
`project_path` 时继承来源任务的项目。来源不绑项目时（伙伴的对话都属于这一类），
`working_dir` 落在某个已登记、可见且目录存在的项目里，就归到最近的那个项目，否则新任务
也不绑项目（2026-11-10：此前一律不绑项目，伙伴在项目仓库里开出的任务全部落在项目外）。
这一步只匹配已有项目，已移除或目录不存在的项目跳过并继续向上找；回执的 `project_note`
说明归属由执行目录决定或任务未绑项目，以及下次怎样指定。
显式传路径则选择当前电脑已登记、可见且目录存在的项目，传 `null` 则明确创建不绑项目的任务。
可用 `get_current_session_id.project_path` 自省归属，用 `list_projects` 选择其他项目。
自省实时读取任务归属，与侧栏分组一致；执行目录不会变成新项目，也不自动登记或恢复项目。
无法确定来源归属或项目无效时，在创建任务、worktree 和发送首条消息之前拒绝。
新增或恢复项目由 `create_project` 显式完成；不能用执行目录隐式登记或恢复项目。

`working_dir` 独立表示执行目录，缺省为所选或继承的项目；不绑项目时分配独立托管目录。
不绑项目也可以显式指定执行目录；此时使用 `use_worktree` 必须指定 Git 仓库目录。
仓库子目录、临时目录、worktree
都不改变已指定或继承的项目归属；复制、续跑保留归属，桌面、手机、搜索按同一归属分组，
灵动岛与菜单栏卡片也按该归属显示项目名（含远程任务）。
旧任务缺少显式归属时继续使用原目录规则，不自动清理用户已有项目。

## 仓库自动任务导入（2026-11-01）

从 `.cindy/automations/schedules.json` 发现的新配置或变更先展示，用户确认当前文件内容后才应用。
启动扫描、手动重新加载均遵守这个边界；文件缺失或损坏不自动删除已保存的自动任务。
界面主动保存只应用正在编辑的一条，不顺带导入其他配置；Agent 通过定时任务工具创建、修改
仍沿用现有权限流程，不因这项导入确认增加限制。已保存的自动任务继续按保存内容运行，
不因升级要求重新确认。仓库文件不构成后续任意修改的持续授权。
导入发现与确认只在主窗口提供，副窗口与独立侧栏不重复发起。多个待导入项目共用一条提示，
取消或失败后保留入口并轮到下一个项目，避免占满全局通知队列。

## 跨电脑的统一口径

- 数据保存在各自的电脑上。跨电脑一律走用户远程控制的同一条通道与授权：同一账号、对方在线、
  双方都开启了远程控制；被撤销授权的设备不可用。
- 默认仍是本机，跨电脑要显式指定（`device` 参数，或 `deviceId::` 前缀的 id）。
- 跨电脑的写操作（改动另一台电脑上的定时任务、给另一台电脑上的任务发消息）交给当前任务的
  权限档：Full Access 不拦，Auto 走统一审阅，Ask 由用户确认。它们不走第一方工具的静默放行——
  改定时任务能改写并触发那台电脑上的命令，不能让本机一次被注入的调用悄悄越到别的电脑。
  本机操作与跨电脑读取保持原样。（伙伴自主轮的额外风险确认卡已于 2026-11-08 随伙伴专属权限门移除，
  见 [伙伴的来源与操作权限](teammate-authority.md)。）
- 查多台电脑时结果按电脑分组；离线、未开启、版本不支持、超时的电脑逐台写明原因，
  有电脑没查到时标 `partial`，不得据此断言「不存在」。
- 对方电脑版本较旧、不支持某项操作时明确说不支持，不静默失败，也不退回成别的行为。
- 写操作没有收到回执时如实说明「可能已生效」，由 Agent 先查再决定是否重试；工具不自动重发。
- 跨电脑请求会像用户打开远程控制一样与目标电脑建立连接。
- Agent 发到另一台电脑任务里的消息，按 [`message-source.md`](message-source.md) 标明来自哪个任务，
  界面标签与发给模型的说明一致。

## 现状台账

Cindy 应用更新（2026-11-11）：`list_tools({query:"更新 Cindy"})`（含中英文更新／升级说法）
可发现 `application.update`，详情列出当前任务实际可用的检查与安装操作。安装仍由本机宿主
确认并执行；没有安装工具时明确列为缺失，并提示在运行 Cindy 的电脑上使用设置中的
“检查更新”。步骤与不可用时的处理写在工具说明及回执，不再占用所有任务的 system prompt。

「跨电脑」一列写 Agent 工具的现状，不是用户界面的现状。改动对应能力时把这张表写回去。

| 对象     | 操作                                                       | 本机 | 跨电脑           |
| -------- | ---------------------------------------------------------- | ---- | ---------------- |
| 模型目录 | `configure_model_provider` 的 `rediscover`：内置供应商复用设置页真实刷新，等待发现完成后返回目录 | 有（2026-11-10；Claude 订阅通过内置 CLI 的 SDK 发现） | 在执行电脑的任务中调用；同账号远控 UI 复用原有刷新 IPC |
| 模型供应商 | `configure_model_connection`：查询预设、读取／添加／编辑／删除 API 与免密本机连接、安全填写或更换密钥、发现与设置型号、验证连接 | 有（2026-11-07；复用设置页事务，保存、目录获取与推理验证分别报告） | 在执行电脑的任务中调用；手机及同账号电脑沿原有加密代输入卡填写密钥，不支持指定另一台电脑或 SSH |
| 订阅账号 | `configure_model_provider` 的 `subscriptionAccounts`：查看、官方 CLI 登录、暂停、限额、权重与调度策略 | 有（Claude / Codex，同供应商内多账号） | 工具按目标电脑的本机任务执行；同账号远控 UI 复用管理 IPC |
| 任务     | 列出、搜索、读聊天记录、发现电脑                           | 有   | 有               |
| 任务与伙伴 | `list_sessions` 返回隐藏状态；`list_teammates` 分页枚举含隐藏、暂停、归档的伙伴，传 `teammate_id` 分页读取已保存的任务关系（默认100、最多1000） | 有（history 组，普通任务与插件共用） | 有（同账号历史查询；旧端不支持时明确返回未覆盖） |
| 任务附件 | `read_session_attachment` 只读已有宿主授权的 Cindy 媒体与 grant / deposit / handoff 引用，分块字节与 SHA-256；历史 JSON 文件路径不构成授权，返回 `UNSUPPORTED_CAPABILITY`，不返回宿主路径 | 有（history 组，受上述限制） | 暂不支持，返回 `UNSUPPORTED_CAPABILITY` |
| 任务     | 获取可直接引用的任务链接（列表、搜索、聊天记录与摘要返回 sessionUrl） | 有 | 有（链接携带所属电脑；旧远端查询结果由调用端补齐） |
| 任务     | 读摘要（状态、最后的要求与回答、模型路线、PR、排队数）     | 有   | 有（2026-10-17） |
| GitHub | 查询明确 PR 的 CI、评审和变化；明确关联、移除、恢复、固定、排序 | 有（桌面与手机关联管理） | 有：helper `github` 类目，同账号跨电脑；脚本 `github.read` |
| 机器     | 看账号下的电脑与 SSH 主机及实时资源（`list_machines`，[规则](cindy-machines.md)） | 有（含 SSH 普通任务） | 有（2026-11-02） |
| 终端与后台进程 | `terminal_start/list/read/write/resize/stop/forget`，复用界面 PTY 与宿主作业注册表，当前调用方归属及独立游标 | 有（仅执行电脑本机；SSH 工作区明确拒绝本机代跑） | 尚无独立指定另一台电脑的参数；重连执行电脑后可续读同一作业 |
| 授权目录文件操作 | `file_request`，复用文件浏览器与 FsSlot；普通任务使用真实工作目录，插件使用亲选引用 | 有（仅执行电脑本机；SSH 目录不在控制端代操作） | 原生选择器授权插件目录；手机、远程页与 Node Host 当前不能建立新引用，watcher 以执行宿主实际装配为准 |
| 宿主服务发现 | `host_services`，Agent 与插件共用当前 provider 目录；插件另有本实例的声明与批准事实 | 有（discovery 组；只读，不管理其他插件） | 仅查询执行宿主本机；未接入或已关闭的服务明确不可用，不代查其他电脑 |
| 任务     | 给既有任务发消息（隐藏群专线不是群聊收件地址，返回不支持且说明未送达） | 有 | 有（2026-10-14；接收电脑执行同一判定，隐藏目标仍优先遵守可见性检查） |
| 任务     | 新建任务（继承项目、选择已有项目或不绑项目；来源不绑项目时按执行目录所在的已登记可见项目归属，2026-11-10） | 有 | 有（2026-11-11，`device` 指定任务电脑；项目与默认模型在目标解析，不继承本机路径）               |
| 任务     | 新建任务时选择 Agent 所在电脑（`send_to_session` create 的 `provider_device_id`（兼容 `agent_device_id`），取 `list_available_models` 的 `locations[]`；只换 Agent 用的远程或分享供应商，任务与文件仍在 `device` 指定的电脑） | 有 | 有（2026-11-07；SSH 任务不支持；那台没有所需模型或连不上返回 `PROVIDER_ROUTE_UNAVAILABLE`，不自动换电脑） |
| 任务     | 归档 / 取消归档                                             | 有   | 有（2026-10-16） |
| 任务     | `delete_session` 删除明确任务（不能删除当前调用任务），复用宿主生命周期清理 | 有（control 组，逐次确认） | 有（既有 patch-meta，结果不明不重发） |
| 共享任务 | 为当前原任务生成原生邀请、查询共享状态（`create_shared_task_invitation` / `get_shared_task_state`） | 有（房主；沿用任务权限，Plan 只读） | 手机或同账号其他电脑控制当前任务时在任务宿主执行；不支持指定其他任务 |
| 任务     | 改名、移动、标签                                            | 有   | 无               |
| 任务     | 给当前任务新建 Cindy 托管 worktree（默认最新远端默认分支，可指定基线分支 `base_ref`；绑定当前任务，随归档回收；不搬任务、不重启） | 有（`create_task_worktree`，2026-10-31；基线分支 2026-11-10） | 无 |
| 任务     | 看输入队列；编辑 / 撤回 / 调序自己发的排队消息；插话；停止 | 有   | 无               |
| 任务     | 模型、推理强度、Fast                                       | 有   | 无               |
| 任务     | `fork_session` 按指定消息分叉；`rewind_session` 恢复指定 user 消息前的历史与检查点 | 有（control，回退逐次确认；共用界面入口的屏障、锁与清理） | 有（既有 fork / rewind 通道，不自动重试） |
| 任务     | `get_session_runtime` 读权限档；`set_session_runtime(permission_mode)` 复用界面权限提交与回滚 | 有（control；权限提高逐次确认；持有 admission 的任务修改自身权限含混合请求，在所有写入前返回 `UNSUPPORTED_CAPABILITY`，其余原判定保持） | 任务在目标电脑运行工具；不新增跨电脑设置入口 |
| 任务     | 代用户确认权限或回答提问   | 无   | 无               |
| 协同 / Worker | 单个 / 批量创建、指定已有目录、查询实际目录与自有 worktree | 有 | 有（运行设备；新建 worktree 仅本机） |
| 协同 / Worker | Lead 使用远程供应商时派发跨设备 Worker；独立选择工作电脑与模型电脑 | 有 | 有（`execution_device_id` + `agent_device_id`；目录查询支持同一工作电脑范围） |
| 协同 / Worker | 为 Worker 新建 worktree、指定源分支、归档时回收 | 有 | 无 |
| 协同 / Worker | 单个／批量创建默认跟随本机手动面板已提交路线，返回实际路线与回退原因 | 有（按当前账号本机 scope；旧逐 Agent 偏好不算选择） | 运行设备与 SSH 保持原策略；远程供应商路线可记忆 |
| 协同 / Worker | 其他仓库的新 worktree 默认使用主任务记住的源分支，失效回退当前分支 | 有（返回实际源分支与原因；显式参数优先） | 无 |
| 定时任务 | 列出、详情、运行记录、修改、暂停、恢复、删除、立即运行     | 有   | 有（V1 / V2 各自实时名册判断可用；仅加密连接不依赖 V1 在线状态） |
| 定时任务 | 选择远程／分享供应商模型（运行位置、引擎、模型与速度）及清除覆盖恢复跟随；绑定任务或持续模式切回本机须保留完整引擎／模型选择 | 有   | 有（设置或清除模型选择均核验目标电脑的 `supportsScheduleAgentDeviceSelection`） |
| 定时任务 | 新建（可指定目标电脑）                                     | 有 | 有（2026-11-01；目标电脑须支持远程创建） |
| 定时任务 | 安装检查脚本                                               | 有（绑定远程 Agent 时由本机辅助模型生成脚本） | 无 |
| 定时任务 | 查可选运行位置与模型；设每次新建任务的 Agent 运行位置（其他电脑 / 分享来的供应商） | 有（2026-10-22） | 无 |
| 定时任务 | 删除单条运行记录、标记已读                                 | 无   | 无               |
| 项目     | 列出、登记、改名、移除；工作目录列表                       | 有   | 无               |
| 项目     | 查询远程已有项目（`list_projects(device)`，复用目标项目目录与可见性） | 有 | 有（2026-11-11） |
| 项目     | 查询新项目存放位置（`list_projects.projects_root`，含来源） | 有（只读；修改该设置暂无 Agent 工具，按 #8259 维护者初审意见保留为缺口） | 无 |
| 外观     | 导入 `.cindy` 主题包并刷新列表；选择主题家族／明暗模式与回读 | 有（`appearance.themes` → `import_theme_package`，选择沿用 `preferences`；同 ID 更新，仅数据主题，额外外观插件仍走插件安装） | 无（在目标电脑的本机任务执行；手机可继续该任务） |
| 任务导入 | 扫描其他 AI 编程工具的任务、开始导入、查进度与结果（与设置 → 任务导入同一实现） | 有（2026-10-30） | 无 |
| 伙伴     | 发现伙伴（普通任务与伙伴任务均可用 `list_agents`，返回各伙伴主对话 `session_id`，另一台电脑上为 `deviceId::sessionId`），用 `send_to_session` 给它发消息；V1 的 `send_to_agent` / `check_agent_message` 已于 2026-11-08 移除 | 有   | 有               |
| 伙伴     | 自身关联项目：列出、添加与移除（原有文件工具按需读资料） | 有 | 无（远程设置界面可管理） |
| 伙伴     | 资料、能力（待办与 V1 后台任务已于 2026-11-08 移除；开任务见上面的 `send_to_session`） | 有 | 无 |
| 伙伴     | 项目规则、技能与自动化：伙伴项目的 `AGENTS.md`、`.agents/skills`、`.cindy/automations/schedules.json`（原有文件工具与 `schedule_*`；伙伴项目的自动化免导入确认） | 有（2026-11-08） | 无（随云端伙伴迁到新主力电脑） |
| 伙伴     | 显式重新接受已保存模型，恢复旧版遗留的自动模型记录 | 有（`update_teammate_profile` 显式提交完整 `modelChain`，即使值未变） | 无（远程设置 IPC 可按版本接受，不等于跨电脑 Agent 工具） |
| 伙伴     | 发现与选择 Codex Apps 连接器（继承默认保留，显式 MCP 白名单可收窄） | 有（能力工具） | 无（SSH Codex 不提供） |
| 工具     | 添加自定义 MCP 服务器（远程 HTTP/SSE；`request_mcp_setup` 在本任务打开同一设置表单，凭证由主人在表单填写）；伙伴随后用能力工具加入，原任务下一轮生效（2026-11-01） | 有（本机桌面任务） | 无（主人到受信电脑的设置 → 工具 → 外部工具添加） |
| 伙伴     | 按已证实归属搜索跨渠道聊天、按最近活动列出旧任务           | 有   | 有（历史查询，两端需支持筛选参数） |
| 伙伴     | 查看自己的本机 IM 连接分配与状态                         | 有   | 无               |
| 伙伴     | 开关自己的记忆（`set_teammate_capability` kind=feature，与能力页同一份设置；系统技能已于 2026-11-08 随系统 Skill 机制移除） | 有（2026-11-01） | 无（远程设置界面可管理） |
| 伙伴     | 给自己添加消息平台连接（Telegram、飞书 / Lark、企业微信、钉钉、Discord、iMessage / BlueBubbles；`connect_account` kind=host、id=`im-<渠道>` 发授权卡，主人在可信电脑卡片上逐项填写凭证，与「消息平台」设置页同一添加实现；移除仍在设置页） | 有（2026-11-01） | 无 |
| 伙伴     | 查看与更换主力电脑                                         | 有   | 有（2026-10-17） |
| 伙伴     | 记忆整理：项目自动化 `teammate-memory-review`（每晚；暂停、恢复、修改、立即运行用普通 `schedule_*`） | 有（2026-11-08） | 有（同普通定时任务） |
| 社区插件贡献 | 当前安装快照准备、提交审核/当前进度、本人列表/详情/留存内容 | 有（2026-10-15） | 无 |
| SSH 主机 | 列出、查状态、执行命令、添加主机、重新读取 ~/.ssh/config（与设置页同一实现；只用 ssh-agent／私钥，密码登录先用 `ssh-copy-id` 经终端代输入装公钥） | 有（添加与重读 2026-10-29） | 无 |
| SSH 主机 | 编辑、删除、安装远端 Agent、Agent Proxy | 无 | 无 |

Worker 工具省略 working_dir 时保持继承 Lead 任务记录目录，不跟随之后 cd 进入的 worktree。
面板默认识别实际目录属于 UI 行为；Agent 通过显式 working_dir 共用已有 worktree，
通过 new_worktree 新建独立检出，二者按会话权限审批，并以返回的 working_dir 核对结果。

表里「无」的项是待补的缺口，不是有意的限制。其中「代用户确认权限或回答提问」
会让 Agent 改变约束自己的那一层，补之前需要单独的产品决定。

插件宿主工具入口（2026-11-10）：`agent.hostTools` 分组批准后，插件以显式调用方经
`cindy.host.call` 使用上述同一工具与宿主服务，不绑定当前任务。`scheduler` 已覆盖新建、修改、
暂停、恢复、删除、立即运行和运行记录；`settings` 的应用分类读改复用设置页保存与生效路径，
不返回秘密值。工具的本机/跨电脑范围不变，风险动作仍由宿主逐次确认。
插件自己的设置界面不属于这些宿主工具。调用契约见
[插件宿主工具](../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-host-tools.md)。

## 实现入口

- 工具索引与作用范围：`packages/lizi-mcps/src/lizi_xdtHelperMcpServer.ts`
  （`HELPER_CATEGORY_DESCRIPTIONS`）、`cindy_schedulerMcpServer.ts`
  （`SCHEDULER_CATEGORY_DESCRIPTIONS`）、`xdt-helper/capabilities.ts` 的 `self-management`。
- 定时任务的 Agent 运行位置：`packages/lizi-mcps/src/scheduler/listModels.ts`（与协同 Worker 的
  `list_available_models` 共用 host 实现；模型项的 `id` 对应 `model`，`providers[].id` 对应
  `providerId`）、`create.ts` / `update.ts` 的 `agentDeviceId`；执行见
  `apps/desktop/src/main/scheduler-host/runner.ts`（按那台电脑的已授权目录解析，不回落本机同名来源）。
- 自动化显式模型保存：桌面表单、Agent 工具、项目配置和跨电脑写入共用 Scheduler 保存前校验，
  按 `modelAgentDeviceId`（空字符串为自动化所在电脑）或绑定任务的实际电脑检查来源与模型。
  失败不写入调度数据库，不启动或切换任务；错误说明实际检查位置及模型位置参数。项目编辑器
  先写文件的路径在拒绝保存后尝试恢复原内容，但只有读回内容仍等于本次写入时才回滚；校验期间
  后来保存、删除或直接编辑的文件保持原样。此为乐观核对，不是跨进程文件事务。仅改名称、时间等无关
  字段不读取目录。旧的无 `modelAgentKind` 配置继续跟随任务；SSH 保留原生目录校验路径。
- 跨电脑定时任务：`packages/lizi-mcps/src/scheduler/_devices.ts`、
  `apps/desktop/src/main/mcp-integrations/schedulerDevices.ts`。
- 跨电脑新建普通任务：`device` + `apps/desktop/src/main/maker-ipc/remoteSessionCreation.ts`，复用 `openSession` 与普通消息队列；不建立协同或自动回传关系。
- 跨电脑发消息：`apps/desktop/src/main/mcp-integrations/sessionHandoffRemote.ts`、
  `apps/desktop/src/main/maker-ipc/sessionHandoffIpc.ts`。
- 新建任务的 Agent 所在电脑：`packages/lizi-mcps/src/xdt-helper/send_to_session.ts` 的 `provider_device_id`（兼容 `agent_device_id`），
  host 侧解析见 `apps/desktop/src/main/maker-ipc/sendToSessionExecutionConfig.ts`
  （`resolveSendToSessionCreateRoute`）。
- 任务摘要（`get_task_digest`）：`packages/lizi-mcps/src/xdt-helper/get_task_digest.ts`（输出合同 ≤2KB）、
  `apps/desktop/src/main/mcp-integrations/taskDigest.ts` 与 `taskDigestHost.ts`（跨电脑只读，复用
  `local-db:sessions:get`、`maker:list-active`、历史消息与 PR 状态通道）。
  本机与跨电脑均排除带隐藏触发标记的协调／续跑输入，保留最新助手回复全文供工具按预算截短；
  长回复保留首尾片段，总预算进一步收紧时仍保留首尾，避免丢掉末尾结果或阻塞说明。
  不用内部回报替代用户要求，也不只取助手回复最后一行。`finished` 只表示所查任务本轮结束，
  不证明委派工作或用户目标完成；不参与输入放行判定，下一条消息仍按实时运行状态和队列派发。
- 「由这位伙伴开的」记录见 `apps/desktop/src/main/maker-ipc/botTaskCreation.ts`。V1 伙伴跟进（`botWorkbenchAccess.ts`）已移除。
- 协议与兼容见 [`../dev-rules/protocol-compatibility.md`](../dev-rules/protocol-compatibility.md)
  「Agent 跨电脑管理定时任务与发消息」。

伙伴或普通任务代用户转交工作时，正文就是 Agent 写的内容；本轮代表用户时转交直接带用户授权
（2026-11-08 取消发送端审核），接收任务按这段内容审核。
回到原话所在任务的消息、自主消息与自动化不带用户授权。接收任务沿用当前权限档，不增加交接确认；来源回执
不是新的执行权限档。本机和同账号跨电脑沿用同一规则，旧接收端仍收旧格式。
详见 [消息来源](message-source.md#跨任务委派代办轮的转交带授权正文是原文)。

### 模型速度

模型能力中的 `supportsUltrafastMode` 来自当前账号的 Codex 目录。桌面和手机的模型配置，以及
`set_session_runtime` / 新建任务 / Worker 工具，均使用同一速度值：`false` 为标准、`true` 为快速、
`"ultrafast"` 为超快。原有布尔值保持兼容；不得把超快归一成 `true`。

### 自主跟进行动授权（2026-10-19）

（2026-11-08 起 V2 不再适用：工作台、自主跟进与伙伴专属的行动风险确认已移除，伙伴与普通任务同一权限流程，
见 [伙伴的来源与操作权限](teammate-authority.md)；以下普通任务、定时任务与 Orca 的权限规则仍有效。）

任务读取与提醒保持原发现入口及可见范围。`cindy_helper` 的工作台、通用任务控制与
Session 委托写操作，以及 `cindy_orca` 的协作写操作，共用 Host 行动授权入口；
直接调用、渐进式调用与 CC / Codex / Pi 路由相同。工具描述明确角色不授予行动权限。
2026-10-20 修订：主人私聊输入及经 Chat Server 实时核验的群内主人请求，沿用普通任务原有权限流程，
不再额外弹行动确认卡；helper 与 Orca、直接与渐进调用保持一致。群专线必须通过
`authorizeGroupTool(sessionId, botId, 'owner-action')`，仅有 role 或持久来源不算主人输入；
访客身份核验暂不可用不得放行。2026-10-21 修订：普通任务中，用户已委托的定时工作沿用
当前任务的权限审核，不能在正常审核前一律拒绝。缺少可复用的实时权限决定时，Host 从活跃
Session 识别定时轮次，并对准确工具、目标和正文调用
`Session.reviewHostPermissionAction`：Full Access 放行，Auto 使用原任务已恢复的用户意图，
审核同时携带宿主确认的「定时触发已经发生」上下文，区分先前的设置阶段与当前续跑，
该事实不构成新授权。排队时应用模型设置不得改写绑定任务的权限档。
Ask 或审核要求确认时复用现有确认入口；Plan 不允许副作用。来源标签本身不提供授权。
审核到执行及延迟投递均保留账号、实例、权限／Plan 代次与输入边界校验，
不得借定时工作扩大原授权范围。
2026-10-29 修订：伙伴的来源记录与访问权限、操作风险分开。移除自主工具白名单与
例行任务的静默 `NEEDS_OWNER_REQUEST`；普通操作沿用任务权限，仅对自主代答授权、恢复暂停、调度命令、独立完全访问 Agent、授予常驻指令等明确风险显示可操作的一次性授权请求与等待状态。
确认、拒绝与取消共用桌面／手机原交互通道。见 [伙伴操作权限](teammate-authority.md)。
2026-10-22 修订：伙伴、转入消息与定时跟进的任务操作
统一沿用普通任务权限流程：Full Access 免审、Auto 使用原有自动审核、Ask 使用原有确认。
helper 任务写工具与 Orca 协作写工具均逐次进入该流程，不能借可信 server 静默跳过；Orca 只读查询保持免审。
Host 不因当前输入缺少主人标记再追加行动同意判定。只认运行中任务的实时权限，
不读数据库旧值；从 Host 接收调用并捕获快照起，权限切换、计划模式或实例变化使该调用
尚未执行及排队中的放行失效。该快照不是 Agent 审批回执：审批完成到进入 Host 之前的交接窗口
沿用普通任务既有语义，本次不增加跨 harness 审批凭证，也不承诺该窗口的原子撤销。
群成员、共享访客及账号归属检查保持原边界；插件任务按普通任务工具权限执行。
没有可核验的实时执行权限时，仍按原有主人输入或委托范围校验，不凭角色放行。
本人通过本机或同账号远控发送带引用的消息时，引用外亲自输入的正文仍是当前请求。
宿主按持久化正文校验引用位置并剔除引用内容，不因附带消息／任务引用就清空整条
`autoReviewUserText`；引用与自动事件本身不获得本人身份或执行授权。
实现与回归见 `maker-ipc/autoReviewUserIntent.ts`、`makerSendTransaction.test.ts` 和
`agent-input-coordinator.test.ts`。
已有委托的执行权不依赖自动观察规则的开关；仅凭普通 Orca Lead 的当前 team 回报只延续原 team 范围。
跨电脑任务互发要求双方支持
行动回执，旧端明确提示不支持；未增加观察数据权限。实机多端验收仍待完成。

2026-10-24 修订：每个独立 MCP 请求隔离启动共享传输时遗留的行动上下文，
再按绑定的当前调用方执行原有权限判定；进程内调用沿同一隔离边界。
普通任务获准后不继承旧调用的行动证据，也不因此强制排队。
当前调用的委托、权限撤销和延迟交付检查继续保留；不恢复过期授权，不自动重发。
实现见 `maker-ipc/taskActionAuthorization.ts`、`taskActionHost.ts` 与
`mcp-integrations/codexHttpBridge.ts`；回归见各自授权及 HTTP 桥接测试。

伙伴例行任务（2026-10-26；2026-11-08 起 V2 不再适用：例行任务引擎与 `routine_*` 工具已移除，伙伴的定时工作是项目自动化，模型、`persistentSession` 等沿用 `schedule_*`）：桌面与 `routine_save` 共用每条规则的 `modelOverride`，可选引擎、来源、型号、执行位置、推理强度与 Fast；null 恢复跟随伙伴，省略保留选择。执行记录返回独立 `sessionId`。内置跟进也可选模型，指令与触发条件仍由宿主维护；每天查待办已是普通例行任务，指令与触发条件可改（2026-10-31）。`sessionMode`（`persistent` 复用同一任务／`fresh` 每次触发新建任务）同样经桌面与 `routine_save` 设置，省略保留原值。跨电脑桌面设置通过 `routines.saveWithModel` 与 `routines.saveWithSessionMode` 能力声明协商；手机仍按现有合同不提供例行任务管理。

结果回传不做成工具（2026-11-09）：`notify_when_done` 与 `report_task_delivery` 已删除，派活方在消息里请对方做完用 `send_to_session` 发回，或自己用 `get_task_digest` 查；用户本人也是这样跟进任务的。

## 历史查询的大结果分页

历史工具 `list_sessions`、`get_chat_history`、`search_chat_history` 的 `limit` 是条数上限。
源设备另按完整记录约 64 KiB 的软预算提前分页，消息、搜索命中及其上下文不被截断；
单条记录超过预算时仍完整返回，保证继续读取可以前进。调用方以 `hasMore` / `nextCursor`
续读，不以返回条数少于 limit 判断结束。原始历史不改写、不另存摘要，所有 Harness 共用；
跨电脑沿源设备同一查询与游标，旧设备保留其原有分页行为。
搜索预算仅由历史工具入口启用；界面搜索和学习证据等内部消费者保留按条数取页。
工具搜索逐条读取上下文并累计预算，到达边界后停止后续读取；游标保留未返回命中的位置。

## 社区插件贡献

普通个人作者的独立入口为 `ghost_contribution_prepare`、`ghost_contribution_submit`、
`ghost_contribution_status`、`ghost_contribution_stop`、`ghost_my_plugins`、`ghost_cancel_plugin_review`，由 `cindy-tools`
直接提供工具说明。手动和 AI 复用 Host 的精确安装快照、操作键、回执及个人读取接口；AI 不拿到
Bearer、PUT 票据或受管文件路径。公开写入遵循当前任务 Full Access / Auto / Ask，不加最后人工点击。
共享任务访客不得借用 Host 账号读取个人插件发布资料或执行发布。插件创建的任务、Worker 和
收到插件消息的普通任务沿相同账号边界与任务权限执行；插件来源标签不另设投稿门槛，人工审核不由 Agent 执行。
客户端提交边界见 [社区贡献实现说明](../plugin-community-contribution.md)。

2026-10-16：个人发布 prepare 返回包内 releaseNotes 和远端只读预检；submit 前重新校验所见快照内容。
`ghost_cancel_plugin_review` 使用本人版本的精确 revision，区分停止上传与取消审核，沿现有 Full Access/Auto/Ask 授权。
旧版本包仍可安装，成功提审后的同版本不再支持改包重提。

自动化任务的 Webhook 触发（2026-11-04 更新）：桌面任务表单与 `schedule_create` / `schedule_update` 共用 `webhookTrigger`（含事件筛选和发送方 `source`），`schedule_get` 返回接收地址和状态。设置密钥（生成或粘贴）和更换地址只由用户在任务所在电脑的详情操作，这是凭证规则带来的有意差异：明文不能进入任务记录，工具参数夹带密钥会被拒绝。账号管理与用户能力一致：`schedule_webhook_list` 查看本账号所有电脑的地址及用量，`schedule_webhook_release` 释放离线旧电脑的名额；`schedule_webhook_restore` 明确重新连接，支持 `device` 选择在线目标电脑，恢复后仍须用户配置密钥。第一步 scheduler 类目索引说明账号范围与离线释放。写操作经过现有权限。规则见 [schedule-webhook-trigger.md](schedule-webhook-trigger.md)。使用 Webhook 需要 Cindy 账号：未登录或没有接收服务时 Agent 开启报错，表单隐藏入口；可用性由任务所在电脑的 `webhook-receiver` 决定。

Webhook 跨电脑配置（2026-11-06）：`schedule_create` / `schedule_update` 的 `device` 可设置或清空目标电脑的 `webhookTrigger`。第一步 scheduler 类目索引即说明触发配置可指定电脑，并区分密钥和普通地址轮换仍由用户在目标电脑详情操作。沿用同账号远程控制权限，写前检查目标的 `supportsScheduleWebhookTrigger`，开启时再检查其 `webhook-receiver`；旧版本或不可用目标明确报错，清空不要求接收服务可用。`schedule_get` 指定电脑或 `all` 查询也返回目标电脑的 `webhookStatus`：通过现有只读状态通道补取，失败时明确报告该电脑查询失败，两次读取之间及返回前复核账号。未增加密钥工具或跨账号权限。

自动化与例行任务的插件前置检查（2026-10-31；`routine_save` 已于 2026-11-08 移除）：桌面「前置检查」与 `schedule_create` / `schedule_update` 共用 `preRunPlugin`（插件实例 id + 出错处理），Agent 与用户能力一致；只能在插件所在的电脑上设置，跨电脑的 `schedule_update` 明确拒绝。

自动化截止时间：桌面创建与编辑表单、项目自动化配置和 `schedule_create` / `schedule_update` 共用 `expireAt`。到期后不再自动启动，已开始的运行允许完成；手动立即运行仍可使用。桌面按编辑设备的本地时区显示，保存绝对时间戳；`schedule_update` 省略表示保留，传 `null` 表示清除，本机与跨电脑一致。手机端没有自动化管理入口。

伙伴例行任务送达与发现（2026-10-30；2026-11-08 起 V2 不再适用：`routine_save`、`routine_delivery_targets` 与 `routineTools` 已移除）：Pi 直接 `routine_save` 与 helper 同时提供 `modelOverride`、`sessionMode`、`delivery`；伙伴 essential tools 提供 `schedule_list_models` 和 `routine_delivery_targets`。价格与能力来自实际连接来源，保留 unknown；本机位置 `local` 保存为 null。桌面、Agent 和另一电脑上的设置共用 `routineTools`，默认结果直接显示在发起伙伴主任务；显式处理才唤醒模型，IM 只使用已连接机器人的已知收件人。执行和送达失败分开记录，静默检查仍静默。

GitHub 查询与关联的独立语义、缓存和游标合同见 [GitHub 状态与关联](github-status-and-associations.md)。

### 普通提问入口（2026-11-08）

Claude Code／Pi 的非阻塞澄清恢复独立的 `ask_user_question_async`；Pi 同步展示为直接工具，
无需先检索 MCP。Codex 保持原生提问入口。独立的 `request_input_handoff` 处理窗口与截图二维码，
三个 Harness 直接可发现；Grok 登录恢复 auth 类目的 `start_grok_device_login`。移除 `ask_owner`，
既有同步提问、卡片和回答生命周期保持不变。

三种 Harness 都直接列出 `manage_user_questions`，无需先猜能力名称；只管理当前任务的
异步问题，Codex 提问仍使用原生终端协议。模型可列出未答题，再逐题带原因撤回。
界面保留撤回原因和正在编辑的草稿，可由用户主动补充发送；撤回不等于回答或授权。
任务结束本身不撤题。审查提醒写在该工具描述与共享提问工具描述中，不修改全局系统提示。

自动任务、worker 汇报和自动续跑不会替用户撤题。失效且未回答的问题在历史中保留
「未回答」和题干，已撤回的显示原因，正文不另复制一份。撤回后已编辑的选项与文字
合成可编辑补充，只保留发送补充与关闭操作。用户在原轮次结束后回答时附带适用性提示，
提醒模型核对当前状态、避免重复已完成操作；这段上下文不属于用户回答或新增授权。

### 同账号电脑开启远控的授权请求（2026-11-10）

用户可在目标电脑本机开启远程控制；Agent 的 `request_remote_control` 可请求该电脑显示
本机确认框，用户直接点击开启，不必另找设置。工具发现为 `devices.remote-consent`，
精确目标来自 `list_machines`。此入口只请求确认，不能远程改开关；原任务收到 enabled 后
继续工作。未授权消息通道与普通远控命令分离，详情见 [机器能力](cindy-machines.md)。

### GitHub App 自动任务（2026-11-11，测试）

Desktop 来源选择与 `schedule_create/update` 共用 `source={preset:"github-app",repositories:["owner/repository"]}`
和事件筛选；Agent 可按既有 `device` 选择运行电脑。连接账号仍在目标电脑的 GitHub 插件完成，工具不接收
OAuth 代码、App 密钥或任务签名密钥。`schedule_get.webhookStatus` 返回接收状态，不伪造专属地址。
旧执行端明确拒绝未知来源；旧控制端省略来源的编辑保持既有配置。手机当前保留／读取该配置，新增来源
表单只在 Desktop；不把控制端本机的登录状态冒充运行电脑的连接状态。
