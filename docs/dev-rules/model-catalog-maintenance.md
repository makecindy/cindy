# 模型配置与下发：架构及维护入口

> 权威入口：先读本页，再按问题打开专题。Server 为独立仓库，文档不代表已部署。

## 数据流

```text
Server 随包 / 远程目录 → /api/model-catalog/catalog
    → 执行端加载与缓存 → 合并连接实报、用户覆盖 → 活动目录
    ├─ 选择器 / 管理页
    ├─ 聊天 → Claude Code / Codex / Pi
    └─ 媒体 → 对应媒体通道
```

聊天调用目标为「连接 ID + 上游模型 ID + 引擎」。同品牌多账号共用资料，凭证、发现、用量和覆盖按连接隔离。
Mobile / device-link 使用执行端目录；本地安装状态来自执行机器。目录声明不等于账号准入或协议已实现。

### 配置包含什么

Server 正本现为 `model-access-server/catalog/source/` 分片，由
`model-access-server/scripts/generateCatalog.mjs` 组装成 `catalog/generated/providers.json`。
本地域编辑 `source/registry/local-models.json`，revision 编辑 `source/catalog.json`；
不要直接编辑生成文件。客户端离线文件分别是
[`catalog/providers.json`](../../packages/model-providers/catalog/providers.json)（providers / presets）和
[`catalog/model-registry.json`](../../packages/model-providers/catalog/model-registry.json)（Registry）。
逻辑结构如下；具体字段及修改位置见下表：

```text
Catalog (version)
├─ providers[]                 内置接入、授权、routing、各引擎 models
├─ presets[].runtimes          新建连接的地址、协议和默认资料
└─ modelRegistry (schemaVersion / updatedAt)
   ├─ interfaceProfiles[]      V6：产品作用域内的接口模板
   ├─ baseModels[]             公共型号
   ├─ models[]                 接入条目：modelRef → baseModels；perAgent 与 routes 同级
   ├─ nativeApiRules[]         原生协议判定
   └─ localModels              候选包装 models[].variants[] + 推荐 featuredIds[]
```

### 哪些东西应该在哪里改

| 要改什么 | 写入位置 / 责任侧 | 不能顺带改变什么 |
| --- | --- | --- |
| 型号公共名称、说明、窗口、输出、思考能力 | Registry `baseModels[].defaults` | 价格、账号权限、地址和凭证不在公共继承内 |
| 接入条目状态、排序、默认开启标记 | Registry `models[]` 顶层 | 显示开关不等于成员资格；订阅账号排序以账号为准，见下文模型排序与默认可见性 |
| 某供应商的上游 ID、支持路由、普通默认 | `models[].routes[]` / `routes[].defaults` | 普通默认不能压过实报 |
| Claude Code / Codex 的工作默认 | `models[].perAgent`，引擎必须被该条目 route 声明 | 不把工作预算当供应商承诺容量 |
| Pi 公共成员和 Pi 默认资料 | `providers[].models.pi`；订阅账号发现另补新型号，公共资料仍按 Registry 合并 | 复用已实现的订阅传输，不复制其他引擎的专属能力 |
| 经核实的错误实报 | 匹配 route 的 `forceOverrides` + `overrideReason` | 不影响其他供应商，也不压过用户配置 |
| 厂商官方参考价及历史价区间 | `baseModels[].referencePriceGroups[].prices[]`（Registry V5） | 按市场分组，保留币种、标准/Fast、输入区间及生效日期 |
| 接入供应商参考报价 | `routes[].referencePrices[]`；`referencePriceGroup` 指向公共型号的官方价组 | Gateway 实价/折扣仍归其计费控制面，不混填缺失字段 |
| 内置接入或新增连接模板 | `providers[]` 或 `presets[].runtimes` | 不在公共目录保存真实账号密钥 |
| 本地候选、包装、门槛、推荐 | `localModels.models` / `featuredIds` | 不自动安装、卸载、切换用户模型 |
| 某个用户的显式设置 | 本机 `model-catalog-overrides.json` 等既有偏好 | 不写回 Server；刷新保留，恢复默认删除 override |
| 新执行协议、SDK 参数、token 计量 | 本仓对应 host / harness / bridge | 加目录字段不会自动获得执行能力 |

结构例外：条目没有 `models[].defaults`；Registry agents / perAgent 只接受 Claude Code、Codex，
Pi 走 `providers[].models.pi`（用户补丁 perAgent.pi 另属合法 schema）。媒体 route 使用 `agents: []`。
`contextWindowMax` 是客户端容量投影，不能填进 Registry；容量与工作预算见 [运行时细则](model-catalog-runtime.md)。

### 多接口目录（Registry V6）

一个模型的身份与其接口绑定分开维护。`interfaceProfiles` 正本位于 Server 的
`source/registry/interface-profiles.json`：`id/providerId/api/baseUrl/inputBaseUrls` 声明接口与精确
凭证作用域；`requestPath` 为可选相对路径；`defaults` 为通道能力；`compatibility/requires`
只引用客户端已实现的具名能力。`inputBaseUrls` 必须与目标同源，不能借目录把密钥换域发送。
`modelIds` 限制旧配置自动采用该模板的成员，显式 `routes[].interfaces` 为新模型绑定已有模板。

`routes[].interfaces[]` 通过 `profileId` 绑定模板，可声明 `wireModelId/defaults/compatibility/requires/retired`；
`preferredInterfaces` 按 Claude Code、Codex、Pi 分别列优先级。模板被撤回、绑定被撤回或必需能力未知时，
该绑定不可执行；不能回填离线数据复活。`nativeApis` 是经核实的型号原生协议集合（`null` 明确未知），
不从 Pi adapter 或代理协议反推。保留 `nativeApi` 作为旧客户端的稳定声明。

三引擎共用 `availableModelInterfaces/providerInterfaceModelRoute`。能力覆盖依次为公共/产品默认、
接口默认、引擎差异、实报、`forceOverrides`、用户覆盖；数组整体替换，`false/null/[]` 不丢失。
界面展示当前接口的能力，输入不支持时不自动重放到另一协议。`interfaceId: "auto"` 跟随目录默认；
显式 profile ID 固定用户选择。旧 `api/piApi/route/requestPath` 保留；仅已声明的旧导入修正规则
通过 `legacyApis` 迁移。用户配置只保存原始选择，不保存解析后的 API、模板或完整快照。
高级模型设置沿用既有入口显示自动与可用接口；手机/设备互联仍使用执行端投影，不在控制端重新选路。

任务首次派发把非敏感接口、模型 ID 与能力快照存入 owner-scoped `model-interface-snapshots/`，
同一任务/来源/引擎/型号在目录刷新与重启后保留接口。旧任务首次恢复按保存的 transport 迁移。
鉴权、来源是否存在、暂停与撤回仍实时检查；快照不存 Key/headers。删除任务清理其快照；
归档和关闭不清理。SSH 由执行宿主复用选路结果；新接口若不能由既有远端协议表达，沿用启动前明确报错。

V6 请求使用 `registrySchemaVersion=6&registryMedia=1&registryLocalRuntimes=1`；旧服务端返回低版本时，
在同一时间预算内重试一次 V5。缓存按实际 URL 变体隔离；同 revision 的 V5→V6 只有旧形状完全相等
才视为升级，反向不覆盖 V6。服务端 V5/V4/冻结 legacy 投影不泄漏新字段或新默认接口。

维护步骤：

1. 在 Server 正本修改模型绑定/通道能力/优先级，增加 `updatedAt`，运行 `pnpm --filter model-access-server catalog:generate`。
2. 更新离线副本时，在客户端运行 `node packages/model-providers/scripts/sync-registry.mjs <Server生成的providers.json>`；
   运行解析、目录一致性及受影响路由回归。旧 `provider-interface-models.json` 与客户端硬编码接口表已删除。
3. 新型号绑定已有模板可以只发目录。新增/改变模板端点、鉴权边界或兼容行为走常规服务发布；
   新执行行为还必须发布客户端。发布门比较组装后的模板，不能通过换分片绕过。
4. 回撤用新的完整 revision 和 `retired`，不回发旧日期快照。先部署可兼容投影的 Server，再发布客户端，
   最后调整目录默认；目录发布与真实上游推理验收分别记录。

回归入口：`providerInterfaceRoutes`、`source-registry`、`modelAccessValidator`、Desktop `providerRoute`
（真实 HTTP 目录→解析→三接口出站、快照冷恢复）、`codexProxyHost`、`piProviderTransport`。
“客户端已实现”“服务已部署”“账号真实推理通过”是三个独立结论。

### Gateway 复杂价目展示

Model Access V5 通过 `X-Cindy-Model-Capabilities: display_pricing` 协商可选 `displayPricing`。
聊天和媒体目录都保留该字段与同一连接快照的 `currency`、`costDiscount`；不进入公共
Registry/defaults、ModelPriceQuote 或 token 成本估算，不跨供应商补价。
成功刷新缺字段或价目不可解析时清除旧价目，模型仍正常更新；新增属性忽略，未知单位保留。
展示字段变化不构成整份目录失败；网络或核心模型协议失败仍沿用既有目录恢复语义。

Desktop 设置页模型详情有 `displayPricing.summary` 时优先按输入、输出、缓存读取、缓存写入
展示主报价，每个角色允许 1–4 段、各带单位与数量，区间统一用 `maxPrice` 表示。摘要的
`priceType` 仅允许缺省、`exact` 或 `estimated`；任一段为 `starting_at` 时整份 summary 无效，
只丢弃摘要，保留价目表。items 的已发布契约不变，仍支持 `starting_at`。summary 缺失或无效时
沿用原价目表；summary 无效只清除摘要，不丢价目表。补充价目表仅在以下条件全部满足时隐藏：
有 summary 且没有 notes；所有 item 都没有 tier，priceType 缺省或 exact；item 总数等于
所有角色报价段数，且每个 item 能按 unit、quantity、price 一一匹配不同的摘要报价，
匹配报价没有 maxPrice 或 tier。其余情况保留在摘要下方。设置页列表对带 displayPricing 的
模型不显示价格；选择器、浮层和聊天价格档位逻辑保持原样。详情中的有效折扣仍单列显示。
摘要的 tier 单独一行使用次要文字，金额、原价区间和单位分别保持完整，同一角色的多段报价逐条换行、靠右对齐，不插入分隔点。
`price` / `maxPrice` 为每 `quantity` 个 `unit` 的折扣前报价，只在展示时应用一次折扣，保留币种
与“约”的语义；items 另外保留“起价”语义。角色和已知单位本地化，label、tier、notes 仅按纯文本呈现，未知单位不猜换算。
数量 1 省略，百万按语言简写，其余按本地数字格式显示。共享目录可传递这些可选展示字段，旧端
缺字段仍合法，不新增能力声明；此 UI 仅覆盖 Desktop 设置页。解析与展示回归见
`modelDisplayPricing.test.ts`、`DisplayPricingDetails.test.tsx` 与 `ModelAdvancedDrawer.test.tsx`。

### 覆盖顺序

这里是**模型资料字段**的优先级，右边覆盖左边；成员、权限、实际计费、显示开关不套用此链：

```text
公共 defaults → 匹配的预设默认（适用时）→ 条目顶层默认
             → route.defaults → 条目 perAgent[引擎]
             → 供应商明确实报 → route.forceOverrides → 用户显式覆盖
```

缺字段继承，false 明确关闭，数组整体替换，null 按字段合同处理，不使用真假判断吞掉空值。
用户公共型号补丁先于用户具体连接/引擎补丁。思考档位默认在公共型号维护，按需增加引擎例外；
`defaultEffort` 的已配置默认优先于供应商实报的推荐档，再适配实际支持能力，force / 用户覆盖仍优先。
详细字段及成员空值规则以 [模型资料优先级](../product-rules/model-metadata-precedence.md) 为唯一正本。

### 远程推理档位快照兼容

Desktop 主机向能力清单和 `maker:provider:list` 的模型条目显式投影既有的
`effortsUnknown` 布尔值：`false` 表示能力已知，`true` 表示未声明。控制端收到旧主机
缺少该字段的空档位表时保留已有选择，只有显式 `false` 的空表才清空；非空表照常校准。
草稿播种与最终提交使用同一兼容口径，不在控制端给缺失字段补 `false`。
无档位选择落库使用既有空串哨兵，任务后续发送也保留“未指定”，不提交输入框显示兜底档位。
Codex 在实际 `turn/start` 请求中省略该档位字段，计划模式的 `reasoning_effort` 使用协议允许的
`null`；运行时切换与恢复重试同样不发送空串，服务端默认档位快照不覆盖明确的无档位选择。
回归见 `packages/maker-core/src/agents/codex/index.test.ts` 的 no-effort 用例。
实现与回归见 `catalog-to-descriptors.ts`、`providerHandlers.ts`、
`deviceLinkDraftDefaults.test.ts`、`deviceLinkCreateArgs.test.ts` 与 `chatInputModelLoading.test.tsx`。

<a id="ordering"></a>
## 模型排序与成员：以账号为准

OpenAI（Codex 订阅）与 Anthropic（Claude 订阅）的 root **成员只来自账号清单**：Registry 只给
已返回的型号补资料、标退役，不补入账号没返回的型号；没有账号清单时名单为空。`sortOrder` 以账号
返回顺序为准：Codex 取 `models_cache.json` 的 `priority` 或 app-server `model/list` 的返回位置，
Claude 取 SDK `supportedModels()` 的返回位置。用户本地 addition 按 Registry / 本地 `sortOrder`
接在其后。装配时重写为连续 `sortOrder`，选择器、设置页、新对话默认与 Claude Code
bridge 共用这一顺序；OpenAI 订阅的 Pi 以公共 Pi 目录为基础，按同一账号的当前发现／恢复
清单补入新型号并排序，能力按 Pi 协议适配，沿用 Registry 条目的 `defaultEnabled: false`；
用户本地 `sortOrder` patch 仍最高。

Claude 订阅没有 HTTP 清单接口，清单来自内置 Claude Code 的 SDK `supportedModels()`：会话启动时
捕获；此外 maker 就绪、登录／认领 Claude 登录以及手动刷新时，用本机 CLI 起一个空闲 Query 只读
清单（不发消息、不产生模型调用）。SDK 对每个系列的当前型号常只给简称（`opus` / `sonnet` /
`default`）并把版本写在说明里（如 “Opus 5.5 · …”）；简称按说明拼出 `claude-<系列>-<主>-<次>`。
Registry 尚未登记的新版本照样显示（资料用未知模型默认值，并记日志提示补登记），**绝不映射到
相邻旧版本**；说明里读不出版本时才跳过。SDK 的 displayName 只有系列名（如 “Fable”）时不作为
型号名称，改用 Registry 名称，Registry 未登记则按 ID 推导（`claude-fable-5-2` → “Fable 5.2”）。
xAI 保留 Registry 声明顺序，XD 以 Gateway `/models` 为准，均不受此规则影响。
第三方 API key 连接（MiMo、Kimi Code 等预设及自定义端点）没有 sortOrder，按连接配置里的
顺序排：首次添加用接口返回的顺序；之后刷新发现的新型号排在已有型号之前（保持接口返回的
相对顺序），已有型号位置不动（`mergeDiscoveredRuntimeModels`）。

来源内的默认推荐可由服务端按区域下发的 `newSessionDefault` 指定；公共 Registry 的
同名字段不进入活动目录。未标记时取排序第一的默认可见模型，即账号返回的第一个可见模型。

未手动选择模型时，客户端出厂来源顺序为 Codex 订阅 GPT-6.1 Sol（Codex）、
Claude 订阅 Opus 5.5（Claude Code）、服务端指定的 Cindy Auto（Pi），最后保留 xAI 回退。
订阅按认证身份识别独立账号，始终保留实际账号 ID。Cindy Auto 由服务端决定：在 Cindy AI 与
企业号池供应商（`source: organization`）中跟随被标为 Pi 新任务默认的 Auto 系列模型
（预设 `auto` 或模型组 Auto `auto/<组ID>`），没有标记时（旧服务端）回退 Cindy AI 的预设 `auto`。
只认 Auto 系列的标记：个人目录仍把旧 GLM 标为 Pi 默认，客户端不采纳，也不把 Auto 替换成固定型号。
服务端保证每个引擎只标一个默认；管理员恰在两次拉取之间改配置、两类来源短暂各标一个时，
以 Cindy AI 为准，不取决于来源列表顺序。未手选的普通草稿记着 Cindy AI 或号池来源时，只有
当前引擎在任一 Cindy 来源中存在服务端标为 `newSessionDefault` 的组 Auto（`auto/<组ID>`），
且该候选可连接、未停用、符合本地可见性与聊天准入条件，才跨两类来源寻找出厂默认；沿用同一
候选筛选和排序规则。没有合格的组默认时保留旧的来源范围，避免旧服务端下把号池草稿改走平台。
草稿本身已记着组 Auto 时仍保留跨来源跟随，以及组 Auto 被撤销后的回退；用户手选、加载期、
固定来源约束（`requiredProviderId`）和自定义来源的保护不变。
草稿发送校准与无人值守默认解析复用同一策略，避免初始化选中 Auto 后又被旧标记改回 GLM。
同一订阅策略先在全部匹配账号中寻找推荐型号，再取该来源按目录排序可见的其他型号；
无人值守入口没有本地显示开关时按 `defaultEnabled` 判断，不能因缺少推荐型号提前换到下一供应商。
策略在 `apps/desktop/src/shared/newMakerDefaultTuple.ts`；连接、型号和对应引擎必须实际可用，
不能为了满足推荐而把 Sol / Opus 放入另一个引擎。用户手动选择及型号开关始终优先，
不修改已有任务的运行配置；伙伴默认复用应用选择，不另造一套来源优先级。
定时任务、`/learn`、IM 新建任务与分享导入等不由用户当场选模型的入口，
没指定模型时同样按新建任务口径解析（`apps/desktop/src/shared/draftModelCalibration.ts`
的 `resolveNewTaskDefaultRoute`），不在代码里写死型号；一个可用来源都没有时明确失败或留空让用户选。

Auto 只按模型 ID 认（`isCindyAutoModelId`）：服务端可以把同一个 Auto 在 Cindy AI 与企业号池
之间挪动。记住的来源是这两类之一且已不再提供它时，`effectiveSourceIdForModel` 改用当前提供它
的那一家（同样限于这两类），新建任务提交与手机端 `resolveRecentModelAndProvider` 复用同一规则；
记住的来源仍列着它（只是断连或停用）、或是用户自己接的供应商时不改道。
手机端新建任务、恢复或切换引擎、目录校准及提交终检，均必须传入完整供应商目录来识别旧来源，
即使旧来源已没有可见模型行也不能用行列表反推身份；提交守卫的目录与行必须来自同一份响应。
Pi 的空来源代表 Cindy AI，先按该身份尝试组 Auto 跟随，再走普通空来源回退。改道目标必须存在于
当前可见模型行中，不能选中隐藏的目标或误用同名自定义模型。

目录刷新后，仍记着旧来源的进行中任务登记一次「下一条消息前切换」：引擎与模型 ID 不变，只换
供应商与 Key（`apps/desktop/src/main/maker-ipc/cindyAutoRouteFollow.ts`）。用户点选、跨引擎或跨电脑
的切换，以及等待生效的换凭证、运行时选择都不覆盖；运行时覆盖本身不算改道——目录刷新按原路由重新加载
进行中任务时也会写上它，这时它就是当前路由，照常跟随——只有故障切换中（`fallbackHop > 0`）的任务
不跟随。系统登记的 Auto 换来源（configStaged、同引擎、同一个 Auto、只换来源）在 Auto 再次挪动时按
当前位置重新核对。首次登记时验证两端都是 Cindy 分发来源，并在内存意图里记录来源身份；
后续目录删除某个来源时，只要记录仍匹配当前路由和登记目标，就仍可撤销或改登记。没有该记录时
仍要求目录中的两端均属 Cindy；目录中明确属于自定义来源的两端始终不跟随。伙伴或 IM 配置登记的
用户自定义来源切换不能被撤销或改登记。重核后：目标仍提供就不动；当前位置又能用、
或哪里都没有了就撤销登记；去了别的来源就改登记到那里。远程主机与另一台电脑上运行的任务不在本机改道。Auto 没有推理档位（任务里 effort
为空串）时按 null 登记。Cindy AI 列表或企业号池目录任一边刷新后 Auto ID 有增减，会顺带刷新另一边
（`cindyAutoModelIdsChanged`），跟随在两边都更新后才看到一致的位置；只刷新一边会把旧位置当成仍有效。
请求被拒后刷新目录重试不在客户端处理。
存下来的「来源 + Auto」（伙伴自己的模型链与用户自定义的伙伴默认、IM 渠道默认路由）在使用时套用
同一规则（`movedCindyAutoSourceId`，Pi 的 null 来源即 Cindy AI），不改写保存的配置；IM 跟随渠道
默认时把 Auto 的新旧位置视为同一路由，避免跟过去后被误判成用户单独改过。
伙伴异步读取 Auto 目录后必须复核当前账号；读取期间退出或切换账号时拒绝旧结果，
包括目录读取失败的回退分支。同账号的目录读取失败仍保留原链，交给既有路由校验。

设置页管理列表组内与选择器同序：组内每项都带 `sortOrder` 时按它排；只要有一项缺失，退回
按系列名 A–Z、同系列版本号降序，避免局部权重把新型号压到旧策展位置之后。

<a id="presets"></a>
## 第三方预设：一份推荐清单

`providers.json` 的每个预设只在顶层写一份 `models` 推荐清单，数组顺序即推荐顺序；
`runtimes[引擎]` 只放地址、协议、模型目录等连接信息，不再按引擎各写一份模型。
加载时由 `expandPresetModels` 展开回各引擎清单，下游与服务端下发的旧格式形状一致。

- 协议限制导致某模型只在部分引擎可用时写 `engines`（如 OpenCode Go 的 Anthropic 协议模型、
  GLM Coding Plan 只给 Claude Code 的 `[1m]` 变体）。
- 引擎专属字段写 `engineOverrides[引擎]`：Pi 的推理档位、按模型路由，以及确有差异的窗口
  （如 GLM Coding Plan 裸 `glm-5.2` 在 Claude Code 不写窗口、1M 走 `[1m]` 条目，Pi 为 1M）。
- `engines` 的每一项与 `engineOverrides` 的每个键都只能是本预设已声明的引擎；拼错或写成
  其它形状时整条预设被拒绝（即使 `runtimes` 另带旧格式清单），不静默丢模型或忽略覆盖。
- 本文件是源格式，旧客户端读不懂顶层清单，不能直接发布到旧 OSS `cfg/providers.json`
  （该文件自 2026-07 冻结，旧客户端经公共 API 与服务端投影拿到展开后的形状）。
- 名称与参数以厂商官方文档为准；未列入推荐清单的型号由 Pi 模型资料补入并默认隐藏。
- `presetModels.test.ts` 校验随包预设不再出现按引擎的清单。服务端分片同样只写一份推荐
  清单，由 `generateCatalog.mjs` 展开后下发；同 id 的服务端预设整体覆盖随包版本，所以
  推荐清单与参数两边保持一致。服务端的连接设置（含 Pi 照抄 Claude Code 的兼容映射）
  以服务端为准，随包版本的原生 Pi 地址只在离线时使用。

<a id="visibility"></a>
## 默认可见性：产品合同与实现差异

[产品合同](configuration-and-overrides.md#模型可见性)：用户开关优先，否则跟随目录 defaultEnabled。

- **不默认显示的型号只写在目录里**：条目标 `defaultEnabled: false`，未标的一律默认显示，
  所以新出的型号一定可见。客户端发现代码不按型号写死隐藏例外（2026-09-26 起移除了
  `gpt-5.4-mini`、Haiku、bridge `gpt-5.4` 等硬编码）。
- 保留的是按状态或引擎的规则，不针对具体型号：`deprecated`、`requires_payment` 默认关闭；
  跨 Harness bridge（如 Claude Code 里的 `chatgpt/*`）与自定义连接的兼容引擎默认关闭，
  Registry `perAgent` 可显式打开。
- **XD 路由一律使用独立的 `xd/*` 条目**，不与订阅或其他供应商共用条目：服务端生成
  Gateway `/models` 时读取 XD 路由所在条目的名称、排序与 `defaultEnabled`，共用会让订阅侧
  调整连带改动 XD。型号规格经 `modelRef` 继承同一公共型号，不重复维护。
  `xdRegistryEntries.test.ts` 校验离线 Registry 不出现混用条目。

排查须同时检查上游值、活动目录值和用户 override。

<a id="release"></a>
## 更新、下发与验收

来源回退：开发本地文件 → 公共 API / 对应最后有效缓存（LKG）→ 旧 OSS / 对应缓存 → 内置目录。
Registry 另按 updatedAt 选择整份有效版本，较新内置快照也可能胜出；这与逐字段覆盖不同。
localModels 整域缺失才用随包本地域，显式空不兜底。

1. **确认目标**：记下 Server/客户端 commit、部署环境、实际目录源、当前 schema/revision、要改的 provider/model/引擎；核实官方资料与该通道实报。本文不是线上状态台账。
2. **修改责任侧**：在授权范围内先维护 Server 正本，再协调客户端离线 Registry。遇到尚未上线的协议配套，分别记录工作分支、已合并和已部署状态，不混成“已支持”。
3. **整表同步**：将审阅后的 Server `modelRegistry` 整体同步到客户端 `catalog/model-registry.json`，保持同 updatedAt、同内容。不要复制 Server 整份 providers.json，也不能只复制 localModels 造成悬空引用。新 revision 必须递增且不可变；价格 effectiveFrom / verifiedAt 保留其真实日期。
4. **先验证兼容再发布**：完整结构过 parseModelRegistry / parseCatalog；确认旧客户端投影。尤其先读 [媒体扩展发布前置条件](../model-registry-v4-media.md#发布前置条件)：同为 V4 并不证明认识新增媒体字段。LKG/内置回退不能代替兼容方案。
5. **核对真实下发**：当前 Server 源码仅加载制品内生成目录，已不读取 MODEL_CATALOG_URL；须核对目标环境版本。部署后读取 `/api/model-catalog/catalog`，核对目标与旧版响应、ETag 和有效 revision。仅改文件、合并 PR、通过 CI 不算下发完成。
   同步回归须核对原有直连 route 与历史参考价区间未丢失；覆盖标准/Fast、缓存读写、长输入分档。
   离线默认档与已发布 Server 有差异时逐项披露。原生协议校验须遍历全部 route 和活动目录中的
   订阅 wire 别名，不能仅统计字段填写率；不能从供应商兼容 API 反推未知型号的原生协议。
6. **验收到运行时**：确认客户端实际接受目标快照，保留用户覆盖；检查选择器、发出的上游 ID/参数及新旧任务。覆盖离线、坏快照、同 revision 冲突与回退版本；刷新不改用户显式型号/档位，工作预算更新按 [运行时细则](model-catalog-runtime.md) 在安全时机应用。

兼容补全只能补缺项：旧快照缺失 nativeApi 可由内置补全；明确协议、null、retired 优先。
它不改窗口、价格、成员资格，也不从 Gateway wireProtocol 或 Pi piApi 猜原生协议。
旧格式迁移中若两份 Registry 有差异，必须使用不同 revision 并记录原因，不能伪造同版本一致。

## llama.cpp 托管接入

客户端的「添加供应商」有两个 llama.cpp 入口，互不影响：托管入口（`cindy-local-llamacpp`）
点击立即保存并进入详情，不等待安装或连接，安装与下载在详情中进行；目录中的 `llamacpp`
预设用于连接用户已运行的服务（默认 `http://127.0.0.1:8080/v1`，地址可改），出现在
「检测到本机服务」或「更多本机服务」，走普通预设连接流程，不调用托管安装或启动。
与 Ollama 共用 `LocalModelDownloadUI.tsx` 的安装提示、目录搜索、模型卡片、量化标签、
下载按钮、进度操作与手动下载布局，各运行时只适配传输和状态。
实现位于 `apps/desktop/src/main/local-model-runtime/llamaCpp*.ts`，界面为
`LlamaCppProviderDetail.tsx`。运行环境从 llama.cpp 官方 GitHub Releases 安装到
userData 下的 `llamacpp-runtime`；macOS 使用对应架构构建，Windows / Linux 先使用
CPU 构建。下载校验官方 SHA-256，不调用系统包管理器。

模型可从共用清单一键下载，也可由用户指定公开 Hugging Face 仓库并选择 GGUF 文件；下载固定到仓库 revision，
校验大小与 LFS SHA-256，自动补齐分片，全部完成后才移入已安装列表。取消或失败清理
本次暂存文件；磁盘不足在下载前提示。当前支持文本模型，不自动下载视觉 projector，
下载清单复用 Server Registry 的 `localModels.models[].llamacpp[]`，只增加
`repo / file / quantization / sizeBytes / verifiedAt` 下载资料，不维护第二份模型名单。
名称、搜索别名、五语简介、顺序来自同一模型条目和 `featuredIds`；两个运行时共用分档推荐。
GGUF 的型号级试用主推复用 `recommendForHost` 与 `featuredIds`，显示实际芯片和内存；
只保留存在 GGUF 包装且文件大小小于物理内存的主推型号。未知硬件、主推撤下或包装缺失时不从其他候选补位。
这是共用型号筛选，不是该 GGUF 的运行内存测量；卡片标明「主推 · 先试这个」，并说明本机速度与峰值内存待实测。
不继承 Ollama 包装的思考配置或实测结论，也不因内存充裕把其他候选自动提升为主推。
2026-09-26 按用户要求将 Flash-Next 显式加入共用主推首位（现有 192 GB 门槛），27B 为轻量备选。
`localModelBrowserItems` 统一过滤已安装项、保留活动下载、搜索与去重；已安装主推也从默认下载区隐藏。
下载支持同一次运行中的暂停/继续：保留暂存字节，按固定 revision 用 HTTP Range 续传，重新校验完整 SHA-256。
取消清理本次暂存；退出应用仍会取消，尚不恢复跨进程的下载。当前一次只执行一个托管操作。
`verifiedAt` 表示文件存在与大小核验日期，不能解释为运行验证；分片大小为总和。
明确空的 `llamacpp: []` 撤下该模型的 GGUF 候选，旧快照缺字段也不按型号猜下载地址。
试验范围与维护记录见 [llama.cpp 试验清单](../llamacpp-trial.md)。

托管服务只绑定 `127.0.0.1:11435`，与原手动预设的 8080 分开；端口被占用时不接管。
router 按请求加载模型，最多同时加载一个模型，默认上下文 32,768、单并发。
2026-09-26 经用户授权，当前 bartowski Flash-Next 试验包装使用 262,144；
按模型生成原生 INI preset，不用全局 CLI 窗口覆盖其它模型。发布模型资料时同步升级旧的托管默认值。
下载完成后自动同步供应商模型列表并广播刷新。服务运行时保留当前模型清单和上下文，
下载模型或修改上下文后，由拥有方在「管理服务」中手动重启生效；停止后的下次使用自动启动并应用最新配置。
普通使用不探测空闲后重载，不因待生效配置阻止已有模型继续使用；手动重启会中断当前生成。
添加时创建 `cindy-local-llamacpp` 连接，经现有 Chat 协议桥供 Pi / Codex / Claude Code 使用，
并保留已有模型的用户设置。后续使用该连接时自动启动服务；Cindy 退出时停止自有子进程。
2026-09-26 用户确认按需启动：安装后不立即启动，详情页不展示启动按钮，停止时显示「按需启动」。
会话启动和 Pi provider 装配均复用 preflight；下载不依赖服务运行。高级管理中保留停止/重启用于排障。
这不代表任意 GGUF 都支持工具调用。Flash-Next 可选 1,000,000 tokens，并自动配置 YaRN；
已完成本机单次 982,003 token 合成检索验证，不能据此承诺其他包装或复杂任务质量。

安装与下载管理目前与既有 Ollama 管理入口一样，只在执行端 Desktop 设置页开放，
不新增远程 privileged IPC 白名单。手机仍可通过已有执行端模型目录使用已连接模型；
SSH 执行路径跳过本机启动，不会把本机模型安装到远端。
安装与手动下载独立于服务端；共用目录的后续更新需要配套发布 Server。
客户端请求增加 `registryLocalRuntimes=1`，服务端仅向同时声明 media 和本能力的 V4/V5
客户端下发 `llamacpp`，旧端剥离该字段并重新计算 ETag。未知能力值等同未声明。
初次同步的完整 Registry 与 Server `dash/llamacpp-catalog` 工作树的生成快照一致，revision 为
`2026-09-26T00:00:00.000Z`（包含 26 日更新的主推顺序）；此为工作副本核验，不代表已合并或部署。同步前将客户端
已有但 Server 主干尚缺的 Grok 4.7 / Build Fast 配置原样补入 Server，避免回退已有型号。
没有仅拼入本地域、改变用户 override 或发布到线上。
随后同步客户端主干 #5119 的目录变更，保留其订阅排序与默认显示资料，以及本 PR 的本地包装和主推顺序；
2026-09-29 再次同步主干目录后，合并快照使用独立递增 revision `2026-09-29T19:00:00.002Z`，
避免与主干 `2026-09-29T19:00:00.001Z` 同版本不同内容。
此合并快照尚未同步 Server 工作树或部署，不能继续声称当前两边整表一致。
2026-09-30 用户确认 Server 配置更新单独推进，不作为客户端 PR #5118 的合并前置。
客户端可先使用随包目录；Server 完整目录同步、兼容下发及部署仍需分别核验，不能以客户端
合并代替 Server 发布，也不因审查线程关闭而声称线上已更新。

回归测试为 `llamaCppDownloads.test.ts`、`llamaCppService.test.ts`、`llamaCppIpc.test.ts`、
`managedLlamaCppProvider.test.ts` 与 `LlamaCppProviderDetail.test.tsx`。

## 通用供应商导入

Pi 上游生成资料统一转换为客户端 `catalog/provider-models.json`，供各引擎和设置页补缺；
不另存 Pi 原始表。目录的 Pi API 是该渠道的执行协议，不冒充 Registry 的厂商原生协议。
维护命令、覆盖顺序和验收见 [通用供应商目录](provider-catalog-generation.md)。
渠道多协议与逐模型接口证据见 [供应商接口核查](provider-interface-audit.md)。

## SSH Codex 模型目录

SSH Codex 的创建入口（含 Orca Worker）、任务内选择器与 main 的新建／切换准入读取所选主机
app-server 的完整 `model/list`，不使用控制端 OpenAI 登录或网关目录作为远端可用性的依据。
沿用已有远端安装与 daemon 连接流程；分页有界，读取失败或空清单显示重试，不回退到本机。
结果只用于该主机，断连、换主机或换账号后的迟到结果丢弃，不发布到本机公共目录。

新任务从远端清单解析默认模型及推理强度／Fast；已有任务保留原模型和历史，由用户改选。
设置页及普通 SSH 创建入口不继承控制端草稿的模型、推理强度或 Fast 记忆，即使型号同名；
采用远端默认模型及推荐推理强度，Fast 初始关闭，创建后可在任务内手动改选。
原样恢复只有在持久化的主机、原生线程、引擎、模型及来源均匹配时才豁免新建目录校验，
允许恢复后来被隐藏的原模型；模型是否仍可推理由远端 Codex 决定。SSH 模型及档位选择不写入控制端本地模型偏好。
首次连接成功会补偿挂载时因尚未就绪而失败的目录读取；重复 ready 快照不清空已成功读取的目录。
升级远端 Codex 包前先停止旧 daemon；有正在执行的回合或无法确认停机时，升级失败并提示稍后重试。
`model/list` 不提供的真实窗口保持未知；普通 SSH Codex 切换沿用 main 的窗口策略：
未知窗口允许切换且不主动重建，已核实的高风险缩窗在远端拒绝，回合中延期。
不能因前端尚无用量报告而静默丢弃点击。未知窗口不代表已证明切换安全，后续上下文处理仍由原生 Codex 决定。
目录成员资格不等于认证、网络和实际推理已验证。

实现：`maker-host/ssh-codex-models.ts`、`remote-ssh/codex-model-list.ts`、
`useSshCodexProviders.ts`；回归：`codex-model-list.test.ts`、`sshCodexModels.test.tsx`、
`chatInputModelLoading.test.tsx`。新增读取 IPC 属于本机 SSH 管理面，与既有 SSH 管理 channel
一样不开放 device-link；手机及设备互联的供应商清单协议保持原样，完整远端能力发现仍由 #65 跟进。

## 按问题继续阅读

| 按需阅读 | 入口 |
| --- | --- |
| 资料、账号、覆盖、空名单 | [模型资料优先级](../product-rules/model-metadata-precedence.md) |
| 窗口、压缩、价格与展示 | [运行时与展示细则](model-catalog-runtime.md) |
| 本地包装、内存、推荐证据与更新 | [本地模型筛选](../product-rules/local-model-selection.md) |
| 图片/视频/音频/向量字段与发布兼容 | [V4 全类型规范](../model-registry-v4-media.md) |
| 供应商界面、账号状态、用量呈现 | [供应商设置](../product-rules/provider-settings.md) |
| 历史型号与同步记录 | [历史记录](../model-catalog-history.md)；不可当作当前状态 |
| 字段写法及可执行校验 | [五个示例](../examples/model-catalog.md) |
| 修改代码与定位测试 | [代码导航](model-catalog-runtime.md#从需求找到代码) |

## 厂商参考价（Registry V5）

公共型号的 `referencePriceGroups` 使用市场标识（当前为 `global` / `cn`），不是供应商 ID。
每组 `prices` 沿用原价格结构与官方证据：币种、每百万 tokens 单价、缓存读/写及 1h 写入、
标准/Fast 等变体、输入区间 `[minInputTokens, maxInputTokens)`、生效日期区间。
缺字段保持未知，明确的 0 才表示零单价；缓存存储每小时费用不能写成缓存写入单价。

`resolveBaseModelReferencePrice` 按公共 ID/唯一 alias 读取，不依赖供应商名单。
多市场/币种必须明确选择到唯一有效价格；无匹配或有歧义返回未知。
路由用 `referencePriceGroup` 明确选择所属公共型号的价格组；供应商自己的 `referencePrices`
优先于该组，整组替换，不逐字段补齐。订阅价值估算指定 `officialOnly`，仅取厂商参考价，
用户显式价格覆盖仍优先，账号归属不变。XD 计费继续只读 Gateway 实报。

新客户端请求 `registrySchemaVersion=5&registryMedia=1`。无媒体能力标识的请求保持服务端
冻结兼容快照，不跟随完整正本更新；正本与客户端离线 Registry 仍保持完整一致。
服务端向 V1–V4 展开官方参考价到原路由字段，
剥离新增组与引用字段；V4 保留公共资料、本地域及原覆盖语义。各版本响应有独立 ETag。
旧服务端仍可返回旧目录，新客户端保留旧格式读取；应先部署服务端再发布客户端。
本次只迁移已有、已核实的价格，不补猜测价格，不改变 XD 的缺价处理。

## xAI 双接口同步与导入验收

新维护入口为 [`tools/model-catalog/sync-xai.mts`](../../tools/model-catalog/sync-xai.mts)，
用账号 `/models` 与官方 `/language-models` 合并型号和资料，再通过实际活动目录、三引擎
选择器数据与参考价解析验收。运行方式、凭证边界、缺项报告与实测限制见
[同步说明](../../tools/model-catalog/README.md)。输出是账号范围的本地导入候选，不可直接
作为全局 Server 清单发布；它不改用户覆盖，也不以抓取成功代替完整适配。

订阅 Fast 若通过独立上游型号执行，在 `providers.models[agent].fastModelId` 声明同来源、
同引擎的目标 ID；不能只下发 `supportsFastMode: true`。客户端结合当前账号发现结果计算
可用性，并在 Claude / Codex / Pi 请求边界统一切模，不再叠加 `service_tier: priority`。
`null` 可显式撤销映射；缺省保持旧行为。旧客户端忽略新映射，因此执行适配需先随客户端
发布；后续相同执行方式的新型号可维护目录数据。4.7 的关系与 Fast 价表已由官方文档和
实测补证，4.6 不从版本号推导 Fast 支持。
