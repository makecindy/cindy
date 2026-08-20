import { describe, expect, it, vi } from 'vitest';

import {
  buildClaudeSubagentModelGuardHooks,
  effectiveClaudeSubagentModel,
} from '../subagent-model-access.js';

function agentInput(model?: string) {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session-subagent-model',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    tool_name: 'Agent',
    tool_input: model === undefined ? {} : { model, run_in_background: true },
    tool_use_id: 'tool-subagent-model',
  };
}

describe('Claude subagent model access guard', () => {
  it('denies only an authoritative denial before Full access can bypass canUseTool', async () => {
    const resolveAccess = vi.fn(async () => ({ status: 'denied' as const }));
    const hook = buildClaudeSubagentModelGuardHooks(resolveAccess)
      .PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');

    await expect(hook(
      agentInput('sonnet'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('sonnet'),
      },
    });
    expect(resolveAccess).toHaveBeenCalledWith('sonnet');
  });

  it.each(['allowed', 'unknown'] as const)('allows a %s decision', async (status) => {
    const hook = buildClaudeSubagentModelGuardHooks(async () => ({ status }))
      .PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');
    await expect(hook(
      agentInput('opus'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ continue: true });
  });

  it('fails open when the live resolver throws', async () => {
    const hook = buildClaudeSubagentModelGuardHooks(async () => {
      throw new Error('account switched while reading access');
    }).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');
    await expect(hook(
      agentInput('haiku'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ continue: true });
  });

  it('normalizes full ids and the [1m] suffix before resolving', async () => {
    const resolveAccess = vi.fn(async () => ({ status: 'allowed' as const }));
    const hook = buildClaudeSubagentModelGuardHooks(resolveAccess)
      .PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');
    await hook(
      agentInput(' Claude-Sonnet-4-6[1m] '),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(resolveAccess).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses the forced env model and skips omitted or inherited native defaults', async () => {
    const forcedResolver = vi.fn(async () => ({ status: 'allowed' as const }));
    const forcedHook = buildClaudeSubagentModelGuardHooks(forcedResolver, ' OPUS[1m] ')
      .PreToolUse?.[0]?.hooks[0];
    if (!forcedHook) throw new Error('expected forced model guard');
    await forcedHook(
      agentInput(),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(forcedResolver).toHaveBeenCalledWith('opus');

    expect(effectiveClaudeSubagentModel(undefined, 'Agent', {})).toBeUndefined();
    expect(effectiveClaudeSubagentModel(undefined, 'Task', { model: 'inherit' })).toBeUndefined();
    expect(effectiveClaudeSubagentModel(undefined, 'Read', { model: 'sonnet' })).toBeUndefined();
  });
});
