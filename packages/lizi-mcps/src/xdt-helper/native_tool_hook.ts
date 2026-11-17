import { z } from 'zod';
import type { ToolLifecycleEvent, ToolLifecycleVerdict } from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

export type NativeToolHookCallback = (context: LiziMcpSessionContext, event: ToolLifecycleEvent, signal?: AbortSignal) => Promise<ToolLifecycleVerdict>;

/** Internal native hook relay over the Agent's existing authenticated MCP channel. */
export function registerNativeToolHook(registry: XdtHelperToolRegistry, context: () => LiziMcpSessionContext, call: NativeToolHookCallback): void {
  registry.register({
    name: 'native_tool_hook', category: 'control', hidden: true,
    description: 'Host native tool hook relay; not a model operation.',
    inputShape: {
      hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
      tool_name: z.string(), tool_use_id: z.string(), tool_input: z.record(z.string(), z.unknown()), tool_response: z.unknown().optional(),
    },
    handler: async (input, signal) => {
      const ctx = context();
      if (!ctx.sessionId || !ctx.sessionInstanceId || ctx.hostCaller || ctx.agentKind !== 'codex' || ctx.remoteHostId) throw new Error('Native hook task context is unavailable');
      const phase = input.hook_event_name === 'PreToolUse' ? 'call' : 'result';
      const verdict = await call(ctx, { engine: 'codex', phase, toolName: input.tool_name, toolCallId: input.tool_use_id,
        input: input.tool_input, ...(phase === 'result' ? { result: input.tool_response } : {}) }, signal);
      const output = {
        ...(phase === 'result' && verdict.decision === 'deny' ? { decision: 'block', reason: verdict.reason } : {}),
        hookSpecificOutput: { hookEventName: input.hook_event_name,
          ...(phase === 'call' && verdict.decision === 'deny' ? { permissionDecision: 'deny', permissionDecisionReason: verdict.reason } : {}),
          // Codex only consumes updatedInput alongside native "allow". This
          // carries parameters, not approval: native core still checks policy.
          ...(phase === 'call' && verdict.decision !== 'deny' && verdict.input ? { permissionDecision: 'allow' } : {}),
          ...(verdict.input ? { updatedInput: verdict.input } : {}),
          ...(verdict.additionalContext ? { additionalContext: verdict.additionalContext } : {}),
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(output) }] };
    },
  });
}
