# 伙伴公开生成状态

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`SessionActivityPayload.workingPhase` 与 Remote Resource `display.generation`
（`phase` / `startedAt`）为可选、瞬时的公开生成类别，不包含 assistant 旁白、工具参数或推理。
生成结束、等待交互或失败时撤掉生成状态；头像连接状态仍由设备目录和连接层判断。
列表失效沿用 `maker:remote-resources:changed`，未打开聊天也能重读当前状态；不新增 relay
消息或权限。各端文案沿用已有 `working:<botId>/<phase>` 只读资源和宿主按轮次、语言共用的
润色缓存。未知类别显示本地通用生成文案；缺字段的旧主机仍走原有摘要/公开阶段回退。
旧控制端忽略新增字段，普通聊天不受影响。完整的列表状态一致性需主机和控制端均带此改动；
服务端无需升级，移动端无原生 fingerprint 变更。正文过滤仅影响伙伴视图，不删除持久消息。

`compacting` 是上述公开阶段的一员，由运行时 `Compacting...` / `Compacting context…`
状态触发，`compact_boundary` 或恢复生成结束它；不读取压缩摘要。该阶段使用客户端固定的
“正在整理对话…”本地化文案，不走模型润色，仍沿用原有文字切换节奏。
