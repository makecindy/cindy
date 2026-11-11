# 接受已保存的伙伴模型

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 `local-db:bots:update` 可选接收 `acceptSavedModelSelectionVersion`（读取到的正整数
Profile 版本）。它是显式接受模型的意图；宿主重新校验模型可用性、版本及账号，在同一保存
事务中推进版本并为跟随专线登记 `pendingBotProfileVersion`。旧版无标记 baseline 不因普通
重试、能力修改或来源不可用而被删除；路由切换尚未就绪时保留恢复记录。

不新增 channel 或权限。旧调用方省略字段保持原有行为；旧宿主不支持该恢复意图，不能将
返回成功视为完成恢复，必须读回版本及发送结果。现有 `update_teammate_profile` 显式提交
`modelChain` 时走同一接受入口，包括重复选择当前值；省略模型字段不改变恢复状态。
