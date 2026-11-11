# 支付宝已付下一期的升级拒绝

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

升级报价和确认可返回 HTTP 409 `PLAN_CHANGE_RENEWAL_PREPAID`。Desktop Main 仅放行该
明确错误码，仍脱敏服务端 message；Renderer 显示本地化提示“下一期费用已提前支付，请等待
本期结束后再进行升级。”，不从错误文本反推业务状态。确认阶段收到该拒绝时也结束本次
支付展示，不将其当作网络未知结果重新确认。具体实现和回归见
`main/billing/index.ts`、`renderer/features/billing/usePlanChange.ts` 与对应测试。

旧客户端仍按 HTTP 409 拒绝操作，显示通用冲突提示；新客户端连接旧服务端保持原行为。
需服务端与客户端均更新才有完整限制和具体提示，不要求同步部署，也不新增订阅状态。
支付宝恢复续订的截止资格由服务端下发 `resumable`，客户端不另算 24 小时规则。
