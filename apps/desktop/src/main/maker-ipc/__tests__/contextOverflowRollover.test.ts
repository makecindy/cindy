import { describe, expect, it, vi } from 'vitest';

import {
  createContextOverflowRollover,
  effectivePiContextWindow,
  findLatestRebuildableError,
  lookupVerifiedContextWindow,
  isContextOverflowErrorData,
  isPiPromptRpcTimeoutError,
  persistedUserContentToWireMessage,
  planContextOverflowRollover,
  shouldRebuildForContextPressure,
  shouldRebuildPiNativeSession,
  type OverflowSourceMessage,
} from '../contextOverflowRollover';

function msg(
  role: string,
  content: unknown,
  clientId: string,
  createdAt = 0,
): OverflowSourceMessage {
  return { role, content, clientId, createdAt };
}

describe('isContextOverflowErrorData', () => {
  it('accepts the stable reason and the xAI prompt-length phrasing', () => {
    expect(isContextOverflowErrorData({ reason: 'context-overflow', message: 'nope' })).toBe(true);
    expect(
      isContextOverflowErrorData({
        message:
          'API Error: 400 litellm.BadRequestError: XaiException - {"code":"invalid-argument","error":"This model\'s maximum prompt length is 500000 but the request contains 637815 tokens."}',
      }),
    ).toBe(true);
  });

  it('rejects generic invalid-argument and other 4xx families', () => {
    expect(
      isContextOverflowErrorData({
        message: '{"code":"invalid-argument","error":"unsupported field: foo"}',
      }),
    ).toBe(false);
    expect(
      isContextOverflowErrorData({ message: 'Rate limit exceeded: too many tokens per minute' }),
    ).toBe(false);
  });
});

describe('shouldRebuildPiNativeSession', () => {
  it('treats a PI prompt RPC timeout as an unhealthy native session', () => {
    expect(isPiPromptRpcTimeoutError({ message: 'pi rpc timeout after 30000ms: prompt' })).toBe(
      true,
    );
    expect(shouldRebuildPiNativeSession({ message: 'pi rpc timeout after 30000ms: prompt' })).toBe(
      true,
    );
  });

  it('treats Grok 4 remaining-window pressure as a rebuild even if the DB window is inflated', () => {
    expect(effectivePiContextWindow('x-ai/grok-4.6', 1_050_000)).toBe(500_000);
    expect(effectivePiContextWindow('x-ai/grok-4.6', 1_050_000, 500_000)).toBe(500_000);
    expect(
      lookupVerifiedContextWindow(
        (_agentKind, id) => (id === 'grok-4.6' ? 500_000 : null),
        'x-ai/grok-4.6',
      ),
    ).toBe(500_000);
    expect(shouldRebuildForContextPressure(553_582, 1_050_000)).toBe(false);
    expect(
      shouldRebuildForContextPressure(
        553_582,
        effectivePiContextWindow('x-ai/grok-4.6', 1_050_000),
      ),
    ).toBe(true);
    expect(shouldRebuildForContextPressure(400_000, 500_000)).toBe(false);
    expect(shouldRebuildForContextPressure(400_000, 500_000, 75)).toBe(true);
    expect(shouldRebuildForContextPressure(450_000, 500_000)).toBe(true);
  });

  it('resolves a verified window with the session agent and explicit provider', () => {
    const resolve = vi.fn((agentKind: string, modelId: string, providerId: string | null) =>
      agentKind === 'codex' && modelId === 'gpt-5.6' && providerId === 'xd' ? 372_000 : null,
    );

    expect(lookupVerifiedContextWindow(resolve, 'gpt-5.6', 'xd', 'codex')).toBe(372_000);
    expect(resolve).toHaveBeenCalledWith('codex', 'gpt-5.6', 'xd');
    expect(resolve).not.toHaveBeenCalledWith('codex', 'gpt-5.6', 'xai');
  });

  it('does not borrow the xAI route when the session provider is unresolved', () => {
    const resolve = vi.fn((_agentKind: string, _modelId: string, providerId: string | null) =>
      providerId === 'xai' ? 500_000 : null,
    );

    expect(lookupVerifiedContextWindow(resolve, 'grok-4.6')).toBeNull();
    expect(resolve).toHaveBeenCalledWith('pi', 'grok-4.6', null);
    expect(resolve).not.toHaveBeenCalledWith('pi', 'grok-4.6', 'xai');
  });

  it('does not rebuild on other PI RPC timeouts', () => {
    expect(
      shouldRebuildPiNativeSession({ message: 'pi rpc timeout after 30000ms: set_model' }),
    ).toBe(false);
  });

  it('finds a trailing prompt-timeout error as the reason to skip resume', () => {
    expect(
      findLatestRebuildableError([
        msg('user', '还有建议吗', 'u1'),
        msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
      ]),
    ).toEqual({ message: 'pi rpc timeout after 30000ms: prompt' });
    expect(
      findLatestRebuildableError([
        msg('user', '还有建议吗', 'u1'),
        msg('assistant', '这是回答', 'a1'),
      ]),
    ).toBeNull();
    expect(
      findLatestRebuildableError(
        [
          msg('user', '继续', 'u1'),
          msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
        ],
        false,
      ),
    ).toBeNull();
  });
});

describe('planContextOverflowRollover', () => {
  it('cuts handoff before the failed user message and keeps that row for wire replay', () => {
    const plan = planContextOverflowRollover([
      msg('user', '先做 A', 'u1', 1),
      msg('assistant', '做完 A', 'a1', 2),
      msg('user', '再做 B', 'u2', 3),
    ]);
    expect(plan).toMatchObject({
      action: 'rebuild',
      sourceUserClientId: 'u2',
      sourceUserContent: '再做 B',
    });
    if (plan.action !== 'rebuild') throw new Error('expected rebuild');
    expect(plan.handoffMessages.map((item) => item.clientId)).toEqual(['u1', 'a1']);
  });

  it('stops when the overflowing turn already produced assistant text or tools', () => {
    expect(
      planContextOverflowRollover([
        msg('user', '改文件', 'u1'),
        msg('tool_use', { toolName: 'Edit', input: { file_path: '/repo/a.ts' } }, 't1'),
      ]).action,
    ).toBe('stop');
    expect(
      planContextOverflowRollover([msg('user', '继续', 'u1'), msg('assistant', '先说一句', 'a1')]),
    ).toMatchObject({ action: 'stop', reason: 'has-side-effects' });
    expect(
      planContextOverflowRollover([
        msg('user', '问你一个问题', 'u1'),
        msg('ask_user', { prompt: '选哪个?' }, 'q1'),
      ]),
    ).toMatchObject({ action: 'stop', reason: 'has-side-effects' });
  });

  it('does not treat a later error card as side effects', () => {
    const plan = planContextOverflowRollover([
      msg('user', '继续', 'u1'),
      msg('error', 'context overflow', 'e1'),
    ]);
    expect(plan.action).toBe('rebuild');
  });

  it('refuses a second rollover of the same user message', () => {
    expect(planContextOverflowRollover([msg('user', '继续', 'u1')], 'u1')).toMatchObject({
      action: 'stop',
      reason: 'already-rolled',
    });
  });
});

describe('createContextOverflowRollover', () => {
  function makeDeps(source: OverflowSourceMessage[]) {
    return {
      getSessionRow: vi.fn(async () => ({
        status: 'active',
        agentKind: 'pi',
        remoteHostId: null as string | null,
        clearedAt: null,
        sdkSessionId: '/tmp/dead.jsonl',
        contextTokens: 0,
        contextWindow: 200_000,
        model: 'x-ai/grok-4.6',
        providerId: 'xai',
      })),
      listMessages: vi.fn(async () => source),
      findLatestUser: vi.fn(async (): Promise<OverflowSourceMessage | null> => null),
      findLatestRebuildMeta: vi.fn(async () => null),
      getLiveSession: vi.fn(
        (): {
          isTurnRunning(): boolean;
          getUsageSnapshot?: () => { contextTokens: number; contextWindow: number };
        } => ({ isTurnRunning: () => false }),
      ),
      closeSession: vi.fn(async () => undefined),
      getAutoCompactThresholdPct: undefined as (() => number | undefined) | undefined,
      drainPersistQueue: vi.fn(async () => undefined),
      commitRebuild: vi.fn(async () => undefined),
      setPendingHandoff: vi.fn(),
      readPendingHandoffGeneration: vi.fn(() => 3),
      replayUserMessage: vi.fn(async () => ({ accepted: true })),
      onRebuilt: vi.fn(),
      withCloseSuppressed: async <T>(_sessionId: string, fn: () => Promise<T>) => fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };
  }

  it('rebuilds once, injects handoff, and wire-replays the same user content', async () => {
    const deps = makeDeps([
      msg('user', '先做 A', 'u1', 1),
      msg('assistant', '做完 A', 'a1', 2),
      msg('user', '再做 B', 'u2', 3),
    ]);
    const rollover = createContextOverflowRollover(deps);
    expect(rollover.claim('s1')).toBe('claimed');
    expect(rollover.claim('s1')).toBe('in-flight');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.stringContaining("exceeded the model's context window"),
      expect.objectContaining({
        reason: 'context-overflow',
        sourceUserClientId: 'u2',
        sourceAgentKind: 'pi',
        sourceModel: 'x-ai/grok-4.6',
        sourceProviderId: 'xai',
        expectedClearedAt: null,
      }),
    );
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.any(String), 3);
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).toContain('先做 A');
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).not.toContain('再做 B');
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '再做 B');
    expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
    expect(deps.replayUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      deps.onRebuilt.mock.invocationCallOrder[0],
    );
  });

  it('keeps coordinator recovery when replay is rejected', async () => {
    const deps = makeDeps([msg('user', '再做 B', 'u2')]);
    deps.replayUserMessage.mockResolvedValue({ accepted: false });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.onRebuilt).not.toHaveBeenCalled();
  });

  it('rebuilds scheduler/IM turns without generic replay so the owner retries', async () => {
    const deps = makeDeps([
      {
        ...msg('user', '心跳任务', 'u-sched'),
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: 'PR 心跳' } },
      },
    ]);
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.setPendingHandoff).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    expect(deps.onRebuilt).not.toHaveBeenCalled();
  });

  it('marks external-origin turns as skipGenericReplay in the plan', () => {
    const plan = planContextOverflowRollover([
      {
        ...msg('user', 'from im', 'u-im'),
        agentMeta: { origin: { kind: 'im', channel: 'feishu' } },
      },
    ]);
    expect(plan).toMatchObject({ action: 'rebuild', skipGenericReplay: true });
  });

  it('treats any origin.kind as an external owner, including orca', () => {
    expect(
      planContextOverflowRollover([
        {
          ...msg('user', 'from orca', 'u-orca'),
          agentMeta: { origin: { kind: 'orca', senderLabel: 'Lead' } },
        },
      ]),
    ).toMatchObject({ action: 'rebuild', skipGenericReplay: true });
    expect(
      planContextOverflowRollover([msg('user', 'from cindy chat', 'u-user')]),
    ).toMatchObject({ action: 'rebuild', skipGenericReplay: false });
  });

  it('rebuilds orca turns without generic replay so the owner retries', async () => {
    const deps = makeDeps([
      {
        ...msg('user', '派给 worker', 'u-orca'),
        agentMeta: { origin: { kind: 'orca', senderLabel: 'Lead', displayText: '派给 worker' } },
      },
    ]);
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    expect(deps.onRebuilt).not.toHaveBeenCalled();
  });

  it('does not replay when the failed turn already had tool side effects', async () => {
    const deps = makeDeps([
      msg('user', '改文件', 'u1'),
      msg('tool_use', { toolName: 'Edit', input: { file_path: '/repo/a.ts' } }, 't1'),
    ]);
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('rebuilds before send when Grok context is already over the real window', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 553_582,
      contextWindow: 1_050_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
  });

  it('uses the host compact threshold when deciding pre-send pressure rebuild', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 400_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.getAutoCompactThresholdPct = vi.fn(() => 75);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
  });

  it('uses the same pressure guard for Claude Code and Codex before send', async () => {
    for (const agentKind of ['cc', 'codex'] as const) {
      const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
      deps.getSessionRow.mockResolvedValue({
        status: 'active',
        agentKind,
        remoteHostId: null,
        clearedAt: null,
        sdkSessionId: `/tmp/dead-${agentKind}`,
        contextTokens: 400_000,
        contextWindow: 500_000,
        model: 'model',
        providerId: 'xd',
      });
      deps.getAutoCompactThresholdPct = vi.fn(() => 75);
      const rollover = createContextOverflowRollover(deps);

      await expect(rollover.prepareUnhealthySession(`session-${agentKind}`)).resolves.toBe(true);
      expect(deps.commitRebuild).toHaveBeenCalled();
      deps.commitRebuild.mockClear();
    }
  });

  it('fails closed when a pre-send rebuild cannot commit', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'dead-thread',
      contextTokens: 400_000,
      contextWindow: 500_000,
      model: 'gpt-5.6',
      providerId: 'xd',
    });
    deps.getAutoCompactThresholdPct = vi.fn(() => 75);
    deps.commitRebuild.mockRejectedValue(new Error('db unavailable'));
    const rollover = createContextOverflowRollover(deps);

    await expect(rollover.prepareUnhealthySession('s1')).rejects.toThrow('db unavailable');
  });

  it('drains persist queue before reading messages on prepare', async () => {
    const order: string[] = [];
    const deps = makeDeps([
      msg('user', '还有建议吗', 'u1'),
      msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
    ]);
    deps.drainPersistQueue.mockImplementation(async () => {
      order.push('drain');
    });
    deps.listMessages.mockImplementation(async () => {
      order.push('list');
      return [
        msg('user', '还有建议吗', 'u1'),
        msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
      ];
    });
    const rollover = createContextOverflowRollover(deps);
    await rollover.prepareUnhealthySession('s1');
    expect(order[0]).toBe('drain');
    expect(order).toContain('list');
    expect(order.indexOf('drain')).toBeLessThan(order.indexOf('list'));
  });

  it('rebuilds a timed-out PI session before send without replaying', async () => {
    const deps = makeDeps([
      msg('user', '还有建议吗', 'u1'),
      msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
    ]);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.setPendingHandoff).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).not.toContain('还有建议吗');
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).toContain('stopped responding to prompts');
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ reason: 'pi-prompt-timeout' }),
    );
  });

  it('omits a still-pending last user from prepare handoff', async () => {
    const deps = makeDeps([
      msg('user', '先做 A', 'u1'),
      msg('assistant', '好', 'a1'),
      msg('user', 'IM 待发', 'u-pending'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 400_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.getAutoCompactThresholdPct = vi.fn(() => 75);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    const handoff = String(deps.setPendingHandoff.mock.calls[0]?.[1] ?? '');
    expect(handoff).toContain('先做 A');
    expect(handoff).not.toContain('IM 待发');
  });

  it('keeps a completed last user in prepare handoff', async () => {
    const deps = makeDeps([
      msg('user', '先做 A', 'u1'),
      msg('assistant', '已完成', 'a1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 400_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.getAutoCompactThresholdPct = vi.fn(() => 75);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(String(deps.setPendingHandoff.mock.calls[0]?.[1] ?? '')).toContain('先做 A');
  });

  it('prefers live usage over a stale DB context snapshot', async () => {
    const deps = makeDeps([msg('user', '先做 A', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 1_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 450_000, contextWindow: 500_000 }),
    });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
  });

  it('finds last user outside the bounded handoff window', async () => {
    const deps = makeDeps([
      msg('tool_use', { toolName: 'Edit' }, 't1'),
      msg('tool_result', { output: 'ok' }, 'tr1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'pi',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead.jsonl',
      contextTokens: 450_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.findLatestUser.mockResolvedValue(msg('user', '先做 A', 'u-old'));
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ sourceUserClientId: 'u-old' }),
    );
  });

  it('does not auto-replay a prompt RPC timeout as context-overflow', async () => {
    const deps = makeDeps([
      msg('user', '还有建议吗', 'u1'),
      msg('error', { message: 'pi rpc timeout after 30000ms: prompt' }, 'e1'),
    ]);
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { message: 'pi rpc timeout after 30000ms: prompt' }),
    ).resolves.toBe(false);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('treats an unaccepted replay as recovery failure', async () => {
    const deps = makeDeps([msg('user', '再做 B', 'u2')]);
    deps.replayUserMessage.mockResolvedValue({ accepted: false });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
  });

  it('rolls over a local Claude Code session on explicit overflow', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'cc',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead-claude.jsonl',
      contextTokens: 0,
      contextWindow: 0,
      model: '',
      providerId: '',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
  });

  it('rolls over a local Codex session on explicit overflow', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead-codex-thread',
      contextTokens: 0,
      contextWindow: 0,
      model: '',
      providerId: '',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
  });

  it('keeps remote sessions out of automatic rollover', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: 'remote-1',
      clearedAt: null,
      sdkSessionId: 'thread-1',
      contextTokens: 500_000,
      contextWindow: 500_000,
      model: 'gpt-5.6',
      providerId: 'xd',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');

    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });
});

describe('persistedUserContentToWireMessage', () => {
  it('replays the retained agent-facing payload without projecting it to display text', () => {
    const wirePayload = {
      type: 'user' as const,
      content: [
        { type: 'text', text: '原始引用语义' },
        { type: 'text', text: 'SESSION_REFERENCE_DATA_V1\nquoted context' },
      ],
    };
    expect(
      persistedUserContentToWireMessage({
        text: '显示给用户的正文',
        agentFacingWireContent: wirePayload,
      }),
    ).toEqual(wirePayload);
  });

  it('projects structured references for legacy persisted messages', () => {
    const href = 'cindy://project/%2Frepos%2Fcindy';
    const text = `请处理 ${href}`;
    expect(
      persistedUserContentToWireMessage({
        text,
        agentReferences: [
          {
            kind: 'project',
            start: text.indexOf(href),
            end: text.indexOf(href) + href.length,
            href,
            name: 'src',
            workingDir: '/repo/src',
          },
        ],
        images: [],
        files: [],
      }),
    ).toBe(
      '请处理 [Referenced project]\nName: src\nWorking directory: /repos/cindy\n[/Referenced project]',
    );
  });
});
