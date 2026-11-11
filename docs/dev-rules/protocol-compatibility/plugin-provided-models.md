# 插件提供的模型（2026-11-01）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

清单新增可选 `models: { types }`，只声明能力；旧 Host 把它当未知字段保留，不授权也不阻止安装。列表由插件经
`PUT /models` 运行时发布，Host 校验后存到 `ghost-published-models`，选择器只读这份记录，不调用插件。不认识的
`target.type` 跳过该项，其余照常显示，所以新版插件在旧一点的 Host 上仍可用支持的模型。

插件 `event-verdict` 新增 `action: 'route'` 与 `route: { agentKind, model, providerId, effort?, agentDeviceId? }`，只在控制节点
`will-start-task` 生效；询问数据带 `modelId`（用户选的已发布模型）。旧 Host 丢弃不认识的 action，插件按超时处理
（沿用原模型）。新增本机专用 IPC `ghosts:models:list` 与 `ghosts:start-task:route`，不进 device-link allowlist。
新任务草稿（本机 `localStorage`）新增 `pluginModel: { pluginId, modelId } | null`，只在本机草稿使用，不同步、
不上传；远程电脑、SSH 主机、多 Agent 协同草稿不提供。`route` 模型不进执行目录：定时任务、伙伴、协同 worker 和
Mobile 看到的仍只有真实模型。首条消息后写一条空正文 assistant 消息，
`agentMeta.pluginModelRoute = { pluginName, outcome: 'routed' | 'kept', modelName, effort?, reason?, why? }`，
Desktop 与 Mobile 渲染为系统说明行；旧端没有对应渲染，按普通的空 assistant 消息处理；历史投影不计入正文。
