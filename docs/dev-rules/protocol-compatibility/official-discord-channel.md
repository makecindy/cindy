# 官方 Discord 渠道的协议增量（2026-11-23，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 服务端契约正本是服务端仓 `docs/telegram-hook-server.md`「官方 Discord 机器人（寄宿）」一节。

两仓 `slack-hook-protocol` 同步追加，全部是可选新增，不改既有字段语义：

- `HOOK_PROVIDERS` 末尾追加 `'discord'`，能力位 `HOOK_FEATURE_PROVIDER_DISCORD = 'provider:discord'`。
  与 Telegram／X／飞书相同，由服务端 welcome 宣告、桌面 hello 声明，双方都有才启用。
  两仓用相同的有效／无效 fixture 覆盖：`protocol-provider.test.ts` 的 discord 往返用例；
  原先拿 `'discord'` 当未知 provider 的拒收用例改用 `'matrix'`。
- 官方 Discord 不单独部署，寄宿在 telegram-hook-server 的独立 WebSocket 路径 `/discord`，
  独立连接表，与 Telegram 线互不顶替。服务端在 `/discord` 只宣告 `provider-bind-v1`、
  `provider-prefs-v1`、`provider:discord`；桌面 Discord 线 hello 也只声明这三项，welcome 须含全部三项
  才启用。不声明 `session-picker-v1`、`session-result-v1`、`turn-reopen-v1`、`msg-op-v1` 与任何
  `telegram-*`：进度、终稿、附件与 `interaction.request` 按钮都由服务端渲染；后台结果帧
  （`turn.end.background`）服务端直接丢弃，`backgroundResults` 不观察 `discord:` lane。
- 关联只靠一次性关联码：`provider.bind.update` 的 `pending` 带 `bindCode`（`XXXX-XXXX`）与
  `connectUrl = https://discord.com/oauth2/authorize?client_id=<应用 id>`（只用于添加应用，不含秘密），
  动作 `copy_bind_code`／`open_connect_url`／`copy_connect_url`／`cancel`。用户把码私信给机器人或执行
  `/bind code:<码>`。`scopeId` 是 Discord 应用 id（17–20 位 snowflake），`scopeName`、`remediationUrl` 恒为 null。
  `confirmed` 的动作为 `revoke`／`open_provider`／`add_to_group`。
- 任务：`task.dispatch.source.im = 'discord'`，`externalKey` 前缀 `discord:`
  （`discord:dm:<应用>:<用户>:g<代>`、`discord:ch:<应用>:<频道>:<用户>:g<代>`）；`/new` 发 `session.archive`。
  偏好经 `provider.prefs.*`，与 Telegram／X 同形。

客户端接线（`apps/desktop/src/main/hook-control`）：

- 端点清单新增 `discordHookWsUrl`（`wss:`），登记为跨区域端点；cn 与 global 两份正式清单都指向
  `wss://telegram-hook.cindy.app/discord`。缺省或清空时不显示入口，可用于回滚；dev 默认留空。
  见[端点清单说明](../../../config/README.md)。
- `manager.ts` 的 `discordConfig` lane。`pending` 的 `connectUrl` 进入设置页快照前按 `discordDeepLink.ts`
  精确校验（主机 `discord.com`、路径 `/oauth2/authorize`、唯一参数 `client_id`），且 `client_id` 必须等于
  `scopeId`；不合规转为 `failed/invalid-connect-url`，清除链接与关联码。「打开机器人」
  （`https://discord.com/users/<scopeId>`）与「添加到服务器」（`bot+applications.commands`，
  权限 274878024768，`integration_type=0`）由本机按 `scopeId` 生成，`scopeId` 不是 snowflake 时连同动作一起去掉；
  `shell.openExternal` 前由 `validateDiscordExternalUrl` 再校验一次。关联码才是主路径，所以本机发起关联后
  不自动打开 `connectUrl`（`autoOpenConnectUrl: false`），由用户点「添加到 Discord」。
- `task.dispatch` 只接本机当前已确认绑定的应用与 Discord 用户（`discordLaneIdentityOf`），冷启动的缓存绑定
  要等这条连接上服务端的绑定快照到了才作数，形状不对的 key 一律拒收。
- 安全边界：官方 Discord 与个人 Discord bot 共用 `source.im = 'discord'`。hook 路径把它映射成
  `{ kind: 'hook', source: 'discord' }`，不得落到个人 bot 的可信 `im` origin；新任务的 `sessions.source` 与
  `vendorOptions.source` 用 `discord-hook`，个人 bot 的 `'discord'` 行逻辑（「对话」分组回填、托管目录改写、
  渠道默认路由跟随、`cindy_discord` 的个人任务准入）都不会接管官方任务。模型说明为
  `buildHookPromptNote('discord')`，点名 Discord，并说明 `cindy_discord` 不是这条对话的出口。
- 项目与模型只读共用的那一份（`hook-control/sharedProjectPrefs.ts`），不等「并入」，也不吃服务端便签；
  Discord 没有 `/model` 卡，不是偏好镜像渠道，不读个人 Discord bot 的 `'discord'` 默认值。

兼容与发布顺序：旧桌面端不认识 `discord`，按未知 provider 拒绝该帧但不断连，也不会协商到
`provider:discord`；新桌面端连到未开启 Discord 的服务端时 `/discord` 返回 404，卡片只显示连接失败，
不影响其它渠道。服务端先发布（`DISCORD_ENABLED` 默认关闭），注入密钥、完成 Discord 开发者后台配置并确认
`/healthz` 的 `discordGateway` 为 `ready` 后，再发布填好 `discordHookWsUrl` 的线上清单与带官方 Discord 卡片的客户端。
客户端没有数据库 migration、新增环境变量、Device Link 或自建中转变化；`sessions.source` 新增的
`discord-hook` 是 SQLite text 列的新取值，不需要 schema 变更。

实现与回归：`discordDeepLink.ts`、`providerRouting.ts`、`manager.ts`、`session-runner.ts`、`outbound.ts`，
`__tests__/{discordDeepLink,transport-manager,session-runner,outbound,dispatcher}.test.ts`，设置页
`HookConnectionsSection.test.tsx`。
