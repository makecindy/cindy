# 统一模型选择器(模型优先)· 实施设计

> **状态**:实施设计文档(本次交付的权威规格;合并后其中「交互契约」章节升为产品规则)
> **读取时机**:实现、review 或修改新版模型选择器(新会话/会话内)前
> **来源**:2026-08-12 交互设计稿(Chris 逐轮裁决)+ 三路代码侦察(选择器结构/目录平面/偏好持久化)

## 0. 一句话

用户只选模型;引擎(harness)由推荐映射自动配好且**常驻可见**;高级调整(引擎/思考深度/Fast/收藏)收进模型行的配置浮层;第一版一次交付完整体验。

---

## 1. 交互契约(定稿)

### 1.1 触发器(composer pill)

- 单一 pill:`[厂商图标] 模型名 · [引擎图标] 深度 [⚡]`。独立的引擎选择器(AgentSelect)从**新会话工具条**撤除。
- 模型名超长:max-width 截断 + hover title 全名。
- hover tooltip:`引擎名 · 思考深度 <档> [· Fast] [· 已自定义/收藏配置]`。
- 智能模式(Cindy Fast/Smart)**本版不做**(无后端 = 假按钮);面板结构预留组位。

### 1.2 面板(向下展开)

- 结构:搜索框贴顶 → 左侧 rail(★收藏 / [同引擎·仅会话内] / 全部 / 各供应商图标) → 右侧列表 → 底部「＋添加模型」。
- 宽度自适应:`max-content`,min 460px / max min(600px, 100vw-48px)——长名先撑宽,到上限才截断,不硬砍。
- 行(双行):
  - L1:厂商图标 · 模型名(弹性,截断) · 价格档/折扣/订阅徽标 · ☆ · 右侧**常驻三元组**`[引擎图标] 深度 [⚡]` · 选中勾。
  - L2:一句描述(截断)。
  - 三元组**所有行同构、永远显示**——引擎可见性靠一致的结构位,不靠出错才显示;自定义未收藏的行整组提亮一档(secondary)。
- 分组:收藏(置顶) → 供应商分组。组间顺序遵循「设置 → 模型供应商」的拖动排序(本地会话;device-link 用被控端快照顺序,不套控制端本地序),组内按服务端下发 group/sortOrder。收藏区条目**不**从供应商组中去重移除(收藏是配置副本,模型本体仍在原地)。
- 折扣表达:价格档 `¥/$` 串按折后价连续填充(付费亮、折扣灰),后跟淡染徽标 `↓60%`;详情(title+浮层)写全「折扣中 · 标准价 X · 省 Y%」。中文计价 ¥,英文 $。

### 1.3 配置浮层(hover 行,跟随行定位)

- 定位:锚点变化时计算一次,同锚点内不重算(防抖动);高度恒定(底栏三态等高:推荐配置/已自定义·恢复推荐/收藏配置·取消收藏)。
- 内容(自上而下):标题(≤2行截断+title) → 来源·上下文(**按当前选中引擎实时变**) → 深度滑杆(+⚡钮) → 引擎胶囊行 → 价格 → 状态底栏。无字段标题,组件自表达。
- **深度滑杆**:
  - 档位绝对色映射(跨模型一致):low `#2AAE5B` / medium `#14B8A6` / high `#3B82F6` / xhigh `#4F46E5` / max·ultra `#8B5CF6`。**紫只属于真正顶档**;封顶 high 的模型拉满也是蓝。
  - 滑条单色 = 当前档色;拖动中滑块连续跟手、条色按相邻档色值逐像素插值;松手吸附;点击跳档 = 宽度+颜色 180ms 扫过动画。
  - 「更高效/更智能」端点标签仅拖动时浮现;首尾档不画点;气泡带档色点,推荐档标注。
- **引擎胶囊行**:小胶囊(高 26、无边框、图标+名),3-4 个横排可换行;推荐项细描边(未选中时)+ hover title「推荐」;选中且=推荐时名旁小勾;单引擎模型为静态块。
- **Fast ⚡**:与深度正交的「插队加速」开关(28px 圆钮,开=蓝),hover 提示「Fast · 1.5 倍速 · 用量更多」;仅 supportsFastMode 的 (模型,引擎) 显示。外侧(pill/行内)Fast 只用中性色闪电,不写字不上蓝。

### 1.4 自定义与恢复(遵循 configuration-and-overrides.md)

- 浮层内改引擎/深度/Fast = 写该模型的用户 override;行内三元组提亮 + 底栏「已自定义 · 恢复推荐」。
- 恢复推荐 = **删 override**,随版本跟随新推荐;未自定义用户自动获得新默认。
- 不设集中管理入口(已裁决删除);恢复只在浮层就地做。

### 1.5 收藏 = 配置副本

- 行/浮层的 ☆ 是**单向「添加副本」动作**:把当前生效配置(模型+引擎+深度+Fast)拷进收藏区,点亮 0.7s 反馈后恢复;源头行不持有收藏态(多副本下不可判定)。重复添加去重。
- 每条收藏有**独立锚点 uid**:选中/hover/浮层绑定/删除全按锚点;同模型多条目互不牵连。
- hover 收藏条目的浮层**直接编辑该条**(改深度/引擎立即存回条目),模型默认不受影响;底栏「收藏配置 · 取消收藏」。
- 非默认配置条目右侧显示 `引擎 · 深度 [⚡]` 后缀;删除选中条目时选中回落到对应模型默认。

### 1.6 会话内(切换有损)

- rail 顶部(★下)多一个**同引擎过滤**(图标=当前会话引擎),**默认选中**;该视图只显示 引擎匹配的收藏 + 同引擎模型;组标题旁 ⓘ 悬停说明(自绘即时 tooltip,原生 title 会被重渲染打断)。
- **「同引擎」的判据是「生效引擎 = 当前引擎」,不只是「候选里有当前引擎」**(Chris 2026-08-19 裁决):
  候选里有当前引擎、但**默认落点在别家**的行(主场明确在别处的行、用户把引擎 override 显式指到别家的行)
  在该视图里**不显示**。裁决是「不显示」而不是「转换成当前引擎」——用户的设置摆明了没打算在本引擎用它,
  要跨引擎就去「全部/供应商」视图显式选。理由:这类行此前会以**外引擎形态**混进「仅 Claude」视图,点下去还
  弹跨引擎确认,与该视图「这里选什么都无损」的承诺直接冲突。
  与 §2.1 pinnedEngine 规则(2026-08-14)的关系:pinned 例外**保持不变** —— 无主场的行本就落在当前引擎上,
  自然通过这道过滤;**过滤口径与行落点必须保持同构**(实现上是同一份 `resolveUnifiedRowConfig` 结果,
  见 `unifiedModelSelection.buildUnifiedListSections` 的注释)。收藏行同理:条目存的引擎掉出候选、解析回落到
  别家时同样不显示。
- 跨引擎:点「全部/供应商」显式切换,列表顶部一行警示「⚠ 跨引擎切换会重建上下文,有丢失风险」。
- 切引擎执行仍走既有 `performAgentSwitch` 链路(确认弹窗、fastMode 不跨引擎带入等语义保留)。
- **风险确认只认任务真实引擎**(Chris 2026-08-20):用户只要选的是**不是当前正在跑的引擎**的模型或收藏,
  一律弹出换引擎确认。挂着的切换意图不算已经确认过 —— Claude 任务里点了 Pi 收藏、还没发消息,再点
  另一条非 Claude 的模型/收藏,仍然要问。只有目标就是正在跑的引擎(回原引擎)才不弹。
- **切换事务的「成功」= 本端请求的完整配置原样落地**(2026-08-19 review 收口):main 先广播意图回声、后回
  ack,回声身份匹配只比 target/model/provider 三元组(effort/Fast 可能被 main 归一化,providerId 传 null 时
  跟随默认路由解析)。因此三元组匹配、但权威回声里的 effort/Fast 与本端请求不一致(device-link 往返期间另一
  控制端只改了同一意图的档位/Fast)时,事务按**未完整应用**上报 false:面板挂在成功上的持久化收尾
  (清 override、提交/删除收藏编辑、写收藏锚点)一律不做,旧锚点由派生校验自然失效;意图展示与偏好同步照用
  **权威快照**的值(缺字段的维不写)。判据的宽严取向(权威快照缺维放行、本端未指定的维放行、双方有值逐字比)
  见 `agentSwitchConfirmation.isAgentSwitchEchoConfigConsistent` 头注。

### 1.7 i18n / 主题

- zh/en 全量;英文超长模型名:标题 2 行截断、来源单行截断、行内 118px 截断+title、引擎名 92px 截断;「Recommended」不进胶囊(描边+勾+title 表达)。
- 颜色一律语义 token + 本组件注册的新 token(滑杆档色/折扣绿等按 DESIGN.md §10 流程登记);Light/Dark 双实现。

---

## 2. 数据契约

### 2.1 推荐引擎推导(纯客户端,不动协议)

模型的候选引擎与推荐引擎从既有 catalog 结构推导,**不新增 wire 字段**:

- 候选引擎 = 该模型在最终 catalog 中出现的所有 `(provider, agent)` 组合(`Provider.models: Record<AgentKind, CatalogModel[]>`),经现有可见/准入/区域/SSH 过滤后。
- 推荐引擎 = 模型**生效来源** provider 的主 root(`MODEL_PLANE_POLICIES`:openai→codex、anthropic→claude-code;xd 按 gateway `perAgent`/membership;user provider 按其 runtime)。同名多来源时先 `effectiveSourceIdForModel` 解析生效来源再推导——**禁止读拍平去重后的列表**(registry.ts 明示)。
- Pi 恒为候选(客户端投影,wire enum 无 pi,维持现状)。
- **原生底座(排序用,与推荐引擎分离)只标确有主场的,可空**(Chris 2026-08-13 裁决):
  anthropic→cc、openai→codex、折扣条目→codex;**多 root 全能模型(xai 系)与判不出家族的
  BYOM 一律 null = 无主场**——任何引擎视图都不降级,只有「主场明确在别处」的行才降到
  「仅兼容」层。理由:给 grok 这类三栖模型硬选主场,会让它在其余引擎视图被错误降级;
  判定链不依赖 `routing.authStrategy`,device-link 投影下本地/远程排序天然一致。
  服务端未来下发 `nativeAgent` 字段沿用同语义(可空,空=全场平等),数据覆盖客户端推导。
- **主场按厂商家族补齐,不随来源变**(2026-08-14,Chris 实测「Claude 全列翻成 Codex」后
  修订):内置 root 表与折扣判定之后,按 classification 既有分类(目录 `group` 优先、id
  前缀兜底)补一层——anthropic 家族→cc,gpt/gpt-budget 家族→codex,其余仍 null。网关上的
  `claude-*`/`gpt-*` 行因此有主场;没有这一层时它们全落 null,推荐走「候选里 cc 优先」
  回落,会产出两类批量错配:GPT 非折扣行整列「底座 Claude」;cc 掉出候选时 Claude 整列
  翻成 Codex。
- **会话内落点(pinnedEngine)只对无主场或主场=当前引擎的行生效**(同日修订):主场在
  别处的行(codex 会话里的 Claude 系)保持显示主场,选中走跨引擎切换确认,不静默骑
  bridge;确要「Claude 骑 codex」走浮层引擎胶囊(override 恒为最高优先)。
- **选中行显示以事实为准(forceEngine)**:当前草稿/会话正在用的那一行,引擎三元组强制
  按实际引擎画(会话取已确认的 sessionAgent,草稿取草稿 vendor),推荐/override/pinned
  都不得改写它。选中行的引擎胶囊因此有专属语义:草稿=override 落库并把新引擎配置立即
  写回草稿;会话=改道跨引擎切换事务,取消时不留任何全局 override。

### 2.2 (模型,引擎) 上下文与能力

- 上下文窗口:走 `getCatalogModelContextWindow(providerId, agent, modelId)` 三元组口径(带 `[1m]`/前缀归一);浮层随引擎选择实时切换显示。
- `resolveVerifiedContextWindow` 目前仅接 codex——本版为 cc/pi 补接 `AgentDeps`(实现清单 M6)。
- efforts / defaultEffort / supportsFastMode:按 (provider, agent) 嵌套条目取,已是现状。

### 2.3 新增存储(前两个只存 override;renderer localStorage,按既有命名约定)

1. `xdt:modelEnginePrefs:v1:<dataOwnerId>` —— 每模型引擎 override:
   `{ "<providerId>:<modelId>": { agent: AgentKind } }`
   - 只在用户显式改引擎时写;删除 = 恢复推荐。key 与四根旧轴同形但**独立第五/六根轴**,不合并。
   - 带 dataOwnerId 分区(吸取 providerModelMemory 不分账号串号的教训)。
2. `xdt:modelFavorites:v1:<dataOwnerId>` —— 收藏配置副本:
   `{ uidSeq, items: [{ uid, providerId, modelId, agent, effort, fast }] }`
   - 深度/Fast 存**档位 key**(low/medium/...)不存显示文案(防语言串档,Maximum 混中文的教训)。
3. `xdt:favoriteAnchorMemory:v1:<dataOwnerId>` —— **收藏锚点记忆**(「面板上哪一行打勾」),
   Chris 2026-08-19 实测后从内存态改为持久化:
   `{ drafts: { <cc|codex|pi>: { uid, wireModelId, providerId } }, sessions: [{ sessionId, uid, wireModelId, engine, providerId }] }`
   - 草稿槽按引擎分(与 `lastByVendor` 同一分槽维度);会话槽按 sessionId,**LRU 上限 100**(队首=最近一次写)。
   - 存的是**选中那一刻的快照**。收藏是独立选中项(Chris 2026-08-20):勾选只认 uid 还在收藏列表里,
     不拿正在跑的模型/引擎/思维去对副本 —— 对上才打勾会让下面同名模型行抢走焦点。用户点普通模型行时
     才把 uid 置空。快照里的 wire/来源仍用于建会话延续,不参与勾选判定。
   - 仍**不是用户配置**:不落库、不进 device-link payload、写失败静默吞;丢了只是回落模型行。
   - 草稿发送建会话时,仍有效且**有显式来源**的草稿锚点写进该 sessionId 的会话槽(跟随默认路由的会话
     `providerId` 为 null,与显式来源的锚点永不相等,存了也打不上勾,故不延续)。
- 深度/Fast 的每模型记忆**沿用** `providerModelMemory` `<agent>:*` 槽(不迁移不改形——它同时是 device-link wire 形状)。

### 2.4 选中态与会话创建

- 选中 = `{ kind:'model', providerId, modelId }` 或 `{ kind:'fav', uid }`(锚点语义)。
- 落到既有链路:选中确定后派生 `(vendor, model, effort, fastMode, providerId)` 写入 `newMakerDraft`(`vendor` 由推荐/override 引擎决定,`lastByVendor`/`modelChosenByVendor` 语义原样保留),createSession 组装不变;会话内走 SET_MODEL / set-fast-mode / SWITCH_SESSION_AGENT 不变。
- `sendProviderId` 契约保留:跟随默认路由时**不得**具体化为 'xd'(cohort 基线)。

### 2.5 三类用户行为(configuration-and-overrides §3)

| 情形 | 行为 |
|---|---|
| 新用户 | 无任何 override;推荐映射+目录默认(`newSessionDefault`→排序首个 defaultEnabled)生效;服务端改推荐,升级即跟随 |
| 未自定义老用户 | 同新用户;旧 lastByVendor 种子值因 `modelChosenByVendor` 未置位而不视为自定义(现有语义) |
| 已自定义老用户 | `modelChosenByVendor=true` 的 vendor 模型选择、providerModelMemory 深度/Fast、新引擎 override 全部保留;**零迁移**——新 store 为空即「全部跟随推荐」,旧数据不搬不猜 |

---

## 3. 实施地图(单 Draft PR 内的逻辑 commit 序)

| # | 模块 | 主要文件 |
|---|---|---|
| M1 | 推荐引擎推导 + 跨引擎联合列表构建(纯逻辑+单测) | `packages/model-providers/src/`(新 `unifiedSelection.ts`;复用 registry/classification/sections) |
| M2 | 新存储(enginePrefs/favorites)+ 读写 API + 单测 | `apps/desktop/src/renderer/state/` 新两文件 |
| M3 | 面板 UI 重做:联合列表/行三元组/rail/收藏区 | `ModelSelector.tsx`(演进,不推倒;保持导出契约) |
| M4 | 配置浮层:滑杆/引擎胶囊/Fast/价格/上下文 | `ModelSelector.tsx` configPanel 区段 + 新子组件 |
| M5 | 新会话接线:撤 AgentSelect、vendor 派生、draft 写入 | `NewMakerDraftRoute.tsx` / `ChatInput.tsx` |
| M6 | 会话内:同引擎过滤/有损警示/AgentSwitch 对接;cc/pi 补接 verifiedContextWindow | `ChatInput.tsx` / `maker-host/index.ts` |
| M7 | i18n(zh/en+术语表)/token 登记/超长适配 | locales / globals.css / tailwind |
| M8 | 测试:新逻辑单测 + 更新受影响测试锁(逐条列明有意变更) | `__tests__/` |

设置类入口(scheduler/IM/Hook/Subagent/GhostErrand/CreateWorker)**不改交互结构**;其内嵌 ModelSelector 面板通过组件演进自然更新,回归验证纳入 M8。

---

## 4. 特殊情况检查表(实现与 review 逐条过)

**目录/来源**
- 同名模型多来源:一切能力(Fast/ctx/efforts/推荐)先解析生效来源再查,禁止读拍平列表;`actualSourceIdForModel`(会话内,含停用) vs `effectiveSourceIdForModel`(草稿)双口径保留。
- XD 网关独占存在性:不从 Registry 给 XD 补条目;`/models` 空则空。
- bridge 条目 id 带前缀(`chatgpt/`,anthropic→codex 强制 `supportsFastMode:false`):按 id 查推荐/能力时先归一。
- `[1m]` 后缀 / `codex/` 前缀归一;`status:'retired'` 的 keepSelected 豁免(运行中会话仍显示)。
- user provider:默认 ctx 200K 不带 verified 标;Pi effort 交集塌陷;`custom:<id>` 分组;`'cindy'` 复合路由排除 user provider。
- 立省/订阅徽标:`group==='gpt-budget'`+前缀兜底;订阅走 provider.access(flat 模式 sourceAccess);`visibleModelUnion` 返回值含 3 个隐藏字段,禁止整对象过 wire/持久化。

**偏好/记忆**
- `MODEL_PRESET_SLOT_ID='*'` 保留 id,新代码读写路径都要防撞。
- `xd` 来源同时服务 cc/codex,记忆 key 必须带 agent 维度(现状已是,别退化)。
- `modelChosenByVendor` 三态:会话侧同步用 `patchVendorPrefsPreservingModelChoice`,不得误置位(scheduler 成本兜底依赖它)。
- localStorage 同步写(热更 app.exit 会丢异步写),禁止 debounce「优化」;写失败静默吞,迁移标记别依赖 localStorage 落盘成功。
- `getPersistedVendorModel` 直读裸 localStorage——改落盘形状必须同步它。
- 多窗口:worktree 布尔有 storage 事件 rebase;新 store 也要监听 storage 事件防旧窗口回滚。
- 正在跑的会话不受全局预设影响;不回填 sessions 表;`sessions.provider_id` NULL 不得具体化。

**device-link / 远程**
- `providerModelMemory` snapshot 原样进 `RemoteNewMakerDefaults` wire——**不改其 schema**;新 store 不进该 payload(老控制端看不到引擎 override 属可接受降级,新被控端按 override 生效,四格矩阵在 PR 写明)。
- 旧控制端 `maker:set-session-model-pref` 与新 `apply-new-maker-draft-pref` 双写桥保留。
- `pendingRemoteSwitch` 5s 兜底、`remoteSwitchInFlight` 绑 ack、镜像不写控制端本地记忆——原样保留。
- SSH:`excludeSubscriptionDirect`/`excludeChatBridgedCodex` 只在 remoteHostId 非空时开;device-link 下 CreateWorkerPopover 外置 Fast 开关不能删。
- 老被控端 capabilities-only flat fallback(`resolveRemoteModelListStatus`)保留。

**交互/组件**
- Radix Dialog 内禁 MorphPopover(ScheduleChips);`data-morph-autofocus` 单点;`keepOpenForAgentConfirmation`;`setOpenWithoutAutoRefresh` 只在真 open 边沿发现;发现指示 300ms 延迟。
- `orca` 退役残留:sanitize 回退 cc、切换守卫保留。
- 工具条 30px 视觉契约、field 面板宽度绑 trigger(DESIGN.md 宽度铁则)、composer 三菜单行统一契约(`--model-item-hover`)。
- 引擎不可用 coerce(`useAvailableAgents` 未加载时不隐藏);`hiddenVendors` 中当前值永远可见。
- 浮层高度恒定+锚点定位缓存(防滑杆下面板抖动);⚡/推荐 tooltip 用自绘即时 tooltip。

---

## 5. 验收与测试

- 单测:M1 推导规则(含多来源/bridge/前缀归一)、M2 store(含 owner 分区/迁移空态)、滑杆档位色映射、收藏锚点语义。
- 更新既有锁:`agentSelect`/`chatInputModelSelectorRouting`/`modelSelectorTriggerVariant`/`modelSelectorProviderGroups`/`newMakerCreateAgentVisualContract`/`draftModelCalibration`/`modelDefinitionsDefaults`/`deviceLinkModelMirror` 等——有意变更逐条在 PR「风险」说明。
- 门禁:根 `pnpm test:unit` + `pnpm --filter desktop run typecheck` + `pnpm --filter @cindy/model-providers run --if-present typecheck`。
- 实机:worktree `pnpm restart:desktop:remote --region=global --isolated=model-picker` 双模式目检;未能真实验证的面(如老版本 device-link 对端)在 PR 如实列出+用户验证步骤。

## 6. 预留(本版不做)

- Cindy Fast / Cindy Smart 智能模式组(等后端路由;UI 组位已在面板结构中留出)。
- 服务端下发推荐引擎/排序字段(`ModelAgentOverride` 加字段的最小路径已勘明:protocol L222 + registry/catalog base + 两处手抄镜像类型 + modelRegistryMetaFields 塌平表)。
- 移动端对齐(mobile 平行实现 + draftModelMemory 多 deviceId 维)。
