# 移动插件接入

手机通过设备互联使用执行电脑上的已装插件。插件业务逻辑、Library 和任务仍在电脑上；
手机提供入口、隔离页面及原生交互，不复制插件安装或另造任务类型。

## 入口与页面

- 主菜单提供插件入口和聚合未读点；目录按电脑展示，支持搜索、最近使用、详情和启停。
  宽屏目录与内容并列，样式使用 Light/Dark 语义 token，文案覆盖现有五种语言。
- iOS 已装目录使用现有 `@expo/ui` 的 SwiftUI List、Menu 和 Picker；搜索复用现有导航栈的
  UIKit UISearchController / UISearchBar，置于标题下并常驻。电脑范围和标题行是普通列表内容，
  随页面滚出；All/Unread 筛选暂不展示，保留内容通知提示点。未读不表示可用更新。
  两页使用平面 List；详情启用 Toggle 放在插件名称右侧，iOS 可视目标 48×24pt，保留 56×44pt 操作区域。
  Use it in 标题下仅保留新建/已有任务原生 secondary 按钮，不附加说明。
  panel/mainView 合并为一个打开插件入口；Tools、Permissions 与 Details 使用真实 Host 只读数据，
  Tools 使用弱底色胶囊与工具图标，随容器宽度自然换行，默认最多两行，标题保留总数；溢出时提供 Show all / Show less，始终隐藏描述；权限复用 PC 声明摘要（排除 tool）。
  分组之间不画线，仅 Details 条目之间使用系统 Divider，避免重复 padding；身份首行顶部 inset 8pt。
  Details 按 PC 顺序展示版本、作者、来源与签名、标识、包含能力、面板和只读安装目录，
  内容与信任标签复用 PC 共享规则。旧 Host 缺字段时仅显示已有真实版本/标识；可选字段为空则隐藏，
  Tools/Permissions 无数据则整组隐藏，不展示未提供数据或缺描述的占位提示。
  不推断为无权限、不补造事实或面板停靠状态。配置和任务偏好不内联，提示到电脑插件详情设置。异常时显示必要提示和单个解决动作；
  导航容器负责容器安全区，Host 保留键盘避让。图标与专用任务设置继续复用 RN 内容。Android
  保留平台列表与搜索，控件同样随内容滚动，详情使用平台原生 Switch。
- Installed 固定按最近使用排序，不展示添加时间/最近使用的筛选交互，不重复展示 Recent 分组。
  最近使用以手机 MRU 优先、Host MRU 补充；不得用没有真实来源的安装时间替代。
  只记录实际成功打开页面/使用入口，查看详情不记。列表可选 pluginOrder 只下发
  addedAt/recentIndex：addedAt 来源于成功首装记录，不取更新/通知/首次手机发现时间；
  老 Host 或历史缺失时间保持未知，排在已知添加时间之后并稳定原序。手机 MRU 优先，
  Host MRU 补充，同排名保持稳定。不同电脑的插件用资源 key 区分，配置与凭证不参与排序。
- 启停开关等待电脑操作回执并重新读取插件状态，操作期间禁止重复点击，成功后保留详情。
  离线时不可操作；失败不自动重发，账号或详情已切换时旧响应不覆盖当前页面。

### 插件市场与安装（提案实现，待维护者确认）

2026-11-25 提案实现：插件页搜索框下加「已安装 | 插件市场」分段（默认已安装，搜索时收起，
先列已安装再列市场），让手机给某一台电脑安装它还没装的插件。这是新增界面行为，是否接受由维护者确认。

- 市场是「某一台电脑能装什么」：顶部「安装到 <电脑>」，多台电脑时可切换，不含「所有电脑」。
  顺序：本次打开插件页期间在市场里手动选的（在已安装与市场分段之间来回切换也保留，退出插件页后失效）＞
  已安装分段选的具体电脑（这两种即使离线也保留，显示未连接）＞
  本机记住的上次市场电脑（在线时）＞ 任一台在线电脑 ＞ 都不在线时用记住的或第一台。自动选择不改写
  「记住的那台」，并在每次进入市场分段时定下（本机偏好读完、且已知有电脑在线后；偏好没读完前市场显示加载、
  不向任何电脑发读取），浏览期间电脑上下线不会让列表跳到别的电脑，下次进入再重新选。
  安装进行中市场固定在正在安装的那台。
  来源筛选全部 / 官方 / 社区 / 团队共享 / 自定义，默认官方；团队共享与自定义只在有对应内容时出现；
  官方与社区是公开页按 `publisherKind` 在本地筛出的子集，与电脑端远程页一致。
- 读取只用目标 Host 的 `management:snapshot {read:'capabilities'}` 与 `{read:'catalog',query}`：
  列表页 `excludeInstalled:true, counts:false`，计数另读一次 `scope:'all', limit:1, counts:true`；
  同一电脑、查询、来源 30 秒内复用（最多 6 份），下拉刷新强制重读；只看市场时（不在搜索），下拉刷新与「重试」
  同时重新查找电脑，读取电脑列表失败后不用切分段也能恢复。切到别的电脑或连接代次后才返回、被丢弃的
  读取会把那份缓存的读取中状态放开，回到原电脑时重新读取而不是一直加载。官方 / 社区整页无匹配时的自动续读
  只在插件页仍挂载、市场仍可见、页面有焦点、还是同一份列表，且当前实际的来源筛选与输入中（未去抖）的搜索词
  都没变时继续（官方与社区共用公开列表，切换筛选或去抖期间不按旧条件续页）；搜索按「全部来源」判断是否有匹配。
  装好后只从安装目标那台电脑的缓存里移除该插件、重读那台的计数，其他电脑的列表不动；同时作废那台电脑在安装前
  发出、还没返回的列表读取（含下拉刷新），它们的回包不再落地，回到市场时重读一次那台电脑的当前列表。旧 Host 回 `INVALID_PARAMS`
  或没有管理能力时显示「先更新那台电脑」，不回退一次读全量；普通读取失败只给重试，重读失败但保留上次条目时
  附一句「未能读取插件市场」。探测通过后某次分页读取回 `INVALID_PARAMS`，同一电脑与连接代次内最多重新探测一次。Host 抛出的错误经
  dispatch 到手机是不带 code 的 `Error("[CODE] …")`，管理 client 按 `deviceProvidersCache` 的做法解出 `CODE`。
  页面按白名单字段做有界解析，`publisherKind`、`organizationAccessError`、`counts`、`nextCursor`
  缺失即降级；图标只接受未过期的 HTTPS 链接，自定义市场项不显示图标。
- 详情读 `management:market-detail`（列表项 + manifest，无 README），工具名来自 manifest；
  权限只在电脑下载并检查真实安装包后的确认回执中出现。安装沿用现有管理 controller 与确认面板：
  点「安装」→ 等待确认 → 允许并继续 → 正在安装 → 成功后打开该插件的已装详情。每次安装单独
  挂一个 controller；这条路径的 controller 读 `{read:'installed'}`（安装前已确认 Host 支持分页），
  一次安装 4 次轻量读，不读全量；装好后打开的已装详情仍沿用原 controller 的全量管理快照（既有行为）。
  同一时间只允许一个安装；安装中市场固定在那台电脑（已安装分段改电脑要等安装结束才生效），
  也不能同时从已装详情发起升级或卸载；反过来，已装详情的升级从读市场详情起就占用这一位置（宽屏下市场仍在旁边），
  读完前市场不能开始安装，读完时若市场已开始安装，升级在 begin 之前停下。失败说明按「电脑 + 插件」记录，只显示在那台电脑的这一行。
  controller 没真正开始（连接代次变化或只发布了错误）时立即放开这一行并说明原因。失败在行内说明原因并可再点；
  断线结果不确定沿用「结果待确认 / 核实结果」，只查原操作，从不重发。原操作已查不到（Host 重启、回执超过
  15 分钟或 begin 未送达）时，以这次核实读回的电脑事实收口：controller 在收到 NOT_FOUND 后保持忙碌、重读已装快照，
  把这份快照作为 `missingReceiptFacts` 发布，市场只用它和它里面的实例判定，不用 NOT_FOUND 之前读到的快照。
  NOT_FOUND 之后只认最新发出的那次已装读取：更晚的读取（例如插件变更刷新）还在途时不发布事实、保持待确认，
  它落地后成为新的事实。事实是否有效在取用时判断（`currentMissingReceiptFacts()`：只有来自最新一次发出的已装读取的
  事实才有效），新的已装读取一发出，已发布的事实就撤回，按旧事实在途的市场详情不再落地；市场的三种结论（已装上 /
  目前没有 / 未能确认）只经同一个出口，落地前再判断一次有效性。回归用例按全部回包顺序枚举，不手挑顺序；每次判定带代次，
  较早一次核实的市场详情晚到时不落地，也不打开实例。快照里有同 ghostId、同 namespace 的实例只是线索
  （电脑上可能是同标识的本地包）。只有用户在手机上实际批准过的才可能是这次的结果：controller 在「允许」**写出到传输层**（本次请求的写出回执，握手不算）时
  记下 `approval`（这次操作与当时回执里的来源），新操作才清掉；没有它（拒绝、没点就断线、确认没送达、来源不符时「允许」
  不可用），电脑上之后出现什么都按「未能确认」处理，官方与社区市场同样适用；自定义市场另要求批准时的来源与用户选中的
  完整来源相等（controller 在来源不符时直接拒绝发送「允许」）。满足后再按原 `pluginId` 读一次 `management:market-detail`，只有电脑按市场来源记录
  判为 `installed` 且 `releaseId` 与这次安装一致时才按成功处理、打开已装详情；自定义市场还要求条目的
  `installedSourceId` 与批准时回执 `originSource.sourceId` 完全相等（同名市场被换成另一个仓库或本机另一个目录、
  插件 ID 与版本都相同时，Host 的 `installed` 描述的是新来源；`sourceId` 是 Host 按完整来源配置生成的不透明标识，
  能区分仓库文字区分不了的情况）。没收到确认回执、或旧 Host 给不出 `installedSourceId` 时同样不算成功；`conflict`、`update-available`
  或版本不一致时不打开任何实例：Host 已确认查不到原操作（NOT_FOUND）且市场事实已读到时，这一行记下
  「没能确认这次安装的结果……请在电脑上核对」并放开市场与其它管理操作（原操作不重发，是否重新安装由用户决定）；
  只是电脑暂时连不上、原操作可能还在时，保持「结果待确认」。快照里没有时放开这一行并说明
  「没能确认结果、目前这台电脑上没有这个插件」，只陈述当前事实、不推断回滚，是否再装由用户决定。
  同标识冲突（`conflict`）只提示到电脑上处理。
- 读取围栏（`usePluginMarket.ts`，所有入口走同一处判断）：
  - 发送前：`readsOpen()`（插件页仍挂载、市场在有焦点的在线电脑上显示、App 在前台；进入后台时路由仍有焦点、
    电脑在 Device Link 退出宽限期内仍在线，所以单独跟踪 `AppState`，回到前台再恢复）加上读取 scope（电脑、账号代次、连接代次），
    由读取 client 在排队请求真正发出前再查一次；
  - 回包落地：同一份缓存列表、读取代次未被安装作废；
  - 首页与计数：`sameView()`（列表或计数的键仍是屏幕上的那个，输入中的搜索词等于这次读取用的搜索词），排队时改了
    搜索就不再发出；因视图变化而被丢弃的首页按「放开」处理，不算读取失败；
  - 下一页：`followUpAllowed()`（还是屏幕上那份列表，加上 `sameView()`，自动续页另要求来源筛选未变）；
  - 能力探测：按探测代次只认最新一次。
  自查矩阵（✓ 表示该情形下不发请求或回包不落地）：

  | 入口 | 卸载 | 离开市场 / 失焦 / 后台 | 换电脑或连接代次 | 换账号 | 切来源 | 搜索未去抖 | 安装后 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 首页 / 下拉刷新 | ✓ 发送前 | ✓ 发送前 | ✓ scope | ✓ scope | 新列表键 | ✓ 搜索词（排队中改搜索不发） | ✓ 代次作废 |
  | 自动续页 | ✓ | ✓ | ✓ | ✓ | ✓ 来源筛选 | ✓ 搜索词 | ✓ 代次作废 |
  | 加载更多（滚动） | ✓ | ✓ | ✓ | ✓ | 同一公开列表照常 | ✓ 搜索词 | ✓ 代次作废 |
  | 计数 | ✓ 发送前 | ✓ 发送前 | ✓ scope | ✓ scope | 新计数键 | ✓ 搜索词（排队中改搜索不发） | 安装后重读 |
  | 能力探测 | ✓ 发送前、代次 | ✓ 发送前 | ✓ scope、代次 | ✓ scope | — | — | — |
  | 市场详情 | ✓ 发送前 | ✓ 发送前 | ✓ scope、详情关闭 | ✓ scope | — | — | — |

- 发送时序与「已写出」（维护者 2026-11-25 08:48、09:30 评审后对照代码写明）：
  - `DeviceLinkContext.invoke` 的 `preSend` 只是校验：入口先调一次；不是共享任务对端时，直连尝试（`tryMobilePeerInvoke`）
    返回后再调一次；走中继时，`recoverLinkBeforeSend` 与 `sendInvoke` 在连接就绪后再调；device-link client 在请求出队、
    首次写 socket 之前最后调一次（增量读取失败重发前还会再调）。任一次抛错就中止发送，错误原样上抛。
  - 「已写出」只认本次业务请求自己的写出回执 `onRequestWritten`（`DeviceLinkContext.invoke` 的可选参数，仅本端，
    不进线上帧）：Device Link 在这条 invoke 首次写 socket 时（`noteFirstWrite`，也是失败带 `inFlight: true` 的同一处）
    调用；Agent-Net 会话路径在会话收下请求（结果不是 `NOT_SENT`）时调用；直连路径给出结果或尝试中抛错时调用。都在调用
    结束前调用一次。链路恢复的握手帧（`link-open`）写出不算：握手写出后超时也带 `inFlight: true`，但那不是这条请求。
  - 插件管理 client 据此分两态：有回包或回执已调用 = 已写出（`onWritten`）；失败且回执没调用 = 确定没写出（任一次校验
    拦下、排队或路由拒绝、握手失败、首次写出前过期）。写操作（begin / answer / cancel、启用停用等）确定没写出就是普通
    失败：放开管理位置，可以重试；已写出而结果不明才是「结果未知」：只查原操作，不重发。
  - 测试用的传输替身按同一顺序：入口调 `preSend`、可选排队、出队前再调 `preSend`、随后调 `onRequestWritten`，写出后超时以
    `inFlight` 失败；`historyViewProvider.test.tsx` 用真实 Provider 走链路恢复锁住「仅握手写出」「出队被拒」「写出后超时」
    三种，device-link `client.test.ts` 与 Desktop `agentNetSessionLinks.test.ts` 用真实 client 锁住回执的调用点。
  - 自查矩阵（结论：写操作的结果）：

    | 情形 | 业务请求写出 | 回执 | 结论 |
    | --- | --- | --- | --- |
    | 入口校验拦下 | 0 次 | 不调用 | 失败，可重试 |
    | 链路恢复握手写出后超时 | 0 次 | 不调用 | 失败，可重试 |
    | 排队期间实例消失，出队前校验拦下（维护者 09:30 #3） | 0 次 | 不调用 | 失败，放开管理位置 |
    | 首次写出前过期（`BACKPRESSURE`） | 0 次 | 不调用 | 失败，可重试 |
    | 写出后回包超时或断线 | 1 次 | 调用 | 结果未知，只查原操作 |
    | 写出后重发前校验拦下 | 1 次 | 调用 | 结果未知，只查原操作 |

- 确认面板（全新安装与升级共用 `PluginManagementConfirmation(.ios).tsx`，文字由 `pluginConsentPresentation.ts`
  统一给出，提案实现，待维护者确认）：
  - 来源行与电脑端 `ghostInstallConsentSourceLabel` 同口径：「来自 {{appName}} 插件市场」「来自自定义市场「<市场名>」」
    「来自本地 .cindy 文件」「本地开发的插件」；用户发起不加说明，Agent 发起套「由 Agent 发起 · …」。品牌名走 i18n
    的 `{{appName}}`（两版同为 Cindy，见 region-and-editions.md §2.1）。
  - 来源说明与电脑端 `ghostInstallSourceNoticeKey` 同规则，只在全新安装时显示：回执带 `communityMarket: true`
    （Host 核实的社区发布者）时显示社区说明，自定义市场显示「请确认你信任该市场……」，本地文件显示对应提示。
    解析只接受缺省或 `true`。
  - 全新安装首行写「安装到 <电脑>」，升级仍只写电脑名。
  - 行序：名称与版本 → 安装到 <电脑> → 来源行 → 仓库 → 第三方来源提示（`installationSource`）→ 来源说明 → 版本变化 →
    插件标识 → 权限列表。前四行（电脑、来源、仓库、第三方来源）用 textPrimary、不加粗、不用警示色，在 iOS 半高面板与
    Android 矮屏上和高风险固定段同屏可见；来源说明、版本变化与标识用 textSecondary。
  - 高风险固定段：固定显示 Host 自己当作高风险的权限项，按稳定的 diff key 判断（`isPinnedHighRiskPermission`）：
    `node:execute`（运行随包 Node 程序，文案自标「高风险」）、`node:secret:*`（把已保存凭证明文交给 Node 程序）、
    `node:resident`（Node 常驻）、`agent:background`（不点击也能让 Agent 开始工作）、`agent:errand`（派活取件）。
    后四项在 Host 源码里称作高风险加档，维护者评审要求一并固定。手机端不另定分级，`kind` 也包含低风险项，所以不按 kind 判断。
    按钮正上方、滚动区之外（iOS 在 ComposerSheet 的 footer，Android 在 ScrollView 与按钮之间）只放有限高度的摘要：
    标题「高风险权限」加每类一行（按 Host 顺序去重，最多五行，每行最多两行；凭证绑定用固定短句：多个写「可将 N 个已保存凭证
    提供给本机 Node 程序」，一个写「可将 1 个已保存凭证提供给本机 Node 程序」，都不插入包声明的名称——Host 允许最长
    64 字且可含换行的名称，插进两行摘要会把「本机 Node 程序」挤出视野），textPrimary，不用警示色；与滚动区之间用一条细分隔线（iOS 原生 `Divider`，Android 用 `border` token 的
    hairline 加留白），标题与列表里的权限标题同字号、加粗一档（iOS `subheadline` semibold，Android `bodySmall` semibold）。
    列表里的高风险项保留标题行（列表是完整清单，升级时带「新增 ·」前缀），靠分隔线避免看起来重复。
    摘要的每一行都完整显示，不按行截断，按固定的类别顺序排（运行 Node 程序、凭证、Node 常驻、后台 Agent、派活取件），
    不随包内声明顺序变化。摘要行区的高度上限由 `pinnedHighRiskMaxHeight` 按实测高度算出：面板可用高度减去身份块（标题、
    插件名、安装到、来源、仓库、来源变化提示、第三方来源提示）、摘要标题、按钮与固定留白，保证这些不滚动可见；未测得前用
    面板的四分之一，最低保留一行（44）。超出上限时摘要区自身滚动，并常显滚动条（Android `persistentScrollbar`，iOS
    `scrollIndicators("visible")`）。Android 面板最高为窗口的 85%；iOS 有摘要时只用大高度，可用高度取窗口减去顶部安全区
    与面板标题栏（随字号增长）。iOS 的 SwiftUI ScrollView 会占满给它的高度，所以给它显式高度 = 实测内容高度与上限取小。
    凭证那一行把接收方放在句首（「本机 Node 程序可获得 N 个已保存凭证」）。
    iOS 有高风险项时确认面板只用大高度（`ComposerSheet` 的可选 `largeOnly`，默认不变）：半高时向上滑是展开面板而不是
    滚动列表，列表下方的内容会像滚不到；`@expo/ui` 没有 `presentationContentInteraction`，无法改成先滚动。iOS 半高面板与 Android 矮屏都不用滚动
    就能看到，也不会把来源、说明和按钮挤掉。每项的完整说明（凭证名与允许的全部方法）留在可滚动的权限列表里，
    高风险项排在最前。Host 允许最多 4 个凭证绑定、每个 16 个方法，摘要高度不随数量增长。升级只看本次新增项。
  - 自定义市场的仓库：「来自 <市场名>」下方显示目标 Host 从本次实际取包的来源生成的去敏仓库标识（「仓库 host/owner/repo」，
    带 ref 时附上；本地文件夹市场显示「本地文件夹」）。字段约定见
    `protocol-compatibility/same-account-remote-plugin-management.md`「自定义市场的来源身份」（由 Host 前置 PR #12731 登记）。
    形状按契约第 2 版：git `{kind, repository, ref?, sourceId}`、本地 `{kind, sourceId}`，`sourceId` 为 22 位 base64url，
    多键或缺键都算不合法。回执里 `originSource` 不合法时整份回执按无效处理；市场条目的 `sourceIdentity` 不合法时
    只丢掉该字段，`installedSourceId` 不合法时按缺省。比较来源时四个键都要相等，`sourceId` 不展示。
  - 来源变化的更新（契约 V2.4b）：回执的 `originSourceChanged`（只接受 `true` 或缺省，否则整份回执无效）表示已装实例
    与这次更新的来源都可核实且不同。升级确认面板在仓库行下方用 textPrimary 显示与电脑端相同的那句「这次更新的来源与
    已安装的版本不同……」；任务卡在 `input.originSourceChanged === true` 且来源有效时同样显示（不用展开详情）。市场条目的
    `updateRequiresConsent` 现在也可能因来源变化置位，手机端只解析、不展示，没有受影响的文案。
  - 发起前复核来源：市场开始安装时读到的详情、以及 controller 在 begin 前最后一次读到的详情，其 `sourceIdentity`
    都必须与用户选择时的完全相等；缺失或变化时不发 begin，这一行提示「来源刚刚有变化，请重新选择」。
  - Agent 发起的安装走任务确认卡（`cindy.plugin.install`，`InteractionPanel`）：卡的 `input` 带 `origin`，自定义市场
    另带 `source`（与回执的 `originSource` 相同）。卡上只显示校验过的仓库一行；交给通用预览（含伙伴卡的完整输入与
    「详情」）的是专用的安全字段（插件标识、版本、操作、来源类型），原始 `source`（含 `sourceId`、不合法值）不显示。
  - 缺来源身份或来源不符时不能在手机上批准（维护者 2026-11-25 05:55 评审，按 #12731 契约）。这收紧了主干既有的
    旧 Host 升级能力：旧 Host 上自定义市场插件的升级要回电脑做。
    - 市场条目缺 `sourceIdentity` 时，行内与详情的「安装」不可点，行内写短说明、详情写完整说明（在电脑上刷新这个市场后
      再试——Host 升级后、到该市场下一次刷新前 Git 来源的身份会暂时缺省；电脑上的 Cindy 较旧时先更新；或直接在电脑上
      安装）。列表有、开始安装时读到的详情没有时，在 begin 之前停下并在这一行说明。
    - 已装详情的升级在发起前读市场详情：没有来源（「这台电脑暂未提供仓库信息……在电脑上刷新或升级」）与来源真的变了
      （「来源刚刚有变化，已停止升级」）分开提示；controller 在 begin 前最后一次读取同样区分 `PLUGIN_SOURCE_UNVERIFIED`
      与 `PLUGIN_SOURCE_CHANGED`。
    - 确认面板：`origin === 'custom-market'` 且缺 `originSource` 时，首装和升级都「允许」不可点、「拒绝」可点，仓库行写明
      回电脑的做法。从手机发起的安装或升级，controller 记下用户选中的完整身份（`expectedSource`，含 `sourceId`），回执的
      `originSource` 必须与它完全相等；最后一次详情读取之后才换源（Host 打包了同名市场的另一个仓库或目录）时同样只能
      拒绝，并提示重新选择。
    - 任务确认卡：`origin === 'custom-market'` 且缺 `source`（或不合法）时，首装和升级都只能拒绝；旧 Host 的首装卡
      （没有 `origin`，无法排除来自自定义市场）也只能拒绝。旧 Host 的升级卡与官方市场的卡不受影响。
    - 理由：只能显示市场名时，两个同名仓库在手机上看起来完全一样，允许了也说不清允许的是哪个仓库。
- 第一版不做：README、安装前权限预览、下载进度、自定义市场图标、替换同标识插件、今日推荐、
  手机添加自定义市场、兼容 0.1.112–0.1.129 的全量读取回退。组织插件首装遇到电脑上残留的同名作品库时，
  电脑会弹只能在电脑上点的原生对话框，手机会等到超时（Host 行为未改）。
- 实现：`usePluginMarket.ts`（选电脑、分页、计数、安装编排）、`pluginMarketCatalog.ts`（解析与呈现）、
  `PluginMarketRows.ios.tsx`（原生 List 行）、`PluginMarketSection.tsx`（Android）、
  `PluginMarketDetailView(.ios).tsx`；`--mock` 演示见 `debug/pluginMarketVisualFixture.ts`。
- manifest 的可选 `mobile` 包含 `channels`、`panel`、`mainView`、`settings`；路径只覆盖
  已声明的原能力。未声明移动适配的插件仍可被发现和在任务中使用，旧桌面行为保留。
- 页面租约绑定账号、控制端连接、插件安装版本和页面实例。页面关闭或来源失效后，
  旧响应不能修改状态；原生弹层覆盖页面时暂停页面业务操作。
- BroadcastChannel 仅桥接声明频道，每条 JSON 最多 48 KiB；Host 覆盖消息的 `mobilePageId`。
  作者显式传递来源，不得保存“最近手机”全局值。未知写入回执按原 requestId 查询，不自动重发。
- 内部返回、动态标题、主题、前后台及隔离草稿由页面桥接支持。静态资源按文件身份读取，
  整页最多 64 MiB；Library 分块固定版本，媒体按已有归属账本读取固定大小块。

## 原生交互与普通任务

- confirm 由手机原生确认，关闭、遮挡、过期或撤权均拒绝；notify 只发送给来源页面。
  badge 沿用 boolean + summary，未引入计数字段。只有实际展示 panel 才按观察版本清未读。
  作者用 `cindyMobile.onUnread(version => …)` 捕获版本，读取并呈现内容后调用
  `cindyMobile.contentRendered(version)`；宿主校验当前可见页面与版本，下一帧提交回执。
  页面加载和轮询本身不确认已读；读取失败不回报，前台恢复时重新呈现再回报。
- 任务卡从已保存且净化的 HTML 投影动作，手机不执行卡片脚本；提交复核卡片版本、归属和真实点击。
- 新建任务复用普通创建页面，选择已有任务复用原生选择器，仅预填使用文字，用户发送后执行。
  iOS 已有任务选择器使用系统 sheet + SwiftUI plain List，无分组卡片；搜索 TextField 固定在标题下，
  输入、清空、无匹配与键盘提交均消费真实任务数据。选择等待原生 onDismiss 后导航，取消或归属变化丢弃待选项。
  workspace 打开对应普通任务；任务能力批准和写权限仍沿用 Host 校验、确认与回滚链。
- `cindy.tasks` 与统一任务接口共用创建、继续、结果查询、模型目录和改模型能力。
  任务设置复用 `pluginTaskPrefsStore` 和 `validatePluginTaskConfig`，保留旧偏好及私有工作目录。
  `PluginsScreen` 按宿主 `capabilities.tasks` 挂载独立的 `PluginTaskSettings` 原生内容，与作者原始设置共存；
  tasks/errand/workspace 使用同一入口，`showTaskPreferences:false` 只隐藏卡片。宿主未声明
  `remoteRoutes` 时仍能选择本机模型。任务卡只在当前插件已批准启用、详情可见且宿主在线时挂载，
  按电脑／物理实例／批准版本／连接代次隔离；关闭或后台停用卸载任务卡，不重挂作者原始设置。
  回归见 `apps/mobile/src/__tests__/pluginsScreen.test.tsx` 与 Desktop `mobilePageService.test.ts`。
- 目录由原生选择器确认；schedule 打开普通自动化草稿，支持每天、工作日、间隔和自定义 Cron，
  使用统一模型选择器，只有用户保存才创建。旧内置模拟器跳转已下线；收到旧客户端的该类消息时，显示通用不支持提示。
- 图片进入原生图片查看器；视频进入已有媒体播放器并提供原生分享。外部预览沿用 Host URL 白名单。
  电脑 localhost 预览固定获批 origin，资源分块经设备互联交给现有本机预览服务器。
  当前本机预览服务器仅支持 GET/HEAD，不支持 POST/WebSocket/HMR；不能宣称任意开发服务器完全可用。

## 配置与授权

手机原生表单负责密钥、设备码和可远程完成的浏览器授权；PKCE/电脑 loopback 场景明确返回电脑操作。
加密复用 v3 Host 授权协议，使用 X25519、Ed25519、HKDF 与 Expo AES。
执行电脑身份固定在 SecureStore，换钥拒绝；来源变化或未知提交结果不静默重试。
凭证不进入插件页面或普通桥接；表单关闭清空临时输入。

## 实现位置与作者约束

- `packages/device-link/src/pluginPages.ts`：远程资源和页面类型。
- `apps/desktop/src/main/cindy-brain/mobilePageService.ts`：页面租约、原生意图、来源校验与回执。
- `apps/desktop/src/main/cindy-brain/mobilePageAssets.ts`：包内资源；`mobilePreview.ts`：电脑预览。
- `apps/desktop/src/main/cindy-brain/runtime/mobilePageRelay.ts`：原逻辑页频道桥接。
- `apps/mobile/src/plugins/`：目录、页面、配置、任务设置和原生交互。
- `apps/desktop/src/main/cindy-brain/forge.ts`：插件作者公开契约。

修改 `pluginPageBootstrap.ts` 后运行 `node scripts/generate-mobile-plugin-bootstrap.mjs`，
检查时加 `--check`。预生成脚本避免依赖 Hermes 的函数源码序列化。
作者必须提供真正可触屏使用的布局及 Light/Dark，保存业务去重记录和草稿；添加声明不代表完成适配。
模块动态加载、键盘、返回和前后台行为需要在目标平台验证。

## 详情状态与旧端兼容

plugin-capabilities.data.usage 为可选摘要，复用宿主 getGhostSetupAssessment，只传就绪状态
与缺失/过期项目名称；保留组内 any-of 选项，不传配置值、动作授权或凭证。批准记录异常、
下线、运行崩溃/熔断与停用分开呈现；运行 off 是正常按需启动，不算错误。
离线/未加载/读取失败时不提供任务使用或设置写入。旧宿主缺少 usage 时保留原任务入口，
不宣称配置已验证；新宿主判定异常显示未知并只重读，不自动重新执行写入。
详情配置恢复入口提示在电脑端完成；任务内既有 Setup 卡流程不变。
DEV visual mock 可用 cindy://plugins?preview=<fixture-id>[-settings] 定位演示状态，
只在显式 visual mock 下生效，不选择真实已装插件。

## 验证边界

直接相关用例覆盖页面/控制端隔离、确认与未读、资源替换、任务归属、模型配置、卡片动作、
原生授权密码学互通和身份固定，以及移动桥接脚本、预览查询和媒体临时文件回收。
浏览器模拟宿主、JSDOM、原生边界 mock 和局部类型检查均不能替代手机实机验收。
验收按各 PR 的当前提交记录，不能沿用历史接入时的未验证结论。
[已装插件页面验收](../design-evidence/2026-10-09/mobile-installed-plugins.md)记录了
iOS 原生构建、Metro 与真实 PocketMind 数据，以及 Android Debug 包的 Demo 验收。
最新 iOS 原生包重复目检为 Light；Dark 证据来自主干同步前。Android 真实账号联动、
iPad、旧 iOS、VoiceOver，以及真实启停期间的断线恢复尚未实测。
启停与回读竞态另有定向回归，不能替代运行验收；完整单测门禁由 PR CI 执行。
插件市场（提案实现）的单测覆盖分页解析与越界拒绝、真实错误形态下旧 Host 的更新提示（不回退全量）、
切换电脑或账号后迟到的分页不落地、下拉刷新保留同一页、空发布者页最多续读 3 页，以及从全新安装到确认、
成功并打开已装详情、安装未开始与结果待确认的收口（`pluginManagement.test.ts`、`pluginsScreen.test.tsx`、
`pluginNativeViews.test.tsx`）。iOS/Android 模拟器 Light/Dark 目检、
与真实电脑的安装联调以对应 PR 的记录为准，未记录前不宣称已验证。

## 兼容、冷更与回退

现有插件不需要重装、重新批准或重配凭证；mobile 为可选扩展，新增远程集合由能力协商发现。
插件批准格式、安装布局、旧任务偏好文件和 Library 数据未迁移。插件基座改动合并前需白名单明确批准。

历史移动插件接入新增纯 JavaScript `@noble/curves@1.9.7`，复用现有 Expo 随机数与 AES，
未新增原生模块，但当时依赖变更改变了 runtime fingerprint，需要冷更与指定把关人明确批准。
iOS 指纹从 `d8cd3b87cb7dcf418004eeb36b0ff1b8f29a44c7` 变为
`25a5a753aaf7740670f9588e976b4770b0817999`；Android 从
`c2eb49bea3303f89edf8de95af3a0cf45179faca` 变为 `d1d89bd866a64c681f3ded59075536abccb84c9a`。
这些指纹记录属于历史接入，不能作为后续页面调整的冷更判据。已装插件页面调整 PR #5730
未修改原生配置、依赖或 runtime fingerprint 输入；本地重建用于匹配现有基线，不代表新增冷更。
发布仍按实际构建与目标 runtime 核对兼容性，不向不匹配的旧 runtime 投送 OTA。
回退客户端代码即可撤销移动入口；不删除插件数据。
