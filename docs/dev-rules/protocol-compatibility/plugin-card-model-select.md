# 插件卡片的模型下拉框（`data-ghost-model-select`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

卡片净化器在有 `data-ghost-action` 的 `button` 上放行 `data-ghost-model-select`，值只留合格的
`PluginModelSelection` JSON，可再带 `agentDeviceId`（同账号其他电脑的 deviceId 或分享供应商的 `share:<id>`，不收 `local`）。renderer 的 `ghosts:card:action` 调用新增可选第 6 个参数 `modelSelection`；
主机核对该动作在已存卡片里确实声明了下拉框、模型当前可用（本机模型与 `cindy.pickModel` 同一判据；远程模型须是当前提供的位置、且在该位置可远程调用的目录里）后，在插件收到的
`card-action` 事件里多带 `modelSelection`。旧插件忽略该字段；旧客户端会丢掉这个属性、照常派发动作，插件按
`cindy.pickModel` 兜底。手机与 device-link 路径不带该字段，不改握手、relay、服务端或数据库。
回归入口：`cardSanitizer.test.ts`、`cardActionDispatch.test.ts`。
