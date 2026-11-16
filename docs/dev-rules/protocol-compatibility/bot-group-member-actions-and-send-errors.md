# 伙伴群聊成员操作与发送错误（#5604–#5606）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`bot-group-chat` 数据追加可选 `supportsMemberRemoval`；仅为 true 时手机调用
`remove-member({ actorId })`，主机复用现有 Chat Server 单成员 remove 与管理权限校验。
成员投影中的 actorId/actorKind 在手机保留，真人不作为分工负责人/步骤候选；缺字段的
旧本地伙伴保持原行为。旧手机继续用 `set-members`，新主机只校验其中新增的本机伙伴，
不丢弃既有真人/外来伙伴 ID。新版手机连旧主机时不调用新动作，伙伴管理沿用旧入口；
真人移出需升级主机，不能用整份伙伴名单差分假报成功。

群错误仍以稳定码作为 Remote Resource 错误 message，新增附件、鉴权、群服务不可达、
历史迁移、权限、归档及结果未确认等分类；新版双端本地化，旧端遇到未知码保留原通用失败提示。
不透传服务器正文或异常文本。仅群 send 的 invoke 预算增加到 180 秒，不改变其他动作、
共享连接、自动重试或授权。超时不能证明操作未执行，重试沿用 clientId；当前账号主机进程
合并相同在途请求并缓存最近成功回执，服务器 operationId 仍是最终幂等依据。
不新增 IPC channel、数据库迁移或 Mobile 原生指纹输入。
