import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * 服务器频道轮次的 per-turn 收紧，与 Telegram 群 / 钉钉群同一口径：读 / 搜 / 答自由通过，
 * 破坏性调用与不透明写进入审批链，确认卡点击只认主人。判定共用 channelForceConfirmToolCall。
 *
 * 这只是「动手要主人拍板」的确认策略，不是对非主人的读权限边界——Auto 档下灰区动作仍可能由
 * 审阅器放行，读文件 / 检索不经确认。所以个人 bot 的频道只对主人开放（见 channelAccessStore），
 * 伙伴成员准入沿用伙伴规则。
 */
export function createDiscordChannelTurnPermissionPolicy(taskId: string, isOwner?: boolean): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'discord', taskId },
    autoReviewContext: {
      requesterAuthority: isOwner === true ? 'owner' : isOwner === false ? 'guest' : 'unknown',
      source: 'group',
    },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
