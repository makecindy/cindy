import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * 飞书群轮次的 per-turn 收紧 — 与 Telegram 2026-07-30 裁决同一信任模型:
 * 群历史前缀把群成员可控文本注入 owner 触发的轮次, 提示注入可借 owner 轮次
 * 的宽松档执行危险操作。读/搜/答自由通过; 破坏性调用与不透明写强制弹确认卡,
 * 且飞书的授权卡走 deliverToOwnerDm 改投 owner 私聊 — 卡片点击本就只认
 * owner(cardActionParser 白名单), 双保险。
 *
 * 判定逻辑与 telegram/dingtalk/个人微信共用 channelForceConfirmToolCall。
 * 会话权限档为 acceptEdits/bypassPermissions 时 maker 拒跑本策略(fail-closed)。
 */
export function createFeishuGroupTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'feishu', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
