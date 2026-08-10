/** Claude PreToolUse guard for legacy shell-based iOS Simulator workflows. */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@cindy/maker-core';
import { getDesktopShellCommandPolicy } from '../shell-command-policy.js';

export function createIOSSimulatorShellGuardHook(logger: Logger): HookCallback {
  const log = logger.child('hook/ios-simulator-shell-guard');
  return async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== 'Bash' && pre.tool_name !== 'PowerShell') return { continue: true };
    const toolInput = pre.tool_input as Record<string, unknown> | null | undefined;
    const command = toolInput?.command;
    if (typeof command !== 'string') return { continue: true };

    const policy = getDesktopShellCommandPolicy(command);
    if (!policy) return { continue: true };

    log.warn('shell command denied by embedded iOS Simulator policy', {
      toolUseId: toolUseId ?? null,
      toolName: pre.tool_name,
      reason: policy.reason,
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: policy.reason,
        additionalContext: policy.reason,
      },
    };
  };
}
