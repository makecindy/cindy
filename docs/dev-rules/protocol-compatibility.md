# 跨端协议兼容

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改插件分发来源边界、device-link 协议／relay／隧道 payload／IPC
> allowlist，或任何改动客户端与服务端之间 wire protocol 的地方之前

客户端与服务端分别维护本仓所需的 wire Bean、validator、parser 与 builder，不共享代码仓库
或发布节奏。真正危险的是单端改变既有 wire 语义，或在不兼容变更中缺少协同；这类问题在
单仓 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

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
