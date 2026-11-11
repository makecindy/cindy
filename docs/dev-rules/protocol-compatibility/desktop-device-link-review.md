# Desktop 设备互联 Review

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

桌面控制端的 /review 通过 maker:review:start 请求被控 Desktop 执行。证据收集、Reviewer
任务创建、只读生命周期和 Review 卡片持久化始终发生在被控端；结果沿现有 session、message
和 maker:event 推送回控制端，不新增独立结果协议。该 channel 仅加入
packages/device-link 的 invoke allowlist，仍受控制租约、会话可见性和被控端 Review 输入
保护约束；SSH remoteHostId 不因此获得 Review 能力。

旧被控端不认识该 channel 时返回 CHANNEL_NOT_ALLOWED，控制端沿用 Review 失败提示，
不得回退到控制端本机执行。Review Reviewer session 的后续输入仍被远程 Review 外部输入门禁拒绝。
控制端先整批校验 Review 请求，再复用现有上传／被控端物化链路。控制端外部文件与内联
内容在上传前通过原生确认，文件只上传已授权的只读快照；被控端的工作区不授予控制端同名
路径的读取权。禁止把控制端本机路径当作被控端文件。被控端自身仍需本机确认的工作区外
成果不自动放行；确认尚无远控入口时返回权限错误。归属未解析的任务不启动 Review，只有
明确归属本机才调用本机入口；已知远端归属在重连期间仍沿用远端。写请求不新增自动重试，
90 秒超时仅作用于该请求，超时不代表被控端未创建 Reviewer，应先查看任务里的 Review 卡片。
