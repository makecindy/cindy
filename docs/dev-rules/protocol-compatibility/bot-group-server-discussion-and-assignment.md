# 服务器伙伴群讨论与分工补全

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Chat Server `/me` 追加 `capabilities.groupDiscussionParity: 1`。Desktop 只在该能力存在时发送
可选 `mentionsAll`、`planningMode`，辅助判断后用 `continue({automatic:true})`，停止判断用
`messages/:id/cancel-planning`。旧服务器继续收到旧形状；能力协商并不恢复旧服务端缺失的行为。
整个服务端集群升级后再发布客户端，不能在新旧副本混用时提前承诺该能力。

领取执行追加可选 `attachment_after_seq`，按伙伴/群/授权版本/分工步骤隔离成功投递水位。
缺字段时沿用旧读取范围；新客户端以此翻页收集未见附件，保留每轮 40 个上限及缺失名称提示。
`cindy.group-notice` v1 的 integration 卡映射到已有 plan-failed/member-failed/member-timeout
展示提示，仅承担文案，不授予执行权限。Mobile 继续消费主机既有群资源投影，无新增原生能力。
