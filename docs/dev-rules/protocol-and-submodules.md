# 协议兼容与 submodule

> **状态**：权威开发规则（authoritative）
> **读取时机**：升级 `cindy-protocol`、修改插件分发来源边界、修改 device-link
> 协议／relay／隧道 payload／IPC allowlist，或任何改动客户端与服务端之间 wire protocol
> 的地方之前

`cindy-protocol` 是客户端与服务端共享的存量 wire protocol 权威来源。协议仓的 package
集合已经封闭，只会维护或减少现有 package，不再接收新 package。submodule 指针可以因
兼容的分阶段升级而不同；真正危险的是单端改变 wire 语义或在不兼容变更中缺少协同，这类
问题在本仓的 typecheck／单测里发现不了，只有真实连接时才暴露。device-link 的运行时约束另见
[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)，submodule 初始化命令见
[`environment-setup.md`](environment-setup.md)。

> **增量适用原则**：wire protocol 兼容对所有跨端改动生效，不因是小改而豁免。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| 协议权威源 | 根 submodule `cindy-protocol`（`github.com/makecindy/cindy-protocol`） |
| hook 双工任务协议 | `@cindy/slack-hook-protocol`；desktop hook-control 与 slack／telegram／x hook server 共同消费 |
| device-link relay 层定义 | `@cindy/device-link-protocol`；客户端重连、IPC allowlist、隧道 payload 在 `packages/device-link` |
| Plugin 交付与 manifest | `@cindy/plugin-protocol`；desktop、`packages/cindy-tools` 与 plugin-server 共同消费 |
| 模型目录 | `@cindy/model-access-protocol`；desktop／mobile 与 model-access-server 共同消费 |
| 插件来源 | 客户端不预装插件；一律通过 SkillHub 或用户手动安装 `.cindy` 包 |

## 1. `cindy-protocol` 是协议权威源

- 协议定义以 `cindy-protocol` submodule 为准；当前只保留
  `@cindy/slack-hook-protocol`、`@cindy/device-link-protocol`、
  `@cindy/plugin-protocol`、`@cindy/model-access-protocol` 四个有真实双端消费者的包。
  客户端重连、IPC allowlist 与隧道 payload 留在 `packages/device-link`，不在客户端另造一套协议。
- 协议仓是封闭、持续精简的存量仓库：不得新增 package、增加 package 数量，或把无关业务域
  塞进现有 package 绕过限制。新业务域的契约在所属业务仓库处理，或另行做仓库外架构决策。
- `makecindy/cindy-protocol` 以新历史公开；父仓锁定的 submodule commit 必须始终
  可从公开仓拉取——合入协议仓 `main`，或打 `client-baseline-<sha>` tag，不允许只
  停在 feature 分支上（分支删除会让 gitlink 失效）。历史 tag
  `client-baseline-436a45f` 仍可能被旧 checkout 依赖，不要删除。
- append-only、带旧端降级路径的兼容变更允许客户端和服务端独立 pin、分阶段升级；只有实际
  使用新字段／消息／校验能力的消费仓需要 bump。删除未被任何消费方引用的 package 也不要求
  两仓同步部署。
- 不兼容 wire 变更、device-link 新增 relay kind 等必须在协议 PR 中声明升级窗口，并协调所有
  相关消费方；不能把“允许指针不同”误读成允许单端改变既有字段语义。

## 2. 插件来源

- 客户端不包含内建插件种子 submodule，不在安装包中预置插件，启动期也没有播种
  （provisioning）逻辑——预装机制已整体移除（2026-07）。
- 插件运行时保留，用户通过 SkillHub 或手动安装 `.cindy` 包；没有任何插件时启动和
  开发不应因此失败。
- 不要重新引入预装／播种机制或私有种子 submodule；需要推荐插件时走 SkillHub 的
  分发与安装确认流程。

## Review 清单

1. 改动是否触及跨端 wire protocol？是兼容独立升级，还是需要协调窗口的不兼容变更？
2. submodule 目标 commit 是否已合入公开协议仓，旧端降级行为是否明确？
3. 是否新增了 protocol package、扩大了 package 数量，或把无关领域塞进存量 package？这些均不允许。
4. 客户端是否在 `packages/device-link` 之外另造了协议或绕过 relay 层定义？
5. 插件能力是否通过 `.cindy` 包和 SkillHub／手动安装分发，而不是重新引入预装／播种
   机制、私有种子 submodule 或绕过插件权限边界？

协议改动按 [`desktop-development.md`](desktop-development.md) 跑相关测试，并与服务端确认
兼容；submodule 相关操作见 [`environment-setup.md`](environment-setup.md)。
