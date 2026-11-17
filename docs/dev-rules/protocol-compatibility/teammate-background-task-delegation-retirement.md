# 伙伴后台任务（委派）退役

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

V2 伙伴用普通 `send_to_session` 开任务，V1 委派工具、服务与回调已移除（产品规则见
[伙伴运行时](../../product-rules/cindy-bots-runtime.md) §6.1）。线协议与存储兼容：

- `bot_delegations` 表、历史 migration 与消息里的 `botCollaboration` 标记都不改；不再写入新行。
- `maker:bot-delegations:list` 保留（本机 IPC 与 device-link 白名单），新 Host 只读应答旧行，
  形状与 `projectRemoteBotDelegations` 投影不变；`pendingInteraction` 恒为 null，未落终态的旧行
  保持存储状态。名册的创建来源与「一眼」产出继续读它，旧控制端也照常读取。
- `maker:bot-delegation:cancel` 保留在白名单，新 Host 对旧控制端稳定返回
  `{ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' }`；本机专用的 `maker:bot-delegation:note-trace`
  已删除（从未进入白名单）。新 Host 不再推送 `maker:bot-delegation:changed`，推送白名单与 topic
  映射保留，新控制端继续响应旧 Host 的该推送。
- 新控制端连旧 Host：照常读取旧 Host 的实时行，只是不再提供停止与补一句；未知字段与旧形状按
  只读卡片渲染，读取失败保持已有卡片并标记过期。
- 伙伴引用快照的 `activeDelegations` 字段保留并恒为 0，旧读取端按原校验通过；模型可见文本不再
  包含 `active_tracked_tasks`。
- 升级前排队、尚未派发的委派输入（clientId 前缀 `bot-delegation-start` / `-resume` / `-unpause`
  / `-interject`）在冷队列恢复时丢弃，不会在无人回传时自行开跑；完成回执输入照常投递。

不增加 IPC channel、权限、服务端字段或数据库迁移。
