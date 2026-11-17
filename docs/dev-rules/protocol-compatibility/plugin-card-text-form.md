# 插件卡片文本表单

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

交互卡沿用 v2，在净化后的 div 上可选增加 `data-ghost-form` 字段数组，动作可选增加
`data-ghost-submit="true"`。桌面与手机共用 maker-shared 校验和标准文本控件；
不开放插件脚本、HTML input、文件输入或凭据输入。字段名唯一，最多 16 项，每项值最多 16000 字。
桌面既有 dispatchCardAction IPC 可选追加 formValues；远程 `plugin-card-actions` 投影可选追加
form 和 items[].submit，既有 invoke 的 input 可选追加 formValues。手机声明 `plugin-card-forms`
能力后，Host 才投影表单并省略重复的静态预览；旧手机保留预览、禁用提交按钮。Host 继续校验会话、
设备、页面与 revision，并检查提交字段与当前声明一致；真实点击票和 Agent 续接规则不变。
表单提交活动归原 callId，插件完成后原地更新卡片，不产生新的空操作卡。

新查看端连接旧 Host 时没有 form，维持原卡片行为。旧查看端忽略新字段；旧桌面保留
插件提供的静态预览，新 Host 拒绝缺少字段的表单提交。插件也必须拒绝缺少 formValues
的写入，并说明需更新客户端或通过原工具继续处理。发布时先升级 Host 和查看端，再发布
依赖表单的插件；插件须保留原工具入口，不把卡片不可用误报为业务写入失败。
字段可选 row（同排分组）和 collapsed（默认折叠）。kind:"recipients" 为可选展示提示：
桌面和手机按实测姓名宽度与卡片宽度折叠剩余人数，展开直接替换摘要；完整地址字符串照常编辑与提交。
旧端忽略 kind 并保留原文本编辑框，未知 kind 也退回文本框，不影响已安装插件。div 可选 data-ghost-change 动作 ID，
桌面 IPC 与手机 input 可选 formChange:true，Host 投递无点击票的 card-action 编辑事件；不唤起 Agent。
手机编辑事件校验当前 changeAction、字段和会话归属；同一编辑版本的自动保存回执允许 revision 变化，
发送校验完整 revision，或同一 formKey（即当前 changeAction）与声明动作。插件必须在自动保存期间保持 changeAction，在重新读取/替换草稿时换 ID。
自动保存回执不重建输入框，不覆盖正在输入的文字。插件负责保存、冲突处理及模型读写与卡片提交的一致性。
发送聊天消息前等待该任务已发起的编辑事件送达，避免远程输入被模型工具超越。
card-update 可选 sourceCallId：只接受当前在途、同插件同任务的工具调用，用于更新较早的卡片；
旧调用、跨任务、跨插件和脚本调用不能重开。旧 Host 忽略此字段，可能不更新超出宽限窗的旧卡，业务工具仍返回回执。
card-update 可选 supersededBy：只能与 sourceCallId 同时出现且取值相同，表示这张旧卡已挪到当前调用的新卡。
Host 在净化后的 html 前加宿主标记 `data-cindy-superseded-by`（插件 html 带不进这个属性），落库并推送；
桌面隐藏整张旧卡及其工具行，远程 `plugin-card-actions` 投影可选追加 supersededBy、不再投影按钮并拒绝点击，
新手机据此隐藏。旧 Host 忽略此字段，旧手机忽略新字段，都显示这次更新的 html，所以插件应同时给一段
指向新位置的简短文字。卡片高度按实测内容显示，下限只挡非正数。
没有新 channel、服务端 schema、数据库迁移或 Mobile 原生 fingerprint 变化。

`ghosts:card-updated` 可选携带 Host 注册调用时确定的 `sessionId`，桌面实时卡匹配只使用
当前对话的推送，避免同插件在多个对话同时运行时串卡。旧 Host 缺此字段时不猜测归属，
等待工具结果里的明确卡片 ID；历史与 fork 的明确 ID 引用仍可显示。旧查看端忽略新增字段。
手机沿用按设备、对话和卡片 ID 获取资源的路径；没有新 channel 或插件作者契约。

公共邮件发送沿用 sending 状态，可选 pendingSend（deadline、label、cancelLabel、sendNowLabel）。
Host 仅在此等待阶段接受 mail:cancel / mail:now；动作不提交表单，草稿编辑锁定。
两端只显示倒计时，真正的 10 秒等待和发送由公共邮件 SDK 执行；同草稿重复请求共用一次等待。
撤销、重新读取或修改草稿取消等待，重启不会恢复自动发送。重启后点击旧倒计时的撤销或立即发送，
SDK 重新读取并恢复草稿；再次发送必须重新经过完整倒计时。旧端忽略 pendingSend，仍按 sending
锁定编辑；旧手机可能无法操作新增按钮，完整撤销交互需升级查看端。没有新 channel 或原生配置。
