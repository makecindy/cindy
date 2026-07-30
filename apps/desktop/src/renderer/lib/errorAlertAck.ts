/**
 * 错误告警的「已处置」ack。
 *
 * 2026-07 统一决策:红点是**未处理告警**的派生投影,不是已读标记 —— 展示不产生
 * 已读,只有处置才收敛。此前这里还有一个 useErrorReadAck hook,在 banner 聚焦驻留
 * 1.5s 后就自动 ack,造成「红点已灭、横幅仍在」的割裂,已随本次统一删除。
 *
 * 现在只剩用户对横幅的**显式操作**这一条 ack 路径(Retry / silent-stop 继续 /
 * 关闭)—— 点击本身就是最强的处置证据。
 *
 * 落库型处置(中断 ack、错误尾行 dismiss)不走这里:它们改变的是 pending-alerts
 * 查询的结果,由 usePendingAlertAttention 的差分收敛清点。本函数服务的是
 * makerChatStore 内存态 live error 那条腿 —— 它没有持久真源可派生,必须显式清。
 *
 * 一个有意的取舍:live ErrorBanner 的「关闭」(handleDismissError → clearError)只清
 * 内存态,**不**把错误行标 dismissed,所以切走再回来会以 ErrorTailErrorBanner 的形式
 * 再次出现。这里仍然清红点 —— 关闭横幅表达的是「我知道了,先不管」,让红点跟着灭
 * 更符合直觉;真要彻底消掉提示,用尾行横幅上的「忽略」(落库)。反之若此时又产生
 * 新的终止错误,useSessionRunningStatus 会重新打点,提醒不会丢。
 */

import { clearSessionAttention } from './sessionAttentionStore';

/**
 * 用户已处置该会话的错误告警:以 explicit 意图清红角标(passive 清除对 error 免疫)。
 * 幂等。store 对 explicit 清除保证把意图经 notification:clear-session-attention 桥接
 * 到灵动岛 / Dock 角标,本地没有条目(如 renderer 曾重载)时同样照发。
 *
 * 远程会话据此按 explicit-action 放行回执(不卡对账新鲜度门槛):用户都动手处置了,
 * 目标会话的内容显然已被看到。
 */
export function ackErrorAlertHandled(sessionId: string): void {
  clearSessionAttention(sessionId, { intent: 'explicit' });
}
