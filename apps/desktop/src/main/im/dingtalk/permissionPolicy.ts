import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

/**
 * DingTalk group turns carry an explicit confirmation boundary for destructive
 * or opaque writes. Owner DMs do not use this per-turn policy and instead obey
 * the session permission mode, matching Feishu and Telegram private chats.
 * Group sessions configured with an incompatible unattended permission mode
 * fail closed in maker-core.
 *
 * Detection is shared with WeChat / Telegram via channelForceConfirmToolCall
 * (nested unwrap covers Claude call_tool, Codex MCP elicitation, and Pi bridged
 * MCP / secondary-dispatch plugins).
 */
export function createDingTalkTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'dingtalk', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
