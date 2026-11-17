import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { ToolLifecycleControl } from '../shared/tool-lifecycle.js';

export function claudeToolLifecycleHooks(
  control: ToolLifecycleControl | undefined,
  sessionId: string | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!control || !sessionId || !control.enabled(sessionId)) return;
  const hook: HookCallback = async (raw, _toolUseId, options) => {
    if (!control.enabled(sessionId) || options.signal.aborted) return {};
    const input = raw as unknown as { hook_event_name: string; tool_name: string; tool_use_id: string;
      tool_input: Record<string, unknown>; tool_response?: unknown; error?: string };
    const phase = input.hook_event_name === 'PreToolUse' ? 'call' : 'result';
    const verdict = await control.run(sessionId, { engine: 'claude-code', phase, toolName: input.tool_name,
      toolCallId: input.tool_use_id, input: input.tool_input,
      ...(phase === 'result' ? { result: input.tool_response ?? input.error, isError: input.hook_event_name === 'PostToolUseFailure' } : {}),
    }, options.signal);
    if (options.signal.aborted || !control.enabled(sessionId)) return {};
    if (phase === 'call') return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      ...(verdict.decision ? { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } : {}),
      ...(verdict.input ? { updatedInput: verdict.input } : {}),
      ...(verdict.additionalContext ? { additionalContext: verdict.additionalContext } : {}),
    } };
    return {
      ...(verdict.decision === 'deny' ? { decision: 'block' as const, reason: verdict.reason } : {}),
      hookSpecificOutput: { hookEventName: input.hook_event_name as 'PostToolUse' | 'PostToolUseFailure',
        ...('result' in verdict ? { updatedToolOutput: verdict.result } : {}),
        ...(verdict.additionalContext ? { additionalContext: verdict.additionalContext } : {}),
      },
    };
  };
  return { PreToolUse: [{ hooks: [hook] }], PostToolUse: [{ hooks: [hook] }], PostToolUseFailure: [{ hooks: [hook] }] };
}
