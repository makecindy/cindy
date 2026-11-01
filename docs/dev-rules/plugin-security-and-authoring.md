# 插件运行时安全与作者契约

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改插件（`.cindy`）的运行时、沙箱、权限、能力声明、面板供片、
> 网络／凭证／文件交接，插件作者可见的身份卡、管子协议、打包与编写手册，或批准状态、
> 安装布局、指纹格式等**存量安装读得到的任何东西**之前

本文治理 Cindy 中运行的插件——以 `ghost.json` 为身份卡的 `.cindy` 包。它约束三件
互为支撑的事：**运行时权限安全**（宿主如何隔离并授权插件）、**存量插件兼容**（升级
不得让用户已装的插件失效或需要重装）和**作者契约同步**（改了作者可见的能力，必须同步
编写手册与校验）。Electron 进程与协议安全另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
媒体字节交接另见 [`media-storage-and-protocols.md`](media-storage-and-protocols.md)，插件在
产品中的定位见 [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)。

> **术语**：产品与对外措辞统一为「插件」，`.cindy` 即插件包；不再使用旧的概念称呼。
> 代码标识仍沿用历史 `Ghost` / `cindy-brain` 命名（目录 `cindy-brain/`、`GhostRuntime`、
> `ghost.json`、`cindy-ghost://`、`ghost_forge_guide` 等），与产品术语「插件」指同一事物；
> 引用代码时照实使用这些标识，不因措辞改写。

> **增量适用原则**：运行时沙箱与权限的安全不变量（下节 2–4）与存量插件兼容红线
> （下节 5）对**所有**触及相关路径的改动都生效，不因是存量代码而豁免。作者契约同步
> （下节 6）在改动命中作者可见契约时触发；不要求为统一形式专项重构无关存量。

MCP Apps 交互页面的 iframe 使用 `allow-scripts allow-same-origin allow-forms`。
`allow-forms` 只让页面收到 submit 事件；页面须 `preventDefault()` 后调用工具，由 Host 执行授权请求。
宿主前置代码在 window 冒泡阶段兜底取消默认提交，并令 `form.submit()` 不执行；整页替换后恢复监听，
避免未处理的表单把卡片导航到 CSP 错误页。此 JS 保护不替代 CSP 权限边界。
Desktop 本机、远程查看与 Mobile 的页面 CSP 始终保留 `form-action 'none'`，原生提交到任何地址均被禁止，
不增加网络或凭证权限。依赖此行为的页面要求执行端与查看端均为 `0.1.122-beta` 或更新版本。

## 事实来源

| 内容                                                 | 权威来源                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编写手册（作者唯一教材，现拿现读）                   | `apps/desktop/resources/system-skills/cindy-plugin-creator/`；`SKILL.md` 编排创建流程，`references/` 保存完整作者契约；`ghost_forge_guide` 兼容读取同一份资料                                                                                                                                                                                                                    |
| `ghost.json` 身份卡字段与校验                        | `packages/plugin-protocol/src/manifest.ts` 是跨消费者协议正本；`apps/desktop/src/shared/ghost.ts` 是 Desktop 运行时 validator。除下文登记的 Desktop-only 能力外，两端必须同步维护                                                                                                                                 |
| 管子协议类型                                         | `apps/desktop/src/shared/ghost.ts`（`cindy.send` / `cindy.onHostMessage` 类型）                                                                                                                                                                                                                                   |
| 打包限制                                             | `apps/desktop/src/main/cindy-brain/forge.ts` 的 `packGhostDir`                                                                                                                                                                                                                                                    |
| 运行时、沙箱进程与生命周期                           | `apps/desktop/src/main/cindy-brain/runtime/GhostRuntime.ts`、`GhostManager.ts`                                                                                                                                                                                                                                    |
| 安装事务状态、内容摘要与技能快照 receipt             | `apps/desktop/src/main/cindy-brain/ghostInstallReceipt.ts`，状态投影见 `shared/ghost.ts` 的 `GhostInstallApproval`                                                                                                                                                                                                |
| 能力实现（网络／通知／确认／文件系统／技能／宿主等） | `networkSlot.ts`、`notifySlot.ts`、`badgeSlot.ts`、`confirmSlot.ts`、`fsSlot.ts`、`cindySlot.ts`、`skillSlot.ts`、`agentSlot.ts`、`errandSlot.ts`；持久作品库见 [`plugin-library-storage.md`](plugin-library-storage.md)，主实现在 `libraryVault.ts`、`librarySlot.ts`、`libraryDbCore.ts` |
| 面板供片、注入主题 token 与协议                      | `apps/desktop/src/renderer/cindy-brain/ghostPanelTheme.ts`、`cindy-ghost://` 分支                                                                                                                                                                                                                                 |
| 插件详情能力说明 UI                                  | `apps/desktop/src/renderer/features/plugin/GhostPluginDetailView.tsx`                                                                                                                                                                                                                                             |
| 远程／手机版能力准入白名单                           | `packages/device-link/src/allowlist.ts`                                                                                                                                                                                                                                                                           |
| 行为与安全不变量                                     | `apps/desktop/src/main/cindy-brain/__tests__/`、`forge.test.ts`                                                                                                                                                                                                                                                   |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文与手册。

## 1. 插件形态与代码术语

- `.cindy` 是以 `ghost.json` 为身份卡的插件包，现行唯一形态为 `kind: 'chip'`。
- 代码目录与运行时使用 `cindy-brain` / `Ghost` 命名，**不得重新引入已退役的 cartridge
  声明型兼容层**。
- `cindy-` 保留为平台官方命名；`filo-` / `xd-` 可作为普通插件名称，名称本身不授予特权。
  旧官方资格只从升级时真实旧安装的可信批准与来源事实保留，换源后清除。企业 XD 宿主
  能力核对 namespace、当前组织与已批准包来源，不要求名称带 `xd-`。保留命名判据见
  `apps/desktop/src/shared/ghost.ts` 的 `isUserInstallReservedGhostId`。

### 1.1 服务端阶段与安装身份

客户端同时承接 S1、S2 关闭和 S2 开启，不根据是否收到 namespace 判断阶段，也不自造阶段开关。
S1 和 S2 关闭时保留旧认领与发布入口，由服务端执行命名准入；S2 开启后同一客户端可以
安装和运行自然命名的企业实例。namespace 缺失是旧协议待确认状态，只有显式 null 才是 root。
通过安装入口新装的 root 插件使用 `_ns/_root/<id>` 和 `_root__<id>` 数据键，企业新实例使用
`_ns/<namespace>/<id>`；`_root` 仅是目录保留名，root 的 namespace 仍为 null。
旧安装只原位确认 namespace，保留原目录与数据键；更新时也不搬迁。安装同名 root 不停旧企业插件，
不搬旧数据、凭证或界面引用。内置种子沿用既有布局。
namespace 迁移读取市场账本时区分缺失与损坏，损坏证据不能作为 root 或手动来源的依据。
普通账本写回也不得过滤并删除坏行，避免后续迁移把损坏事实误判为无记录。
断连的企业市场记录仍匹配原批准内容时保持 pending；恢复失败或常驻重试不能把它认作手动 root。
已完成迁移的旧 Forge 安装保留 namespace 与批准修订号；降级丢失 namespace 后，只在原批准、
Forge 来源及当前组织分类都吻合时恢复，不能据此认领普查后新装的实例。
同来源 Forge 更新先持久化原／新批准修订的桥接证据，提交和回滚都保留该旧实例的恢复资格。
旧组织身份缺少 orgSlug 时，发布先刷新已验签身份；仍缺失则从当前服务端市场的
currentOrganization 核对同组织、同 membership 与 owner 后补齐，不能把前缀当成 namespace。
`scope=all` 的企业部分被拒时，列表仍成功并带 `organizationAccessError`。客户端保留公开目录
和已安装企业插件，提示原因，不把这种情况当成「企业没有插件」，也不据此卸载。

安装、调用、项目启停、OAuth、媒体归属和卸载必须使用 Main 核准的实例键，不能用 URL host
或裸插件名选取同名实例。调度器只绑定可信 XD 企业实例；旧调用没有明确实例且同名候选
不唯一时，不默认选择 root。OAuth 连接在开始时绑定批准版本、owner 和实例，最终写入
仍在凭证锁内复核，身份变更后旧流程不得把账号写给替代实例。
面板和逻辑页的内存 session 绑定 owner 代次、批准版本及目录，协议注册事实不可原位复用。
旧页即使尚未被 Renderer 销毁，也不能在替换后发起新请求；异步响应返回前再次核对绑定。
外部请求保留 namespace 缺失／null／组织三态；选定实例后的内部复核、订阅队列、下载和
外链导航按物理实例定位，不再用裸名字重新选择。文件确认记忆及授权卡 adapter 绑定安装
身份，不能跨实例复用授权；身份或批准变化使旧卡失效，恢复卡先更新实例与交互版本。
普通 Setup 的 Connection 和 Secret 表单在创建时绑定安装批准版本，最终写入再次核对；
相同物理键和 manifest 不代表相同安装。持久 Bot 授权卡保存批准绑定，恢复时批准变化则
终结旧卡；缺少绑定的旧卡先绑定当前安装并提高交互版本，旧提交不能直接执行。
同批准版本的合法物理位置变化仍刷新卡片身份后恢复，不按换源处理。
新 root 技能快照的断链回收识别 `_ns/_root/<id>`，仍须核对受管根、root 身份和插件 ID，
不得覆盖真实目录或删除外来链接。
历史交互卡及手机插件资源只按持久化的物理实例键定位，实例消失后不得回退到同名逻辑身份。
手机 relay 和资源 fetch 复用该实例实际运行的批准版本分区，不能仅按 manifest id 构造分区。
手机资源 ref 使用物理实例键；PluginPageDocument.pluginId 仍是协议 host（manifest id），
不能拿资源 ref 拼协议 URL。资源 id 独立允许至 256 字符，覆盖最长 namespace 实例键，
手机列表与 Host 请求复用同一 ref parser；collection、kind 等其它标识仍保持原上限。

旧集成账号导入只允许仍有历史来源资格或可信内置资格的已批准原物理实例；
换源清除资格后，保留的旧凭证文件不得再次导入。OAuth 导入还须核对原提供方路径：
Google 直连仅使用确切的 Google token endpoint，Atlassian 仅使用原 jira broker。
面板关闭请求携带用户确认时的批准版本，Main 在停止运行时前及安装变更队列内复核；
迟到的确认不得停用替代安装。

同来源更新延续原实例与数据。真正换源时，安装事务把旧密钥、OAuth、连接、KV、私有文件、
Library、媒体、卡片归属、偏好、亲选目录、errand 会话映射及普通任务回执隔离归档；新来源不能自动继承。
任务回执的实例键在既有任务写入队列中归档，保留原任务、消息、成果和请求身份，并增加修订号使旧写入失效。
换源不继承旧任务能力批准；新来源即使重新获批也不能读取归档任务。同来源更新和原位 namespace 确认保留原归属。
旧包回滚时恢复旧数据和任务归属；中断恢复依据
receipt 的提交版本选择归档或还原，恢复未完成前保持隔离。普通升级迁移不属于换源，
不要求旧插件重新授权。归档不会把历史任务和面板改指向一个可运行的归档插件。
归档恢复与安装、卸载共用变更队列，并在回调前后核对 owner、journal 和 receipt；
归档与卸载统一先取得安装变更队列，再取得任务写入队列；任务存储就绪后重试未完成恢复。
换源归档的暂存上传除搬目录，还迁移库 meta、任务 manifest 和
未完成 intent 的实例归属，保留原任务、owner、校验和与文件字节；失败可按日志重放。
旧恢复任务不能覆盖后续重装。损坏批准的本地包仍可明确重装恢复，但不继承旧来源资格。
有在途工具、文件请求、网络请求或 AI 工作时先等待，网络请求从异步凭证准备起计入在途；
网络响应及媒体落仓全程复核入口绑定的安装批准与 owner。异步用户确认绑定原安装目标，不让晚到的结果
重建原键或授权给替代实例。资源迁移幂等重放现有安装日志，
中途失败保留日志与隔离，不能靠只存于内存的回滚闭包认定恢复完成。
已有安装／更新恢复日志时，后续更新或卸载不得覆盖该日志或解除隔离；已有卸载日志按原意图续跑。

Library 目录重命名必须有持久、owner 绑定的事务证据，重放校验原目录与授权根的文件身份
及绑定代次。目标目录已存在但没有本事务证据时仍拒绝，不得把它当作自己的已完成重命名。
换源归档及其预检严格读取 Library binding；读取失败、损坏配置或无效记录必须拒绝，不能按默认位置继续。
Library 请求同时绑定迁移代次和安装批准，根解析、排队及开库之后都复核；迁移结束清旗标
不恢复旧请求的资格，避免延迟请求在归档后重建原目录或阻断回滚。

### 1.2 Manifest v3 直接能力声明

- 新插件统一使用 `schemaVersion: 3`，并填写插件实际依赖的首个 Cindy 正式版本作为
  `minCindyVersion`。Manifest schema 不设置统一的 Cindy 版本下限；具体版本只属于插件包元数据。
  v3 **没有** `slots`；
  `tools`、`card`、`panel`、`mainView`、`taskView`、`subscribe`、`skill`、`cindy`、`agent`、`node`、`network`、
  `preview`、`mcpApps`、`browserExtension` 等顶层字段本身就是插件贡献项或自主 Host 能力的直接声明。
- `browserExtension` 是宿主承接随包浏览器扩展连接的直接字段（2026-10-27 由 Cindy Chrome
  插件自带接线进程迁入宿主）：`protocol` 必须是当前宿主实现的 `cindy-browser-extension/3`，
  `extensionIds` 是允许连接的扩展 id（装入时逐条展示并钉死），可选 `nativeHost{name,binary}`
  由宿主复制包内平台二进制并注册 Native Messaging：该程序在插件沙箱外运行且同一账号的所有
  Cindy 共用一份注册，宿主只为官方 Cindy Chrome（`my-browser`、`com.makecindy.browser`、
  声明了 Node 程序，且打包版里来自公共市场并与批准字节一致——清单 id 是自报的，不算身份；
  未打包的开发版视为官方）安装，其它插件的声明被忽略（2026-10-29 决定，宿主代码点名具体插件的唯一
  例外）；注册在没有任何运行中的 Cindy 仍在使用时撤销。可选 `pageControl: true` 表示扩展实现
  页面控制契约、可作为 Browser Use 的「我的浏览器」执行端；同样只有官方 Cindy Chrome 的声明生效，其它
  插件声明了也不会接管「我的浏览器」（2026-10-30 决定）。宿主代码里不得出现具体插件名
  或专有协议：桥接按声明启停（`cindy-brain/browserExtensionSlot.ts`），扩展发起的请求经
  `browser-extension-relay` 事件转交给声明插件，插件经 `browser-extension-request` 投递作业、
  推送配对身份。不设站点名单（2026-10-30 决定：安全交给任务的权限档位与自动审核，与专用浏览器
  一致）；旧插件仍推送的 `setPolicy` 照常应答但不生效。本机与私网地址和公网网站一样可访问
  （2026-10-28 决定）。「我的浏览器」的能力对齐专用浏览器（截图、上传、evaluate、控制台、
  网络事件、弹窗、坐标与拖拽、resize），底线只有不打扰用户（Agent 页面开在不抢焦点的 Cindy
  窗口、截图不切走用户正在看的标签页、resize 只动 Cindy 窗口）和防冒充；不限制 Agent 能力：
  扩展不按字段类型拦截，密码／支付／验证码输入框与其它输入框一样可以被执行端操作，其余风险交给
  任务权限档位与自动审核（2026-10-30 决定，共同规则见 [Browser Use](browser-use.md)）。这不放宽
  [代输入](../product-rules/input-handoff.md)边界：登录密码、验证码等需要主人填写的值仍由
  `ask_owner` 交给主人，主人填的值只交给宿主执行、不进模型上下文、工具结果与日志，任务权限档位和
  自动审核不能代替这条边界。Chrome 调试接口（PDF、读 Cookie、抓包等配方）
  按需申请可选权限：首次需要时在用户窗口打开说明页、十分钟内最多一次、用后断开，开关放
  扩展自己的选项页，不进 Cindy 设置；新增权限不得改变 Chrome 的安装提示（`<all_urls>` 可加，
  `tabGroups` 只能做可选权限）。Agent 操作的页面显示红光边框与「Cindy 正在自动操作此页面」
  标签，保持到最后一次动作后约 20 秒。新增 id 或新增 `pageControl` 视为权限变多，删减视为收权。
- 无配置的布尔能力只接受字面量 `true`：`notify`、`badge`、`confirm`、`fs`、`library`、
  `sessionContext`、`pick`、`workspace`。不用就省略，写 `false` 是无效清单。
- `card: {}` 与 `agent: {}` 分别表示基础卡片能力和由真实用户点击触发 Agent 回合；
  其它对象型能力必须至少包含一项真实能力，不能用空对象占位。
- v3 未识别的顶层字段，以及能力对象中的未知扩展字段、动作和订阅事件，必须原样保留，
  但当前 Host 不展示、不授权、也不因此阻止安装或发布。
  未来 Host 识别该字段后，才按正常的能力展示和运行时守门链路启用。不能把
  未知字段猜成现有权限，也不能让它意外获得能力。
- `mcpApps.ui` 使用 `resources[]`（作者指定唯一 `ui://` URI、包内 `file`）与按原工具名声明的标准 `_meta.ui`。资源 `file` 不透传；`domain` / `permissions` 仅校验保留，不授予权限。资源 URI 单独改名不算扩权，新增资源、页面域名或 app 可调用工具仍按安装批准规则处理。旧宿主保留未知顶层 `mcpApps`，不授权。
  新包上传、Forge 打包和本地包安装严格校验 UI 资源文件；已存储 Release（含市场默认下发）、
  已安装快照分享及启动读取遇到缺失、目录、链接或超过 4 MiB 的资源时，只移除运行时/确认投影的 UI，普通工具继续可用。
  原始清单与签名/摘要不改写；Host receipt 的可选 `unavailableUiResources:true` 仅记录历史包资源无效，
  不授予权限，不改变 receipt 版本。旧 receipt 无该字段时仍读取，并按实际文件收窄 UI。
  分享和导出已有插件沿用存量校验；重新上传提审仍严格校验并返回具体原因。页面不可用时，模型结果仍按原批准声明移除根 `_meta`，不恢复页面授权。
- 顶层 `showTaskPreferences?: boolean` 由每个插件在自己的 manifest 声明。
  省略或 `true` 保持该插件的卡片配置、权限限制和执行规则；`false` 隐藏该插件的 Desktop/手机卡片，
  且运行期不读取、不使用、不回写其模型、目录和权限配置。旧数据保留，重新启用后恢复。
  此选择仅影响声明它的插件，不影响其它插件或全局设置。隐藏字段本身不授予宿主能力，
  能力批准、账号、任务归属、目录与 Session/Plan 校验继续执行。
  隐藏插件的新任务权限由插件参数决定，包括完全访问；不增加独立权限上限或逐次宿主确认。
  旧 Host 可能只隐藏 UI；依赖停用语义须使用实现此契约的 Host。
  实现见 `getPluginTaskDefaults`、`ghostPluginViewModel.ts`、`mobilePageService.ts`；作者用法见 `FORGE_GUIDE` §4.8。
- `agent.tasks` 另需 Host receipt 的显式任务能力批准事实；旧 receipt 没有该事实时，
  只在首次任务能力调用通过既有宿主权限界面确认，原插件的启用态、其它能力、凭证和
  设置保持不变。拒绝、窗口不可用、账号或安装版本变化均不授予任务权限；同能力更新
  保留既有明确批准，移除该能力后不保留。清单或旧未知字段本身不能补写批准。
  批准后，插件创建的任务及 Worker 中的 Agent 按普通任务的权限使用已连接工具；
  创建回执仅约束插件直接管理该任务，不参与任务内 Agent 的工具权限判定。
  插件直接调用 `cindy.tasks` 仍只管理本插件的任务。
- `agent.targets` 必须与 `agent.tasks: true` 同时声明，独立列出 `agent:targets` 权限并要求 Host receipt 的 `targetCapabilityApproved` 显式批准。
  可查询本机项目、任务和伙伴的目标元数据，并投递文字/图片；该接口本身不授予其他任务的历史读取、设置修改或停止权限。
  安装/更新复用既有权限确认；历史 tasks 批准和未知 targets 字段不能自动扩权，缺新批准时只阻止新目标接口，首次调用复用既有宿主确认。
  实现与作者契约见 [通用投递目标](plugin-task-api-implementation.md#通用投递目标增量接口尚未发布)。
- `agent.observe` 是独立能力，不依赖 `agent.tasks`，单列 `agent:observe` 权限并要求 Host receipt 的 `observeCapabilityApproved` 显式批准。
  只读返回已登记本机项目中任务的标题、Agent 类型、归档与状态元数据，并可在主窗口打开其中的任务；不返回消息、计划或文件，也不能发送、修改或停止任务。
  旧 tasks/targets 批准与历史未知字段不授予查看；首次调用复用既有宿主确认。实现见 [只读查看项目任务](plugin-task-api-implementation.md#只读查看项目任务增量接口尚未发布)。
- `agent.hiddenTasks`（后台任务）只在与 `agent.tasks: true` 同时声明时有效：新包缺 tasks 或非布尔
  直接拒装；已安装快照里不成对的历史值原样保留但不授予。它单列为 `agent:hidden-tasks` 权限，
  更新新增即「权限变多」；运行期由 taskSlot 与任务服务按身份卡双重守门。透明性兜底与多端口径见
  [`plugin-task-api-implementation.md`](plugin-task-api-implementation.md)「后台任务」。
- **Agent 在途调用不需要重复登记具体操作。** 插件工具是否执行由当前
  `ghost_call` 的 Cindy Agent 授权决定；普通网络和当前工作目录操作使用主机
  下发且仍在途的 `callId`。随包代码与 CLI 继续使用已有 Node 工作进程，顶层
  `node` 字段只声明这一运行形态，不预登记具体命令。不得为具体 CLI、域名或路径
  新增 Slot、manifest 字段或客户端特例。只有插件要在 Panel、订阅、常驻进程、
  后台任务等**脱离当前 Agent 调用**的场景自主使用 Host 能力时，才需要
  对应直接字段。需要 Cindy 尚未实现的真正新 Host 服务时，才提高
  `minCindyVersion` 并增加客户端实现。
- `schemaVersion: 2` 只作存量兼容。Desktop 在验证边界把已知 `slots` 显式映射为同名的
  v3 直接字段；运行时只消费规范化后的直接字段。未知但格式合法的 v2 slot 不阻止安装，
  运行时也不授予任何能力。未来支持必须新增明确映射，不得按名称猜测。
- v2 的空 `slots` 和历史零能力声明可继续安装，规范化时直接丢弃。v2 → v3 更新按规范化
  后的直接能力比较；只删除 `slots`、能力等价时不算新增权限。
- 安装／更新前向用户确认插件声明的权限（2026-09-25 用户裁决，取代此前「安装不设能力
  确认弹窗」的做法）：首次安装一律确认；更新只在新版本权限变多时确认；服务端
  `defaultInstall` 下发的插件首装与后续更新都不确认。判据、入口与落位前复核见第 3.1 节。
  确认只决定这次安装／更新是否进行，不是运行期授权：插件自主 Host 能力仍须在 manifest
  如实声明、在插件详情展示，并由 Host 运行时强制守门；动态资源与 Agent 在途操作不重复
  建权限实体，继续复用 Cindy 既有 Agent 授权系统，不新增 grant／申请状态机。

## 2. 运行时沙箱与进程隔离

- 每个运行中的插件使用独立 Electron 沙箱进程与按 owner × plugin 隔离的内存 session
  partition。同插件的 `settingsHtml`、panel 与逻辑页继续共享该 partition，保留 browser
  storage 与 `BroadcastChannel` 契约；沙箱禁止直接访问 Node、宿主文件系统和通用网络，
  唯一例外是第 4 节明确限定的 HTTPS 图片资源。
- 插件只允许读取自身安装目录内、经安全相对路径校验的静态资源，不得越权读取其它目录。
- 逻辑页只能经最小 `contextBridge` 管子申请主机能力；面板 webview 保持零特权桥。
- 主机按 `webContents` 绑定反查真实 ghostId，**不信任 sender 自报身份**。
- 沉睡、抽离和主机退出必须终止对应沙箱；沙箱崩溃只由 `GhostRuntime` 收敛，不得带崩
  主应用。
- 声明 `node` 的插件另有独立 Node 工作进程，拥有当前系统用户级本机能力，不属于
  上述浏览器沙箱。参考 [VS Code 的本地扩展权限模型](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)，
  macOS 以 `disclaim: false` 创建插件 Node 工作进程及宿主代启的 Node 子进程，保留
  宿主的 TCC 责任归属，为插件开放底层系统能力；具体访问仍由系统授权、签名和用途声明
  决定，不自动授予宿主尚未取得的权限。实现见 `nodeRuntimeBroker.ts` 的
  `createUtilityNodeWorkerProcess`。浏览器沙箱、Host 能力守门和宿主环境变量过滤继续生效。

## 3. 权限即授权边界

- 先判断**谁在执行**，再判断授权边界：
  - 当前 Agent 在途 `ghost_call` 是否执行插件工具，由该会话既有的 Agent 授权决定。
    普通网络和工作目录操作以 Host 下发的严格在途 `callId` 绑定会话；随包代码与
    CLI 仍由已有 Node 工作进程执行，不新增 Host 进程协议或具体命令登记。
  - 插件脱离当前 Agent 调用的自主 Host 能力，必须先在 manifest 以对应顶层字段
    直接声明，通过校验，在插件详情中如实展示，再由 Host 代码强制守门。
- Agent 调用必须同时满足：`callId` 尚在途、绑定同一插件、绑定本地会话。已交卷、
  他插件、scheduler 脚本、Panel 和后台调用都不得借此绕过自主能力声明。
  对未声明公网目标，Host 必须在每一跳完成代理选择与 DNS/IP 守门后、真正 dispatch
  前再次复核同一 `callId`；直连与系统代理都只能连接该次守门确认的 IP，代理不得
  重新解析插件提供的域名。选中代理不构成私网授权；无法证明由当前代理生成的 fake-IP
  仍按特殊用途／私有地址拒绝。
- **控制节点（2026-10-31）**：Host 预埋的 `will-` 拦截点目录在 `shared/ghost.ts`
  `GHOST_CONTROL_POINTS`，新增节点 = 加目录项 + 在对应流程按任务配置调用 `screenGhostControlPoint`，
  插件不需要 Host 再发版。四条不变量：只问用户在该任务里选定的插件（定时任务 / 例行任务的
  `preRunPlugin`），不是装了就管所有任务；插件只能收紧（allow 只表示不反对，不能替用户批准）；
  出错处理（没装、停用、超时、崩溃、熔断）由用户按任务设置，插件不能自报；只有 receipt
  `approvedControlPoints` 记录的节点可被任务选用——批准来自安装/更新确认里实际显示过的权限行，
  旧 receipt 缺字段视为未批准但插件照常可用，提前声明 Host 当时不认识的节点不会随 Host 升级
  静默生效，下一次更新会把它作为新增权限复核。随包种子与服务端默认安装视为已批准声明的节点。
  `will-start-task`（新任务选模型）是唯一能回 `route` 的节点：只在本机新任务第一条消息发出前、
  用户在模型选择器里选了这个插件发布的模型时询问一次，任务中途和伙伴任务都不问（换模型会让提示缓存失效）。
  Gateway 只保留 route 的 `agentKind` / `model` / `providerId` / `effort` 四个字段；Main 再按当前已连接、
  可用于新任务的模型核验（档位不合法先去掉档位），不合格、超时或出错都沿用用户原选的模型。
- **插件提供的模型（2026-11-01）**：清单 `models.types` 声明能力，列表经 `PUT /models` 运行时发布，存在插件自己的
  `/kv` 之外，读时重新校验。`route` 模型必须声明 `will-start-task`，节点批准后才显示；选择器只读落盘列表，
  不调用插件，文案全部来自插件。`route` 模型不进执行目录。
- 安装／更新确认只决定这次落位是否进行，不以弹窗点击作为运行期能力授权事实；
  **prompt 和前端展示都不构成运行期安全边界**。确认结论由 Main 在安装锁内按真实包复核，
  不能由 Renderer 或 Agent 自报（第 3.1 节）。
- 新增或修改能力声明时，除同步编写手册与校验（下节 6）外，还必须同步 shared 类型、
  preload／host handler、详情能力 UI（`GhostPluginDetailView.tsx`）、错误边界和测试。

### 3.1 安装与自动更新

插件通过 `tasks.create` 指定任务目录、通过 `setTeamPlan` 登记批次目录时，Host 仍核验插件配置和目录选择记录；Library 绑定和批次计划本身不授予目录权限。任务中的 Agent 使用公共 Orca 工具创建 Worker 时，沿普通任务的目录、模型和运行位置规则，不因任务由插件创建而添加目录或跨设备限制。创建期间仍复核当前账号与任务操作凭证；失败沿既有 Worker 清理和团队收尾流程，不构成跨持久化与派发的事务。实现及回归见
`apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts`、`register.ts` 与 `__tests__/orcaWorkerCreationService.test.ts`。
插件批次目录在文件系统查询前拒绝 UNC/device 路径，并按宿主目录记录核验候选路径；不通过探测未登记别名发现授权目标。本地 Windows 盘符长路径保留支持。解析后仍复核真实目录；这不构成执行隔离，也不能阻止已授权目录内的链接置换。

- 首次安装只来自明确依据：用户导入本地 `.cindy`、明确要求当前 Agent 调用
  `ghost_forge_install`、用户点击某个市场条目的安装、当前 Agent 按用户请求与既有操作授权
  调用 `ghost_market_install` 安装选定的缺失插件，或服务端为当前 owner 下发
  `defaultInstall`。安装成功默认启用。
- **安装／更新确认**（`shared/ghostInstallConsent.ts` 判据，`main/cindy-brain/ghostInstallConsent.ts`
  两段式实现）：
  - 判据：「权限」与插件详情页权限区同口径，即 `ghostPermissionItems` 中除 Agent 工具外的
    全部条目。首次安装展示全部权限并确认；更新相对当前已装版本按 `diffInstalledGhostPermissionItems`
    比较，新增条目、同 key 条目内容变化或内置 OAuth 客户端变化才算权限变多，只删除不算；
    已装版本没有有效批准基线时按全部权限新增处理。
    邮件的 `mail`、`mailReader.tool`、逐个 reader host 和 `markRead: true` 分别进入权限投影；
    复用既有工具也不能隐藏新增邮件能力。域名重排／去重不算扩权，只移除邮件能力不要求确认。
    同一投影用于插件详情、首装与更新确认；不新增批准记录或要求存量插件重新配置。
  - 入口与确认界面：插件页、拖入、双击 `.cindy` 与设置页导入由发起窗口弹确认框
    （`GhostInstallConsentWindowBridge` → `GhostInstallConsentHost`，只投给、也只接受发起安装
    的那个 webContents）；Agent 调用 `ghost_market_install`／`ghost_forge_install` 不论任务权限档
    （含 Full Access）都向调用所在任务投宿主权限确认卡（`permission` 交互 +
    `hostOwnedConfirmation: 'plugin_install'`，经 `requestHostInteraction` 路由），桌面对话、
    手机远控与 IM 渠道卡都能处理，旧版手机无需升级。用户拒绝返回 `MUTATION_CANCELLED`，
    Agent 不得自行重试；确认界面不可用时 fail closed。
  - 两段式：确认在任何安装锁、来源锁与 owner 租约之外求得（等待期间不阻塞其它插件）；
    落位前在按 ghostId 的安装锁内用即将落位的真实包、现读受体 receipt 与确认前钉住的包摘要重算
    （`assertGhostInstallConsent`），确认后权限面、已装版本、受体 receipt 或包字节变化就拒绝；
    用户确认过的更新不能因为受体已被换成权限已覆盖候选包的版本而静默落位。自定义市场在
    来源 cache-path 租约内只打包，释放租约后再求确认；提交时仍复核来源。Forge 在 packing
    租约内捕获 owner 并传入装入入口，等锁结束后若账号已切换则拒绝取租约。每条装入路径都
    必须显式交出确认策略（`prompt`／`automatic`／`exempt`）或锁外求得的结论，签名上必填，
    新增路径无法漏掉。
  - 服务端 `defaultInstall` 插件（首装、组织默认接管与之后的自动更新）按下发方决定，
    策略为 `exempt`，不向用户确认。豁免只绑当前用户对该条目的默认下发资格：目录标
    `defaultInstall` 且该用户没有仍生效的 default-install opt-out。只有用户显式卸载写
    opt-out；用户之后显式从市场安装或更新（插件页、Agent 安装确认卡，即确认策略 `prompt`）
    并落位成功，即视为重新订阅，与安装记录在同一次账本写入里清除该用户对此插件的 opt-out，
    此后扩权更新恢复免确认。落位失败、回滚或用户拒绝确认时 opt-out 保持不变；`automatic`
    与 `exempt` 路径（后台更新、默认安装、组织接管）不清除，自定义市场不涉及。旧版本遗留的
    「已安装 + opt-out」（旧版重装不清 opt-out；早期同步扫描、本地／Forge 换源误写的
    opt-out 在之后重装或断开路由恢复后也落成这一状态）由维护对账修复：账本记录仍为已安装的
    `market`／`legacy-adopted`、带清单摘要，已装包已批准且原始 manifest 与记录一致时，按
    捕获的记录 compare-and-write 清除。未安装记录上的 opt-out 无法与真实卸载区分，一律保留；
    缺清单摘要的旧记录不足以证明包身份，也保留；记录在对账期间被并发卸载改变则不清除。修复
    逻辑幂等，不新增账本字段或持久标记。仍有 opt-out 的服务端插件扩权更新必须确认。
    **交互页面同样随下发方静默授予**：合法默认首装、组织接管、同源更新和仍具默认资格的恢复，
    在真实包的安装批准事务中一并写入 `uiCapabilityApproved`，不另弹页面确认、不出待确认提示条。
    旧 Host 安装缺该事实时，只有当前默认资格、来源账本、已批准实例与包身份均匹配，才通过
    同一市场更新事务重新校验当前 Release 并补齐；保留启停态和同来源数据。落位前复核 owner、
    实例、批准 revision 与退订资格。没有有效安装 receipt 的后台恢复仍拒绝。
    普通市场手动安装、自定义市场、本地 `.cindy`、Forge 以及已失去默认资格的插件仍走原确认流程；
    市场审核结果、展示 manifest 或内置种子身份不能替代服务端默认下发资格。实现与真实 receipt
    组合回归见 `main/plugin-market/service.ts`、`main/cindy-brain/ghostInstallConsent.ts` 及对应测试。
- 市场安装账本是后续更新来源的唯一事实：服务端市场按 `pluginId + releaseId` 路由，
  任一来源账本文件存在却损坏时，读写都必须拒绝，不得把其它来源的记录当成完整视图重写并覆盖损坏文件。
  自定义市场还必须匹配 `sourceKey`；已装目录的原始 `ghost.json` 字节 SHA-256 必须与账本
  一致。旧记录缺少 raw 字段时，Host 只能按已发布的 legacy digest 编码核对同一份受限读取
  的字节，命中后原地补字段且不改 `updatedAt`；raw 字段已经存在但不匹配时必须 fail closed，
  不得用当前目录覆盖基线。`manifestDigest` 保留旧语义供降级客户端读取，不能改写成 raw SHA。
  无账本的旧前缀认领还须具备已完成历史迁移、无包哈希的批准回执及匹配的已批准 manifest；
  Forge、现代重装回执和已知 namespace 不匹配的安装不能仅凭前缀自动认领。
  同 id 来源冲突或目录漂移通常不得被自动覆盖，只能由用户显式选择替换来源。唯一受控例外是：
  当前组织下发 `defaultInstall`、组织与合法非空前缀都精确匹配、同 ghost id 在目录中唯一时，
  可以接管无有效市场来源的普通本地安装，或修复同一目标 `pluginId` 的坏 market / legacy-adopted
  记录。接管仍要求现有 receipt 已批准、未显式卸载退订、插件不忙，并在落位前于 ghost id 锁内
  重读 owner、来源、批准与退订事实；不得覆盖有效的公开／其它组织市场路由或 Git／本地自定义
  市场路由。`ghost_forge_install` 的首装与更新一律记录 `agent-forge`，作为作者本地自测保护，
  不进入自动接管；普通 `.cindy` 导入仍是 `manual`，不享受这项保护。自动接管不得复用用户手动
  换源的退订语义，不写 `markRemoved` 或 default-install opt-out。普通本地／Forge 换源只把
  旧来源记录置为 `installed=false`，不得新增或清除 opt-out；只有用户显式卸载才写 opt-out。
  清除只来自显式市场安装／更新成功、历史断开路由的恢复与上述「已安装 + opt-out」修复；
  换源落位前失败的回滚只恢复原有 opt-out 状态。
- 仍匹配稳定来源的已装插件自动更新，不限 public／organization；更新保持现有启用状态，
  不弹成功 toast；插件正有调用、派活或 Cindy 工作时跳过，下一轮重试。权限没变多的更新
  静默完成；新版本权限变多时（按下载后的真实包判定，策略 `automatic`）放弃本轮、不记失败、
  不退避，同一 release 在当前进程内不再重复下载，旧版本照常可用；市场条目带
  `updateRequiresConsent`，插件页标出「需确认新权限」，用户点更新时再弹确认。Renderer
  目录走延后对账时，记下新 hold 后立即通知重投影，不等无关前台刷新。自定义
  市场暂停记录同时钉住 release 与包内容指纹，同版本包被改掉后必须重新判定。仍具备
  默认下发资格的服务端 `defaultInstall` 插件不受此限，权限变多也静默更新。
- 服务端市场按客户端版本投影最近发布、曾上架且仍有效的兼容
  Release；current 不兼容时回退兼容历史版本，没有兼容版本时不展示。Desktop 信任该投影，
  不再用 `minCindyVersion` 二次筛选、跳过或弹兼容性确认。自定义市场和本地 `.cindy` 采用
  同一安装策略：`minCindyVersion` 是发布／发现元数据，不是客户端安装授权或确认闸门。
  真实包身份、Release 摘要、能力上限、Manifest schema 与当前 Host 是否能解析仍按各自
  安全边界校验，不能把包内容异常降级成“仍要安装”。
- 自动对账在 owner 稳定后的启动／登录切换、应用回前台、系统唤醒和 30 分钟周期触发。
  不新增持久化任务队列或“是否自动更新”设置；卸载写下的 opt-out 继续阻止默认安装复活，
  直到用户再次显式从市场安装。
- 当前组织的历史市场安装即使已指向当前 release，也须恢复遗漏的来源证明：有效批准与
  原始 manifest 仍匹配更新路由，且已完成旧迁移但缺包 SHA，或 `legacy-adopted` 记录与
  批准包 SHA 一致时，通过同一市场更新事务重新下载、校验并原位落位。仅补来源字段不能
  代替包验证；Forge、显式 SHA 冲突及不匹配的组织／来源不进入此恢复。沿用更新确认、
  忙碌跳过和失败退避，保留启停态、实例键和同来源用户数据。实现与回归见
  `main/plugin-market/service.ts` 及其 `__tests__/service.test.ts`。
- 同一 release 自动更新失败后，在当前进程内按 owner、来源路由和 release 做指数退避
  （5 分钟起、最长 6 小时），日志记录失败次数与下次重试时间；来源发布新 release 时立即
  解除。忙碌跳过不记失败，用户手动重试不受退避限制。
- 服务端包必须通过 release SHA／大小及 id／版本校验，安装与运行时能力以真实包内的
  Manifest 为准，不将服务端目录的 Manifest 投影作为第二份能力上限。
  自定义市场以发现并规范化的 manifest 为能力上限。超出能力上限按包内容不一致拒绝并留待
  来源修复，不转成用户审批流程；上限内的新版声明仍按上一条判断是否需要用户确认。能力上限按 Host 实际消费语义
  比较：真实包不得从无到有增加 `settingsHtml` 设置 WebView 或扩大固定 `settingsHeight`；
  OAuth `scopes` 换序或取子集属于收权，其它 OAuth、凭证标签与注入字段仍须保持在清单上限内；
  `setup.requires` 只能保留或删除市场已有的完整需求组，不能增加组、收紧 `anyOf` 或更换引用；
  真实包同名工具的 `parameters` JSON Schema 必须与市场规范值一致（仅对象键顺序可不同）。
- 本地 `.cindy` 没有稳定来源，不自动更新；用户再次导入同 id 新包时原位更新（权限变多时
  先确认），由 Main 保持当前启用状态。
- 市场下载与本地安装使用一致的 Node 包体边界：压缩包最多 128 MiB、解包总量最多
  256 MiB、最多 2048 个条目；普通沙箱包仍为 8 MiB／32 MiB／256 个条目。
  下载前尚未识别真实包类型，按 128 MiB 限流；下载后由共用安装器按真实包类型校验。
  市场下载采用 120 秒总超时和 60 秒无进展超时，任一触发即中止；分块写临时文件并校验
  完整大小和 SHA-256，失败清理本次临时文件，不替换现有安装。错误提示区分下载超时、
  网络失败与安装包异常；服务端负责包体大小发布准入，客户端保留防御校验而不另设体积提示。
  实现与回归见 `apps/desktop/src/main/plugin-market/download.ts` 及同目录的
  `__tests__/download.test.ts`。
- 同一安装流程的同步预检可以复用一次已装清单扫描；跨下载、用户确认或异步等待后，
  目标安装、批准状态与锁内提交仍须重新核对，不能缓存批准结果。`inspect` 与安装可在
  60 秒内复用一份不超过 8 MiB 的包解析结果，但每次必须稳定重读完整源文件并核对
  SHA-256、宿主语言与信任表；返回的清单与缓存隔离，不能只凭路径或修改时间复用。
- Host receipt 是安装事务和运行完整性的状态记录，不是一次交互式“能力授权”。合法的安装／更新
  事务（已按上文求得确认）写入 receipt，钉住 canonical manifest、trust、启停态与随机 `revision`；
  `ghostInstallApprovalToken()` 只是 Renderer 与 Main 之间防止并发漂移的前置条件，不是权限凭证。
  没有或损坏 receipt 的存量安装优先走自动迁移／对账，不能改成逐插件能力确认弹窗；安装确认只作用
  于新的安装／更新事务，Cindy 升级后已装插件不因此需要重新确认（以当前已装版本为基准）。
- receipt 不等于“安装目录从此不可变”的证明：普通 `packageSha256` 仍是安装时点来源指纹；
  真正越出沙箱的技能继续使用 receipt 绑定的字节指纹与 Host 状态根快照。不要把审计字段误写成
  全量运行时内容校验，也不要把安装确认当成完整性守门而删减现有校验。
- **Forge 的源码区与 Host 受管根互斥。** `ghost_forge_scaffold` / `ghost_forge_pack` /
  `ghost_forge_install` 的目标必须是独立作者目录，不得是安装根或状态根；按 realpath
  挡住大小写折叠与软链／junction 别名。目录内外均核对活跃任务的实际执行计划状态，
  不能用数据库的一次性计划勾选代替；计划中、状态未知或授权过期时禁止写入，落盘前复核。
  会话工作目录内无需额外确认；工作目录外走与
  `ghost_call` 过户相同的会话权限路径（本地 Full Access 自动放行，Auto 交当前会话
  AI 审阅，Ask 弹确认卡，远程／缺会话／查询失败 fail closed），禁止在 Host 已放行
  后再因目录边界悄悄硬断。`ghost_forge_pack` 只负责校验与打包；只有用户明确
  要求后调用独立的 `ghost_forge_install` 才安装或更新，不因 scaffold／pack 成功而隐式安装。
- 存量插件技能投影在当前账号的 `<状态根>/agent-skills`，不写 `~/.agents/skills`
  或 `~/.claude/skills`。Claude 使用每插件独立的本地 plugin（命令带命名空间），
  Codex 通过 Cindy 的 `CODEX_HOME/skills`，Pi 通过显式 `--skill` 加载；均保留技能
  停用与 Bot 白名单。旧全局链接仅在能证明属于 Cindy 时迁移删除；用户文件与外来
  链接保留。账号切换撤销私有投影与遗留全局投影。
- `skill` 是唯一**越出沙箱**的能力：技能指令由主 Agent 以用户全部权限执行、全局
  生效、不随 workdir 级停用隐藏。其安全边界是**声明一致性**（manifest 里的
  name／description 必须与 SKILL.md frontmatter 逐字一致，`skillSlot.ts` 的
  `checkSkillMdConsistency` 是唯一裁判，打包与装入、以及 Host 固化快照三侧共用；注意它**只**
  校验 frontmatter 的 name／description，正文与辅助文件不在它的判据里）+
  **Host 固化快照与字节指纹**（安装／更新事务提交时把技能目录逐字节拷进
  `<状态根>/skill-snapshots/<id>/<revision>`，只收普通文件，同时把逐 item 的内容
  指纹钉进 receipt 的 `skillContentSha256`——装入/更新时该指纹取自 **`.cindy` 包的
  内存投影**(inspect 时已被 `packageSha256` 钉住的那份字节),不从已发布的可变安装
  目录首读:publish 与首次 hash 之间被换的字节应当在快照对账时被拒,而不是被首读钉成
  固化基线；安装事务校验的 SKILL.md 必须就是 Agent 之后
  读到的那份，所以 Cindy 私有技能投影的链接指快照而不是可被改写的 `cindy-brain/<id>/<dir>`。
  快照缺失需要从安装目录重建时，**顺序本身就是安全性质**：先把字节复制进状态根的
  临时目录，再对**临时目录里那份即将成为快照的字节**做全部权威校验（尺寸上限 →
  指纹逐字节比对 → frontmatter 一致性），通过才 rename 就位。**不得改成"先校验安装
  目录、再复制"**——安装目录随时可被同权限进程改写，校验与复制各读一次就有一个可换
  字节的窗口，复制出来的快照可能不是被校验过的那一份。同理，复制前对安装目录做的
  任何预检只是"早失败"优化，**不是安全边界**；尺寸上限必须排在算指纹之前——上限要在
  权威路径上真正生效，且不为一份注定被拒的字节先付一整趟读取成本。指纹计算一律流式
  喂入、不整份读进内存（技能目录里除 SKILL.md 之外的文件没有尺寸上限，整份读会被一个
  塞进来的超大辅助文件撑爆）。只靠 `checkSkillMdConsistency` 拦不住"frontmatter 不动、改写正文或塞
  辅助文件"，那会把一份未经合法安装／更新事务校验的指令在一次启用里固化成
  宿主快照并挂载到 Cindy 会话。对不上一律 fail closed，要求重新安装合法包，不许就地自愈成新固化状态；
  `skillContentSha256` 因此是
  **运行期判据**，与只作审计用的 `packageSha256` 不同，且必填——留"字段缺失就跳过
  校验"的可选口子等于给漂移开一条绕过路径）+ **链接对账**（`reconcileGhostSkillLinks` 只增删"目标落在
  安装根或批准状态根内的 symlink／junction"，绝不触碰真实目录与外来链接；
  启用挂链、停用／卸载撤链、断链自愈）。快照目标带 revision，因此每次更新都换目标、
  靠对账重指，旧 revision 在 receipt 提交后回收。改动技能落链、命名
  （`<id>--<name>`，name 侧禁 `--`）、快照或对账判据前，必须先读 `skillSlot.ts`
  头注释并保持上述不变量；`approvalStateRoot` 是必填项——漏给会让指向快照的活链接被
  判成外来链接而永不撤链，停用／卸载后技能仍对主 Agent 生效。
- 收敛方向不对称：**启用需要有效批准状态，停用必须永远能成功**。停用是安全方向，不
  能因为快照缺失之类的环境问题把插件卡在"既不能用也不能关"。
- **「插件内容目录怎么读」只有一份判据：`ghostContentTree.ts`。** 条目类型判定
  （`classifyGhostDirEntry`，一律 `lstat`、链接与非普通条目显式归类，**不信 Dirent 的
  类型位**）、清单相对路径的逐段解析（`resolveGhostContentPath`，中间段是链接一律拒）、
  内容树收集与指纹格式（`collectGhostContentFiles` / `hashGhostContentFiles`）都在这里，
  各调用方之间的差异只允许以**显式策略参数**表达：点开头条目算不算内容
  （技能目录 `include` ／安装目录与种子 `skip`）、非普通条目是 `throw`（授权判据）还是
  `flag`（对账判据——收敛动作是重新播种而不是拒绝）。
  - 理由是实测的复发史：同一条判据曾经在技能指纹、快照拷贝、安装目录漂移指纹、随包
    种子指纹、种子复制、Forge 打包收集六处各写一遍，还有五处各自 `path.join` 后再判
    一次类型，分别用 Dirent 类型位／`lstat`／`stat`／realpath 钳制实现。于是每轮审查都
    能在其中一处找到没覆盖的角落，补一处、下一轮换另一处。
  - 新增任何"读插件内容目录"的代码一律从这里取判据，**不要就地 `readdir` + `isDirectory()`
    或 `stat` 直读**。只 `lstat` 最终段等于没判：中间段被换成软链／junction 时 OS 会
    静默穿透，最终段报的是"真目录、非链接"，字节却来自插件目录之外。
  - `hashGhostContentFiles` 的摘要编码必须保持无歧义 framing（当前为
    `cindy-ghost-content-v2` + UTF-8 路径长度前缀 + 每文件摘要），不得恢复成
    `path + NUL + bytes + NUL`；文件内容本身允许包含 NUL，分隔符编码会产生不同文件树
    的等摘要。该编码升级同步 bump `GhostInstallReceipt` schema；旧 receipt 必须
    fail closed 并按第 5 节迁移，不能拿旧摘要继续授权。**编码 bump 属于第 5 节的存量兼容
    场景**：先按**旧编码**核对旧摘要与当前安装字节，对得上就原地重算成新编码并升级
    receipt（安全水位与旧版本已提供的保证等价），只有对不上（真漂移）才 fail closed 并
    要求重新安装合法包——不得把一次纯格式升级直接变成全体用户的重新安装操作。
  - 同理，"源目录与受管根的包含关系"必须**双向**判（既不能落在受管根内，也不能是受管
    根的祖先）：单向判定下只要在 owner 数据目录里放一个 `ghost.json`，递归打包就会把
    已安装插件字节、批准 receipt 与技能快照打进 `.cindy`。
  - 随包种子是第一方输入；发现链接、junction、FIFO 等非普通条目必须整颗跳过并告警，
    不得在复制时静默丢弃后继续写批准 receipt。

## 4. 网络、凭证与资源交接

- 自主 network 只允许 manifest 白名单域名；凭证由主机保险库注入，**无明文读回**
  给沙箱。Agent 在途调用可凭严格 `callId` 访问未预声明的普通 HTTPS 地址，仍须通过
  主机 URL、SSRF、超时、体积与重定向守门。此途径不注入任何未在 manifest 中声明且
  未命中目标 host 的托管凭证。
- 沙箱 `cindy.fetch` 可由 Host 附加《Cindy MCP Apps 页面生成手册》的 `Cindy-MCP-Apps-Manual` /
  `Cindy-MCP-Apps-Manual-Sha256` 请求头（`mcpAppsManualHeaders.ts`）：缺省仅当 callId 对应的在途工具在
  `mcpApps.ui.tools` 中对模型可见时带上，`mcpAppsManual: true | false` 显式覆盖。它不是凭证，但与凭证头同样
  逐跳只发往 `network.hosts` / 连接地址中已声明的主机，插件自带的同名头（不区分大小写）一律剥除；版本无关
  （0.0.0）或找不到内置手册时不带。Node 工作进程的请求不带，只剥除同名头。
- `source: "gh-cli"` 是只为官方 `cindy-github` 保留的宿主凭证来源：Host 优先读取
  本机 `gh auth token`，不可用时才回落到同 key 经 `/secrets` 保存的 PAT。两种 token
  均只在 Main 的 networkSlot 或受信本机账号检查中注入 `api.github.com` 的
  `Authorization: Bearer` 请求头，不得进入插件、Renderer、Agent、KV、日志或 Node
  Worker。本机账号检查仅允许固定 GET `/user`，拒绝重定向，限时 15 秒；只返回
  连接分类、用户名和来源，不返回响应原文。插件设置页只能读取 `hostAvailable`、
  `hostManagedSetup` 布尔与备用 PAT 的 `saved/tail` 状态。该来源
  不允许 `exchange` 或 `setup.requires` 引用，第三方插件不得声明。
- `source: "oidc-token"` 是 Host 托管的短时 Cindy Connection JWT：只对当前企业
  Membership 生效。资格有两条默认基座：当前组织的 Plugin Market organization 安装记录仍有效、
  且安装目录 `ghost.json` 的 raw SHA（旧记录迁移前为集中 legacy digest）与记录一致；
  Manifest 与身份必须来自同一次受限读取，禁止分两次读取后分别校验与消费；或企业作者显式使用 `ghost_forge_install`
  安装、在提交前核对插件 id 与精确注入域名，且插件 id 命中当前组织前缀。手动导入不取得
  Forge 作者资格。另有一条临时例外，计划在 XD 企业市场版 `mivo-canvas` 上线并发布一次性数据迁移后删除，只对 root 实例生效：`ghostId` 精确等于 `mivo-canvas`；已装 manifest 声明的精确 `oidc-token` host 只有 `mivo-canvas.dsworks.cn`；只在组织身份校验之后且没有市场记录时生效，已有 organization 记录（含 `installed:false`）仍走 digest，市场账本损坏、schema 不认或记录校验失败时 fail-closed，不得当成「无记录」；实例 namespace 必须为 null，或是尚未写入 namespace 的旧 root 安装。`_ns/xd/mivo-canvas` 这类企业实例、其它本地插件、个人账号、通配 host 和其它精确 host 仍不签发。Host 根据当前组织和插件 id 推导 audience。
  插件和 Node Worker 都不能读取或保存令牌。声明必须固定使用
  `Authorization: Bearer {value}` 并显式列出非空 `inject.hosts`；其中只允许精确域名，
  不允许通配。实际目标必须精确命中这份可信 manifest 声明的服务域名才会签发和注入。它没有用户输入、`url`、`exchange` 或
  `setup.requires` 配置动作。Connection JWT 请求遇到 401 时，仅 GET / HEAD / OPTIONS
  可自动换令牌重试一次；非幂等请求只作废缓存，不自动重放。
- 插件 setup 的完成状态只由 Host 读取真实持久化状态后判定。简单的
  `source: "user"` Secret 可由 Host 在聊天 Setup 卡中生成 `inline_form` 并直接写入
  保险库；插件详情页的 `settings.js` 仍可通过 `/oauth`、`/kv`、`/secrets`、
  `/connections` 完成正常保存。两条路径都不得自行向聊天卡回调“已完成”，Renderer
  也不得以轮询或 `BroadcastChannel` 事件替代 Host 判定。
- Agent 可编排 setup 卡片的说明与步骤，但只能引用 Host 下发的 requirement / action；
  插件身份、字段 schema、字段与存储目标的绑定、Action 执行、完成状态和原
  `ghost_call` 恢复均由 Host 掌控。Secret、Token、OAuth code 和连接凭证不得进入
  Agent、Ghost、interaction / pending snapshot、会话历史、日志或分析事件。内联 Secret
  只允许短暂存在于本地 Desktop 输入组件和一次性的 trusted Renderer → Main 专用 IPC；
  不得走通用 interaction response、通用 device-link invoke，也不得写入 Renderer
  store。提交成功、取消、request / revision 替换和组件卸载时必须清空。远程普通 user
  Secret 的窄例外仅为下述签名输入桥，不提供保险库读取或同步。
- 远程设备插件 OAuth 的 [Desktop 回调桥](../remote-plugin-oauth.md) 是独立的 Host 对 Host
  授权事务，只承接当前卡片的已声明 OAuth action。URL/code 必须在两个 Main 间加密，
  不能暴露给 Renderer、Agent、插件或通用 invoke；token 仍由目标 Host 现有账号管理器交换保存。
  通用设备码、浏览器确认和 CLI PKCE 回调由同一类型化适配层承接，仍须精确任务/插件/目标
  绑定；可信 Node 的私有 CLI callback 只回 bootstrap Promise，不经 stdout、沙箱或模型。
  Node 本来拥有系统用户权限，这不是隔离恶意 Node 的保证；不放开任意端口/URL 转发。
  新 Node 授权卡须以 `cancelWithCall:true` 和当前 `callId` 显式启用；只带旧调用编号
  不取得授权能力，也不改变旧 RPC/后台子进程生命周期。任务 Stop 后不得迟到启用，
  取消只回收该调用所属子进程，不停止同一 Worker 中其它调用。
  普通 user Secret 可由 `remoteSecret:true` 卡片通过专用本机 `plugin-oauth:submit-secret`
  加密送到目标 Host；必须先签名握手，并比较原 Host 的完整字段展示与用户看到的字段，绑定
  设备/插件/action/revision，在最新声明与写入边界复验。只允许写既有 executor 解析出的
  单个 Secret；OAuth、gh-cli、oidc-token 和账号 vault 不接受此输入。Bot/旧卡片无此标记，
  不自动获得能力。原始值不进通用 invoke、事件、会话历史、日志或 store；不增加确认窗口。
  用户要求的设备码卡片展示是窄例外：加密 device offer 中供用户手工输入的短时
  `userCode` 可通过本机专用 `plugin-oauth:device-code` 接口投影到发起授权的自有顶层
  Renderer。只在当前卡片组件内存显示；按 owner、窗口/frame、设备、插件、request/action
  绑定，支持再次复制与重新打开 Main 保管的同一授权页。过期、终态或身份失效后清除。
  它不包含 OAuth callback code、device_code、Token、完整 URL 或 state，不进入聊天
  snapshot、模型、持久化或通用远控；不改变原授权卡片或新增确认窗口。
- Host 必须把每个未满足 `any_of` 组的全部可执行 item 投影到卡片，Agent plan
  不能隐藏合法配置路径。Renderer 统一按组展示选项并复用 Ask 卡片的正文限高与纵向
  滚动，不得为 Brave、Tavily、Gmail 等具体插件增加分支。
- `network.secrets[].url` 可由 Host 作为 Setup 字段旁的辅助获取入口展示。该地址必须
  继续满足 manifest 安装期的 `https`、无内嵌凭证校验；它不是 Agent 文案或 plan
  的一部分，插件也不能通过 `settings.js` 动态替换 Setup 卡地址。
- 模型调用一律走 Cindy 统一通道，不允许插件自建绕过通道的推理请求。
- 插件是沙箱小程序，不等于 AI 代办。模型与任务相关能力必须分别描述：
  - 快问快答（`cindy.text.oneshot`）不创建任务、没有 Agent 工具；沿用其统一轻量模型通道。
    模型依次取插件详情的「模型」字段（与插件新建任务共用、钉死不回落）、身份卡
    `oneshotModel` 声明、系统辅助模型链；每单现读，辅助模型改动后跟随默认的插件自动跟随。
  - `agent.run` 承接已有用户任务的继续／新建／分叉，保留原任务的交互与权限语义；
    真实点击票／后台关联授权不因共用模型校验而扩大。
  - `cindy.tasks` 创建并管理插件自己的普通任务，有独立的 tasks 声明、批准与持久回执；
    不依赖旧 errand 权限，不把任务完成等同于取到一段文本。
  - `workspace.ensureSession` 只定位／创建工作区任务入口；不因创建入口就自动执行模型。
  - `agent.errand` 是旧的派活取件适配器，保留专属任务映射与结果回传，不作为其它能力的产品抽象。
- 用户界面、Agent 工具、伙伴和插件的新建任务共用普通 Session 创建入口。伙伴的完成回报、
  时间线与信号留在伙伴层；插件按需查询结果，不默认唤醒伙伴或另一个 Agent。
- 插件详情「模型与任务」是插件唯一的模型偏好（快问快答与新建任务共用）加任务权限与
  工作目录，普通任务、工作区新建与旧 errand 使用同一配置；只声明快问快答的插件只显示
  模型行。图像／视频／向量没有逐插件选模，始终走系统默认与调用方档位。旧版逐能力选模
  （`ghost-cindy-prefs.json` 的 `overrides`）在主进程首次读取任务配置时一次性迁移：
  快问快答的 `cat:` 目录钉仅在插件尚未选模型时写入 agent／供应商／模型，其余覆盖丢弃，
  并删除该键（保留 `inflightLimits` 等其它键）。新建任务时显式完整模型组合优先；
  缺省从宿主验证的发起任务继承，面板无发起任务则使用当前新任务的完整选择，不优先翻找 Claude Code 的历史草稿。模型选择不授予权限或目录。
  保存、新建和插件派发前复用普通独立任务的模型／供应商／Agent 准入，不另建目录或选择器。
  连接状态不等于额度、网络及远端参数一定可用；执行失败如实返回，不静默换型号或账号。
- 已启用默认卡的插件新建普通任务，其权限沿用用户插件设置或既有宿主确认流程，默认普通任务的 `ask`，允许
  用户显式选择默认权限（`ask`）／自动审批（`auto`）／完全访问（`bypassPermissions`）；不继承发起任务的权限。
  这类插件的 `tasks.create` 与 project 的 `targets.send` 可选 `permissionMode`，仅在当前用户插件权限上限内
  选择本次新任务的 ask／auto／bypassPermissions；参数本身不授予权限、不写插件默认设置。
  完全访问须来自用户在插件设置中的选择；旧 `requestWriteAccess` 仍只支持 acceptEdits／auto，
  不增加完全访问确认弹窗，也不因复用该流程降低用户已授权的上限。
  Main 在创建前及异步准备后复核；省略参数保持旧行为，已有任务／伙伴投递不接受权限覆盖。
  旧 errand 适配器保留历史缺省 `plan` 与原 Agent 行为；历史 plan／acceptEdits 配置保留，但不列入新建接口和设置页的新选项。已有任务不自动改权。
  不把历史 `plan` 值宣称为跨 Agent 的只读保证，也不为它改造各 Agent 的权限引擎。
  旧存储文件名、键及 IPC 保持兼容，升级不丢配置、不重批权限。来源优先级、复用和恢复
  详见 [插件普通任务接口](plugin-task-api-implementation.md#模型配置与创建来源)。
  隐藏卡片的插件不读取该上限，可通过已批准任务能力的创建参数自行选择；权限确认只改变目标 Session，不写回停用卡片。
- 附件、媒体、目录和保存路径通过归属校验后的 grant／deposit／ledger 交接，**禁止把
  宿主绝对路径或不必要的字节暴露给沙箱**。媒体字节须走
  [`media-storage-and-protocols.md`](media-storage-and-protocols.md) 的统一入库。
  `ghost_call` 的 `attachments`／`dir`／`save_dir` 在目标位于 workdir 外时，普通权限档
  仍沿用现有确认与授权记忆策略；Auto 只有一个审批负责人：本地活跃 Harness 已用原生
  审批接管工具调用时，交接不再调用 Cindy 模型复审；以运行时 `autoReviewOwner` 为准，
  不从订阅、模型名或数据库快照推断。免复审要求原始路径与 canonical 目标一致；
  symlink/junction 解析改变目标时，由 Cindy 审核真实路径。仅接收 canonical 路径、
  无法核对原始工具参数的 Host 文件系统回调同样保留审核。没有原生接管时交 Cindy 审阅器，
  allow 逐次放行、block 返回原因、ask 或服务故障才交用户确认。Full Access 旁路则仅当
  Host 能现读到**本地活跃会话**的运行时权限恰为
  `bypassPermissions`（Full Access）时自动批准。该判定不得读取启动期 MCP context 快照，
  也不得回退可能滞后的 DB `permission_mode`。business `sessionId` 不足以证明仍是同一内存
  Session，必须同时匹配由 Maker 铸造、调用方不可覆盖的 instance identity；权限切换在途、
  close／detach 已开始、会话缺失、实例不匹配、查询失败、远程会话均 fail closed。
  对 Codex、Pi 与远端 Claude Code 这类进程外 harness，instance 只作为 opaque MCP route
  identity 写入 Host 生成的 loopback URL；桥接层必须将 URL identity 与注册表中的当前实例
  严格比对，不匹配直接 401。 兼容旧客户端时，缺 instance 的 URL 可继续获得普通会话上下文，
  但必须剥除 instance 能力，使 Full Access 自动交接继续 fail closed。
  越界文件系统副作用（cindy-docs / 电脑工具的 `outside_workdir`，以及 Forge 的
  `forge_source`）在缺少 instance、live grant 读不到或实例已失效时直接拒绝，
  不得退回仅凭用户确认的放行；附件过户仍可确认。
  自动批准须区分 Full Access 与 AI 审阅来源，不得伪装为用户点击，也不得写入人工目录授权
  记忆。附件自动交接必须写独立 `ghost-tool-grant`，不得写 `ghost-grant`；这是回退兼容
  边界——旧客户端只认识后者，降级时必须 fail closed，不能把新版自动交接误读成人工永久
  授权。切回 Ask 后新请求恢复确认。在途插件操作统一沿用当前会话的操作审批：包括工作区
  草稿创建、工作目录写入、媒体路径揭示，Forge 在工作目录外的打包／骨架，以及
  cindy-docs / 电脑工具读写工作目录外路径，
  Full Access 不额外审批，Auto 文件交接和媒体路径揭示沿用实际审批负责人，
  原生接管免复审仅用于 Harness 调用链，不授权独立 Host 操作或远程任务访问控制端文件；
  插件内部新发起的工作目录写入仍走既有真实路径和操作检查。
  Ask 沿用原确认流程。越界路径的确认与执行绑定裁决时解析到的规范路径，
  工作目录里的 symlink 不能把真实目标藏成相对路径。MCP 的 `prompt-each-time` 仅限制授权记忆，不得覆盖 Full Access，
  也不得跳过当前负责人的 Auto 审阅。审批期间实例、权限或调用归属失效时，旧 allow 不可执行。
  Plan 与操作审批档位正交：Host 副作用须先检查实时 Plan 状态，未知或切换中拒绝；
  Plan 切换代次也参与审批后和落盘前复核，不能以数据库镜像或切回原状态恢复旧授权。
  一次性 Plan 的 UI 开关在发送后熄灭，不代表当前 Plan 回合结束；授权判定使用 Provider
  的执行态，不能只读下一轮开关。Claude Code 本地/SSH 的 Full Access 短路同样不能
  放行当前 Plan 回合里的非只读工具；显式批准计划后才恢复底层操作审批档位。
  这不扩大本轮来源/执行范围、不改变跨主机路径归属，不替用户填写 Setup、OAuth、Secret
  等必要信息，也不改变第 3.1 节的安装／更新策略。自主面板或后台调用不得借用前台会话权限。
  实现与回归见 [Session.reviewHostPermissionAction](../../packages/maker-core/src/session.ts)、
  [fsSlot.test.ts](../../apps/desktop/src/main/cindy-brain/__tests__/fsSlot.test.ts) 和
  [ghostWorkdirGate.test.ts](../../apps/desktop/src/main/mcp-integrations/__tests__/ghostWorkdirGate.test.ts)。
  `dir`／`save_dir` 批准的是裁决时解析到的 canonical realpath 快照；出票必须使用该规范路径
  并在票据库内重新解析核对，路径映射已变化时拒绝并要求重新确认。出票后真正读／写时仍须
  再次核对根与目标真身；保存文件必须排他创建且不跟随最终 symlink，不能让短命票据留下消费期
  TOCTOU。附件继续使用裁决前已读入的字节，不得在批准后重新跟随原始路径。
- 对话文件交接：目标工具参数表把保留参数 `cindy_handoff_files` 声明为数组时，`ghost_call.attachments`
  里的本地非媒体文件不进媒体仓，由 Host 存一份副本到 `owners/<账号>/ghost-handoff/<实例键>/`，
  插件只收到 `handoff:<uuid>` 引用（`args.cindy_handoff_files`），未声明的工具行为不变。
  该参数只由 Host 注入，模型或页面自带的同名值一律剥除。限额与配额（4 个／64 MiB／128 MiB；
  每实例 512 MiB／200 个）在弹卡前判定；确认沿用附件两层策略（lane=`handoff`，不做目录会话
  记忆，自动放行不写人工授权），落盘的是裁决前读入的字节。副本只能经 `upload.handoff` 出网（按交出时的大小有界读取，文件被改长或改短即拒绝），
  或由本卡页面经签发的只读地址读取；插件不能读取字节或删除副本。副本连续 7 天未使用后由 Host 删除
  （签发页面地址、页面读取、上传成功算使用，同一副本每小时最多续期写盘一次；`expiresAt` 是当前到期时间、
  会顺延，不是固定截止时间；访问时、启动后延迟及切换账号时清理），用户可在插件详情页逐个删除，或在访达／资源管理器中打开副本目录（按清理后的原文件名存放）；卸载删除、换源随
  归档实例键搬走（副本已落盘、派发未结束时换源等待；换源期间新的交接直接报错）。Node 工作进程不开放。回归见 `handoffStore.test.ts` 与 `ghostWorkdirGate.test.ts`。
- 媒体模型接入分成两层：插件声明并封装业务能力，Cindy Core 提供低级目录和调用能力。
  插件设置页／panel 只能通过同源只读 `/media-models?type=image|video` 配置模型；Host 按
  Gateway `mode` 切图片／视频大类，并结合插件 `cindy.image/video` 声明、Gateway
  `modalities`、Guide operation 与当前客户端协议支持度，只投影当前可执行模型。单模型
  Guide 失败必须局部隔离，不能阻断其余模型或插件面板。响应仍只把归一化后的
  `modalities.input/output` 原样交给插件，不得包含 Guide、endpoint、凭证或内部兼容判定；
  付费请求前 Core 必须再次校验。新媒体生成请求只能由当前 Agent 调用永久 Core `media`
  工具发起，插件沙箱和 panel 不得直接提交、轮询或下载。存量 `cindy-request` 媒体代办仅作
  兼容，不得作为新 Guide 模型的接入路径。插件工具通过现有 `tool-result` 返回普通 JSON，
  Agent 读取后自行决定下一次 `media` 调用；Host 不识别插件专用媒体意图字段，也不自动
  转发。插件需要结果时，Agent 调用普通接收工具，并通过顶层
  `ghost_call.attachments` 显式交接；Host 复用已有的通用授权链，将授权后的指纹注入
  `args.attachments`，绝不把本地绝对路径暴露给插件。插件自行保存业务状态和更新 UI。
  Host 不自动回调插件，也不得新增画廊等插件业务语义。
- 回环嵌入是第二个、也是更窄的页面网络例外：插件同时声明一种自绘页面（`panel`、`mainView`
  或 `taskView`）、`node` 工作进程和 `preview.hosts` 中的 `localhost` / `127.0.0.1` 时
  （`ghostPanelLoopbackEmbedAllowed`），
  其页面 CSP 追加 `frame-src 'self' http://127.0.0.1:* http://localhost:*`，分区请求闸放行
  三类请求：插件页面作为父帧发起的回环子帧导航；该子帧内部再套一层、**父帧与目标同
  主机:端口**的子帧（本机页面自己的分层结构）；该子帧内回到**同一主机:端口**的资源、
  XHR 与 WebSocket。面板页自身发出的回环 fetch/XHR、顶层导航到回环地址、换端口或换主机
  的请求、带凭证的 URL 与 HTTPS 伪装一律继续拒绝。嵌入页由插件自己的随包 Node 进程在
  本机提供，因此不扩大插件可达的网络范围；权限请求处理器不变（嵌入页不能申请摄像头、
  定位等权限）。首个消费者是官方 `baguette-simulator`（iOS 模拟器的任务页与管理主视图）。
- 所有插件 HTML 页面（`settingsHtml`、panel、mainView 与逻辑页）都可以通过 `<img>` 或
  CSS 图片直接加载任意 HTTPS 地址，这是唯一的页面网络直连例外。Host 统一生成包含
  `img-src https:` 的 CSP，并由 owner × plugin session 请求闸把外部请求严格限定为
  `protocol === "https:" && resourceType === "image"`。HTTP 图片、`fetch` / XHR、脚本、
  样式表、字体、音视频、WebSocket 与其它协议一律不因此放行；同 ghost 的
  `cindy-ghost://` 资源继续放行。该能力不新增 HTML sanitizer 或图片属性白名单；既有 CSP
  继续阻止内联脚本和内联事件处理器，同包脚本行为不变。远程图片请求会向第三方暴露用户的
  网络地址及完整 URL，作者不得把密钥、令牌或用户私密数据拼进图片 URL。session listener
  按 owner × plugin 幂等注册；设置页与同插件其它页面继续共享 browser storage、IndexedDB
  与 `BroadcastChannel`。
- 面板供片与注入的主题 token 只用 `ghostPanelTheme.ts` 白名单内的值，不扩大暴露面。
- 已下线功能仅保留通用迁移目录与历史清单兼容字段，不提供 Host 能力。
  `iosSimulator` / v2 `ios-simulator` 只用于旧安装记录往返和下线识别；升级前已装且启用的
  用户在原插件位置收到迁移引导，旧运行时、MCP、技能入口不再加载。见
  [`feature-retirements.md`](../product-rules/feature-retirements.md)。

## 5. 存量插件兼容：升级必须无感（红线）

**红线**：插件系统的任何改动，都不得让用户本地**已安装、已启用**的插件在 Cindy 升级
后变得不可用，也不得要求用户重新安装、额外确认、重新配置凭证或重新落一次技能。
升级后的默认结果只有一个：用户什么都不做，插件照旧能用。

- **判据是用户视角的可用性，不是代码路径没报错。** 插件还在列表里但被标成「已停用」
  「失效」「需恢复安装」，或者启用按钮点不动、技能链断了、面板打不开、
  已配置的凭证要重填 —— 都算不可用。「fail closed 得很干净」不是通过条件。
- **触及范围**（改这些就命中本节，逐条按"老数据怎么办"设计）：宿主侧批准状态记录
  （receipt 一类）的 schema／字段必填性／落盘位置、指纹与摘要编码、
  `validateGhostManifest` 的校验规则、能力字段与参数形态、技能快照布局与链接命名、
  安装根与状态根路径、`.cindy` 包格式、
  管子协议消息形态、随包种子与内置插件 id／前缀、市场侧的 id 与版本口径。
- **新增校验或新增必填字段，默认必须自带迁移（backfill），不是自带拒绝。** 老数据缺
  新字段是**升级前的正常历史状态，不是攻击证据**，不得按篡改处理。迁移的判据是"能不能
  从旧版本自己的安装验证事实重建出等价物"：
  - 例：receipt 机制上线前的安装，等价事实就在安装目录的 `ghost.json` /
    `.cindy-trust.json` / `.disabled` 三份文件里（第 3 节所说的"旧版本兼容镜像"）。
    宿主必须能一次性读它们 backfill 出等价 receipt，用户无感。
  - **迁移不得成为扩权或降级通道**，这是它与安全不变量共存的前提：迁移只在该 id
    **从未有过 receipt**（或 receipt 已判损坏）时发生，manifest 及运行事实原样取旧记录、
    不做并集、不吞新增能力；迁移只重建旧版本已有的等价安装验证状态，之后的
    manifest 变化只能由新的合法安装／更新事务固化；迁移来源必须记进日志，便于事后分辨
    “正常安装写入”与“宿主迁移来的”。
  - 迁移**读不出**（文件缺失、格式坏）或**自相矛盾**（镜像与内容互斥）时才 fail
    closed，落到下面的兜底义务。
- **receipt schema／指纹编码 bump 必须走「按旧编码核对 → 原地升级」，不是 fail closed
  到用户重新安装。** 纯格式变更时旧 receipt 的安装验证事实没有消失：先用旧编码核对旧摘要与当前
  安装字节，对得上就原地重算成新编码并升级 receipt，只有真漂移才 fail closed。一次内部
  格式变更不得变成全体用户重新安装。历史注：v1→v2（NUL framing 修复）没有专门的 v1
  读取器，因为 v1 receipt 从未随任何构建发布、全网不存在；同时一次性 legacy 迁移会把
  「已判损坏」的 receipt 从安装目录 backfill 治愈，效果上覆盖了该场景（有回归用例钉住）。
  **从 v2 起的任何 bump 都必须实现原地升级器**，不得再引用本注作为豁免。
- **确实不可避免时的兜底义务**（四条全部要满足，缺一条就不算做完）：
  1. **能自动就别打扰用户**：自动重建／自动重算／自动重新播种优先，且要能在下一轮启动
     对账时自愈，不要求用户在特定时机点特定按钮。
  2. **自动做不到就必须明确提示**：UI 要说清发生了什么、影响哪些插件、点哪里恢复，并
     提供**一次性批量恢复入口**；不得只留"去市场逐个重装"，也不得让它看起来像是用户
     自己关掉的（与第 3 节的 UI 义务同一条）。
  3. **不丢用户本地状态**：恢复过程不得清掉已保存的凭证／Secret、KV、per-plugin 偏好、
     errand 配置、面板状态。恢复的是安装验证记录，不是用户的配置。
  4. **留回滚余地**：新版本写出的状态被旧版本读到时不得当成损坏——未知字段忽略而不是
     判 `invalid`，否则用户一旦回退旧版就再炸一次。
- **测试门槛**：命中本节的 PR 必须有"从旧状态升级"的自动化用例——fixture 造出老布局
  （无 receipt／旧 schema／旧指纹编码／旧目录形态），断言升级后插件仍列为启用、技能仍
  挂链、无需用户操作。只测全新安装流程不算覆盖，这类回归**只在存量数据上出现**。
- **PR 约束**：命中本节的 PR，Description 必须写明「存量插件影响：无」或「有 + 迁移与
  提示方案」，并说明上面的升级用例跑在哪。会让存量插件失效的改动与 mobile 冷更同级：
  需仓库把关人针对该影响明确确认后才能合并，提交者身份不构成例外。漏迁移 = P0。
- **插件基座改动一律走白名单确认门。** 「基座」= 所有已装插件共同踩着的那一层：运行时与
  沙箱、来源／信任 receipt、能力声明、打包与内容判据、manifest 契约、装入与能力说明 UI、已装
  列表投影（`main/cindy-brain/`、`main/plugin-market/`、`main/mcp-integrations/ghost.ts`、
  `shared/ghost.ts`、`packages/cindy-tools` 的 ghost 部分，以及 renderer 侧的
  `installFlow.tsx`／`installErrorKey.ts`／`GhostPluginDetailView.tsx`／`useInstalledGhosts.ts`／
  `runtimeStates.ts`／`features/plugin/lib/ghostPluginViewModel.ts`／
  `features/plugin/lib/pluginMarketPresentation.ts`）。命中即需放行人在 PR 上明确
  Approve 才能合并，**不看 diff 大小，也不因为「是 bugfix／纯技术改动」就放过**——#1080
  正是以 `fix` 身份、按纯技术改动被放过的。这条与本节前面的义务是一套：门只保证「有人
  看过存量影响」，看什么按上面逐条对。纯粹改插件面板视觉、纯文案／locale 不算基座。
- **历史教训（本节的由来）**：2026-07-31 合入的批准 receipt 改造
  （`ghostInstallReceipt.ts`）把"无 receipt = 不构成运行授权"一次性作用到全部存量安装，
  只给随包内置插件留了自动补批准的路，市场与本地安装没有 backfill 路径，结果升级后用户
  **所有非随包插件**同时变成停用、必须逐个重新确认，本地包还要求重新提供原始 `.cindy`
  文件（包已丢失就无从恢复）。安全方向是对的，落地方式把一次内部机制升级变成了全量
  用户故障。


### 5.1 实例注册表

每个数据所有者一份 `plugin-instances.v2.json`。记录包含 `instanceKey`、目录 `contentRelId`、`ghostId`、`namespace`、`namespaceState`、`pluginId`、`source`、receipt 修订和包 sha。旧的 `plugin-instances.v1.json` 只在第一次加载时读一次并导入，之后留在磁盘上，不再写入。

`instanceKey` 由安装目录推出，不另分配：旧 root 是 `helper`，新 root 是 `_root__helper`，企业是 `_ns__<namespace>__<ghostId>`。注册表丢失或损坏时按目录重建，KV、密钥和 OAuth 仍挂在这个键上。

设备模拟器的官方 ID 迁移是单项例外：`baguette-simulator` → `cindy-simulator` 只接受
同一 public 市场资源、root 实例、当前批准和已验证包。更新事务更换包目录、清单与 receipt，
保留原 `instanceKey`；KV、凭据、Library、历史任务等继续使用原键，不复制数据。
Host receipt 的 `simulatorPreviousRelId` 只允许这对 ID 和 root 路径，注册表重建仍取原键；
作者清单不能声明该字段。后续同 ID 更新继续保留此存储身份。
事务在移走旧包前记录旧路径，receipt 提交前中断则恢复旧包，提交后清理旧包与旧 receipt。
提交期间两端保持隔离。新 receipt 同时记录已验证的市场资源、版本资源和旧包 SHA；
若进程在市场账本写入前中断，现有市场维护流程核对批准、现存清单和原账本后补写。
此恢复证据不跨下一次包更新继承。组织同名插件、自定义来源、目标已占用及来源证据不符不自动迁移。
权限确认仍使用正常更新判据，不能借改名扩大权限；`BaguetteCindy` 底层数据目录不变。

`namespaceState`：

- `confirmed`：身份已确认，可以按该 namespace 使用 Broker、OIDC 等新权限。
- `pending`：这次升级普查时已经存在、receipt 还没有 namespace 的旧安装。按升级前的规则继续运行，不停用。
- `unconfirmed`：曾经确认过的 namespace 被旧客户端抹掉，或证据不够。不给新权限，等市场同步或 Forge 自测的正面证据再确认。

市场同步补写账本 namespace 的条件只有一条：该行已安装，pluginId、ghostId、scope、organizationId 都与服务端目录一致，而且行上没有 namespace 字段。只补缺失，不覆盖已有值。非法 slug 不写。组织行上的显式 null 也不写成 root。

### 5.2 迁移中按名称判断归属的唯一例外

升级普查里、来源是 Forge 自测（agent-forge）的旧安装，如果 ghostId 以当前组织登记的前缀加连字符开头，就归到当前组织的 orgSlug。这是唯一允许按名称判断归属的例外。

旧 Forge 安装没有市场 pluginId 或其他归属证据。旧客户端本来就按这个前缀给 Forge 自测安装发 Connection 权限，所以按同一前缀迁到当前 orgSlug 不会扩大权限。

- 只对这次升级普查时已经存在的旧安装生效。普查之后新装的 Forge 插件在安装时已经绑定 namespace，不走这条规则。
- 前缀按当前组织 id 从组织前缀记录查出。ghostId 以前缀加连字符开头时，namespace 取当前 token 的 orgSlug，不是前缀本身。orgSlug 和前缀可以不同。
- 当前 token 没有合法 orgSlug 时保持待迁移，不写成 root。
- 当前组织的前缀对不上这个 ghostId 时保持待迁移，插件按旧规则继续运行，不报错。作者以后登录前缀匹配的组织，再完成迁移。
- 归属一旦写入注册表并确认，再切换组织也不会改这条记录。

### 5.3 市场刷新与实例核对

- Renderer 的市场目录请求只做 discovery，不顺带安装、更新、移除或修复。Main 在数据所有者
  稳定后、系统恢复和 30 分钟周期运行完整维护；切回应用仍受 30 秒节流，但先比较远端目录
  中影响安装的事实。目录未变时不扫描本机插件；签名图标 URL 的变化不触发完整维护。
  本地改动和暂时失败由启动恢复与周期维护重查，不靠每次焦点切换重复全盘扫描。
  前台检查与完整维护各有独立的节流时刻和有界在途槽位：持续切回应用不能推迟周期维护，
  在途前台请求也不能吞掉系统恢复检查。两类入口重叠时仍由市场服务合并目录请求与完整维护。
  前台入口完成或失败时，仅从当前 owner 的内存提示队列检查并广播待处理的移除提示，
  不为发送提示额外请求目录或扫描插件。
- 同一 owner、会话 generation、市场端点及执行策略的并发请求合并为一轮；延后维护的槽位
  保留到实际维护结束。不同账号或端点不复用在途结果。一次同步扫描只读一组市场账本，
  这组事实不跨 `await` 保存，也不作为运行时授权缓存。
- `pending-but-not-listed` 是注册表中的旧实例脱离普查清单，不能只记日志后永远跳过。
  修复不得扩大冻结的普查名单，也不能用 receipt 的 namespace 字段直接确认身份。必须核对
  唯一的已安装市场记录、包指纹、namespace 和当前组织；实例已有 pluginId 时，市场记录必须
  与它一致，确认提交前也复核该绑定未变。尚未绑定的旧实例仍按完整证据链核验。缺少包指纹的已迁移旧 receipt，
  还必须同时匹配批准清单、当前安装清单和账本原先保存的清单身份。孤立记录不能走只对普查
  存量开放的 Forge 前缀或手动安装推断。证据不足保留既有可用状态并记录等待证据，
  由下一次独立完整维护重查，不触发启动协调器整批自动重试；实际的扫描、落盘等错误仍报告维护失败。
- 内容根读取失败不能当空目录；子树读取失败表示该子树的存在性未知，不能将其记录置为
  未安装，也不能据此自动补装。其他可读插件仍可投影；界面可以保留当前 owner 最近一次完整
  列表，运行时授权仍读取当前批准事实。
- 相同实例、receipt 修订和包指纹的核对告警首次记录，之后每 5 分钟汇总重复次数；恢复正常、
  事实改变或 owner 切换后重新记录。告警事实在核对时同一遍收集，不能为每条异常重新遍历
  全部实例，也不为日志额外读取磁盘。刷新日志记录轮次、触发来源、耗时和合并请求数，用于
  区分“一处异常被多次检查”和“多个插件异常”，不记录凭证或用户内容。

这部分不改变 manifest、包格式、安装布局、批准权限、凭证或用户偏好，不涉及作者契约变更。

## 6. 作者契约与编写手册同步

内置 `cindy-plugin-creator` Skill 是 Agent 替用户编写插件的**统一手册与流程入口**，正本位于
`apps/desktop/resources/system-skills/cindy-plugin-creator/`。`SKILL.md` 负责流程与按需阅读索引，
`references/` 负责各章作者契约。创作流程以 §0a 的宿主版本与源码核验开头：先确认插件
执行电脑，通过实际版本对应的已验证 tag 或构建 commit 定位官方仓库，再按需核对公开
接口、宿主处理与测试。不能用 main 或未经核实的本地 HEAD 代替运行宿主；版本或源码
不可核实时说明限制，继续完成随包手册和运行时结果可以支持的部分。源码核验的详细流程
只维护在 `references/plugin-source-verification.md`，并由兼容手册入口读取同一份资料。
插件页「让 Cindy 创建」从当前引擎的本机命令清单中选择
已验证的内置 Skill，预填其实际命令名（Claude 同名冲突时带 `cindy:`）；始终优先内置版本，
不可用时提示并保留原草稿，不回退到同名用户 Skill。使用普通新任务的技能调用链路；
草稿保留内置身份，编辑正文、语音转写回填与切换 Agent 时不丢失；发送前按最终引擎和任务所在电脑的
命令清单重新解析，并同步调整正文范围。本机与设备互联 worktree 创建后，按最终目录再次
解析，避免来源分支不同导致同名命令归属变化；本机协同准备结束后才做最终解析，
直接发送解析得到的官方命令，不再按短名称重新选择。内置版本不可用时停止发送并保留输入，
恢复到已有任务的草稿及发送被拒后恢复的草稿都保留内置身份，每次重试在清空输入前重新核验。
跨路由首条消息与远程交接恢复副本也携带同一意图；任务页面在协同／认证等待结束、实际分派前
重新解析官方命令。恢复副本仅追加技能名和命令名，沿用按账号隔离及 7 天过期机制，兼容旧正文副本。
未认领的远程 worktree 沿用原恢复账本回收。远程供应商沿用任务电脑的 Skill 资源；SSH
没有 Cindy 内置清单时不回退本机。用户主动更换命令或替换草稿后不再保留原内置调用意图。
技能随应用内置 bundle 升级，不另建安装或权限流程。
`forgeGuide.ts` 从这些 Markdown 构造兼容的 `FORGE_GUIDE`，供旧 `ghost_forge_guide`
调用按原章节号读取。不要在 TypeScript、工具描述或界面文案中另存一套编写流程。
修改随包 Skill 字节时同步递增 `BUILT_IN_SKILLS_BUNDLE_VERSION`。改动其中的《Cindy MCP Apps 页面生成手册》
（`PAGE-GENERATION.md`）时，还要在对应客户端上线前把新手册发布到各区域 CDN，用法与发版前检查见
[`media-storage-and-protocols.md`](media-storage-and-protocols.md) 的《Cindy MCP Apps 页面生成手册》一条。
手册 CDN 路径带客户端版本号与 sha256（`mcp-apps/manual/<版本号>/<sha256>.md`），发布脚本从打包产出的
`build-info.json` 读取版本号、区域与发版提交；开发版（0.0.0）没有发布的手册。客户端在 `cindy.fetch` 中自动带手册地址（见第 4 节）后，每个发版版本、每个区域都
必须发布，否则该版本带出去的地址会 404，因此带地址的客户端上线前要先把发布接进发版流程。
**手册过期 = AI 按旧规则写出过不了校验的插件包**（校验拒装只是兜底，用户体验是“AI
反复打包反复被拒”）。

`ghost_forge_pack` 的边界严格止于校验和生成 `.cindy` 产物；打包成功不构成安装依据，
不得顺带安装、更新或启用插件。安装由用户导入本地包、明确要求当前 Agent 调用独立的
`ghost_forge_install`、点击市场安装或服务端 `defaultInstall` 明确触发；Forge 安装与本地
导入必须复用同一套 Main 安装／更新事务。

Forge 新装默认 root，不按当前登录组织自动创建组织实例。已有 root 优先原位更新；仅有
一份当前组织的旧实例时原位更新，保留其归属。新装组织实例必须明确传当前组织 `namespace`，
不能从名称前缀或当前登录推断归属。无法唯一确定已有实例时返回 `INSTALL_TARGET_REQUIRED`
与现有实例的身份、版本、启用状态，不默认新增并启用副本。用户选择更新时传 `target_instance_id`，另装时明确传
`install_copy:true`，两者互斥。更新受体仅可为 root 或当前组织，不能借当前组织权限更新
其它组织；落位前复核原受体 receipt 和实例键，变更后拒绝而非改选。换源或存在其它副本
时复用既有确认卡，说明位置、旧账号数据隔离及独立连接要求。不会自动迁移凭证、停用
旧副本或保存全局选择。本地文件导入仍只更新 root；新增 root 的确认框告知已有其它副本，
换源更新即使没有扩权也要确认账号影响。已装插件不会因升级被停用或要求补确认。

凡改动**插件作者可见的契约**，同一改动内必须同步更新手册对应章节：

- (a) `ghost.json` 身份卡字段或校验规则（`shared/ghost.ts` 的 `validateGhostManifest`）；
- (b) 管子协议（`cindy.send` / `cindy.onHostMessage` 的消息形态，`shared/ghost.ts` 管子类型）；
- (c) Cindy 模型代办能力的 kind／参数／模型白名单；
- (d) 面板供片协议与注入的主题 token（`cindy-ghost://` 分支、`ghostPanelTheme.ts` 白名单）；
- (e) 打包限制（`forge.ts` 的 `packGhostDir`）。
- (f) 安装、来源绑定、自动更新与能力展示的用户可见行为。

其中 `ghost.json` 属于 Ghost manifest 协议。新增或修改字段、v2 兼容映射或枚举时，至少同步：

1. 协议正本 `packages/plugin-protocol/src/manifest.ts` 及其测试；
2. Desktop 完整镜像 `apps/desktop/src/shared/ghost.ts` 及其测试；
3. 内置 `cindy-plugin-creator/references/` 的对应章节（兼容导出为 `FORGE_GUIDE`）及 Forge 测试。

`mainView` 的现行协议在 `FORGE_GUIDE` §4.20；v2 的 `main-view` 只保留输入兼容。

`taskView`（跟对话的任务页）的现行协议在 `FORGE_GUIDE` §4.22；v2 对应 `task-view` 槽。
任务页页签（右侧栏 kind `plugin-task`）存在各任务自己的页签桶里，随任务切换；页面与
panel / mainView 同一 Ghost WebView 沙箱（零桥、专属分区），只经查询参数 `session`
得知所在任务。逻辑页经 `cindy.taskView({sessionId?, focus?})`（管子 `task-view-request`）
打开或聚焦它：只承载包内页面、不收网址，因此不设 preview 式白名单与限速。Host 做资格审
（已装、启用、声明 taskView）与落点解析（显式任务优先，缺省台前任务），回执带回落点
任务。缺省或 `focus: false` 只打开页签，不切换任务或抢前台。
用户点击跳转时可传 `focus: true`：Host 须消费该插件实例最近 3 秒内的真实鼠标/键盘手势
（复用派活的一次性账本），无手势、过期或已消费均返回 `PERMISSION_DENIED`，不开页也不导航。
有效请求复用任务导航切到目标任务，并按用户操作显示任务页签；内嵌、分离侧栏和弹出页签均
保留用户放置位置，分离命令由 Main 沿既有路由与排队路径传递来源，不在执行端降级为后台。
成功回执的 `focusRequested: true` 仅表示导航请求已投递，不保证任务存在或已呈现；
旧 Host 可能忽略 focus，缺该回执字段时插件应提示更新。`peek: true` 始终只查询落点，
即使同时传 focus 也不消费手势或导航。实现与回归见 `taskViewSlot.ts`、`taskViewSlot.test.ts`
和 right-sidebar 的 `openPluginTaskTab.test.ts`、`executeSidebarCommand.test.ts`。
远程任务不投影本机插件的任务页；插件停用、卸载或不再声明 taskView 时页签隐藏。
使用该能力的插件须声明实际支持且完成整包验收的最低宿主版本。旧 Host 可能保留未知顶层
字段，但会拒绝 `locale.taskView` 或 v2 的 `task-view` 槽；运行时检测 API 不能替代安装兼容验证。
`mainView.icon` 只接受 Cindy 系统线性图标
`puzzle`、`globe`、`code`、`folder`、`database`、`chart-column`、`image`、
`message-circle`、`calendar-days`，缺省回退 `puzzle`。枚举值直接等于图标名，不设别名；
该字段只控制主视图侧边栏入口，不替代或修改根级 `icon` 品牌图片协议。后续扩展该枚举时也
必须遵守第 5 节的存量兼容红线，并核对第 7 节的旧客户端降级缺口。

反向同样成立：改校验必须同步手册；改手册宣称的新能力必须真有实现。`forge.test.ts` 的
关键章节存在性测试只是最低闸，不替代逐条人工核对。

**PR 约束**：命中上述任一路径的 PR，Description 必须写明「手册已同步（改了哪节）」或
「无需同步 + 为什么不涉及作者契约」；漏同步 = P1。

## 7. 已知安全／兼容缺口（不得随旧文档删除而视为完成）

以下缺口在触及相关链路时必须一并修复，或在 PR 中保留明确的正式跟踪，不得静默丢弃：

- **存量安装的 receipt backfill 必须无感。** `GhostManager.migrateLegacyApprovalsOnce()` 在对账前
  从旧安装事实重建等价的安装状态记录；迁移必须崩溃安全、不扩张 manifest 能力、只写状态根，
  并受 owner 租约保护。能自动重建时不得要求用户重新安装或确认能力；确实无法重建时应进入统一的
  legacy recovery 状态并保留凭证与偏好，不能伪装成普通停用，也不能把能力审批弹窗当恢复方案。
- **manifest 扩展的降级兼容（#1283）。** v3 通过“未知顶层字段原样保留，但当前 Host
  不展示、不授权、不阻止安装”解决向前兼容；能力一旦被 Host 支持，必须成为明确的直接字段
  和权限映射。v2 仅保留输入兼容：未知但格式合法的 slot 允许安装、运行时不提供能力。
  不得恢复独立的 Host slot 支持表或按名字猜测映射。能力动作和订阅事件只校验标识格式，
  不能以当前实现列表阻断声明；已知字段类型、安全路径、协议格式及运行时凭证边界仍校验。
  `schemaVersion > 3` 仍以 `GHOST_HOST_UNSUPPORTED` 拒绝，避免
  当前 Host 误读整体结构变化。已经发布的旧 Host 无法追改，降到 v3 改造前仍可能拒绝新清单。
- **声明与实现进度解耦。** 插件开发不应等待客户端先注册每一项扩展；声明被接收不等于
  API 已存在或获授权。插件必须检查所需接口是否存在，处理不支持响应，保留可用功能并对
  不可用部分给出升级提示。不得把权限拒绝、账号失效或网络故障当作“不支持”绕过。
  `minCindyVersion` 用于版本兼容声明与分发选择，不是运行时能力探测：手动导入、
  旧版客户端或其它分发入口仍可能让不适配客户端安装插件，必须有运行时降级路径。
- `networkSlot.ts` 的 `as: 'media'` 不能只信任 Content-Type（GLB 常见
  `application/octet-stream`），需要安全的 magic-byte／扩展名嗅探。
- SSH 远程场景必须让 `LiziMcpSessionContext` 携带 remote 标识；目录过户不得回退读取本机
  同名路径，无法证明来源时 **fail closed**。
- 手机版仍需把历史 mivo 动作按钮降级为纯展示。
- **安装内容字节仍可变、且加载时不校验。** 批准 receipt 钉住的是授权事实
  （manifest／trust／启停／revision），逻辑页代码仍从 `cindy-brain/<id>/` 现读；
  `packageSha256` 只是批准时点的来源指纹（市场／本地包 = `.cindy` 文件哈希，随包种子 =
  内容目录哈希），**没有任何运行期校验消费它**。因此能写这个目录的本机进程仍可替换
  代码，只是被限制在**此前已批准的权限集**内运行，且不能借改写 `ghost.json` 扩权。
  技能目录因为越出沙箱已单独拷成快照（第 3 节），其余内容的持续完整性校验仍未做——
  改动装入链路时不得声称已有内容完整性保证。
- **批准状态根自身没有写保护。** 这是与上一条并列、但**不同**的缺口：上一条说的是
  内容根字节可变，这一条说的是 `<userData>/ghost-install-state/` 本身对同权限本机进程
  可写。当前实现已经把能在写入侧关掉的窗口关掉了，**剩下的是消费侧的窗口**，两者要分清：
  - **已关闭（写入侧）**：技能快照的字节指纹在每次写批准事实时都重新核对——接受既有
    快照前核一次、复制到临时目录后核一次、`rename` 就位后再核一次（`skillSnapshotMatchesReceipt`
    是唯一判据）。因此"复制完到 rename 之间被改写"与"快照事后被就地改写"都会在下一次
    写批准事实时暴露：对不上就删掉重建，重建仍要过安装目录的字节校验，安装字节也漂移
    时一律拒绝并要求重新安装合法包。
  - **仍未关闭（消费侧瞬时窗口）**：启动/装卸/启停广播触发技能对账时，Host 会在建立
    或保留私有投影前重新核对整棵批准快照，加载清单也核验批准来源；但核对之后、主 Agent
    读取技能之前，快照仍可被同权限进程改写。Agent 的读取路径不在宿主控制内，宿主不做逐次
    校验。receipt 同理——它有严格结构与字段校验（改坏即判 `invalid`、fail closed），
    但没有签名或 MAC，能写状态根的进程可以伪造一份结构合法的批准。
  - 彻底关闭需要给状态根加签名／MAC 或 OS 级写保护，**尚未做**；改动批准链路时不得声称
    批准状态不可伪造，也不得把"写入侧已核对"说成"消费时读到的一定是被批准的字节"。
- **点开头目录的内容不进随包指纹（有意为之，不是缺口）。** `fingerprintDirContent` 与
  `hashApprovedDirectory` 都跳过 `.` 开头条目（`.disabled`、`.cindy-trust.json` 是用户与
  宿主状态，不是插件内容），点开头**目录**整条不递归。之所以安全：清单里所有相对路径
  （`entry` / `node.entry` / `panel.html` / `settingsHtml` / `icon` / `locales` / skill
  `dir`）都过 `isSafeGhostRelativePath`，段首字符必须是 `[a-zA-Z0-9_]`，任何声明都不可能
  指向点开头目录里的文件——它们既不会被当代码加载，也不会被当技能读取。点开头条目本身
  的**类型**仍然要判（名为 `.x` 的链接会翻起 `hasNonRegularEntry` 并触发重新播种），
  判定顺序见 `ghostContentTree.collectGhostContentFiles`。改这条策略前先确认清单路径
  正则没放开首字符。

## 8. 远程与手机版

移动页面契约见 [移动插件接入](plugin-mobile-implementation.md)。可选 `mobile` 声明
只选择已有能力的页面入口，不改变旧插件批准、凭证或安装布局。逻辑仍由执行电脑运行。
Host 为页面消息附加 `mobilePageId`，原生弹窗、任务操作、目录选择和预览等必须保留
该来源；页面覆盖、关闭、账号/连接/安装代次改变后，旧响应不得继续写入或清除未读。
手机任务配置复用普通任务配置校验。密钥/连接表单走 Host 原生 v3 加密授权通道，
不得通过 WebView、BroadcastChannel 或通用插件 fetch 传递凭证。


插件能力可能运行在 SSH 远程工作区、设备互联远程控制或手机版控制端。新增或修改 IPC
channel 与推送事件时，若手机／远程控制场景需要用到，必须按
`packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并同步
topic 路由；产品层多端语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md) 的
「多端连接与任务连续性」。缺登记会让手机／远程控制端永远调不通，且静态检查发现不了。

## Review 清单

1. 沙箱是否保持进程隔离、专属 partition、无 Node／宿主 FS／通用网络直连？HTTPS 图片
   例外是否仍严格限定为 `protocol === "https:" && resourceType === "image"`？身份是否由
   主机反查而非信任 sender 自报？
2. 是否先按执行者分清边界：当前 Agent 在途的通用操作是否严格绑定同插件、同会话、
   未交卷的 `callId` 并复用 Agent 授权；插件自主 Host 能力是否以 manifest 直接字段声明、
   在详情如实展示并由 Host 守门？是否误把安装弹窗或前端展示当成授权事实？
3. receipt 是否仍只由 Main 的合法安装／更新／迁移事务写入？跨进程更新是否回传
   `ghostInstallApprovalToken()` 并在锁内重读比对？缺失或损坏状态是否优先无感迁移，
   而不是用安装确认充当恢复方案？停用方向是否始终可成功？技能快照与字节指纹是否仍受保护？
   3.5. 新增或改动的装入路径是否显式交出安装确认策略，并在锁内用真实包复核
   （`assertGhostInstallConsent`）？确认等待是否在所有安装锁与 owner 租约之外？后台路径是否
   只会 `automatic` 放弃、从不替用户确认？Agent 路径是否不受任务权限档影响、始终确认？
4. Agent 在途网络是否仍通过 URL／SSRF／重定向等 Host 守门，自主网络是否限 manifest
   白名单，托管凭证是否只向声明且命中的 host 注入、无明文读回？附件／媒体／目录是否经
   归属校验的 grant／deposit／ledger 交接，未暴露宿主绝对路径？
5. 内联凭证是否只走 trusted Desktop 专用 IPC，未登记 device-link？Main 是否重新校验
   sender、request、revision、action、精确字段集合与 manifest 绑定？
6. Forge（scaffold／pack／install）是否排除了 Host 受管根，按 realpath 双向判定并挡住
   大小写与软链／junction 别名？`ghost_forge_pack` 是否仍然只产出 `.cindy`，没有隐式安装；
   `ghost_forge_install` 是否只在用户明确要求时调用并复用本地安装／更新事务？
   6.5. 新增的“读插件内容目录”代码是否走 `ghostContentTree.ts` 的统一分类、逐段路径解析和
   指纹格式，而不是就地复制一份 `readdir`／`stat` 实现？
   6.6. **存量插件升级后还能不能用（第 5 节红线）**：改动安装状态记录、manifest、能力字段、
   快照、安装根、包格式或管子协议时，是否提供无感 backfill，保留已装、启停、凭证与偏好，
   并覆盖旧布局 fixture？让存量插件失效且无迁移 = P0。
7. 改动是否命中作者可见契约（身份卡／管子／模型代办能力／面板供片／打包）？命中就必须
   同步 `FORGE_GUIDE` 并在 PR 说明；漏同步 = P1。
8. 第 7 节的已知缺口是否被触及？触及是否一并修复或留了正式跟踪？
9. 新增 IPC／推送是否需要远程／手机版？需要就登记 device-link 白名单与 topic 路由。

最小验证入口：

```bash
pnpm --filter desktop exec vitest run src/main/cindy-brain
pnpm --filter desktop typecheck
```

其余按 [`desktop-development.md`](desktop-development.md) 的分层验证选择；命中媒体、协议或
IPC 时追加对应专项规则要求的验证。

### 只读 Agent 模型目录

插件自己的同源 `GET /agent-models` 面向 settings、panel、mainView 与电子脑。
无需新增 manifest 权限，不改变存量批准状态。无参时投影已连接来源中可用于新任务的本机
`id/name/agent/providerId/providerName/efforts/defaultEffort/visible`，并追加 `locations`
（同账号其他电脑与生效中的供应商分享，不含本机；读失败则省略）。可选查询参数只有
`agent_device_id`：带上后读那台允许远程调用的来源并回显 `agentDeviceId`，不查 `locations`。
来源级强度不能被跨来源合并。无参 visible 复用当前账号模型选择器的用户开关与目录默认值；
带参 visible 只用模型目录默认值，不套本机开关。隐藏项保留供显式展开，偏好未就绪不伪造默认。
使用 ProviderService 的 `allowSideEffects:false` 读取本机清单；带参经 `readDeviceProviderViews`
跨设备读取。不主动发现或认领凭证，不调用模型。不暴露 ProviderView、auth、账号 identity 或 endpoint；
响应 no-store、仅 GET。其他参数、重复参数、空或超过 128 字符的 id 返回 400；格式合法但读不到
（离线、未知、没开远程控制）返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目。
旧 Host 带任何参数都返回 400。检查插件在装启用与 owner 归属，异步返回前复核。
旧 Host 404 时插件应明确提示升级。此端点不覆盖远程 SSH 模型，执行前仍需核验真实路由。

### 宿主统一模型选择器（新增接口，尚未发布）

电子脑 `cindy.pickModel({initial?,mobilePageId?})` 与桌面页面同源 `POST /model-picker`
复用 Cindy 的统一模型选择器，返回完整 `PluginTaskRoute`（来源、模型、引擎、思考档位、Fast）。
选模不需要新的 manifest 权限、不改变存量批准，不修改默认或现有任务、不执行模型调用。
任务创建仍走原任务能力批准。仅返回显式配置字段，不返回凭证、endpoint 或 ProviderView。

Main 按真实逻辑页或专属协议分区定位物理实例，绑定当前 owner 与安装批准版本；
只接受目标宿主窗口或目标页面的回答，验证输入形状与实际可用路由，异步校验后再次复核绑定。
同一 Host 仅一单，重复打开沿用目录选择的限速。取消、90 秒超时、窗口/页面关闭、账号边界、
插件停止均撤销等待并收起界面；不可用的来源保持选择器可编辑，不能静默换模型。
手机与远程桌面设置页保留显式 mobilePageId，展示端读取执行电脑目录，缺失/失效来源不回退另一设备。
旧 Host 通过函数检查/404 明确升级；旧控制端忽略新增可选 modelPickers，超时取消，不产生执行。

实现见 `ghostModelPicker.ts`、`PluginModelPickerHost.tsx`、`mobilePageService.ts`；
作者契约见 `cindy-plugin-creator/references/plugin-agent-models.md`，回归见 `ghostModelPicker.test.ts`。


### 同账号插件资料同步

`deviceSync: true` 是独立自主能力；旧版插件的权限不变。Host 只允许 namespace 已确认、
已装启用且批准有效的同一插件在同账号未撤权电脑之间交换有界密文，业务合并与持久化
留在插件。每次请求和回执重新核验 owner、安装 revision、namespace 与 peer。
不向插件提供设备私钥、账号 token 或其他插件数据，不为通道增加远程 Renderer IPC。
接口和失败语义见 `FORGE_GUIDE` §4.10.2，协议与兼容边界见
[协议兼容](protocol-compatibility.md#插件资料设备同步)。

## 社区插件贡献入口

个人作者可从来源可核实且已批准的本地 root 插件详情提交审核；已有公开插件的后续版本通过“发布插件”管理页提交，并核对当前提交授权。安装或运行批准本身不授予发布权。Host 复用导出快照原语和现有包自检，
不弹保存/选文件框，不接受任意路径或独立资料。准备绑定原物理实例、安装目录、批准版本与账号；
登录意图也须核对这些证据，不按同 ID 替换为另一个账号安装。私域 ledger 关联不可转 public；
合法 public Broker 声明仍由服务端既有 public 规则与精确 ACL 判断，不靠声明直接拒绝。

个人工具与旧企业 Forge 发布是独立能力入口。任务权限只决定是否可以执行公开写入，不决定
public 身份归属；共享访客不能借用 Host 个人发布能力。插件创建的任务、Worker 和收到插件消息的
普通任务按当前账号及任务权限执行个人投稿，不因插件来源标签另加限制。

详见 [客户端实现与验证边界](../plugin-community-contribution.md) 和
[HTTP 契约](../plugin-community-contribution-contract.md)。此改动涉及打包原语和授权边界，仍须人工 review
及本规则第 5 节的插件基座白名单确认后方可合并；本地代码检查不替代该门禁。


## 插件伙伴委派协议与回执（未发布）

agent.delegation 为可选独立能力，依赖 tasks + targets，只有 Host 确认的
delegationCapabilityApproved 才授予；历史未知字段、旧 tasks/targets 批准不推断新授权。
缺省不改变旧权限项、批准、配置或回执摘要；已安装的历史字段保留，不因新校验停用。
新包严格校验声明，旧 receipt 缺少新可选字段照常读取。无需 schema migration。

targets.capabilities 新增只读协议发现；delegation.version=1 与 execution 就绪状态分开。
执行端接入现有 Auto 审核后才报告 execution=true；未就绪时显式 delegation 请求在预留/投递前返回
UNSUPPORTED_CAPABILITY，不降级为普通消息或另建任务。旧 Host 无入口时不发送。
委派只允许 bot + queue，scope 最多 8000 字符并参与请求摘要，持久回执保存版本、
执行范围及原目标/批准事实。取消、撤权、换批准版本和恢复排队沿原接口复核。
Main 从当前接受的输入、原批准和持久回执读取 scope，交给现有 Auto 审核投影；
不伪造主人原话，不提升伙伴权限，不新增团队，Core 不包含业务插件流程。
作者契约见 cindy-plugin-creator/references/plugin-agent-tasks.md §4.11.7。
