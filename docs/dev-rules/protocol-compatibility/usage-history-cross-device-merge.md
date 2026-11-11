# 用量历史跨设备合并

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增只读 invoke `maker:usage:device-rows`（Desktop ↔ Desktop，已登记 allowlist）。请求可选
`{ sinceDay: 'YYYY-MM-DD' }`；被控端回 `{ format: 'usage-device-rows-v1', todayKey, sinceDay,
rowsGz }`，`rowsGz` 为本机 `daily_spend` / `daily_model_usage` / `daily_session_usage` 原始行
及全部记过用量任务的当前标题、模型、供应商、上下文与最后活跃时间 JSON 的 gzip + base64
（任务元数据不分增量区间，每次都是完整集合，控制端整体覆盖；不在集合里的任务连同旧行丢弃）。
任务元数据与 `local-db:sessions:list` 走同一远端 Bot 可见性判据，隐藏伙伴的任务及其行不外发；
压缩后仍超帧预算回 `{ format, oversize: true }`。只含按天 × 模型、按天 × 任务的 token 与金额及任务展示元数据，不含消息内容或凭证；handler 无 sender 依赖、无副作用。控制端按账号缓存每台电脑最近一次读到的行，
增量从缓存 `todayKey` 前一天起拉；被控端回的 `sinceDay` 与请求不一致时按全量替换。
新增端到端可选能力 `background-link-v1`（`DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1`，link-open 与
link-accept 双向声明，不改 relay）。Desktop 控制端在本机没有订阅对端任何 topic 时建链即声明
（`apps/desktop/src/main/device-link/backgroundLink.ts`，所有建链与自动重开入口共用这一判据）；新被控端
见到后不装 legacy `'*'`，不亮被控横幅、不转发推送、不挡无人值守更新重启，控制端之后显式 subscribe
照常生效。旧被控端忽略该能力、照旧装 legacy `'*'`，所以用量读取走 `remoteBackgroundInvoke`：
0.1.93 及更早的正式版或版本未知的电脑不建链；新建链路时对端未在 link-accept 声明支持，且本机仍无订阅，
就立即关闭这条链路并按需要更新处理，同一版本不再重试。已就绪的链路直接复用。
旧控制端与 Mobile 不声明该能力，行为不变。
旧被控端回 `CHANNEL_NOT_ALLOWED`，控制端把该电脑标为需要更新，不影响其它电脑；旧控制端
不调用新通道，行为不变。手机不参与读取，也未新增入口。本机 `maker:usage:history` 仍只对
受信 renderer 开放。不改 relay、帧限制或服务器权限，服务端无需改动。实现见
`apps/desktop/src/main/usage/usageDeviceRows.ts` 与 `peerUsageSync.ts`。
