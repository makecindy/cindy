import type { HookCallback, HookCallbackMatcher, HookEvent, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { ToolLifecycleControl } from '../shared/tool-lifecycle.js';

/** SDK matchers run in parallel. Sequence our rewrite before our own guards. */
export function withClaudeToolLifecycleHooks(
  control: ToolLifecycleControl | undefined,
  sessionId: string | undefined,
  host: Partial<Record<HookEvent, HookCallbackMatcher[]>>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const plugin = claudeToolLifecycleHooks(control, sessionId);
  if (!plugin) return host;
  const guards = (host.PreToolUse ?? []).map(group => ({
    ...group, matches: group.matcher && group.matcher !== '*' ? new RegExp(group.matcher) : undefined,
  }));
  const pre: HookCallback = async (raw, id, options) => {
    const initial = await plugin.PreToolUse![0].hooks[0](raw, id, options);
    if ('async' in initial || raw.hook_event_name !== 'PreToolUse') return initial;
    let output: SyncHookJSONOutput = initial;
    let specific = output.hookSpecificOutput?.hookEventName === 'PreToolUse' ? output.hookSpecificOutput : undefined;
    if (specific?.permissionDecision === 'deny' || output.continue === false) return output;
    const input = specific?.updatedInput ? { ...raw, tool_input: specific.updatedInput } : raw;
    const answers = await Promise.all(guards.filter(group => !group.matches || group.matches.test(raw.tool_name))
      .flatMap(group => group.hooks.map(hook => hook(input, id, options))));
    const rank = { deny: 3, ask: 2, allow: 1, defer: 0 };
    for (const answer of answers) {
      if ('async' in answer) throw new Error('Asynchronous host PreToolUse callbacks cannot follow a plugin rewrite');
      const next = answer.hookSpecificOutput?.hookEventName === 'PreToolUse' ? answer.hookSpecificOutput : undefined;
      const restriction = (rank[specific?.permissionDecision ?? 'allow'] > rank[next?.permissionDecision ?? 'allow']) ? specific : next;
      specific = { ...specific, ...next, hookEventName: 'PreToolUse',
        ...(restriction?.permissionDecision ? { permissionDecision: restriction.permissionDecision,
          permissionDecisionReason: restriction.permissionDecisionReason } : {}),
        ...([specific?.additionalContext, next?.additionalContext].some(Boolean)
          ? { additionalContext: [specific?.additionalContext, next?.additionalContext].filter(Boolean).join('\n') } : {}),
      };
      output = { ...output, ...answer, hookSpecificOutput: specific,
        ...(output.continue === false || answer.continue === false ? { continue: false } : {}),
        ...(output.decision === 'block' || answer.decision === 'block' ? { decision: 'block' } : {}),
      };
    }
    return output;
  };
  // Preserve the Host's long command-concurrency wait, plus the plugin's 1s budget.
  return { ...host, PreToolUse: [{ hooks: [pre], timeout: Math.max(60, ...guards.map(group => group.timeout ?? 60)) + 1,
    ...(guards.some(group => group.onFailure === 'block') ? { onFailure: 'block' as const } : {}),
  }],
    PostToolUse: [...plugin.PostToolUse!, ...(host.PostToolUse ?? [])],
    PostToolUseFailure: [...plugin.PostToolUseFailure!, ...(host.PostToolUseFailure ?? [])],
  };
}

export function claudeToolLifecycleHooks(
  control: ToolLifecycleControl | undefined,
  sessionId: string | undefined,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  if (sessionId && control?.bind) control = control.bind(sessionId);
  if (!control || !sessionId || !control.enabled(sessionId)) return;
  const selected = control;
  const hook: HookCallback = async (raw, _toolUseId, options) => {
    if (!selected.enabled(sessionId) || options.signal.aborted) return {};
    const input = raw as unknown as { hook_event_name: string; tool_name: string; tool_use_id: string;
      tool_input: Record<string, unknown>; tool_response?: unknown; error?: string };
    const phase = input.hook_event_name === 'PreToolUse' ? 'call' : 'result';
    const verdict = await selected.run(sessionId, { engine: 'claude-code', phase, toolName: input.tool_name,
      toolCallId: input.tool_use_id, input: input.tool_input,
      ...(phase === 'result' ? { result: input.tool_response ?? input.error, isError: input.hook_event_name === 'PostToolUseFailure' } : {}),
    }, options.signal);
    if (options.signal.aborted || !selected.enabled(sessionId)) return {};
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
