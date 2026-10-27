import { describe, expect, it } from 'vitest';
import { buildClaudeHarnessHooks } from '../harness-hooks.js';

describe('Claude native harness hooks', () => {
  it('maps block to a tool denial without granting permission on continue', async () => {
    const signal = new AbortController().signal;
    const input = { hook_event_name: 'PreToolUse' as const, session_id: 's',
      transcript_path: '/private/native.jsonl', cwd: '/workspace', tool_name: 'Bash',
      tool_input: { command: 'echo ok' }, tool_use_id: 't' };
    let blocked = true;
    const seen: unknown[] = [];
    const hook = buildClaudeHarnessHooks(async request => {
      seen.push(request);
      return blocked ? { action: 'block' } : { action: 'continue' };
    }).PreToolUse![0].hooks[0];
    expect(await hook(input, 't', { signal })).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked by an approved task plugin or an expired request.',
    } });
    expect(seen[0]).toEqual({ name: 'tool.before', toolName: 'Bash', toolUseId: 't', input: { command: 'echo ok' } });
    blocked = false;
    expect(await hook(input, 't', { signal })).toEqual({});
  });

  it('uses Claude PreCompact decision rather than its ignored continue field', async () => {
    const hook = buildClaudeHarnessHooks(async () => ({ action: 'block' })).PreCompact![0].hooks[0];
    expect(await hook({ hook_event_name: 'PreCompact', session_id: 's', cwd: '/workspace',
      transcript_path: '/private/native.jsonl', trigger: 'auto', custom_instructions: null },
    undefined, { signal: new AbortController().signal })).toEqual({
      decision: 'block', reason: 'Blocked by an approved task plugin or an expired request.',
    });
  });
});
