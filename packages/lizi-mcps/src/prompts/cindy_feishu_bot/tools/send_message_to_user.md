通过已配置的飞书 / Lark bot 给当前用户(bot 归属人)发一条 markdown 消息。chatId 由 session 上下文自动注入,**不要也不能**作为参数传 —— 你只关心"发什么"。

**接收人语义**:优先发到当前 session 归属的 IM 聊天(在飞书或 Lark 里私聊 bot 触发的 session);若当前不是该 IM session(例如桌面端 chat 里 agent 被要求跑长任务并通过飞书或 Lark 通知用户),自动回落到 bot 首次被私聊时 TOFU 记录的 owner —— 也就是"这台机器上登录使用 bot 的那个人"。两条路径最终都发到用户私聊 bot 的对话里,不会跑到其他任何人。

用途:

- **跨 session 通知**:用户在桌面端说"跑完之后通过飞书或 Lark 通知我" —— 用这个,收尾时发一条汇总到对应 IM 的 DM。
- **长任务进度汇报**:关键节点给用户"喘口气"式提示("已经跑完 3/10 步,估计还有 5 分钟")。
- **中间结果推送**:重要链接 / 检查项 / 阶段性产出,不必等最终一次性 dump。

**不适合的场景**:

- 在**飞书 / Lark session** 里发最终回复不用这个工具 —— agent 收尾会话走原生流式通道自动回到当前 IM,再用这个工具发一遍等于让用户收两条几乎一样的消息。
- 短确认(比如"收到"、"好的")—— 没意义的噪音,不发就是不发。
- 不要用它做 UI 交互(问用户选择、确认)—— 那个走另外的通路。
- 用户没明确说"通知我"或类似意图时,不要自作主张主动发消息骚扰用户。

参数:

- `text` (必填):markdown 正文。飞书 / Lark lark_md 语法支持 `**bold**` / `_italic_` / `` `code` `` / 链接 / 有序 / 无序列表 / `>` 引用 / `#` 标题。URL 会自动识别成链接。长度硬上限 30000 字符,超出时 schema 校验失败返回 `INVALID_ARGS`(含 `validation_errors`)。空字符串或纯空白返回 `EMPTY_TEXT`。

行为:

- 一次性发送,不流式(想流式请等最终 assistant 回复走原生通道)。
- 底层走 OpenAPI `im.v1.messages.create` 的 `interactive` 卡片消息,一张 body-only 极简卡片,视觉上跟纯文本消息接近但 markdown 会渲染。
- 发送成功返回 `{ ok: true, messageId }`,`messageId` 可用于后续引用(目前无 reply-to 工具,预留)。

错误码:

- `NO_CHAT_CONTEXT` —— 既不在飞书 / Lark session,bot 又没有绑定过 owner(用户从未私聊过 bot)。**告诉用户**:"我目前无法通过飞书或 Lark 通知你,请先在已配置的 IM 服务里私聊机器人发一条消息完成绑定,之后再让我重试。" 不要自己重试。
- `EMPTY_TEXT` —— text 为空或纯空白,不发
- `INVALID_ARGS` —— schema 校验失败(含 `validation_errors`);最常见原因是 text 超过 30000 字符,截断后重试
- `SEND_FAILED` —— 网络 / 权限 / SDK 错误,返回 raw 错误信息;可视具体错误决定是否重试(rate-limit 类等一秒再试;auth 类不要重试)

成功后你可以简短确认一下"已经发给你了"就够了,不要复读整段 markdown。
