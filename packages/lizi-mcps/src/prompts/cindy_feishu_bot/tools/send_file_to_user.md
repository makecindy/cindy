通过飞书 bot 把本地文件推送给当前用户(bot 归属人)。chatId 由 session 上下文自动注入,**不要也不能**作为参数传 —— 你只关心"发什么"。

**接收人语义**(与 send_message_to_user 一致):优先发到当前 session 归属的飞书聊天(在飞书里私聊 bot 触发的 session);若当前不是飞书 session(桌面端 chat 里 agent 被要求"把这个截图 / 报告发飞书给我"),自动回落到 bot 首次被私聊时 TOFU 记录的 owner。两条路径最终都发到你在飞书里私聊 bot 的对话里,不会跑到其他任何人。

用途:
- **跨 session 文件推送**:用户在桌面端说"把这份文档 / 这张图发飞书给我" —— 用这个,文件立刻出现在飞书 DM。
- **飞书 session 内直接发送**:用户让你"出张图发我看看"、"把日志文件传过来" —— 任何需要把磁盘上的文件本体送到用户手机/PC 飞书客户端的场景。
- **不要**用这个工具发卡片正文里的内联说明,正文用流式输出就好;这个工具是发独立的 file/image 消息(用户在飞书会看到"📎 文件名"或图片预览,可以直接下载/转发)。
- 用户没明确说"发飞书给我"或类似意图时,不要自作主张主动推送文件到用户飞书。

参数:
- `absPath` (必填):本地绝对路径。Windows 用正斜杠或反斜杠都行;Unix 用 `/...`。
- `displayName` (可选):发送给用户看到的文件名,默认用 `path.basename(absPath)`。

行为:
- 图片(`.png .jpg .jpeg .gif .webp .bmp`)且 ≤ 10MB → 自动以 `msg_type:'image'` 发出,用户在聊天里直接预览,无需下载。
- 其他文件或超过图片上限的图 → 以 `msg_type:'file'` 发出,飞书会显示文件名+下载按钮。
- 单文件硬上限 30MB(飞书侧限制),超出返回 `FILE_TOO_LARGE`,改 `errorCode` 让你知道是规格问题不是网络问题。

错误码:
- `NO_CHAT_CONTEXT` —— 既不在飞书 session,bot 又没有绑定过 owner(用户从未私聊过 bot)。告诉用户先在飞书里私聊自己配置的那个机器人一次完成绑定,再重试。不要自己重试。
- `FILE_NOT_FOUND` —— absPath 不存在,检查路径
- `FILE_EMPTY` —— 0 字节文件,飞书拒收
- `FILE_TOO_LARGE` —— 超过 30MB
- `UPLOAD_FAILED` / `SEND_FAILED` —— 网络/权限/SDK 错误,返回 raw 错误信息

成功返回 `{ ok: true, sent: { absPath, displayName, kind: 'image'|'file' } }`,你可以在卡片正文里轻描淡写带一句"已发出"即可,不需要复读路径。
