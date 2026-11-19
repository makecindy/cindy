/**
 * 前台发送的作用域守卫:命中哪一条要能反推(#10852 P1)。
 *
 * 守卫原来把 10 个条件合成一条「Attachment confirmation is no longer current」:
 * 日志里看不出命中项,没有附件确认的普通发送也会说「附件确认」。这里把判定收成
 * 纯函数 —— main 侧只负责取样,命中条件与文案都在这里,便于单测。
 */

/** 作用域失效的命中条件。 */
export type SendScopeReason =
  | 'aborted'
  | 'boundary-pending'
  | 'owner-unset'
  | 'owner-changed'
  | 'generation-changed'
  | 'sender-destroyed'
  | 'frame-missing'
  | 'frame-detached'
  | 'frame-changed'
  | 'window-missing'
  | 'window-destroyed';

export interface SendScopeProbe {
  /** 本次发送的取消信号(会话作废、窗口销毁、主框架导航都会触发它)。 */
  aborted: boolean;
  /** 账号边界正在切换。 */
  boundaryPending: boolean;
  /** 发起时捕获的账号归属。 */
  ownerDataOwnerId: string | null;
  ownerGeneration: number;
  /** 此刻的账号归属。 */
  currentDataOwnerId: string | null;
  currentGeneration: number;
  senderDestroyed: boolean;
  frameMissing: boolean;
  frameDetached: boolean;
  /** 发送 frame 仍然是 sender 的主框架。 */
  frameIsMainFrame: boolean;
  windowMissing: boolean;
  windowDestroyed: boolean;
}

/** 命中第一个失效条件;作用域仍然有效时返回 null。 */
export function resolveSendScopeReason(probe: SendScopeProbe): SendScopeReason | null {
  if (probe.aborted) return 'aborted';
  if (probe.boundaryPending) return 'boundary-pending';
  if (!probe.ownerDataOwnerId) return 'owner-unset';
  if (probe.currentDataOwnerId !== probe.ownerDataOwnerId) return 'owner-changed';
  if (probe.currentGeneration !== probe.ownerGeneration) return 'generation-changed';
  if (probe.senderDestroyed) return 'sender-destroyed';
  if (probe.frameMissing) return 'frame-missing';
  if (probe.frameDetached) return 'frame-detached';
  if (!probe.frameIsMainFrame) return 'frame-changed';
  if (probe.windowMissing) return 'window-missing';
  if (probe.windowDestroyed) return 'window-destroyed';
  return null;
}

/**
 * 用户看得见的文案走 i18n key(#10906 review P1):这些串会以 `[PERMISSION_DENIED]` 带到
 * 渲染层的错误横幅,而渲染层对未登记的码只能回落原文 —— 硬编码英文等于所有语言都看到英文。
 * 具体命中条件只进日志,不进文案(用户要的是「这次发送为什么没成」,不是内部术语)。
 */
export function sendScopeReasonI18nKey(reason: SendScopeReason): string {
  return reason === 'aborted'
    ? 'deviceLinkSendScope.cancelled'
    : 'deviceLinkSendScope.invalid';
}
