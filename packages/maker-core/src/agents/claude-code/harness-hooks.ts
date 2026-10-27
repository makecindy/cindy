import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessHookHandler } from '../../types/harness-capabilities.js';

/** Empty output preserves Claude's own permissions and the user's other hooks. */
export function buildClaudeHarnessHooks(run: HarnessHookHandler): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [async (input, toolUseId, options) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const result = await run({ name: 'tool.before', toolName: input.tool_name,
        toolUseId, input: input.tool_input });
      return result.action === 'block' || options.signal.aborted ? {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by an approved task plugin or an expired request.' },
      } : {};
    }] }],
    PreCompact: [{ hooks: [async (input, _toolUseId, options) => {
      if (input.hook_event_name !== 'PreCompact') return {};
      const result = await run({ name: 'compaction.before' });
      return result.action === 'block' || options.signal.aborted
        ? { decision: 'block', reason: 'Blocked by an approved task plugin or an expired request.' } : {};
    }] }],
  };
}
