import { createGhostCardTaskAutoArchive } from '@cindy/maker-shared/ghost-card-task-archive';
import { isHookSchedulerOrigin, readMessageSourcePlugin } from '@cindy/maker-shared/message-source';
import type { RemoteMessage } from '@/session/types';

/**
 * 手机端的卡片归档任务按钮状态。约定、状态机与电脑端相同(maker-shared ghostCardTaskArchive):
 * 卡片露出「立即归档」与自动归档提示由电脑端的 `taskArchive` 决定,看过、取消与离开时的归档在手机这一侧。
 */
export const taskAutoArchive = createGhostCardTaskAutoArchive();

/**
 * 最后一条由人发出的消息(手机、电脑、IM、共享成员都算)。不算:插件代发、任何带来源的内部发送
 * (自动化、其他任务、协同 Agent)、自动续跑、子代理内部的行。官方 IM Hook 的渠道消息复用 scheduler
 * 形态的 origin,但是真人发的,要算。与共享的「用户真的开口」判据(maker-shared messageRender)同一口径。
 */
export function lastUserAuthoredClientId(messages: readonly RemoteMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'user' || readMessageSourcePlugin(m.agentMeta)) continue;
    const meta = m.agentMeta;
    const origin = meta?.origin;
    if (origin !== undefined && origin !== null && !isHookSchedulerOrigin(origin)) continue;
    if (meta?.autoResume === true) continue;
    const parent = meta?.parentToolUseId ?? meta?.parent_tool_use_id;
    if (typeof parent === 'string' && parent.trim()) continue;
    return m.clientId;
  }
  return null;
}
