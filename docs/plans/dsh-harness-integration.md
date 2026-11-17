# DSH harness 接入计划与证据入口

> 状态：提案 / 参考，尚未实现；不代表维护者排期或发布承诺。
> 核对日期：2026-11-07。Cindy 源码基线：`d920573a985f65645a15b34e91d84cd04e91616a`。

目标是让用户在 Cindy 内使用 DeepSeek Harness（`dsh`）运行任务，保留任务历史、停止、
权限确认与跨端控制。接入属于 Core 的 Agent 连接与任务生命周期能力，依据
[核心产品原则](../product-rules/core-product-principles.md)；供应商能调用 DeepSeek 模型，
与使用 DeepSeek Harness 是两件事。

## 当前可以确认什么

| 证据 | 已确认的范围 | 不能据此推断的结论 |
| --- | --- | --- |
| [core AgentKind](../../packages/maker-core/src/types/common.ts)、[Agent 导出](../../packages/maker-core/src/agents/index.ts) | 当前基线注册 Claude Code、Codex、Pi | DSH 已可作为产品 Agent 使用 |
| [模型供应商类型](../../packages/model-providers/src/types.ts)、[调度类型](../../packages/maker-shared/src/scheduleTypes.ts) | 这些边界也仍使用三种 Agent identity | 只加一个启动命令即可贯通产品 |
| [总任务 #3770](https://github.com/makecindy/cindy/issues/3770) | 已有 F0–F11 接入方向与子任务 | 计划已经实现、通过验收或进入发布排期 |
| [前置验证 #3771](https://github.com/makecindy/cindy/issues/3771) | issue 中记录了未注册 bridge 和固定制品验证尝试 | issue 正文中的代码、测试结果已在当前 main 合并 |
| [历史 PR #2989](https://github.com/makecindy/cindy/pull/2989) | 曾有 Desktop/provider/text 接入尝试；已关闭、未合并 | 当前版本已具备该 PR 描述的功能 |

当前基线未发现 issue 引用的 `docs/issues/dsh-native-integration/` 四份规范文档，也未发现
`DshControlPlane`、`DshAcpClient` 或 DSH gate 脚本。接手者应先取得原实现的提交与证据映射，
再判断哪些工作可复用。本文件补充发现入口，不冒充缺失文档的恢复版本。

### F0 历史记录需要按时间阅读

早期记录的阻塞是固定 PyPI wheel 无法核验与源码的对应关系。随后记录了 Cindy 受控源码构建
路径；[2026-09-03 更新](https://github.com/makecindy/cindy/issues/3771#issuecomment-5518114765)
仍标记 `INCOMPLETE`，缺少已推送的 CI 制品、来源证明与 Linux runner 证据，Windows smoke
也被暂缓。不能将早期 wheel 阻塞当作当前唯一待办，也不能把后来的本地构建报告当作 CI 通过。
以上均为历史报告，本次未复跑二进制验证；后续以固定提交、制品与可重跑证据重新判定。

## 建议的接入路径

按 #3770 已定的公开 ACP v1 路径接入受管 runtime，先核验固定 release 对所需能力的支持。
Cindy Main 拥有任务归属、进程、权限交互和产品事件投影，DSH 拥有 Agent Loop。
参考上游 [ACP 契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
与独立的 [SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)。
这些是可变分支链接，仅供理解协议差异；实现 PR 必须固定实际支持的上游 commit/release 与协议版本，
不得将 SDK 方法和 ACP 方法混用。

上游 ACP 文档描述了任务创建/恢复/关闭、消息流、取消、权限请求与 MCP。接入前逐项验证：

- 模型与推理档位如何发现、选择并传到实际执行层；不从其他 harness 的目录推断支持。
- ACP 恢复不回放历史更新时，Cindy 如何恢复已有展示记录并继续接收新事件。
- 每任务一个进行中 prompt 的约束如何与 Cindy 发送、排队、插话、停止入口衔接。
- `session/request_permission` 与 Cindy 权限模式的映射，以及拒绝、取消、超时和迟到回执。
- 由客户端提供的 MCP 命令、环境、URL、headers 的归属与授权；协议握手成功不等于用户授权。
- 上游未暴露的能力（如 fork、历史回放、terminal）分别标为缺失或待实现，不能伪装成功。

通用 harness 扩展应复用本次实际证明的生命周期与 capability 契约。先用 DSH 验证一个完整
适配，再决定是否抽取共用 ACP 层；本提案不承诺任意命令行工具都可直接注册为完整 Agent。

## 分阶段交付与退出条件

沿用既有 issue 依赖图；下表是交付分组，不改变原任务的批准或验收要求。

| 阶段 | 对应任务 | 可审查交付与退出条件 |
| --- | --- | --- |
| 证据与可复现入口 | [F0 #3771](https://github.com/makecindy/cindy/issues/3771) | 固定实现提交、上游来源、构建输入与制品摘要；提交无秘密 verifier、运行记录、平台结果；维护者依据证据判定是否通过 |
| 身份、受管进程、持久恢复 | [F1 #3772](https://github.com/makecindy/cindy/issues/3772)、[F2 #3773](https://github.com/makecindy/cindy/issues/3773)、[F3 #3774](https://github.com/makecindy/cindy/issues/3774) | 跨层 identity 清单闭合；缺能力显式不可用；进程退出可确认；重启后恢复归属并对账，投递结果不确定时不自动重放 prompt |
| 权限、事件与 Desktop 完整流程 | [F4 #3775](https://github.com/makecindy/cindy/issues/3775)、[F5 #3776](https://github.com/makecindy/cindy/issues/3776) | 从真实入口完成创建、发送、流式输出、工具确认、拒绝、停止、重开和错误恢复；选择与权限实际生效 |
| 活动、扩展与多端 | [F6 #3777](https://github.com/makecindy/cindy/issues/3777)、[F7 #3778](https://github.com/makecindy/cindy/issues/3778)、[F8 #3779](https://github.com/makecindy/cindy/issues/3779)、[F9 #3780](https://github.com/makecindy/cindy/issues/3780)、[F10 #3781](https://github.com/makecindy/cindy/issues/3781) | 分别证明活动/扩展、SSH、设备互联/Mobile 与 Orca 的身份、权限和停止恢复；不以本机演示替代远端证据 |
| 发布与持续维护 | [F11 #3782](https://github.com/makecindy/cindy/issues/3782) | 实际发布平台的启动、升级/回滚、旧状态保留与原三种 Agent 回归通过；未验证能力继续明确标注 |

近期第一份功能 PR 应围绕 F0 的可复现入口收敛：说明原实现在哪里、哪份证据对应哪个提交、
还缺什么。源码构建与制品来源策略由维护者评审，不用换成 PATH、包管理器最新版或读取私有
JSONL/数据库绕过原计划。F0 完成后才能按依赖推进产品注册。

## 验收记录格式

每次功能 PR 记录源码提交、上游版本、制品摘要、平台、入口、操作与预期、实际结果和证据位置。
各项分别记 `PASS` / `FAIL` / `INCOMPLETE`，不把整个计划统一标绿：

- 程序流程：真实 transport 与 bridge；可使用隔离的本地假模型服务，明确其模拟范围。
- 真实模型：仅在获得授权后少量抽样；记录语义质量与流程结果，未调用时写明未验证。
- 用户操作：创建 → 发送 → 工具确认/拒绝 → 停止 → 重开；覆盖等待确认时停止与迟到结果。
- 恢复与隔离：进程 EOF/异常退出、应用重启、重复/乱序事件、不同任务隔离、投递不确定不重放。
- 交付：逐平台核对包与已测源码；平台未运行不记通过；回归 Claude Code、Codex、Pi。

涉及实际实现时，继续遵守 [Agent 行为](../dev-rules/maker-core-and-agent-behavior.md)、
[协议兼容](../dev-rules/protocol-compatibility.md)、[本地数据](../dev-rules/credentials-and-local-storage.md)
和 [远程与手机适配](../dev-rules/remote-and-mobile-adaptation.md)。本提案未改运行时、协议、
权限或发布策略，不构成这些后续动作的批准。
