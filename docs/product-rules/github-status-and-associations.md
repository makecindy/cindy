# GitHub 状态共享与 PR 关联

## 用户行为

用户或助手消息中提到完整 GitHub PR 链接时自动关联，不要求 Agent 另调 attach，也不按任务分支猜测归属。工具结果不参与提取，单纯调用 GitHub 查询工具不建立关联；助手把链接写入可见消息则按提及关联。关联只用于显示状态，不登记自动化，也不推断唯一 owner。手动添加、固定和排序仍可用。

桌面、手机、伙伴卡和任务摘要沿现有 `association_source=explicit` 且 `removed_at IS NULL` 的投影展示；该存储值表示当前有效关联，并不代表用户曾手动确认。消息提取记录 `association_origin=message`，保持 `manually_added=false`；手动管理或 Agent attach 记录真实入口并保护关联不被消息重算删除。

升级必须保留原有未移除关联的可见性。0144 将这些 `legacy` 关系恢复为 `explicit`，缺少来源时记为 `upgrade`；保留 ID、固定、排序、手动标记和时间。历史补扫使用新的完成标记，覆盖自动提取停用期间遗漏的消息；外部编程工具导入消息也走同一提取语义。清空、回退及用户或助手正文更新（含普通插件改写）按仍可见消息重算自动关联，保留手动关联。移除优先：普通 attach、再次提及、补扫和迁移都不能复活已移除项，必须显式 restore。固定最多三条，工具列表不受顶栏数量限制。

关联沿 `session_pr_refs` 原表和 `managePrRefs` 的单任务写队列执行，保留原 ID、排序和时间。实时提取、导入、历史补扫和重算均在队列内读取实际落库且仍可见的消息，并复用 `messageToCamel` 的公开内容投影；MCP App 的私有输入、结构化结果与元数据不参与普通关联提取，导入事务跳过的行也不得形成关联。带 `[UI_ACTION_TRIGGER]` 前缀（裸文本或 `{text}` 包裹）或 `autoResume=true` 的隐藏用户行不算可见提及，其中复制的续跑摘要不能创建或保留 PR 关联。来源由宿主记录 UI、调用任务或同账号远程入口，模型不能提供来源字段。账号切换时在途写操作不得跨账号生效。手动管理所需的 GitHub 校验在任务 PR 写锁外执行，返回后重新入锁读取并核验当前任务及关联；网络等待不得经助手终态校正阻塞所有任务共用的消息持久化队列。

## 公共入口

三个 Harness 共用 `cindy_helper` 的 `github` 类目。Codex / Claude Code 沿原 MCP 装配，Pi 沿原 MCP 网关；不修改引擎内核。类目总览提供用途和范围，详细参数按需发现。

交互式查询时 Agent 可以直接用 gh / glab 等命令行；github 类目主要服务定时任务和脚本的增量读取，以及任务关联的管理，不替代命令行。

| 工具 | 作用 |
| --- | --- |
| `get_pr_status` | 状态、当前 head 的 CI 汇总、评审汇总、采集时间、版本、来源电脑和完整性 |
| `get_pr_changes` | 首次建立基线，后续按独立游标读取观察到的提交、生命周期、CI、评论、评审和线程变化 |
| `get_pr_details` | `checks / threads / comments / reviews / rules`，可筛条目、分页、明确刷新 |
| `manage_session_prs` | `list / attach / detach / restore / pin / unpin / reorder`；省略任务标识使用宿主绑定的当前任务 |

PR 选择器只能是完整 GitHub PR URL，或 `{repo:"owner/repo",number:123}`。不接受裸编号，不根据工作目录、最近搜索结果或任务关联推断 PR。查当前任务的 PR，先 list，再选择查询对象。

脚本宿主的 `github.get_pr_status / github.get_pr_changes / github.get_pr_details` 需要 `github.read` 能力，复用同一个运行时入口。脚本只读取执行电脑的 GitHub 身份；MCP 可以显式选择同账号电脑。工具不返回凭证。

## 缓存与完整性

- `PrStatusService` 是界面、摘要、工具和脚本共用的汇总缓存；有效期 60 秒，同一 PR 的并发请求合并。UI 保留原前台 90 秒刷新节奏，工具不注册后台计时器。
- GitHub transport 按当前 Cindy 账号、数据库代次和 GitHub token 身份隔离；共享在途请求、条件请求和身份级限流退避。显式刷新可以加入已发出的同一请求。
- 详情正常缓存 60 秒，分支规则按仓库和目标分支缓存 5 分钟。REST 支持 ETag/304；普通变化观察把线程、评论、评审、检查首批合为一条 GraphQL，继续读取所有外层与线程评论分页。达到分页预算时返回 partial。
- 显式刷新变化观察时，四类详情复用本次刚刷新的合并首批，后续分页仍强制刷新；独立详情刷新不能复用此前观察的旧首批。
- CI 的 GraphQL head 必须与 REST head 一致，否则 checks 为 null。未知不能当作零或通过；无检查、全跳过和通过分别保留。CI 全绿不表示审核、冲突、保护规则都允许合并。
- CI 汇总与必需检查的判法一致：同一来源、同一 workflow（按 workflow id，不按可重名的显示名）、同名检查只计最新一次执行（check suite），被新执行取代的取消/失败不算失败；同一次执行里的同名检查（如固定名称的 matrix 分片）互不取代，全部计入。拿不到 workflow 或执行身份的运行不合并；检查条目未能完整读取时沿用 GitHub 原始计数，宁可多报失败也不漏报；`get_pr_details` 的 checks 仍保留全部原始运行。
- `observed_at` 是观察时间，`revision` 用于核对同一汇总；详情缓存保留真实采集时间。API 读取不构成 GitHub 原子快照，处理或合并前仍核对 head。
- 账号切换、宿主登录变更使对应缓存不可访问；在途 transport 失效后不能重新填入缓存。沿原 gh token source 的登录态缓存读取本机授权，不复制到别的电脑。

## 变化日志与可靠投递

首次不带 after 返回当前快照和基线，不把旧评论当新事件。当前失败和未处理评审仍须由工作流读取详情判定。后续游标按账号、GitHub 身份、来源设备和 PR 绑定；两个读取者互不确认对方的进度。`next_cursor` 只覆盖本页返回范围，`has_more` 为真则继续；过期、越界或范围不符返回 `RESYNC_REQUIRED`。

事实日志落在当前账号的 `github_observations`，重启后可继续。每 PR 最多保留 1000 个事件、约 4 MiB；最多 200 个 PR，30 天无访问淘汰。轮询只报告观察到的变化，不能保证两次观察间的瞬态。失败或不完整观察不推进事件游标。

完整观察中消失的条目保留原 `kind` 与 `item_id`，以 `fact: {id, deleted: true}` 记录删除；删除事件不重复携带旧正文。重复观察不重复产生删除事件；条目再次出现时按普通事实返回。读取不完整时不推断删除。

读取不是 ACK。工作流必须保留原 pending、语义筛选和送达回执，成功投递后才保存消费位置。`sessions.dispatch` 的可选 `idempotency_key` 由宿主按 schedule、目标任务和 key 生成稳定消息 ID，通过原持久消息队列投递；持久化完成后才回执。重试复用同一 ID，已入队或落消息库的输入不重复入队。发送者必须先持久保存待发批次，重试期间不能把新事件并入旧批次而换 key。

私人 PR 跟进适配只替换读取来源，保留原 owner、频率、停止条件、CI 重试与评审判断。新宿主支持且一次 live run 验证成功后，才去掉旧 preRunHook，避免双读或监控空档。旧宿主继续原通道，不能宣称迁移完成。私人脚本、路径和运行回执不提交客户端仓。

## 宿主与 GitHub 插件的分工（2026-11-06）

按[核心产品原则](core-product-principles.md#清楚的分工让能力持续生长)，宿主只做所有任务都用得上的通用能力，
具体流程留在插件和 Skill：

- **宿主**：本机 GitHub 登录与登录引导、PR 状态汇总与缓存（标题栏、侧栏、手机、卡片状态位共用一份）、
  PR 关联、`github` 读取入口、定时任务与前置检查的执行、插件卡片的净化与投影。这些不懂「怎么跟进一个 PR」。
- **GitHub 插件**（`cindy-github`，`/pr` 技能）：何时开 PR、怎么跟进、节奏、等待哪些评审机器人、何时叫醒
  Agent、卡片长什么样。规则写在插件的技能和脚本里，改规则不改宿主。
- **新的第三方服务**沿「插件声明、宿主跑通用流程」：插件在清单里声明凭证、连接和设置，宿主提供统一的连接卡、
  保险库和出网注入，不为单个服务写专属入口。GitHub 是早于这套机制的存量集成，登录与状态仍由宿主提供，
  装没装插件看到的标题栏 PR 状态、任务列表 PR 信息（含手机）完全一样；整体收进插件只是长期方向，
  不在没有等价体验前迁移。

宿主为 PR 跟进补的三个通用能力：

- **状态变化即时触发**：`PrFollowWatch` 只消费已有的状态刷新（前台标题栏、侧栏、卡片状态位），不新增后台
  轮询。同一 PR 的汇总（状态、head、检查计数、未解决数、合并状态、冲突、审批）与上次不同时，立刻运行
  前置检查命令里写着该 PR 链接、按计划重复的 active 定时任务（一次性和仅手动任务不会被提前用掉），并在前置检查 stdin 里带
  `trigger: {kind:'watch', source:'pr-status', detail:<PR 链接>}`。第一次看到某个 PR 只记基线；只认成功结果；
  正在运行的任务不触发，同一任务两次触发至少间隔 60 秒。宿主不判断要不要叫醒 Agent，仍由前置检查决定。
- **只在 PR 开着时成立的卡片部分**：卡片元素标 `data-ghost-pr-open-only="owner/repo#N"`，标题栏同源状态为已合并或
  已关闭时，电脑端藏起，手机投影在宿主侧去掉（文字、`live` 状态与按钮一起），新旧手机都不用改；查不到状态照常显示。
- **从对话里引导登录**：任务对声明 `gh-cli` 凭证的插件调用 `connect_account` 时，本机 GitHub 登录可用（gh 或插件保存的
  备用 Token）就回报 ready；不可用或明确要求重新连接时，在用户正看着的窗口（否则主窗口）打开 Cindy 自己的 GitHub
  登录框，返回 `GITHUB_SIGN_IN_REQUIRED`，不在对话里索要凭证，不夺焦点。

## 远程和兼容性

`git-context:github-read` 是同账号公共入口，以 `github-read-v1` 能力协商。旧电脑未声明能力时明确返回不支持；原 PR 链接和旧关联状态接口仍可用。共享任务访客不获得这个任意 PR 读取/管理入口，旧 `pr-status` 远程关联过滤保持原边界。

迁移只追加，不改写已发布的历史 migration，也不删除历史引用。0144 同时覆盖直接从旧版升级和已执行 0141–0143 的数据库：只恢复当时仍未移除的旧关联，不创建自动跟进；再次启动不会重新恢复用户后来移除的关联。共享 GitHub 查询 API 保持只读；自动关联恢复在消息持久化层，旧版和新版控制端共用宿主的提取、回填及状态投影。旧客户端缺少来源/CI 字段时保留旧展示兼容，不能推断未知 CI 通过。

## 回归重点

PR 状态变化只触发引用该 PR 的定时任务、首见不触发、失败不算变化、在途与 60 秒内不重复（`gitContextPrStatusService.test.ts`），
触发信息到达前置检查 stdin（`runnerPreRunHookCwd.test.ts`、`scheduler.test.ts`）；open-only 部分在合并或关闭后
电脑端藏起、手机端不投影（`ghostCardPrStatus.test.ts`、`cardRemoteResource.test.ts`）；gh-cli 插件的连接请求打开
GitHub 登录框或回报 ready（`ghostWorkdirGate.test.ts`、`githubSetupIpc.test.ts`）。

真实工具发现和调用、读无关联副作用；明确管理及移除优先；非空旧库升级并再次启动；消息写入、导入和故障期间的历史补扫能关联，清空、rewind 与助手校正重算且保留手动关系；head 不匹配和分页失败显式未知；多读取者、重启、游标过期；账号切换与在途失效；固定批次重试、消息持久化后回执；同账号远程与共享任务权限；iOS/Android 历史引用恢复。

## GitLab MR 的界面状态与关联

任务顶栏、悬停面板、管理弹窗、侧栏和伙伴卡片同时支持 GitHub PR 与 GitLab MR。
Mobile 只扩展现有状态展示与网页跳转，不增加原生功能。GitLab 使用 `!N` / MR，
HTTPS 链接 `https://host/group/subgroup/project/-/merge_requests/N` 沿既有消息提取、
导入、补扫、重算与手动添加入口关联；识别不依赖登录。任意域名可识别，多级 namespace
完整保存在 owner，repo 保存项目名；不支持 HTTP。子路径部署的链接会被识别为多级
分组，部署前缀也会计入项目路径，因项目路径不正确而查不到状态。

0145 为旧关联补上 `provider=github`、`host=github.com`，唯一索引及状态身份包含
provider / host / owner / repo / number。不同 GitLab 实例上的同名项目不会串用缓存。
迁移由 Drizzle 生成；配套脚本逐列检查后添加，兼容部分字段已存在的库。

执行电脑按 MR 自身 host 调用 `glab config get token --host <host>`，令牌只用于该
HTTPS origin，重定向不得跨 origin 或降级 HTTP。没有令牌不请求 API；未安装 glab、
未登录分别提示，401 视为未登录。令牌及 CLI stdout 不写日志，不返回客户端。
窗口恢复焦点时只清除 glab 令牌负缓存和 GitLab 认证失败结果，保留成功缓存与在途
请求；终端登录后无需额外刷新按钮。
远程、SSH 和只读任务不展示本机登录引导；GitLab 不使用 GitHub 安装登录窗口。

每个 MR 一次 GraphQL 汇总读取，复用 60 秒缓存、并发合并和前台 90 秒刷新。
未解决数为 resolvableDiscussionsCount 减 resolvedDiscussionsCount。流水线 SHA
不同于 diffHeadSha、作业未完整返回或出现未知状态时 checks 不可用，不能算通过。
SUCCESS 为通过，SKIPPED 为跳过；FAILED / CANCELED 为失败；MANUAL 与等待、
准备、排队、运行、定时状态均为进行中。手动作业保持未完成，不猜它是否允许失败。

GitHub Agent 工具与脚本 `github.read` 仍只支持 GitHub。GitHub 管理工具 list 跳过
GitLab 关联，显式 GitLab 选择器沿用现有校验拒绝；包含 GitLab 的整组排序也明确拒绝，
避免 GitHub 工具误改不完整的排序。UI 管理和任务摘要支持两者，不新增后台跟进。
