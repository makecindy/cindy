# 官方飞书 / Lark 渠道的协议增量（2026-11-04）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

两仓 `slack-hook-protocol` 同步追加，全部是可选新增：

- `HOOK_PROVIDERS` 追加 `'feishu'`（飞书与 Lark 共用），能力位 `provider:feishu`。与 Telegram／X
  相同，由服务端 welcome 宣告、桌面 hello 声明，双方都有才启用。
- `provider.bind.update`／`state` 新增可选 `bindCode`：一次性短关联码（4–32 位大写字母或数字，
  可含中间连字符），只允许在 `pending` 时非空，缺省等同 `null`；新增 UI 动作提示 `copy_bind_code`。
  `pending` 仍要求 `connectUrl`（飞书为网页授权地址），关联码只是网页授权不可用时的兜底。
- `query.request` 新增可选 `recipient = { scopeId, principalId }`：多个组织共用的服务（官方飞书）发出的查询
  代表哪个应用的哪个账号；带上时两项都须是非空字符串。其它服务不发，旧桌面端忽略。
- 客户端端点清单新增 `feishuHookWsUrl`（`wss:`），登记为跨区域端点：服务只在海外部署一套，
  两份区域清单都指向 `cindy.app`。服务部署并核验后，在两份正式清单同时填写并发布该字段；
  缺省或清空后，重启读取新清单会停止连接；未开启的用户不显示入口，已开启的用户保留卡片并提示
  地址未配置，以便关闭，可用于回滚。dev 使用独立开发服务，配置与发布步骤见
  [端点清单说明](../../../config/README.md)。

飞书群上下文由服务端组装进 `task.dispatch.prompt`（含 `<thread_context>`、引用与当前发言人）；`source.threadContext` 同时供来源卡展示，客户端继续保留服务端完整 prompt，不再从展示元数据重复注入。X 的客户端 prompt 组装只作用于 X，不能据此推断其它渠道丢失上下文。

多设备（2026-11-07）：同一应用下，同一飞书账号可同时保留多个设备的 `confirmed` 绑定；新绑定默认成为工作电脑，重连不改变选择。工作电脑通过机器人菜单 `device` / `/device` 或已绑定电脑的「设为工作电脑」按钮选择，绑定成功后机器人私聊说明用法。服务端内部会话代次、工作目录与偏好按设备绑定隔离，外部 lane 格式仍相同（设备各自存本地任务）。选择仅影响后续消息，运行中任务沿原设备继续；离线 / 繁忙时拒绝，不改派、不补发。`superseded/rebound` 仅表示同一设备的旧账号绑定被替换；其它电脑的绑定不失效。桌面解绑只影响本机。

桌面选择是可选增量：本机 `confirmed` 快照的 `actions` 提供 `select_device` 时，客户端才显示按钮。客户端发 `provider.bind.select { requestId, provider, bindingId }`，服务端按已认证连接的设备核对本机绑定、应用和归属，回 `provider.bind.selection { requestId, provider, bindingId, ok }`；只有匹配的成功回执才能提示「已设为工作电脑」。请求不能创建绑定，不改变其它电脑的绑定状态；服务端从收到请求起限制处理时间，不依赖客户端时钟。断线、解绑、切账号及超时让在途请求失败，不补发。旧服务端不提供动作时隐藏按钮；客户端不缓存可能被其它设备切换而过时的「当前工作电脑」标签。

客户端接线：desktop 的飞书线 hello 的基础能力是 `provider-bind-v1`、`provider-prefs-v1` 与 `provider:feishu`
（不声明 `telegram-*`；电脑排版的可选能力见[「官方飞书 / Lark 由电脑排版」](official-feishu-lark-desktop-layout.md)），welcome 同样须含这三项才启用。不声明 `session-picker-v1`：飞书服务由多个组织
共用；会话列表查询要双方都声明才回答，服务端单方面宣告不算。飞书线的工作目录 / 模型查询必须带 `recipient`，且与
这条连接上服务端确认过的绑定（`scopeId` / `principalId`，等到绑定快照之后）一致才回答，否则回 `ok:false`。`pending` 的
`connectUrl` 与 `remediationUrl` 在进入设置页快照前按飞书 / Lark 精确主机白名单校验（`feishuDeepLink.ts`），且授权页 `client_id` 必须与当前宣告的 `scopeId` 一致；不一致时转为 `failed/invalid-connect-url`，清除链接与关联码，不向 Renderer 暴露或自动打开；
「打开机器人」的 AppLink 还须指向绑定的应用（`appId` 等于 `scopeId`），否则连同 `open_provider` 一起去掉。

兼容：旧校验器不读取 `bindCode`；不认识 `feishu` 的旧端按未知 provider 拒绝该帧但不断连，也不会
协商到 `provider:feishu`；新客户端连旧服务端收不到飞书帧，连不发 `recipient` 的旧飞书服务端时 `/project`、`/model`
查询失败（两端都未发布，飞书服务端须先于客户端上线）。客户端里协议渠道值进入本地类型的
回调（`onHookReadyForPrefsMirror`）按客户端支持集收窄。没有服务端部署、数据库、环境变量、
Device Link 或自建中转变化；协议包改动会触发服务端全部服务的 CI。
