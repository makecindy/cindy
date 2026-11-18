# 插件宿主工具的平台服务

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

现有 `usage` 组增量注册 `get_provider_usage_history` / `get_provider_group`，Agent/插件共用原 usage-history 与组 get 处理器，
异机复用现有同账号 manage-share / manage-group；无新 action、channel、额度 DTO、缓存或服务端请求种类。
不声明 `usage` 的旧插件权限不变，manifest 新增该组走既有安装确认；仅有 `settings` 不授予这些读取。
已有 `usage` 批准的插件可调用新增组内读取，宿主升级不触发补批；安装确认说明（12语言）包含订阅配额、已记录用量与估算、供应商组配置/状态和可见成员/设备信息；
后两类覆盖同账号已授权其它电脑。不新建权限组、版本化重批或额外授权记录。
`list_model_providers` 与 `configure_model_provider` 的 `subscriptionAccounts/read` 仍要求原本机任务上下文，
插件订阅额度只经 `get_subscription_usage` 的既有字段白名单投影，不返回登录邮箱、CLI 目录、内部账号指纹或凭证。
历史视图包含成员/分享标识、日期、模型、token、估算费用及中转设备名；组视图包含设备/供应商显示名、可见 ownerName、
运行与组配置，原本可见的 reshare 还含受邀者显示名/头像/批准状态，保留分享来源的匿名边界；具体字段见作者手册。
插件返回的当前成员与配置快照 `providerName` 中，宿主生成的品牌加登录身份只保留品牌；不修改原组视图或 Agent/UI 名称。
原截断标记 coverageStart、当天累积、缺失/未知和错误语义保持，旧端不认识工具/命令时明确不支持，不退回本机/零数据。
插件 Host 调用签名、manifest、receipt、自建中转透传及原 UI/Agent 命令保持，不涉及迁移。

`usage`（2026-11-16）为独立只读组，经原 `cindy.host.call` / `host-tool-request` 调用
`cindy_helper.get_subscription_usage({providerId?})`。不改已有消息签名、receipt 或数据存储布局；
不声明该组的旧插件权限不变，扩权更新走既有安装确认。该额度工具只读执行电脑当前 owner 的本机订阅账号，
账号、套餐、窗口和时间通过字段白名单投影，不返回原生目录、邮箱、身份摘要或凭证。
旧宿主将新组保留为未知声明且不提供工具，调用者须按不支持处理；未接入额度服务的 Node Host
同样不宣称可用。未新增 Device Link channel / payload；官方和自建中转仍透传既有插件消息，
本次不经过远程账号额度路径，不需要中转适配。结果与缓存约定见
[作者手册](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-host-tools.md#读取订阅用量)。

`terminal` 新增同一 helper registry 的 `terminal_start/list/read/write/resize/stop/forget`，不改 Host 调用签名。
整体安装批准有效、启用且已声明新组即可调用；旧 receipt 的分项字段读到即忽略，未知组不提供实现。终端输出用 Host 随机进程代次及
非消费游标续读，缺口显式 `resetRequired`；执行电脑不支持或重启后记录丢失时报告失败，不重放命令。
托管作业按调用方最多同时运行 10 个（包括启动和停止中），超出返回 `TERMINAL_JOB_LIMIT`，
`data.current/limit` 说明数量和上限；不排队、不终止已有作业。输出在运行中最多 256 KiB、
终态最多 16 KiB；每个调用方保留最近 100 条终态记录，在退出时按结束顺序回收，不新增定时器。
界面直接创建的终端沿用原生命周期，不受上述托管作业配额影响。
任务托管作业仅订阅其真实 Session 实例的关闭状态，关闭时复用 ProcessOwner destroyed 的 PTY 释放链。
释放或替换作用域时移除订阅，旧实例关闭不影响同任务 id 的新实例；普通轮次结束与客户端断开不回收。
Node Host 与桌面控制端沿用上述工具签名、manifest 和 receipt。loopback SSE 客户端通过
`protocol=2&confirmations=1` 显式协商不回放的 `host_prompt` 帧；只有现有四种插件确认请求/
撤回 channel 可用，不占用或推进任务事件序号。旧客户端不协商就不投递此类帧；旧 Host
忽略额外 query，任务事件流保持原行为。回答沿用同名 preload 契约，经已认证控制端绑定
到原窗口确认桥；断线取消，不重试写操作。不改变 device-link 或自建中转 wire payload。
新增确认 SSE writer 在发送积压超过 1 MiB，或 `write` 返回 false 且未排空时按无法送达
拒绝本次确认；不排队、不重试、不关闭其它客户端，原任务事件流不变。
Node Host 的本机 `history` 查询增量接入相同回调和 owner 数据库，沿用原工具参数、分页、
错误与来源范围。任务动作的输入快照与确认复用共享实现，不新增身份字段、任务副本或批准记录。
Node Host 未装配的服务返回 MCP `UNSUPPORTED_CAPABILITY`，附当前执行环境不支持的说明；当前包括生产调度器。
Desktop 原有暂未就绪场景仍返回 `HOST_NOT_READY`。不新增调用字段，也不改变旧宿主返回值。
Node Host 的 browser 平台 provider 同时供 Agent 与插件使用，保留原后端与客户端门禁。
插件 computer 的安装归属与调用生命周期尚未接入 Node 平台桥，在创建 runtime 前返回
`UNSUPPORTED_CAPABILITY`；插件能力发现也标为 unsupported，不创建跨调用观察快照。
不信任转发的 caller 元数据，不新增授权证明；Node Agent、Desktop 插件的电脑路径不变。
插件调用选中 `rsb-webview` 时返回既有 `BROWSER_RUNTIME_ACTION_FAILED`，不借界面焦点归属；专用浏览器、我的浏览器及原 Agent/UI 不变。

`storage` 增量复用整体安装批准、声明与 `storage_request` 工具通道，支持 providers/targets/call/share；
不新增管子、device-link 或 relay 字段。跨插件只交付原 handoff 副本，同账号本机、同组织且身份已确认，
不追加分享确认，仍复核具体源内容、目标与摘要。旧 receipt 分项批准字段读到即忽略，原存储布局与已有 API 不变。
handoff 新接口的分块读返回 base64/nextOffset/sha256，旧页面与原网络上传仍按旧通道读取同一份副本。
browser/computer/ssh/docs 增量扩展现有组和 server 准入，复用原 MCP registry 参数与业务校验；插件不套用 Agent 风险审批，Agent 仍走自身流程。
不改变 host.call、host-tool-request 或 HostToolCaller 签名，不新增跨端字段。文档路径根为插件私有目录。
服务提供者继续使用 browserExtension.pageControl 原声明与详情页选择，不改变扩展 wire 协议。
discovery/host_services 继续用相同 helper 调用，增量返回本机服务目录及本插件声明布尔值，不提供独立 approved 状态；
不增加跨端消息或批准字段，旧宿主不支持时按原工具错误处理。目录不授予执行或插件管理权。
服务依赖继续使用已存在的 agent.hostTools；资源退出只接回原运行时生命周期，不新增 manifest、receipt、
setup 或远程字段。停止、崩溃与换版后的电脑连接/快照失效，旧插件其余能力和持久数据不要求重新配置。

## usage 组范围扩展的维护确认

`usage` 已随 [v0.1.138-beta](https://github.com/makecindy/cindy/releases/tag/v0.1.138-beta)（2026-11-17T03:18:31Z）及
[v0.1.139-beta](https://github.com/makecindy/cindy/releases/tag/v0.1.139-beta)（2026-11-17T06:45:56Z）发布。
此前仅核验 v0.1.137 / v0.1.137-beta 不含引入提交，不能据此断言该组未进入任何已发布版本。
旧 beta 安装说明只包含本机订阅用量，排除其它电脑；本次新增读取扩大了已批准 `usage` 插件可访问的数据面。
本次沿用整组安装批准，不增加版本化批准或新声明项；合入前须维护者按
[#10794 的选项 c](https://github.com/makecindy/cindy/pull/10794#discussion_r4596363525)
明确确认接受 beta 存量批准随宿主升级获得这两个读取，并在该线程记录确认。不能以安装说明已更新代替这项取舍。
随包作者手册只记录能力与授权契约，不记录发布状态。
