import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';
import type { InterruptedTurnErrorSignals } from './interruptedTurnAutoResume.js';

export interface UsageLimitFallbackRoute {
  providerId: string;
  model: string;
}

/**
 * 任务级「额度用尽自动换路」策略：只对账号额度耗尽生效。
 *
 * 这是用户显式选择，不是自动降级：`source` 记下配置时任务实际使用的组合，只有任务仍在
 * 这个组合上运行时才触发；切到 `target` 之后来源已变，同一条策略不会再次命中，天然不回环。
 * 目标模型保持同一个 Harness（只换来源与模型，不换引擎）。
 */
export interface SessionUsageLimitFallback {
  source: SessionRuntimeProfile;
  target: UsageLimitFallbackRoute;
}

/**
 * 只认确定的账号额度耗尽。普通 HTTP 限流、认证失败、权限拒绝都不触发：
 * 那些失败换模型也救不回来，还可能白花一次备用额度。
 */
export function isConfirmedUsageLimit(signals: InterruptedTurnErrorSignals): boolean {
  if (
    signals.errorStatus === 401 ||
    signals.errorStatus === 403 ||
    ['authentication_failed', 'authentication_error', 'billing_error', 'permission_error'].includes(
      signals.sdkError ?? '',
    )
  ) {
    return false;
  }
  return signals.usageLimit === true || signals.codexErrorInfo === 'usageLimitExceeded';
}

/** 策略只在任务仍跑在配置时的组合上生效；远程 Agent 任务不参与本机额度备用。 */
export function matchesUsageLimitFallbackSource(
  policy: SessionUsageLimitFallback,
  profile: SessionRuntimeProfile,
): boolean {
  return (
    policy.source.agentKind === profile.agentKind &&
    policy.source.model === profile.model &&
    policy.source.providerId === profile.providerId &&
    !profile.agentDeviceId
  );
}

/** 展示用：活动行「{from} 撞到用量上限，已换到 {to} 继续」。 */
export function usageLimitFallbackLabels(policy: SessionUsageLimitFallback): {
  from: string;
  to: string;
} {
  return { from: policy.source.model, to: policy.target.model };
}
