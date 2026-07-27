# 协议兼容与 submodule

> **状态**：权威开发规则（authoritative）
> **读取时机**：升级 `cindy-protocol`、修改插件分发来源边界、修改 device-link
> 协议／relay／隧道 payload／IPC allowlist，或任何改动客户端与服务端之间 wire protocol
> 的地方之前

`cindy-protocol` 是客户端与服务端共享的 wire protocol 权威来源。submodule 指针漂移或
单端改协议会让两端不一致，且这类不一致在本仓的 typecheck／单测里发现不了，只有真实
连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)，submodule 初始化命令见
[`environment-setup.md`](environment-setup.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 协议权威源 | 根 submodule `cindy-protocol`（`github.com/makecindy/cindy-protocol`） |
| desktop 消费的协议包 | `@cindy/slack-hook-protocol` |
| device-link relay 层定义 | `@cindy/device-link-protocol`；客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| 插件来源 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包 |

## 1. `cindy-protocol` 是协议权威源

- 协议定义以 `cindy-protocol` submodule 为准；desktop 通过 `@cindy/slack-hook-protocol`
  消费，device-link 复用 `@cindy/device-link-protocol` 的 relay 层定义。客户端重连、IPC
  allowlist 与隧道 payload 留在 `packages/device-link`，不在客户端另造一套协议。
- `makecindy/cindy-protocol` 以新历史公开；父仓锁定的 submodule commit 必须始终
  可从公开仓拉取——合入协议仓 `main`，或打 `client-baseline-<sha>` tag，不允许只
  停在 feature 分支上（分支删除会让 gitlink 失效）。当前锁定的 `4468730` 已在协议
  仓 `main` 上；历史 tag `client-baseline-436a45f` 仍可能被旧 checkout 依赖，不要
  删除。
- **升级 submodule 指针前必须确认服务端同步升级**，避免两端 wire protocol 漂移。协议是
  跨仓契约，单端先行会让线上连接对不上。

## 2. 插件来源

- **第一方内置播种**：`builtinGhostProvisioner` 从随包种子目录（official / xd 等
  provisioning.json 声明）在启动期静默安装与覆盖更新第一方插件——这是**现状陈述**
  （机制见 `builtinGhostProvisioner.ts`），用户的 `.disabled` 停用标记与手动安装不
  受播种回收影响。
- **市场 `defaultInstall`**：服务端策展的默认安装条目当前在 snapshot 内静默安装并
  启用，不经确认弹窗——同为**现状陈述**；未配置的插件装完进入「已启用 · 待
  配置」态（生命周期投影 needs_setup，工具不对 agent 派发，卡片带待配置徽章）。
- 预装 / installPolicy 的策展策略仍是**待定决策**（见 plugin-lifecycle issue P1 的
  二选一事项，需 owner 确认），最终策略确定后再更新本节。
- 用户手动安装 `.cindy` 包一律走装入确认框；第三方插件不存在无确认通道。
- 没有任何插件时启动和开发不应因此失败。
- 不要引入**新**的无确认第三方分发通道；需要推荐第三方插件时走 SkillHub 的
  分发与安装确认流程。

## Review 清单

1. 改动是否触及跨端 wire protocol？是否要同步 `cindy-protocol` 与服务端？
2. 升级 submodule 指针时，是否确认了服务端同步、不会造成协议漂移？
3. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
4. 插件分发是否保持在三条既定通道内（第一方播种 / 市场策展 defaultInstall /
   手动确认装入），没有为第三方新增无确认通道或绕过插件权限边界？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容；submodule 相关操作见 [`environment-setup.md`](environment-setup.md)。
