import type {
  Capabilities,
  PermissionMode,
  TurnPermissionPolicy,
} from '@cindy/maker-core';

import { checkDestructiveToolCall } from '../../destructiveGuard';

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Personal WeChat has no structured card UI. Interaction requests are rendered
 * as one-shot text prompts by the channel adapter; the destructive guard still
 * blocks unsafe calls before a prompt can be approved.
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
    confirmationTimeoutMs: 30 * 60 * 1_000,
    ...(options?.onInteractionStateChange
      ? { onInteractionStateChange: options.onInteractionStateChange }
      : {}),
    forceConfirmToolCall(toolName, input) {
      const direct = checkDestructiveToolCall(toolName, record(input));
      if (direct.destructive) return true;

      // Claude call_tool wrappers put the inner action directly in input.name.
      // Codex MCP elicitation wraps it in input.toolParams.name.
      const outer = record(input);
      const nested = record(outer?.toolParams);
      const innerName =
        typeof nested?.name === 'string'
          ? nested.name
          : typeof outer?.name === 'string'
            ? outer.name
            : null;
      const innerInput = nested ?? outer;
      if (
        innerName &&
        (checkDestructiveToolCall(innerName, innerInput).destructive ||
          /(?:^|_)(?:merge|system_write|overwrite)(?:_|$)/i.test(innerName))
      ) {
        return true;
      }

      // Codex does not expose the patch body in fileChangeApproval, and a
      // permissions escalation can authorize an opaque write. Confirm these
      // conservatively rather than auto-approving a possible deletion.
      return toolName === 'file_change' || toolName === 'permissions';
    },
  };
}

export function supportsWechatTurnPermissionMode(
  capabilities: Capabilities,
  mode: PermissionMode,
): boolean {
  const policy = capabilities.turnPermissionPolicy;
  return (
    policy?.supported.supported === true &&
    !policy.unsupportedPermissionModes.includes(mode)
  );
}
