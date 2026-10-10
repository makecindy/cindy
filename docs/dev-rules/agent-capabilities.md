# Agent 能力声明与伙伴继承

伙伴和普通 Agent 复用已有工具实现、注册和权限档。新增一个工具，不需要再登记伙伴来源分档、底层调用口或另一份 `control_session` 操作表。

## 声明放在哪里

- 内置 MCP：在现有 `createLiziMcpProviders` / Desktop provider 注册处声明。`capability` 元数据可提供名称、说明、来源和渐进发现入口；实际工具名称、参数、说明仍从 MCP 注册读取。
- 插件：沿插件自己的 manifest 和 `ghost_list → ghost_info → ghost_call` 发现，不复制为另一套工具。
- 自定义 MCP：连接由引擎持有。目录查询不会另起进程、调用其工具或读出 URL、headers、token，而是向发起查询的任务所在引擎读取该服务在本任务中实际持有的工具（见下节）。
- 命令行、文件、原生子 Agent：由当前引擎提供。伙伴不再额外禁用；运行时能力摘要和引擎实际提供的工具共同表达可用范围。
- Skill：仍使用既有安装、发现和伙伴自有 Skill 学习体系。工具全部继承不意味着覆盖伙伴人格、共享个人记忆或将全部 Skill 正文塞入上下文。

## 如何查询

调用已有 `cindy_helper` 的 `get_capabilities`：

```json
{ "scope": "runtime" }
```

返回当前 Agent 的 provider 目录、注册/不可用状态、原因、权限档及宿主交互能力摘要。`registered` 表示注册及入口条件满足，不代表外部服务已连通。

```json
{ "scope": "runtime", "server": "cindy_helper", "category": "control" }
```

读取内置 server 的真实 schema 与渐进目录。没有 `scope` 时保留原产品说明查询行为。

指定由引擎自己连接的 server（自定义 MCP 等）时，宿主经发起查询的 Session 读取引擎在本任务中的状态：Codex 用带本任务 `threadId` 的 `mcpServerStatus/list`（不拿共享 app-server 的进程级清单代替），Claude Code 用 `mcpServerStatus()`。有工具时返回服务端原始工具名与截短说明；否则返回 `ok: false` 和明确的 `engineState`——`not-mounted`（本任务引擎未挂载，常见于任务开始后才增改）、`no-tools`（已配置但未报告工具，Codex 无法区分启动失败与本无工具）、`failed`、`needs-auth`、`pending`、`disabled`；引擎没有该入口（Pi、SSH 远端 Claude、远程 Agent）报 `HARNESS_DISCOVERY_UNAVAILABLE`，读取失败或超时报 `HARNESS_DISCOVERY_FAILED`。不转发引擎的失败原文，避免带出连接地址。实现见 `apps/desktop/src/main/maker-host/agentCapabilityCatalog.ts` 与 `packages/maker-core/src/agents/{codex,claude-code}/mcp-server-tools.ts`。宿主交互能力不等于 Agent 已有可调用接口；例如应用安装更新、重启没有正式 Agent 接口，`check_app_update` 只查询当前更新渠道。

## 伙伴默认配置

```json
{
  "toolCapabilityVersion": 1,
  "toolsetMode": "inherit",
  "mcpMode": "inherit"
}
```

新伙伴默认继承 Cindy 已启用的工具和连接，创建时的显式选择优先。读取或导入旧配置时，空和非空工具允许名单都统一升级为继承，工具集与 MCP 一致，旧引用不删除。`toolCapabilityVersion: 1` 下的明确选择（包括主动清空的名单）均保留，后续读取不会再次放开。配置变更继续沿同任务轮次边界刷新，已开始的一轮保持冻结快照。

2026-10-02 产品确认：旧格式没有可靠记录名单来自用户还是系统；AI 创建、导入也会生成非空名单。用户确认旧名单统一放开，不再用空/非空猜测用户是否设置过。此迁移也会放开旧版真正手选过的限制；升级后仍可重新选择，并按新声明语义持久保留。

现有 ask / auto / 完全访问保持原值，全局停用、平台/引擎不支持和连接缺失如实报告。所有伙伴共享这套解释规则，不按名字或数量逐个适配。

## 权限与正确性

权限继续由 Agent 配置、统一审批以及普通工具的公共入口处理。删除伙伴单独的 owner / arranged / other 工具分档。账号切换、过期实例、目标不存在、队列消息归属、对象操作条件仍须校验；插件自身的面板/后台入口保留其已有授权，不因没有 Agent 在场就获得 Agent 权限。

已知边界：群专线、其他伙伴及自动化转来的消息，沿用该 Agent 的能力与权限档，目前没有按触发来源整轮降低权限的实现。若该 Agent 配置为完全访问，这些来源也沿用完全访问；现有公共审批不能被描述为已经实现来源隔离。本次不自动更改用户的权限档，后续如区分来源，应在 Agent 执行层统一处理，而不是恢复逐工具分档。

调用任务的归档状态不是停止信号：已有运行轮次在归档后仍可调用 helper 和自动化工具；共享入口拒绝缺失、已删除的调用任务和失效账号。具体操作仍保留各自的目标状态要求。

伙伴自己的资料、工作台、群记录等仍有具体业务对象；普通任务没有伙伴资料，远程工作目录也不能冒充本机工作台。查询目录和执行操作必须返回真实结果，不把未连接当成权限拒绝，不把宿主内部方法写成公开工具。

## 回归入口

- `botCanonicalSession.test.ts`：创建、存量配置、同任务刷新、跨引擎/远端可用性和能力修改。
- `botProfileVersioning.test.ts`：旧名单升级、保留权限档、显式选择的幂等保存。
- `botCapabilitySettings.test.tsx`：默认全选及主动取消后的其他能力保留。
- `agentCapabilityCatalog.test.ts`：真实 SDK schema、渐进目录、未挂载原因、外部连接不被重复启动，以及引擎实际工具与各类未就绪状态。
- maker-core `agents/codex/mcp-server-tools.test.ts`、`agents/claude-code/mcp-server-tools.test.ts`：按本任务线程读取、未挂载与无工具的区分。
- `lizi_xdtHelperMcpServer.test.ts`：普通任务/伙伴使用同一个能力查询和通用任务工具。
- 三个引擎各自的伙伴启动回归：没有伙伴专属的原生子 Agent 禁用参数。
