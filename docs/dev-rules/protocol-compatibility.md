# 跨端协议兼容

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改插件分发来源边界、device-link 协议／relay／隧道 payload／IPC
> allowlist，或任何改动客户端与服务端之间 wire protocol 的地方之前

客户端与服务端分别维护本仓所需的 wire Bean、validator、parser 与 builder，不共享代码仓库
或发布节奏。真正危险的是单端改变既有 wire 语义，或在不兼容变更中缺少协同；这类问题在
单仓 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 本页与协议记录的分工

本页只放动手前必须知道、对所有跨端改动都成立的规则：事实来源、协议演进、插件来源、
Ghost manifest、自建中转同步维护与 Review 清单。每项具体能力的协议约定（字段、channel、
旧端降级、发布顺序、实现与回归入口）各占一个文件，放在
[`protocol-compatibility/`](protocol-compatibility/) 目录。

- **改动前**：读完本页，再按能力名、channel、字段或包名在目录内检索，读命中的记录：
  `grep -rl '<关键词>' docs/dev-rules/protocol-compatibility/`。列出全部记录的标题：
  `grep -rm1 '^# ' docs/dev-rules/protocol-compatibility/`。
- **新增记录**：在目录内新建 `<领域>-<主题>.md`（小写英文、数字与连字符；同一领域沿用已有
  前缀，如 `remote-desktop-`、`provider-group-`、`plugin-`），一级标题写能力名，正文沿用现有
  记录的写法。延续已有能力时改原文件，不另起一份。
- **不往本页追加逐项记录**：每个协议任务都要先读完本页，逐项记录写进来会把通用规则埋掉。
  `pnpm check:dev-docs` 检查本页体积与记录文件的格式。

## 事实来源

| 内容                     | 权威来源                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| hook 双工任务协议        | 客户端 `packages/slack-hook-protocol`；服务端仓同名本地 package，desktop hook-control 与 slack／telegram／x hook server 分别消费本仓实现                                                   |
| device-link relay 层定义 | 客户端 `packages/device-link-protocol`；服务端仓同名本地 package，客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link`                                                        |
| Plugin 交付与 manifest   | 客户端 `packages/plugin-protocol`；服务端仓同名本地 package，desktop、`packages/cindy-tools` 与 plugin-server 分别消费本仓实现                                                             |
| 模型目录                 | 客户端由 `packages/model-providers/src/modelAccessBean.ts` 与 `modelAccessValidator.ts` 维护；model-access-server 在服务端仓维护对应 Bean／validator，双方只共享稳定 wire 语义，不共享实现 |
| Skill Hub                | Desktop 的 `apps/desktop/src/main/skillhub` 与 `shared/skillhubCatalog.ts`；服务端仓 `packages/skill-hub-protocol` 与 `cindy-skill-hub-server`                                             |
| 插件来源                 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包                                                                                                                             |

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

## 2. 插件来源

- 客户端不包含内建插件种子，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与用户主动安装流程。
- 开发或个人构建仍可在本地 `apps/desktop/resources/builtin-ghosts` 放种子测试未发布的插件
  （安装包不带）；与同名商店安装按版本取新，规则见
  [插件安全 §3.1](plugin-security-and-authoring.md#31-安装与自动更新)。

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
- Plugin Market、仓库 CI 与 Desktop 不得用当前 Host 能力清单拒绝未知扩展字段、
  能力动作或订阅事件；未知声明保留为数据，由实际运行客户端决定是否支持。
  已知字段形状、安全路径和整体协议格式仍须校验。新增能力不要求发布入口先登记；
  只有改变既有字段结构或安全语义时才需要协调协议升级。
- 插件必须检测接口并处理不支持响应，局部降级或提示升级。`minCindyVersion` 不能替代
  这些处理：手动导入、旧版或其它安装渠道仍可能将包交给不适配客户端。

## 自建中转同步维护

**硬性要求：凡 Device Link 的改动会影响自建中转，必须在同一次改动中完成必要的同步适配、
兼容处理与验证。缺少这些内容视为未完成，不得只完成官方中转路径后把自建中转留到后续。**

- **触发范围**：共享客户端与协议（`packages/device-link`、`packages/device-link-protocol`）、
  relay 的握手／帧路由／顶层字段／能力协商、鉴权与设备签名、设备／媒体／ICE 接口，以及
  Desktop、Mobile 的连接恢复与中转路由。判断以实际行为影响为准，不以修改文件的位置为准。
- **一起适配**：修改前核对共享客户端、自建中转内核（`packages/device-link-relay`）及两端接入代码。
  需要调整的实现、测试和协议说明必须一起更新；能由已有通用转发或共享客户端直接支持的，
  不要求制造无意义的服务端改动，但必须说明为何无需修改并提供验证结果。
- **一起验证**：影响通信兼容或恢复行为时，必须运行共享客户端测试、自建中转测试，以及
  `pnpm --filter @cindy/device-link-relay run interop`，验证当前生产客户端与真实自建中转的
  加入、签名通信和重连。涉及设备、媒体等未被该互通场景覆盖的接口时，补充对应定向验证。
  官方中转测试或本地 fixture 通过，不能替代自建中转互通结果。
- **照顾已部署版本**：服务器上的自建中转不会随客户端自动更新。新增能力遵循可选字段与能力协商，
  核对新客户端连接旧中转时的行为；需要更新中转程序时同步维护 `RELAY_VERSION`、分发构建与
  升级入口。不兼容变化必须明确支持的版本、升级路径和旧端处理，不能只在两端同时更新时可用。
- **交付说明**：PR／交付中写明自建中转的影响、同步修改位置及实际验证结果。若只是官方服务内部
  扩容、数据库或监控调整，或已有通用转发足够支持本次变化，可以写明无需同步修改的具体依据；
  不得仅写「不涉及」或假定官方与自建中转会自动保持一致。

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
