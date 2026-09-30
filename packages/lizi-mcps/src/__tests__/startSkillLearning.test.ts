import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerStartSkillLearningTool } from '../xdt-helper/start_skill_learning.js';

function payload(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error('missing text payload');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('start_skill_learning', () => {
  it('binds the current task and starts a session Learn run', async () => {
    const registry = new XdtHelperToolRegistry();
    const authorizeSkillLearning = vi.fn(async () => ({
      ok: true as const,
      sessionInstanceId: 'instance-1',
    }));
    const startSkillLearning = vi.fn(async () => ({ ok: true as const, runId: 'run-1' }));
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'session-1',
      }),
      authorizeSkillLearning,
      startSkillLearning,
    });

    const result = await registry.call('start_skill_learning', {
      source_kind: 'session',
      input: '',
    });

    const request = {
      callerSessionId: 'session-1',
      input: '',
      sourceKind: 'session',
    } as const;
    expect(authorizeSkillLearning).toHaveBeenCalledWith(request, expect.objectContaining({
      sessionId: 'session-1',
      agentKind: 'codex',
    }));
    expect(startSkillLearning).toHaveBeenCalledWith(request, {
      sessionInstanceId: 'instance-1',
    });
    expect(payload(result)).toMatchObject({ ok: true, run_id: 'run-1', status: 'collecting' });
  });

  it('normalizes SkillHub input and defaults its catalog scope', async () => {
    const registry = new XdtHelperToolRegistry();
    const authorizeSkillLearning = vi.fn(async () => ({
      ok: true as const,
      sessionInstanceId: 'instance-2',
    }));
    const startSkillLearning = vi.fn(async () => ({ ok: true as const, runId: 'run-2' }));
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => ({
        agentKind: 'claude-code',
        workingDir: '/repo',
        sessionId: 'session-2',
      }),
      authorizeSkillLearning,
      startSkillLearning,
    });

    await registry.call('start_skill_learning', {
      source_kind: 'hub',
      hub_slug: 'release-notes',
      input: '  keep the checks  ',
    });

    expect(startSkillLearning).toHaveBeenCalledWith(
      {
        callerSessionId: 'session-2',
        input: 'keep the checks',
        sourceKind: 'hub',
        hubSlug: 'release-notes',
        hubCatalogScope: 'market',
      },
      { sessionInstanceId: 'instance-2' },
    );
  });

  it.each([
    [{ source_kind: 'freetext', input: '   ' }, 'INVALID_ARGS'],
    [{ source_kind: 'hub', input: '' }, 'INVALID_ARGS'],
    [{ source_kind: 'session', input: '', hub_slug: 'extra' }, 'INVALID_ARGS'],
  ])('rejects inconsistent arguments %#', async (args, expectedErrorCode) => {
    const registry = new XdtHelperToolRegistry();
    const authorizeSkillLearning = vi.fn(async () => ({
      ok: true as const,
      sessionInstanceId: 'instance-3',
    }));
    const startSkillLearning = vi.fn();
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => ({
        agentKind: 'pi',
        workingDir: '/repo',
        sessionId: 'session-3',
      }),
      authorizeSkillLearning,
      startSkillLearning,
    });

    const result = await registry.call('start_skill_learning', args);

    expect(payload(result)).toMatchObject({ ok: false, errorCode: expectedErrorCode });
    expect(authorizeSkillLearning).not.toHaveBeenCalled();
    expect(startSkillLearning).not.toHaveBeenCalled();
  });

  it('requires a host-attested one-shot Learn invocation before starting', async () => {
    const registry = new XdtHelperToolRegistry();
    const authorizeSkillLearning = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'USER_REQUEST_REQUIRED',
      message: 'The latest user message is not a matching /learn invocation.',
    }));
    const startSkillLearning = vi.fn();
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'session-4',
      }),
      authorizeSkillLearning,
      startSkillLearning,
    });

    const result = await registry.call('start_skill_learning', {
      source_kind: 'freetext',
      input: 'create release notes',
    });

    expect(payload(result)).toMatchObject({ ok: false, errorCode: 'USER_REQUEST_REQUIRED' });
    expect(authorizeSkillLearning).toHaveBeenCalledOnce();
    expect(startSkillLearning).not.toHaveBeenCalled();
  });

  it('fails closed without a bound Cindy task', async () => {
    const registry = new XdtHelperToolRegistry();
    const authorizeSkillLearning = vi.fn(async () => ({
      ok: true as const,
      sessionInstanceId: 'instance-5',
    }));
    const startSkillLearning = vi.fn();
    registerStartSkillLearningTool(registry, {
      getSessionContext: () => ({ agentKind: 'codex', workingDir: '/repo' }),
      authorizeSkillLearning,
      startSkillLearning,
    });

    const result = await registry.call('start_skill_learning', {
      source_kind: 'session',
      input: '',
    });

    expect(payload(result)).toMatchObject({ ok: false, errorCode: 'NO_SESSION_CONTEXT' });
    expect(authorizeSkillLearning).not.toHaveBeenCalled();
    expect(startSkillLearning).not.toHaveBeenCalled();
  });
});
