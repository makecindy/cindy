# 群内能力提示（非执行终态）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

复用现有通用 card 消息合同，新增 `cindy.capability-notice` / `schemaRevision: 1`：data 只带固定 code（`GROUP_AUTHORIZATION_REQUIRED`、`GROUP_AUTHORIZATION_UNAVAILABLE`、`ATTACHMENTS_UNAVAILABLE`），fallback 为执行电脑本地化的完整可读提示。以伙伴 actor 发往原主群或话题；同执行 ID、epoch、类别复用同一稳定幂等 ID，并按既有消息 POST 合同放入 `operationId`（不发送本地 `clientId` 字段）；投递重试不创建执行、不结算模型轮次。

Desktop 和 Mobile 共用 shared parser，仅认可未删除的伙伴作者消息、单个完整 card、已知版本及白名单类别；普通人或未知／混合内容继续普通消息展示。Desktop 发往手机的既有消息视图可选追加 `capabilityNoticeCode`，手机 Remote Resource 解析仅保留未删除的伙伴 notice 上的白名单类别，content 保留 fallback，旧手机忽略新字段仍可读；手机直连自行投影，新手机连旧电脑仍用旧内容。旧桌面／手机直连把未知卡片显示为伙伴消息的 fallback，不丢失提示。

不改服务端接口、权限档、原生配置、schema 或数据库 migration。提示只有原因，没有原始工具参数、路径或错误正文。回滚客户端后沿用 fallback，不修改已有历史。
