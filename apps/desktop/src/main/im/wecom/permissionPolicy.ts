import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * 企业微信群里非主人触发的轮次(个人机器人的「群成员也能提问」): 破坏性 / 不透明写必须主人确认,
 * 会话是完全访问时由共享 runner 临时降到 Auto(与钉钉同一口径)。主人自己的群轮次与私聊不挂,
 * 照会话权限档执行, 与升级前一致。
 */
export function createWecomGuestTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'wecom', taskId },
    autoReviewContext: { requesterAuthority: 'guest', source: 'group' },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
