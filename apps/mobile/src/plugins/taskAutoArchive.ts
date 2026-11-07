import { createGhostCardTaskAutoArchive } from '@cindy/maker-shared/ghost-card-task-archive';
import { isHookSchedulerOrigin, readMessageSourcePlugin } from '@cindy/maker-shared/message-source';
import type { RemoteMessage } from '@/session/types';

/**
 * 手机端的卡片归档任务按钮状态。约定、状态机与电脑端相同(maker-shared ghostCardTaskArchive):
 * 卡片露出「立即归档」与自动归档提示由电脑端的 `taskArchive` 决定,看过、取消与离开时的归档在手机这一侧。
 */
export const taskAutoArchive = createGhostCardTaskAutoArchive();

/**
 * 最后一条由人发出的消息(手机、电脑、IM、共享成员都算;自动化、其他任务和插件代发的不算)。
 * 官方 IM Hook 的渠道消息复用 scheduler 形态的 origin,但是真人发的,要算。与电脑端同一口径。
 */
export function lastUserAuthoredClientId(messages: readonly RemoteMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user' || readMessageSourcePlugin(m.agentMeta)) continue;
    const origin = m.agentMeta?.origin as { kind?: unknown } | undefined;
    if (origin?.kind === 'scheduler' && !isHookSchedulerOrigin(origin)) continue;
    return m.clientId;
  }
  return null;
}
