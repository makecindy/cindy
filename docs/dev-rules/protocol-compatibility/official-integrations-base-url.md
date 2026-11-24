# 三方应用集成服务的统一地址与已开启应用列表（2026-11-24，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 服务端契约正本是服务端仓 `docs/telegram-hook-server.md`「服务定位与域名」一节。

三方应用集成服务目前由 telegram-hook-server 承载官方 Telegram 与 Discord，计划改名为
`integrations-server`。它在端点清单里只有一个字段，以后新增三方应用不再加清单字段：

- `integrationsBaseUrl`（`https:`；dev 本地文件可用 `http:`），登记为跨区域端点。cn 与 global 两份正式
  清单都填 `https://telegram-hook.cindy.app`；新域名 `integrations.cindy.app` 实测可用后只改这个值。
  客户端按路径派生：Telegram 连接 `wss://<主机>/telegram`，Discord 连接 `wss://<主机>/discord`，
  群历史图片 `POST https://<主机>/telegram/group-image`。
- 服务端新增 `GET /integrations`：公开、无需鉴权，返回 `{ "integrations": ["telegram", "discord"] }`，
  只按服务端开关决定。桌面在注册 hook-control IPC 时读一次（端点清单此前已解析）；网络错误、非 2xx
  或格式不对时按 30 秒、2 分钟、10 分钟最多再试三次，之后等下次启动，不轮询。本版本不认识的值忽略；
  404（服务端还没有这个接口）按只有 Telegram 处理。
- 列表只决定尚未开启的用户能否看到入口：服务端没列出的应用，快照里的 `url` 置空，设置页因此不显示
  卡片。已开启的用户始终保留卡片，以便关闭；连接地址始终由 `integrationsBaseUrl` 派生，读取失败不影响
  已有连接。

兼容与发布顺序：

- 更早的桌面端继续读旧字段：没有官方 Discord 的版本读 `telegramHookWsUrl`（连根路径）；带官方 Discord
  卡片（[官方 Discord 渠道](official-discord-channel.md)）但还没有本能力的版本，另读 `discordHookWsUrl`，
  只在它非空时显示 Discord 入口。两份正式清单保留这两个字段，服务端继续接受根路径的 Telegram 连接和
  `/discord`；这些版本按未知字段忽略 `integrationsBaseUrl`。
- 新客户端不再读这两个旧字段。发布新客户端前，两份线上清单必须已有 `integrationsBaseUrl`，否则新版本的
  官方 Telegram 与 Discord 会显示地址未配置。
- 服务端与新客户端的发布先后不限：部署前的服务端在任意路径接受 Telegram 连接，`/integrations` 返回 404
  时客户端按只有 Telegram 处理。
- 不涉及 hook 帧协议、数据库 migration、环境变量、Device Link 或自建中转。

实现与回归：客户端 `packages/maker-shared/src/{clientEndpointSchema,clientEndpointOrigins}.ts`，
`apps/desktop/src/main/hook-control/{integrationsDirectory,ipc,manager,groupImageBridge}.ts`，
`hook-control/__tests__/{integrations,transport-manager}.test.ts` 与 `__tests__/endpointManifestCache.test.ts`；
服务端 `telegram-hook-server/src/integrationsHttp.ts`，`__tests__/{integrationsHttp,server}.test.ts`。
