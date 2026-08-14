import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { channelForceConfirmToolCall } from '../shared/channelToolPolicy';

export const WECHAT_TURN_PERMISSION_POLICY_UNSUPPORTED =
  'TURN_PERMISSION_POLICY_UNSUPPORTED';

/**
 * Single source of truth for the personal-WeChat one-shot confirmation deadline.
 * The policy advertises it as confirmationTimeoutMs AND WechatIM enforces the
 * actual auto-deny timer from the same constant, so the declared contract and
 * the enforced timeout can never drift (design §7.9). WeChat confirmation is a
 * text reply from a remote human; 30 minutes matches the state machine copy.
 */
export const WECHAT_INTERACTION_CONFIRM_TIMEOUT_MS = 30 * 60 * 1_000;

/**
 * Personal WeChat has no structured card UI. Interaction requests are rendered
 * as one-shot text prompts by the channel adapter; the destructive guard still
 * blocks unsafe calls before a prompt can be approved. Detection is shared with
 * Telegram / DingTalk via channelForceConfirmToolCall (nested unwrap covers
 * Claude call_tool, Codex MCP elicitation, and Pi bridged MCP / secondary
 * dispatch plugins).
 */
export function createWechatTurnPermissionPolicy(
  taskId: string,
  options?: {
    onInteractionStateChange?: TurnPermissionPolicy['onInteractionStateChange'];
  },
): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'wechat', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: WECHAT_INTERACTION_CONFIRM_TIMEOUT_MS,
    ...(options?.onInteractionStateChange
      ? { onInteractionStateChange: options.onInteractionStateChange }
      : {}),
    forceConfirmToolCall: channelForceConfirmToolCall,
  };
}
