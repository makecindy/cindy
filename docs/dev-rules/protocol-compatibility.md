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

## 2. 插件来源

- 客户端不包含内建插件种子，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与安装确认流程。

## 3. Ghost manifest 与 Cindy 专属界面能力

- `ghost.json` 的跨消费者字段、slot 与枚举属于 Ghost manifest 协议，客户端正本位于
  `packages/plugin-protocol/src/manifest.ts`；Desktop 在
  `apps/desktop/src/shared/ghost.ts` 维护运行时 validator。除明确登记的 Desktop-only
  能力外，两份实现及相同的有效／无效 fixture 必须同步，作者契约同时写入
  `FORGE_GUIDE`。
- 当前 `GHOST_SLOTS` 槽位集合中唯一登记的 Desktop-only 例外，是尚未进入跨消费者发布
  契约的 `library` 槽；在其首个正式支持版本确定并完成分发端兼容设计前，不得把它加入
  `packages/plugin-protocol`。这里的「唯一」只描述槽位集合，不表示两套 validator 的其它
  历史字段语义已经完全同构；`main-view` 是跨消费者字段，不属于该槽位例外。
- `main-view` / `mainView` 是通用的 Cindy Host 界面能力，不是 `xd-sites` 专用 API，协议中
  不出现 `xd-sites` 的端点、OIDC 流程或业务模型。具体插件可在它已获批准的其它 slot 内调用
  自己的服务，基座只负责声明校验、授权、导航和沙箱承载。
- `mainView.icon` 是主视图入口的 Host 系统图标枚举，只作用于该入口；根级 `icon` 仍是插件
  品牌图片协议。字段白名单、默认回退与完整枚举见 `FORGE_GUIDE` §4.20，不能用图片路径或
  未声明别名绕过枚举。
- 如果 Plugin Market／服务端仓会解析或严格校验新增的 manifest slot／枚举，发布使用新能力
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
