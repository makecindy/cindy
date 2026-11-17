import type { HookCallback, HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { ToolLifecycleControl } from '../shared/tool-lifecycle.js';

export function claudeToolLifecycleHooks(
  control: ToolLifecycleControl | undefined,
  sessionId: string | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (!control || !sessionId) return;
  const before = control.enabled(sessionId, 'call');
  const after = control.enabled(sessionId, 'result');
  if (!before && !after) return;
  const selected = control;
  const hook: HookCallback = async (raw, _toolUseId, options) => {
    const input = raw as unknown as { hook_event_name: string; tool_name: string; tool_use_id: string;
      tool_input: Record<string, unknown>; tool_response?: unknown; error?: string };
    const phase = input.hook_event_name === 'PreToolUse' ? 'call' : 'result';
    if (!selected.enabled(sessionId, phase) || options.signal.aborted) return {};
    const verdict = await selected.run(sessionId, { engine: 'claude-code', phase, toolName: input.tool_name,
      toolCallId: input.tool_use_id, input: input.tool_input,
      ...(phase === 'result' ? { result: input.tool_response ?? input.error, isError: input.hook_event_name === 'PostToolUseFailure' } : {}),
    }, options.signal);
    if (options.signal.aborted || !selected.enabled(sessionId, phase)) return {};
    if (phase === 'call') return { hookSpecificOutput: { hookEventName: 'PreToolUse',
      ...(verdict.decision ? { permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } : {}),
      ...(verdict.additionalContext ? { additionalContext: verdict.additionalContext } : {}),
    } };
    return {
      ...(verdict.decision === 'deny' ? { continue: false, stopReason: verdict.reason } : {}),
      hookSpecificOutput: { hookEventName: input.hook_event_name as 'PostToolUse' | 'PostToolUseFailure',
        ...('result' in verdict ? { updatedToolOutput: verdict.result } : {}),
        ...(verdict.additionalContext ? { additionalContext: verdict.additionalContext } : {}),
      },
    };
  };
  return { ...(before ? { PreToolUse: [{ hooks: [hook] }] } : {}),
    ...(after ? { PostToolUse: [{ hooks: [hook] }], PostToolUseFailure: [{ hooks: [hook] }] } : {}),
  };
}
