# OpenCode Go 配额查询（2026-11-04）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同账号只读 invoke 白名单新增 `maker:usage:opencode-go`，请求只接受 `providerId`、可选
`agent` 及 `forceRefresh`，不接受端点或凭证。执行端按真实路由只认官方
`https://opencode.ai/zen/go/v1`，执行地址对控制端剥离；返回规范化的滚动、每周、每月
窗口比例、重置时间及查询状态，控制端再次校验字段。不开放供应商分享、共享任务或未连接
设备权限，不改变推理请求、计费、凭据配置及限额自动继续规则。

新控制端连接旧执行端时该 channel 不受支持，返回 `CHANNEL_NOT_ALLOWED`，界面按查询
不可用处理且不回退到本机账号；旧控制端不发送此请求，新执行端的既有通道保持不变。
查询失败只影响该连接的配额显示，不重启共享链路、不重放任务写操作；无需 server、协议
版本、数据库迁移或新增能力协商。

自建中转沿用 `packages/device-link-relay/src/hub.ts` 的通用 envelope 转发：`invoke`
的 channel、args 与响应 payload 不由中转解析，因此无需修改中转内核、升级 `RELAY_VERSION`
或新增能力协商；旧中转也可转发，是否支持查询仍由执行端决定。验证包括共享客户端与
自建中转单测，以及 `pnpm --filter @cindy/device-link-relay run interop` 的真实客户端
加入／签名通信／重连；这些验证不替代真实 OpenCode Go 账号与两台实机的端到端验收。
