/**
 * Automatic Bot Session rollover. The Bot identity is permanent; this physical
 * context volume is not.
 */

import {
  normalizeBotRenewalPolicy,
  shouldRenewBotSession,
  type BotRenewalReason,
} from '../../shared/botRenewalPolicy.js';

export interface BotRenewalSnapshot {
  botId: string;
  /** `capabilities_json` 里的 `renewal` 段(可能没有 → 走默认策略)。 */
  renewal: unknown;
  canonicalSessionId: string | null;
  currentVersion: number;
  /** 伙伴状态。只有 active 的才换代 —— 暂停/归档的不该被动起来。 */
  status: string;
}

export interface BotRenewalDeps {
  readSnapshot: (botId: string) => Promise<BotRenewalSnapshot | null>;
  /** 主对话最后一次活动时间(unix ms);没有对话或读不到时给 0。 */
  readLastActivityAt: (sessionId: string) => Promise<number>;
  /** 这个伙伴还有没有在跑的活儿(后台命令、未完委派、排队自动化)。 */
  hasActiveWork: (botId: string) => Promise<boolean>;
  /** 换代:走既有底座,带 CAS。 */
  renew: (input: {
    botId: string;
    expectedCanonicalSessionId: string;
    expectedProfileVersion: number;
  }) => Promise<{ canonicalSessionId: string; created?: boolean }>;
  /** 留痕。失败不影响换代结果本身。 */
  recordEvent?: (input: { botId: string; reason: BotRenewalReason; from: string; to: string }) => Promise<void>;
  now?: () => number;
}

export interface BotRenewalOutcome {
  renewed: boolean;
  reason?: BotRenewalReason;
  /** 换代后的主对话;没换时是原来那条。 */
  canonicalSessionId: string | null;
  /** 换代后要不要告诉用户(策略里的 notify)。 */
  notify: boolean;
}

const NOT_RENEWED = (canonicalSessionId: string | null, notify = false): BotRenewalOutcome => ({
  renewed: false,
  canonicalSessionId,
  notify,
});

/**
 * Check lazily at the next real use. No midnight timer creates empty Sessions.
 */
export async function renewBotSessionIfDue(
  botId: string,
  deps: BotRenewalDeps,
): Promise<BotRenewalOutcome> {
  const now = deps.now?.() ?? Date.now();
  const snapshot = await deps.readSnapshot(botId);
  if (!snapshot) return NOT_RENEWED(null);
  // 暂停 / 归档 / 正在删除的伙伴不该被动起来。
  if (snapshot.status !== 'active') return NOT_RENEWED(snapshot.canonicalSessionId);
  // 还没有主对话 —— 那是「首次创建」的事,不是换代。
  if (!snapshot.canonicalSessionId) return NOT_RENEWED(null);
  const policy = normalizeBotRenewalPolicy(snapshot.renewal);
  const lastActivityAt = await deps.readLastActivityAt(snapshot.canonicalSessionId);
  const hasActiveWork = await deps.hasActiveWork(botId);
  const reason = shouldRenewBotSession({ policy, lastActivityAt, now, hasActiveWork });
  if (!reason) return NOT_RENEWED(snapshot.canonicalSessionId, policy.notify);

  const previous = snapshot.canonicalSessionId;
  const result = await deps.renew({
    botId,
    expectedCanonicalSessionId: previous,
    expectedProfileVersion: snapshot.currentVersion,
  });
  if (!result.canonicalSessionId || result.canonicalSessionId === previous) {
    return NOT_RENEWED(previous, policy.notify);
  }
  // Another window/process may have won the CAS and returned its replacement.
  // Follow that winner without claiming a second renewal or recording a
  // duplicate lifecycle event.
  if (result.created === false) {
    return NOT_RENEWED(result.canonicalSessionId, policy.notify);
  }
  await deps.recordEvent?.({
    botId,
    reason,
    from: previous,
    to: result.canonicalSessionId,
  }).catch(() => undefined);
  return {
    renewed: true,
    reason,
    canonicalSessionId: result.canonicalSessionId,
    notify: policy.notify,
  };
}
