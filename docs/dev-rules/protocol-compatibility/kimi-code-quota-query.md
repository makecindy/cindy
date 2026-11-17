# Kimi Code 配额查询

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同账号 invoke 白名单新增 `maker:usage:kimi-coding`，请求只接受 `providerId`、可选 `agent`
及 `forceRefresh`，不接受端点或凭证。执行端通过现有凭证链查询固定官方 Coding 接口，
返回规范化的窗口比例、重置时间及查询状态；控制端再次校验字段。远程供应商目录新增可选
`kimiCodingUsageAgents` 展示能力数组，由宿主根据真实路由计算，执行地址仍被剥离；该字段
不参与宿主授权，实际查询仍按真实目录严格检查官方端点。不开放供应商分享、
共享任务或未连接设备权限，不改变推理请求及限额自动继续规则。
新控制端连接旧执行端时，该 channel 不受支持，界面显示查询不可用且不回退到本机账号。
旧控制端不发送此请求，新执行端的既有通道保持不变；无需 server、协议版本或数据库迁移。
查询失败只影响该连接的配额显示，不重启共享链路、不重放任务写操作；回滚即恢复不显示
Kimi 配额，用户已有登录及配置保留。

自建中转沿用 `packages/device-link-relay/src/hub.ts` 的通用 envelope 转发：
`invoke` 的 channel、args 与响应 payload 不由中转解析，因此此只读通道无需修改中转、
升级 `RELAY_VERSION` 或新增能力协商；旧中转也可转发，是否支持查询仍由执行端决定。
验证包括共享客户端与自建中转单测、`pnpm --filter @cindy/device-link-relay run interop`
的真实客户端加入／签名通信／重连，以及 Desktop 的 Kimi dispatch 回归；这些验证不替代
真实 Kimi 账号与两台实机的端到端验收。
