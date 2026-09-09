import { describe, expect, it, vi } from 'vitest';

import {
  buildClaudeSubagentModelGuardHooks,
  claudeSubagentModelWithContextWindow,
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
  it('normalizes the 1M suffix from the resolved model capability', () => {
    expect(claudeSubagentModelWithContextWindow('z-ai/glm-5.3', 1_000_000))
      .toBe('z-ai/glm-5.3[1m]');
    expect(claudeSubagentModelWithContextWindow('z-ai/glm-5.3[1m]', 272_000))
      .toBe('z-ai/glm-5.3');
    expect(claudeSubagentModelWithContextWindow('unknown/model', undefined))
      .toBe('unknown/model');
  });

  it('rewrites an explicit Agent model before Claude Code resolves its context window', async () => {
    const hook = buildClaudeSubagentModelGuardHooks(
      async () => ({ status: 'allowed' as const }),
      undefined,
      undefined,
      (model) => model === 'z-ai/glm-5.3' ? 1_000_000 : undefined,
    ).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');

    await expect(hook(
      agentInput('z-ai/glm-5.3'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      hookSpecificOutput: {
        updatedInput: { model: 'z-ai/glm-5.3[1m]' },
      },
    });
  });

  it('does not rewrite unknown models or non-Agent tools', async () => {
    const hook = buildClaudeSubagentModelGuardHooks(
      async () => ({ status: 'allowed' as const }),
      undefined,
      undefined,
      () => undefined,
    ).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected subagent model guard');

    await expect(hook(
      agentInput('unknown/model'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ continue: true });
    await expect(hook(
      { ...agentInput('z-ai/glm-5.3'), tool_name: 'Read' },
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toEqual({ continue: true });
  });

  it('can rewrite context metadata even when account access preflight is not installed', async () => {
    const hook = buildClaudeSubagentModelGuardHooks(
      undefined,
      undefined,
      undefined,
      (model) => model === 'z-ai/glm-5.3' ? 1_000_000 : undefined,
    ).PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected context-only subagent guard');

    await expect(hook(
      agentInput('z-ai/glm-5.3'),
      undefined,
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      hookSpecificOutput: {
        updatedInput: { model: 'z-ai/glm-5.3[1m]' },
      },
    });
  });

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
