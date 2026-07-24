/**
 * consentGate — 协议同意门 pending 动作的确定性校验(纯函数,规则 9)。
 *
 * 背景(codex 审查 P1,2026-07-24):协议弹窗打开期间,认证状态可能被异步推进
 * (深链 OAuth 回调、另一路登录完成、步骤切换)。pending 若只存裸闭包,用户点
 * 「同意」仍会执行陈旧登录动作,造成跨流程派发或覆盖刚完成的状态。
 * 本模块把「pending 是否仍可续接」收敛为纯函数:开门时打快照(stamp),
 * 同意时用当前状态复验,任何漂移都丢弃动作只关弹窗。手机端同构实现见
 * apps/mobile/src/auth/consentGate.ts(双端语义一致,各自单测覆盖;
 * 修改任一侧必须同步另一侧)。
 */

/** 打开协议弹窗时刻的登录上下文快照。 */
export type ConsentStamp = {
  /** 当时的登录步骤(login flow step;undefined 归一为 'unknown') */
  step: string;
  /** 当时是否处于 in-flight(正常拦截时刻应为 false) */
  busy: boolean;
  /** 当时是否已认证(正常拦截时刻应为 false) */
  authenticated: boolean;
};

export function makeConsentStamp(
  step: string | undefined,
  busy: boolean,
  authenticated: boolean,
): ConsentStamp {
  return { step: step ?? 'unknown', busy, authenticated };
}

/**
 * pending 动作是否仍可安全续接:
 * - 当前已认证 → 丢弃(登录已在别处完成,续接会重复派发/覆盖状态);
 * - 当前 in-flight → 丢弃(另一路登录进行中,不追加并发派发);
 * - 步骤已切换 → 丢弃(动作绑定的来源视图已不存在,续接语义失效)。
 */
export function canResumePendingConsent(
  saved: ConsentStamp,
  current: ConsentStamp,
): boolean {
  if (current.authenticated || current.busy) return false;
  return current.step === saved.step;
}
