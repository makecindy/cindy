# 异步问题主动撤回（2026-11-10）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

三种 Harness 共用直接发现的 `cindy_helper.manage_user_questions`（Pi 同名直接工具）：
`list` 返回当前任务逐题 request_id、题干和 pending／answer_in_flight；`withdraw` 必须给
精确 ID 与用户语言的原因，返回逐题 withdrawn／not_pending／answer_in_flight。仅当前活跃
Session 实例的已证实根代理可调用；不提供通用 call_tool 别名，不涉及同步问题或权限审批。
既有 `interaction_dismissed` 增加 `reason=question_withdrawn` 和可选 `withdrawalReason`；
持久化沿用 `status=cancelled`，只增加同名原因字段，无 schema migration。旧查看端仍按
cancelled 处理，新端显示「无需再回答」及原因；当前正在编辑的本地草稿保留为补充发送入口。
撤回不发送输入、不重开任务；已进入提交的答案优先。手机复用已确认撤卡的旧快照抑制。
结束、超时不自动撤题；模型根据工具说明审查是否仍有价值，明确撤回已过时问题。

共享 `ask_user_question_async` 的回执保持 request_id／status，增补逐题
`questions: [{request_id, question}]` 和当前 `pending_count`，旧消费者可忽略。
撤回仍须显式 request_ids；漏传不等于撤回全部。Codex 原生回执不改，可先 list 获取逐题 ID。
清题来源由宿主判断；自动输入不会撤题。`SUPERSEDE_ASYNC_QUESTIONS` 是进程内 Symbol，
不接受来自 Renderer／Device Link 的同名字符串参数，不新增跨端权限或协议字段。

撤回原因限制 200 字符。未答失效的历史行显示题干与「未回答」；手机须等权威 pending
快照后才判断持久 pending 行是否失效，未知状态保持隐藏，待答集合变化须使历史渲染缓存失效。
撤回后保留本端草稿，选项转为可编辑的补充文本，不再提供原选项、跳过等旧动作。
原轮次结束后才交付的回答在原回复格式外附带 `cindy_question_context`，提醒核对适用性与
不要重复已完成工作；运行中同轮回答不添加。该上下文不是用户新授权，不新增 RPC 字段。
