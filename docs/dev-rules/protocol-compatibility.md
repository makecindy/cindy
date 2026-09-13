# 跨端协议兼容

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改插件分发来源边界、device-link 协议／relay／隧道 payload／IPC
> allowlist，或任何改动客户端与服务端之间 wire protocol 的地方之前

客户端与服务端分别维护本仓所需的 wire Bean、validator、parser 与 builder，不共享代码仓库
或发布节奏。真正危险的是单端改变既有 wire 语义，或在不兼容变更中缺少协同；这类问题在
单仓 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 自动化检查恢复投影

运行状态和已读回执保留历史事实。当前警告只保留未被**同一自动化**更新成功运行恢复的失败；
另一自动化成功不能清除它。检查受阻与实际执行失败分别显示；原有运行历史页面保持不变。
轻量侧栏协议新增可选 `failureKind` / `failureRecovered`，旧端忽略，新端缺省按普通失败处理。

前置检查仍遵守 exit 0 放行、exit 2 跳过、其他值阻止执行。脚本可在 stdout 单独输出一行
`CINDY_PRECHECK_OK`，表示检查完整完成（包括正常无事可做的跳过）。只有 exit 0/2 且输出未
截断时记录可选 `checkSucceeded: true`；错误、超时、取消和退避跳过不构成恢复。
该标记只恢复此前的检查故障，不恢复 Agent 执行失败；旧脚本不输出、旧客户端不识别均不影响
原有退出码语义。实现见 `scheduler-host/pre-run-hook.ts` 与 `scheduler-host/storage.ts`。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| hook 双工任务协议 | 客户端 `packages/slack-hook-protocol`；服务端仓同名本地 package，desktop hook-control 与 slack／telegram／x hook server 分别消费本仓实现 |
| device-link relay 层定义 | 客户端 `packages/device-link-protocol`；服务端仓同名本地 package，客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| Plugin 交付与 manifest | 客户端 `packages/plugin-protocol`；服务端仓同名本地 package，desktop、`packages/cindy-tools` 与 plugin-server 分别消费本仓实现 |
| 模型目录 | 客户端由 `packages/model-providers/src/modelAccessBean.ts` 与 `modelAccessValidator.ts` 维护；model-access-server 在服务端仓维护对应 Bean／validator，双方只共享稳定 wire 语义，不共享实现 |
| Skill Hub | Desktop 的 `apps/desktop/src/main/skillhub` 与 `shared/skillhubCatalog.ts`；服务端仓 `packages/skill-hub-protocol` 与 `cindy-skill-hub-server` |
| 插件来源 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包 |

## 1. 两仓本地协议演进

### X 回复链的结构化输入

服务端负责 X 事件、账号绑定、真实回复链读取与预算、可靠派发和回传；Desktop 的
`hook-control/xPrompt.ts` 负责模型提示词格式。可选 `source.xContext` 提供
`requesterId`、`requesterName?`、`truncated`，`threadContext` 沿回复顺序排列并包含
链尾当前消息；各条可选 `messageId / replyToMessageId / authorId` 记录平台事实。
`triggerMessageId` 对应末条，`userText` 为完整请求正文，不含模板说明。

新客户端在展示元数据截短前校验当前消息身份及相邻回复关系，并组装一次模型 prompt：
顶部请求者、按序历史、链尾当前请求。沿用历史随机栅栏、逐行作者与缺失提示；排队及恢复
直接复用已组装结果，不重复拼接。展示沿用原有有界快照，不拿其截短正文重建模型输入。
这里只改变每条消息的文本组装，不修改主 Agent system prompt、权限或 UI。

新服务端继续发送兼容 `prompt` 给旧客户端；新客户端遇到旧服务端、旧持久任务或不完整
结构化字段时原样使用该 prompt。两仓可独立升级，无数据库迁移、Mobile 冷更或部署顺序要求。
服务端兼容模板不再是新客户端格式的正本。

- 两仓同名协议 package 是各自消费者的本地实现，不允许跨仓源码 import、Git submodule 或
  运行时共享依赖。客户端重连、IPC allowlist 与隧道 payload 留在
  `packages/device-link`，不在客户端另造一套协议。
- append-only、带旧端降级路径的兼容变更允许客户端和服务端分阶段升级；只有实际使用新
  字段、消息或校验能力的消费仓需要发布。
- 不兼容 wire 变更、device-link 新增 relay kind 等必须声明升级窗口，并协调所有相关
  消费方；不能把“两仓独立发布”误读成允许单端改变既有字段语义。
- 改动一端协议实现时必须核对另一端同名实现和消费者。需要相同约束的 parser／validator
  应在两仓分别落地，并用相同的有效／无效 fixture 覆盖边界。
- 新业务域的契约优先放进所属业务仓库；不要建立新的公共协议仓来重新引入发布耦合。

### Skill Hub 目录与管理契约

- Desktop 本地技能管理用扫描条目 `id` 区分不同 scope / 项目中的同源记录；启停与卸载
  的本地 IPC 可选携带 `skillId`，Main 同时匹配路径、当前发送窗口的扫描记录和项目授权，
  缺省字段保留旧调用行为，不向 device-link 新开放管理能力。启停偏好仍按物理身份共享；
  `activation-preferences.json` 的可选 `discoveryPaths` 按物理路径保存已扫描的绝对发现
  路径数组，可选 `revisions` 记录每次停用意图的代次；缺省兼容旧偏好。卸载清理只在
  设置锁内匹配原代次及入口快照后清除旧偏好，不覆盖后续启停。启动时复核指向，启用时
  删除该身份的入口记录，重命名时
  同事务迁移到新入口。活动任务在启动时另存规范化物理身份快照，菜单过滤不重新解析
  停用别名；同时冻结词法入口到物理身份的映射，在写原生配置前剔除改指向的入口，
  使原生停用目标与菜单快照一致。插件托管技能只能在所属插件管理，详情禁用开关，Main 拒绝独立启停。
  卸载由 Main 原生确认框授权，默认取消；确认后再次核对发送窗口、账号、项目与文件
  身份，导航或身份变化撤销确认。同一窗口最多一个待确认卸载，取消不产生文件或注册副作用。
  物理卸载的清理快照汇总已扫描 scope 的同源发现链接，外部导入只移除所选 scope 的入口
  与对应词法注册记录，不追加其它范围的全局候选。斜杠详情路径携带 scope 与工作目录，
  同源多副本按范围和最近项目匹配；旧路径无法唯一消歧时不任意选择副本。SkillHub
  项目目录包含置顶任务和已创建但尚未发消息的项目任务，不沿用侧栏的展示排除规则；
  仍只扫描本地目录，并由 Main 的项目目录白名单复核。
  worktree 同时保留分组后的基仓与任务实际 cwd：分组路径只作目录归并，不能代替
  原生技能发现路径。Renderer 项目目录和 Main 白名单使用同样的两组路径，排除远程任务。
  扫描结果可选携带按物理路径关联的 `registrySkillName`，市场详情按此原始注册 slug
  与 catalog scope 匹配；保留实际目录名用于本地展示。未注册或旧扫描缺少该字段时，
  只按精确名称匹配，不用大小写折叠推断两个目录属于同一市场技能。
  源目录形状不能单独证明归属：同一分组必须有直接、非符号链接的发现入口，才可按独立
  实体卸载；检查覆盖入口、发现根及引擎配置目录各级，拒绝其中的符号链接，保留发现
  布局以上的已跟踪项目别名兼容。外部入口移除及清理重试保留源文件和按物理身份共享的
  停用偏好。安装、学习、导入、重命名及卸载共用小写归一的名称锁，一次操作的多个锁名
  按相同规则去重；大小写敏感卷上的同名大小写变体也保守互斥。
  名称锁之外，安装、学习、导入、重命名、卸载及清理重试还持有跨进程 lease：复用现有文件锁协议，
  在 Electron `appData/Cindy/shared-skill-mutation-locks` 下按归一名称的哈希共享锁文件，
  不随正式版/dev/isolated profile 的 userData 改变。名字相同但目录不同也保守串行；
  导入别名、重命名等多名称操作按同一顺序获取，拿不到锁不变更文件。卸载覆盖物理源名
  及清理快照中每个发现别名；执行中的短期 lease 持有到本次清理尝试结束，未完成时以
  `pending/<名称哈希>/<token>.json` 持久屏障继续阻止冲突写入，直到清理完成。进程退出
  只回收短期 lease，不删除屏障；屏障只存操作 token 和名称哈希，不存用户路径或账号。
  锁只协调采用此协议的 Cindy 实例，不约束外部 CLI。
  后台扫描补链、孤儿注册清理及原生发现根的补链/断链清理也必须参与同一 lease，
  并在锁内重验注册快照及源/入口文件身份，不能根据锁外扫描结果直接写入。安装、
  导入、学习流程中的嵌套补链只复用当前异步调用链仍有效的 lease，释放要等借用者结束；
  独立窗口及释放后的迟到回调必须重新获取，拿不到锁的维护留待下次扫描。
  卸载持锁后的快照包含每个已知 scope 的同名兼容入口，覆盖 UI 扫描后刚完成的补链。
  自动同步的取消/失效清理同样获取 lease；锁被占用时交回既有重试流程，不当作清理成功。
  卸载在改动前将身份及副作用快照写入当前 profile 的 `skillhub/uninstall-cleanups`，
  先写回执、再建立屏障、再移到回收站；恢复不重放回收站操作，只按旧入口与目标身份逐项
  清理。注册记录在注册表锁内比较旧快照，来源恢复或替换时保留其链接、注册与偏好。
  清理完成状态必须先落盘，随后才移除屏障及回执；最终删除失败只重试收尾，不重放清理。
  窗口导航/关闭只撤销授权，不删除回执。`skillhub:scan` 可选返回当前 profile/data owner
  的 `pendingCleanups: [{ token, name }]`，并向当前窗口重新发放重试授权；不同窗口互不
  覆盖授权。此字段不开放远程管理能力。
  卸载遇到目录大小写变体时按实际文件身份匹配清单，并使用清单原始名称清理记录及自动同步偏好。
  原子编辑的 `*.xdt-tmp` 和重命名的 `SKILL.md.xdt-rename-<UUID>` 是内部保留文件，
  共用 `packageIgnore` 从浏览、哈希、发布快照与 ZIP 中排除；即使备份清理被文件锁阻止，
  也不得上传旧内容，不因清理失败回滚已经提交的重命名与偏好。
- `scope=market|team` 是公开与组织目录的通用读取上下文；列表得到的 scope 必须贯穿详情、
  文件、版本、扫描、下载、Learn 和批量同步。同 slug 在不同 scope 下是两条独立远端记录；
  但全局 Skill 发现路径仍按 slug 只有一个安装槽，自动同步配置重复同一 slug 时由首个有效项
  选定该安装槽的目录来源，不得尝试把两个 scope 同时安装到同一路径。
- Desktop 与 Mobile 的 `/learn hub:<slug>` 兼容语法统一归一为 `market`；目录来源明确时使用
  `/learn hub:<scope>:<slug>`，并把 scope 原样传入 Learn 请求和后续文件读取。
- 单条详情、批量同步等原生管理读取省略 scope，不得把省略值当成 `market`。本地 registry
  对已发布旧版客户端遗留且缺少 scope 的安装记录一次性回填为 `team`；新记录显式保存
  来源目录，原生管理记录则以逐条迁移标记保留缺省 scope。迁移状态不得只存在 manifest
  顶层，否则降级客户端新增的无 scope 条目在再次升级时无法被识别。
- `isMine` 表示归属当前个人或组织，逐 Skill 写权限只看服务端 `canManage`，客户端不得用
  账号级写能力与 `isMine` 推导管理权。
- 发布版本的 `/versions` 条目和 `/scan?version=...` 响应可附带 `rejectionReason?: string`。
  该字段由服务端按既有 `canManage` 授权，仅返回被拒版本的原因；客户端按目标版本展示
  人工反馈，并保留独立的自动扫描详情。旧服务端缺少该字段时继续展示状态与扫描结果，
  旧客户端忽略新增字段；与 `visibilityReview.reason` 的公开可见性审核含义互不替换。
  手动查看拒绝原因按当前拒审版本请求原生 `/scan`，版本、管理权限或账号代次变化后
  丢弃迟到响应并隐藏旧反馈；发布轮询绑定启动时的账号代次，在账号切换期间或代次
  变化后停止请求与事件派发，不能将前一账号的审核反馈带入后一账号。
  `/scan` 与 `/versions` 的 Desktop IPC 同时校验可信顶层 sender、参数类型／长度／目录枚举，
  并在账号切换后丢弃在途响应。人工拒审原因只对应原生 `rejected`；`failed` 的处理失败和
  旧扫描状态 `blocked` 不代表人工审核拒绝，不应套用人工反馈文案。
  市场预览中可管理的拒审或处理失败版本也省略目录 scope 走原生管理读取；目录读取仅开放已批准
  版本，普通目录扫描仍保留原 scope。发布进度推送逐帧验证接收窗口为可信应用页面，
  不向辅助窗口或已导航到外部内容的窗口发送私有反馈。
  推送附带可选 `ownerStamp`（复用 `DataOwnerPushStamp`）；接收端同时校验 Skill 和账号代次，
  丢弃已在 IPC 队列中的旧账号事件。弹窗在异步刷新后及交付结果前再次校验账号代次。
  整次发布在首次异步身份读取前捕获发起账号代次；提交成功后的本地对账保留成功语义和
  原发布者身份，但过期发布不再派发进度或启动轮询，也不能停止新账号已启动的轮询。
  进度回调与 IPC 标记之间同步复核发起代次，不能给旧发布重新标上当前账号。
  认证区域变化也是代次边界，即使 membership ID 相同：显式登录、恢复和运行期刷新
  均推进 owner generation，主实例与共享 userData 的被动实例一致；同区域普通刷新不推进。
  区域、令牌与代次同步提交时立即发送新认证快照，不等后续迁移或投影收尾的 await；
  即使同 owner 的稳定投影不进入 teardown 边界，新区域请求返回前也已发布新代次。
  显式登录的主实例先清理上次登录的灰度标记，再提交并推送新认证快照；被动实例
  继续只读共享配置，不替其他实例清理持久标记。
  因此现有请求 scope 与推送 stamp 即可拒绝旧区域反馈，无需修改 wire 字段或持久账号键。
  已打开的自动结果也保存 owner snapshot，在新代次的首次渲染中隐藏旧反馈；同 ID
  跨区域切换不依赖按 dataOwnerId 重挂路由，普通同代次刷新仍保留当前结果。
  发布弹窗同样绑定打开时的账号代次；跨代次立即隐藏并关闭，旧发布 IPC 的成功、失败、
  异常返回和等待中的提交／取消确认均失效，不能让新区域的弹窗进入旧发布的扫描阶段。
  本地改名在 IPC 入口捕获完整账号 scope，在扫描授权等待后及持有文件锁实际变更前
  复核；旧代次不能写盘。已经提交的改名仍是有效本地事实：同本地 owner 跨区域时，
  仍挂载的详情页保留并交付新路径（包括迟到的成功回执）以修复导航，但不继续旧发布；
  不向不同 owner 或已经卸载的详情页交付，刷新导航期间也复核本地 owner。
  旧接收端忽略新增元数据，旧的无标记事件沿用现有兼容读取；首次发布的同版本拒审例外
  仅适用于 `rejected`，不能把处理失败 `failed` 或旧扫描失败 `blocked` 套进该例外。
  人工拒审原因缺省时始终明确提示缺省，即使已有自动扫描失败项；扫描发现继续独立展示，
  不能替代审核方提供的拒绝原因。管理读取失败版本不会改变其原始状态或套用人工拒审文案。
  `/scan` 读取失败与“已拒审但未提供原因”分开：详情和预览均回退为状态暂不可用，
  不因请求失败合成 `rejected`；成功读取的旧记录仍保留真实状态与缺原因提示。
- Skill 标签全部由 Platform 管理；客户端通过 Skill Tab 已有的 `/categories` 能力获取可选标签，
  发布和编辑时只在兼容字段 `tags: string[]` 中提交已存在的稳定 slug（可为空数组），不提交标签名称或多语言内容。
- 服务端返回的 `tags` / `categories` 字段继续保持 wire 兼容，客户端不得再引入作者标签语义。
- Cindy Skill Hub 客户端与服务端在首次对外发布前同步收紧以上契约，不为未发布过的中间
  协议增加 fallback；已经发布的旧客户端仍使用原有 XD Skill Hub endpoint，不受此契约影响。

## 2. 插件来源

- 客户端不包含内建插件种子，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与用户主动安装流程。

## 3. Ghost manifest 与 Cindy 专属界面能力

- `ghost.json` 的跨消费者字段、v2 兼容映射与枚举属于 Ghost manifest 协议，客户端正本位于
  `packages/plugin-protocol/src/manifest.ts`；Desktop 在
  `apps/desktop/src/shared/ghost.ts` 维护运行时 validator。除明确登记的 Desktop-only
  能力外，两份实现及相同的有效／无效 fixture 必须同步，作者契约同时写入
  `FORGE_GUIDE`。
- `mainView` 是通用的 Cindy Host 界面能力，不是 `xd-sites` 专用 API；v2 的 `main-view`
  只保留输入兼容。协议中不出现 `xd-sites` 的端点、OIDC 流程或业务模型。具体插件可通过
  其它已声明且经运行时守门的能力调用自己的服务，基座只负责声明校验、导航和沙箱承载。
- `mainView.icon` 是主视图入口的 Host 系统图标枚举，只作用于该入口；根级 `icon` 仍是插件
  品牌图片协议。字段白名单、默认回退与完整枚举见 `FORGE_GUIDE` §4.20，不能用图片路径或
  未声明别名绕过枚举。
- 如果 Plugin Market／服务端仓会解析或严格校验新增的 manifest 字段／枚举，发布使用新能力
  的插件前必须同步其本地 `plugin-protocol` 实现；这不要求 Cindy 客户端运行时依赖服务端，
  也不改变两仓独立发布边界。

## Review 清单

1. 改动是否触及跨端 wire protocol？是兼容独立升级，还是需要协调窗口的不兼容变更？
2. 两仓本地协议实现是否保持兼容，旧端降级行为与分阶段发布顺序是否明确？
3. 是否把本可归属业务仓的代码放进协议 package，扩大了不必要的耦合面？
4. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
5. 插件能力是否通过 `.cindy` 包和 SkillHub／手动安装分发，而不是重新引入预装、播种或
   绕过插件权限边界？
6. 修改 Ghost manifest 时，协议正本、Desktop 镜像、`FORGE_GUIDE` 与相关测试是否同步？
   若服务端严格校验该字段／枚举，发布顺序是否已协调？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容。


## Model Registry V3：权威协议与旧端下发

- 权威协议位于 `model-registry.json` 的逐模型 `nativeApi`，与窗口、参考价和输出上限同目录维护。`nativeApiRules` 仅按指定 providerId + modelIdPrefix 覆盖未来家族成员；精确声明优先，显式 null 表示待核实，退役项禁止继承家族规则。跨厂商不根据同名猜测。
- 新客户端请求 `/api/model-catalog/catalog?registrySchemaVersion=3`。V1/V2 继续可读；Server 任意版本缺少某条原生协议时，使用 Cindy 本地声明。V3 的明确协议修正、显式 null 与退役优先；删除字段或遗漏规则不再清空本地协议知识，撤销须用精确条目的 null／retired 表达。仅原生协议作此字段级补全，价格、窗口、可用性与完整目录的 revision、LKG、冲突拒绝仍用既有策略。
- Server 支持 V3 后，仅给明确请求 V3 的客户端返回 nativeApi/nativeApiRules；无参数／V1／V2 请求必须返回旧版本并去掉新字段，ETag 按实际响应格式隔离。不得直接把 V3 制品目录原样发送给旧客户端。
- UI 的 CatalogModel.nativeApi 是主进程按实际 provider/model 投影的结果。Pi 的 piApi 是执行配置，不能反过来当作模型原生协议。界面只展示简短的协议名、原生支持／兼容模式，不展示目录实现与抓包说明。
- 默认开关按原生协议与 Harness/出站协议比较：兼容路径默认关闭；已有用户显式偏好优先。逐引擎服务端显式 defaultEnabled 保留策展覆盖能力。Google 原生模型推荐 Pi，Messages 推荐 Claude Code，Responses 推荐 Codex，Chat Completions 推荐 Pi；推荐必须在可用候选内。
- 此客户端改动不代表 Server 已部署 V3。发布目录前须验证旧客户端降级、新客户端 V3、更新/撤销/冲突与相应 ETag 四项；不能只修改 bundled 数据宣布线上生效。

### Cindy 本地协议声明的维护（2026-09-05）

`packages/model-providers/catalog/model-registry.json` 的 `nativeApi` 与 `nativeApiRules`
也是客户端执行策略的本地基线，不依赖 Gateway 提供原生协议。Pi 的
`catalog/pi-model-catalog.json` 和官方运行时内置模型表用于核对协议及 serializer 参数；
核实后写入 Registry，不在 UI 中反推 Pi 配置。Gateway 的 `perAgent.pi.wireProtocol`
仅是末级执行提示，不能覆盖本地已声明的原生协议，也不能填充 UI 的原生协议字段。

| 已核对的本地模型家族 | Cindy 原生协议基线 | 本地参考 |
| --- | --- | --- |
| Claude、MiniMax | Anthropic Messages | Pi 原生 provider 表、现有 Cindy 直连配置 |
| GPT、Grok | OpenAI Responses | Pi 原生 provider 表、现有 Cindy 直连配置 |
| Gemini | Google Gemini | Pi 原生 Google provider 表 |
| DeepSeek、Qwen、Kimi、GLM | Chat Completions | Pi 本地目录对应 provider；不使用同名聚合商条目 |
| 腾讯 HY | Chat Completions | Cindy 原有 HY3 协议声明；Pi HY4 的协议记录交叉核对 |
| Muse Spark | OpenAI Responses | Cindy 原有 Muse Spark 1.2 声明；Pi 同型号协议记录交叉核对 |

新增家族规则仅匹配指定 provider 路由与命名空间，不能扩到任意 BYOM 或同名聚合商。
精确条目可覆盖家族规则。当前本地维护的 Registry 条目均有显式协议声明；
Seed 2.1 Pro 按火山方舟官方示例选择 Chat Completions 为 Cindy 的标准接入协议，
依据与全路由覆盖验收见 model-catalog-maintenance.md。
价格、窗口、推理档位不随此次协议补全修改；协议默认开启策略仍保留用户显式覆盖。
