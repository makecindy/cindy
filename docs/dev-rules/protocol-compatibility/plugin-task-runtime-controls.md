# 任务运行时插件控制点（未发布）

`subscribe.hooks` 追加 `will-start-turn`、`will-model-request`；管子裁决追加
`transform` 和 `request`（供应商 JSON 正文），`route` 在这两个新节点支持 `fastMode`。
旧节点及旧插件行为保持不变；未知 hook 仍原样保留且不自动授权。安装／更新确认的新节点
沿用 `approvedControlPoints`，不新增 grant、授权账本或申请状态。

新增本机任务设置 IPC `maker:runtime-plugins`，任务选择保存在账号独立的
`runtime-plugin-prefs.json`，不改数据库 schema。未选择时无插件调用；选择不写入新任务草稿、
不自动继承到分叉任务，不进 device-link allowlist。手机／另一台电脑的设置入口暂不支持，
执行电脑仍在统一发送入口应用其已保存的选择。官方及自建中转无新帧、relay 或服务端改动。
现有任务列表／更新投影附带可选 `runtimePluginsSelected` 布尔值，由同一设置缓存派生，
不新增持久状态或 IPC 请求／通道；保存后复用 `sessions:patched` 通知更新，旧端忽略该字段。
菜单仅在已装插件声明运行能力或任务仍有已选项时出现；关闭的列表行不订阅插件清单。
逐请求控制只支持本机 Pi；Claude Code、Codex、SSH／设备托管 Pi 明确不支持。
Pi 通过进程内 Symbol 接收宿主回调，能力不从 Renderer／远程 JSON 选项取得。
发送接入范围仅限 App 内正常发起的新轮次，沿原有任务选模／重读／启动流程应用选择，
再把逐请求回调交给本机 Pi。个人 IM、官方 hook 与同轮插话保持原流程，不询问轮前／资料
提供者，不通过这些入口装配或更新静态片段、安装逐请求回调。已有 App 轮次内的 Pi 请求
控制继续沿用该轮预算，已有会话内容不会因入口变化被清空；渠道队列、取消与授权逻辑不变。
上下文提供者只收到当前消息原文，不接收引用历史、引擎交接、计划对账或目标说明；返回
资料追加到最终引擎消息。Desktop 复用既有原文凭据隔离插件资料与用户授权，保留原附件边界。
Pi 在完整正文进入宿主私有 RPC 前核对 JSON 转义后的 16 Mi 字符帧预算；超限只交接
有界错误标识，由宿主沿同一任务出错策略继续、跳过或失败，不发送截断正文，不放宽通道上限。

同一任务设置追加 `will-compose-context` 和 `will-search-memory`。管子返回分别为
`context + blocks[{id,text}]`、`memories + entries[{id,title,content,type?}]`，旧宿主忽略未知
节点，不会自动批准。资料只进入普通消息资料通道；现有 `memory_search` 的 hits 可追加
内联条目与 `sourcePlugin:{id,name}`，不改变原有本地命中形状，不加新工具。失败时返回原结果。
`memory_search` 是共享工具，按任务选择和原有记忆开关调用提供者，不受发送入口限定。
资料、记忆只在原执行电脑按任务选择调用，仍无 device-link／relay／服务端或数据库变更。

清单新增可选 `systemPrompt` 静态数组与 `system-prompt` 权限标识；该标识不接受
`subscribe.hooks` 声明，不调用插件逻辑。旧插件无字段时保持原样，历史未知同名字段不合法
时仅忽略新能力；没有旧批准记录的片段不会在升级后自动生效。内容、顺序、范围的更新进入
现有安装权限差异确认。任务未选择时不改变系统提示词字节。Claude Code／Codex 复用既有
任务级系统指令通道，本机／SSH Pi 用进程内 Symbol 与原生扩展追加尾段；Symbol 不序列化，
设备托管 Pi 明确不支持。无新远程帧、relay、服务端接口或迁移要求。

## 等待与结果预算

仅四个新增节点采用新时限：`will-start-turn` 1000ms、`will-compose-context` 2000ms、
`will-search-memory` 1500ms；`will-model-request` 每次请求的 select＋payload 共用 1000ms。
选模和正文变换串行，资料／记忆提供者并行收集，按任务选择顺序归并。旧节点时限不变。

App 普通消息准备入口为 turn/context/model 三点建立每轮 5000ms 插件等待预算，工具续轮和逐请求调用不重置；同轮插话不另行询问提供者或建立预算。
单点 deadline 取节点时限、每轮余额、该次请求余额的最小值；并行重叠等待按墙钟计一次。
只统计插件等待（含插件按需唤醒），`readRoute`、`applyRoute`、Agent 进程恢复等宿主工作、
模型请求和工具执行不计入。耗尽后不再调用余下插件，沿各插件任务 `onFailure` 处理。
共享 memory_search 不参与 App 每轮累计预算，每次检索的提供者等待独立最多 1500ms，固定
allow-on-failure。一个 App 轮的插件总等待不包含记忆，每次额外检索最多再加 1500ms。
未选择任务同步短路，不分配预算或定时器。

插件记忆按选择顺序填充，全局最多 50 条且 `content` 合计不超过 32768 字符；
超出后截断并在原 `memory_search` 的 `data` 增加可选 `truncated: true`，被截短的插件
命中也带同名可选标记。旧消费者忽略该字段，原有 Cindy 命中形状和总 limit 不变。
普通附带资料装配（包括来源 JSON 与分隔符）合计不超过 32768 字符，静态系统片段装配
沿用同一 32768 字符预算；正文处理返回的请求 JSON 序列化后上限仍为 1048576 字符。
