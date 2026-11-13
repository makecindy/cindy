# 插件宿主工具的平台服务

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件记录对应能力的增量协议与旧端降级。

`terminal` 新增同一 helper registry 的 `terminal_start/list/read/write/resize/stop/forget`，不改 Host 调用签名。
新组仍须显式批准；旧 receipt 和未知字段不自动授予执行命令权限。终端输出用 Host 随机进程代次及
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
插件 computer 调用因缺少可跨进程复核的 Desktop 逐次批准身份，在创建 runtime 和确认前返回
`UNSUPPORTED_CAPABILITY`；插件能力发现也标为 unsupported，不创建跨调用观察快照。
不信任转发的 caller 元数据，不新增授权证明；Node Agent、Desktop 插件的电脑路径不变。
插件调用选中 `rsb-webview` 时返回既有 `BROWSER_RUNTIME_ACTION_FAILED`，不借界面焦点归属；专用浏览器、我的浏览器及原 Agent/UI 不变。

`storage` 增量复用相同组批准与 `storage_request` 工具通道，支持 providers/targets/call/share；
不新增管子、device-link 或 relay 字段。跨插件只交付原 handoff 副本，同账号本机、同组织且身份已确认，
可信确认和摘要复核不接受插件自报批准。新增组不把历史未知字符串变成批准事实，原存储布局与已有 API 不变。
handoff 新接口的分块读返回 base64/nextOffset/sha256，旧页面与原网络上传仍按旧通道读取同一份副本。
browser/computer/ssh/docs 增量扩展现有组和 server 准入，复用原 MCP registry 校验和风险规则；
不改变 host.call、host-tool-request 或 HostToolCaller 签名，不新增跨端字段。文档路径根为插件私有目录。
服务提供者继续使用 browserExtension.pageControl 原声明与详情页选择，不改变扩展 wire 协议。
discovery/host_services 继续用相同 helper 调用，增量返回本机服务目录及本插件声明/批准布尔值；
不增加跨端消息或批准字段，旧宿主不支持时按原工具错误处理。目录不授予执行或插件管理权。
服务依赖继续使用已存在的 agent.hostTools；资源退出只接回原运行时生命周期，不新增 manifest、receipt、
setup 或远程字段。停止、崩溃与换版后的电脑连接/快照失效，旧插件其余能力和持久数据不要求重新配置。
