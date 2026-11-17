import { randomUUID } from 'node:crypto';
import type { SilentStopTurnEndPorts } from './silentStopTurnEnd.js';
import type { SilentStopDecision } from './silentStopAutoResume.js';

export type SilentStopFailureCause =
  | Extract<SilentStopDecision, { action: 'exhausted' }>['cause']
  | 'dispatch-not-accepted'
  | 'dispatch-error';

const FAILURE_DETAILS: Record<SilentStopFailureCause, string> = {
  budget: '本次自动续跑次数已用完。',
  'rate-limit': '距上次自动续跑时间过短，已触发频率保护。',
  'session-breaker': '本任务累计自动续跑次数已达上限。',
  'dispatch-not-accepted': '自动续跑请求未派发。',
  'dispatch-error': '派发自动续跑请求时发生错误。',
};

/** Bounded host facts only: never claim why the upstream response was empty. */
export function buildSilentStopFailure(cause: SilentStopFailureCause) {
  return {
    message: `检测到空响应，自动续跑已暂停。${FAILURE_DETAILS[cause]}\nsilentStopFailureCause=${cause}`,
    isTerminal: true as const,
    // Existing clients and Continue actions depend on this stable reason.
    reason: 'silent-stop-exhausted' as const,
    silentStopFailureCause: cause,
  };
}

/** Persist and broadcast the same diagnostic, including when persistence fails. */
export async function surfaceSilentStopFailureWithPorts(
  sessionId: string,
  cause: SilentStopFailureCause,
  ports: {
    createDbMessage: SilentStopTurnEndPorts['createDbMessage'];
    broadcast(data: ReturnType<typeof buildSilentStopFailure>): void;
    log: Pick<SilentStopTurnEndPorts['log'], 'warn'>;
  },
): Promise<void> {
  const data = buildSilentStopFailure(cause);
  await ports.createDbMessage(sessionId, {
    clientId: randomUUID(), role: 'error', content: data,
  }, { shouldBroadcast: () => false }).catch((err) => {
    ports.log.warn('silent-stop exhausted marker persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  ports.broadcast(data);
  ports.log.warn('silent-stop auto-resume paused — surfaced continue banner', {
    sessionId, silentStopFailureCause: cause,
  });
}
