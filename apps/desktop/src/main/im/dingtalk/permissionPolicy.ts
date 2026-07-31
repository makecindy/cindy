import type { TurnPermissionPolicy } from '@cindy/maker-core';

import { checkDestructiveToolCall } from '../../destructiveGuard';

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * DingTalk group turns carry an explicit confirmation boundary for destructive
 * or opaque writes. Owner DMs do not use this per-turn policy and instead obey
 * the session permission mode, matching Feishu and Telegram private chats.
 * Group sessions configured with an incompatible unattended permission mode
 * fail closed in maker-core.
 */
export function createDingTalkTurnPermissionPolicy(taskId: string): TurnPermissionPolicy {
  return {
    origin: { kind: 'im', channel: 'dingtalk', taskId },
    confirmationSurface: 'channel',
    confirmationTimeoutMs: 30 * 60 * 1_000,
    forceConfirmToolCall(toolName, input) {
      const direct = checkDestructiveToolCall(toolName, record(input));
      if (direct.destructive) return true;

      const outer = record(input);
      const nested = record(outer?.toolParams);
      const innerName =
        typeof nested?.name === 'string'
          ? nested.name
          : typeof outer?.name === 'string'
            ? outer.name
            : null;
      if (
        innerName &&
        (checkDestructiveToolCall(innerName, nested ?? outer).destructive ||
          /(?:^|_)(?:merge|system_write|overwrite)(?:_|$)/i.test(innerName))
      ) {
        return true;
      }
      return toolName === 'file_change' || toolName === 'permissions';
    },
  };
}
