import { describe, expect, it, vi } from 'vitest';

import {
  createContextOverflowRollover,
  effectiveContextWindow,
  effectivePiContextWindow,
  findLatestRebuildableError,
  hasModelWindowContextToProtect,
  lookupVerifiedContextWindow,
  isContextOverflowErrorData,
  isOversizedHistoryErrorData,
  isPiPromptRpcTimeoutError,
  persistedUserContentToWireMessage,
  planContextOverflowRollover,
  shouldRebuildForContextPressure,
  shouldRebuildForModelWindowSwitch,
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

  it('treats Codex remote compact encrypted-content 400 as rebuildable', () => {
    expect(
      isContextOverflowErrorData({
        message:
          'Error running remote compact task: { "type": "error", "error": { "code": "invalid_encrypted_content" } }',
      }),
    ).toBe(true);
    expect(
      isContextOverflowErrorData({
        message:
          'Encrypted content could not be decrypted or parsed. code=invalid_encrypted_content',
      }),
    ).toBe(false);
  });
});

describe('effectiveContextWindow', () => {
  it('uses the running route report when the current catalog window is unverified', () => {
    expect(effectiveContextWindow('gpt-5.6-sol', 258_400, null)).toBe(258_400);
  });

  it('keeps a verified route window authoritative over an inflated runtime report', () => {
    expect(effectiveContextWindow('gpt-5.6-sol', 1_000_000, 372_000)).toBe(372_000);
  });

  it('switches the reported 258400-token task directly to a verified larger window', () => {
    const currentContextWindow = effectiveContextWindow('gpt-5.6-sol', 258_400, null);

    expect(
      shouldRebuildForModelWindowSwitch({
        contextTokens: 90_789,
        currentContextWindow,
        targetContextWindow: 372_000,
      }),
    ).toBe(false);
  });
});

describe('hasModelWindowContextToProtect', () => {
  it('skips the window gate only for authoritative empty context', () => {
    expect(hasModelWindowContextToProtect(true, 0)).toBe(false);
    expect(hasModelWindowContextToProtect(true, 90_789)).toBe(true);
    expect(hasModelWindowContextToProtect(true, -1)).toBe(true);
    expect(hasModelWindowContextToProtect(true, Number.NaN)).toBe(true);
    expect(hasModelWindowContextToProtect(false, 0)).toBe(true);
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
    expect(shouldRebuildForContextPressure(400_000, 500_000, 75)).toBe(false);
    expect(shouldRebuildForContextPressure(450_000, 500_000)).toBe(false);
    expect(shouldRebuildForContextPressure(500_000, 500_000)).toBe(true);
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
    expect(
      findLatestRebuildableError([
        msg('user', '继续', 'u1'),
        msg('error', { reason: 'codex_history_oversized', message: 'oversized' }, 'e1'),
      ]),
    ).toEqual({ reason: 'codex_history_oversized', message: 'oversized' });
    expect(isOversizedHistoryErrorData({ reason: 'codex_history_oversized' })).toBe(true);
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

describe('shouldRebuildForModelWindowSwitch', () => {
  it.each([
    [244_799, 272_000, false],
    [244_800, 272_000, true],
    [271_999, 272_000, true],
    [272_000, 272_000, true],
    [449_999, 272_000, true],
    [450_000, 272_000, true],
    [179_999, 200_000, false],
    [180_000, 200_000, true],
  ] as const)(
    'assesses 500K → %i at the unified 90%% target boundary (%i tokens)',
    (contextTokens, targetContextWindow, expected) => {
      expect(
        shouldRebuildForModelWindowSwitch({
          contextTokens,
          currentContextWindow: 500_000,
          targetContextWindow,
        }),
      ).toBe(expected);
    },
  );

  it('does not rebuild for equal or larger target windows', () => {
    expect(
      shouldRebuildForModelWindowSwitch({
        contextTokens: 450_000,
        currentContextWindow: 500_000,
        targetContextWindow: 500_000,
      }),
    ).toBe(false);
    expect(
      shouldRebuildForModelWindowSwitch({
        contextTokens: 450_000,
        currentContextWindow: 500_000,
        targetContextWindow: 1_000_000,
      }),
    ).toBe(false);
  });
});

describe('createContextOverflowRollover', () => {
  function makeDeps(source: OverflowSourceMessage[]) {
    return {
      getSessionRow: vi.fn(
        async (): Promise<{
          status: string;
          agentKind: string;
          remoteHostId: string | null;
          clearedAt: number | null;
          sdkSessionId: string;
          contextTokens: number;
          contextWindow: number;
          model: string;
          providerId: string;
          workingDir?: string | null;
        }> => ({
          status: 'active',
          agentKind: 'pi',
          remoteHostId: null,
          clearedAt: null,
          sdkSessionId: '/tmp/dead.jsonl',
          contextTokens: 0,
          contextWindow: 200_000,
          model: 'x-ai/grok-4.6',
          providerId: 'xai',
        }),
      ),
      listMessages: vi.fn(async () => source),
      findLatestUser: vi.fn(async (): Promise<OverflowSourceMessage | null> => null),
      findLatestRebuildMeta: vi.fn(async () => null),
      getLiveSession: vi.fn(
        (): {
          isTurnRunning(): boolean;
          getUsageSnapshot?: () => {
            contextTokens: number;
            contextWindow: number;
            needsRollover?: boolean;
          };
        } | undefined => ({ isTurnRunning: () => false }),
      ),
      rehydrateColdPiRuntimeForWindowVerification: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      getAutoCompactThresholdPct: undefined as (() => number | undefined) | undefined,
      resolveVerifiedWindow: vi.fn((): number | null => null),
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

  it.each(['cc', 'codex', 'pi'] as const)(
    'rebuilds %s native context before a pressured 500K → 272K model switch',
    async (agentKind) => {
      const deps = makeDeps([
        msg('user', '先做 A', 'u1', 1),
        msg('assistant', '做完 A', 'a1', 2),
      ]);
      deps.getSessionRow.mockResolvedValue({
        status: 'active',
        agentKind,
        remoteHostId: null,
        clearedAt: null,
        sdkSessionId: '/tmp/live-session',
        contextTokens: 244_800,
        contextWindow: 500_000,
        model: 'wide-model',
        providerId: 'xd',
      });
      const rollover = createContextOverflowRollover(deps);

      await expect(
        rollover.prepareModelWindowSwitch('s1', {
          contextWindow: 272_000,
        }),
      ).resolves.toBe('rebuilt');

      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.closeSession.mock.invocationCallOrder[0]!).toBeLessThan(
        deps.commitRebuild.mock.invocationCallOrder[0]!,
      );
      expect(deps.commitRebuild).toHaveBeenCalledWith(
        's1',
        expect.any(String),
        expect.objectContaining({
          reason: 'model-window-switch',
          sourceAgentKind: agentKind,
          sourceModel: 'wide-model',
        }),
      );
      const commitCalls = deps.commitRebuild.mock.calls as unknown as Array<[string, string]>;
      const handoff = String(commitCalls[0]?.[1] ?? '');
      expect(handoff).toContain('switching to a model with a smaller context window');
      expect(handoff).not.toContain("exceeded the model's context window");
      expect(deps.setPendingHandoff).toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    },
  );

  it('prefers the verified live Pi runtime window over a stale directory window', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'pi',
      contextTokens: 300_000,
      contextWindow: 200_000,
      model: 'runtime-wide-model',
      providerId: 'xd',
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 300_000, contextWindow: 1_000_000 }),
    });
    deps.resolveVerifiedWindow.mockReturnValue(200_000);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('rebuilt');
    expect(deps.resolveVerifiedWindow).toHaveBeenCalledWith(
      'pi',
      'runtime-wide-model',
      'xd',
    );
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ reason: 'model-window-switch' }),
    );
  });

  it.each([244_800, 300_000])(
    'requires confirmation at %i tokens before rebuilding pressure revealed by Pi final-window verification',
    async (contextTokens) => {
      const deps = makeDeps([msg('user', '继续', 'u1')]);
      deps.getSessionRow.mockResolvedValue({
        ...(await deps.getSessionRow()),
        agentKind: 'pi',
        contextTokens,
        contextWindow: 500_000,
      });
      deps.getLiveSession.mockReturnValue({
        isTurnRunning: () => false,
        getUsageSnapshot: () => ({ contextTokens, contextWindow: 272_000 }),
      });
      const rollover = createContextOverflowRollover(deps);
      const onConfirmationRequired = vi.fn();

      await expect(
        rollover.prepareModelWindowSwitch('s1', {
          contextWindow: 272_000,
          recheckTargetPressure: true,
          onConfirmationRequired,
        }),
      ).resolves.toBe('confirmation-required');
      expect(onConfirmationRequired).toHaveBeenCalledWith(contextTokens);
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.commitRebuild).not.toHaveBeenCalled();

      await expect(
        rollover.prepareModelWindowSwitch('s1', {
          contextWindow: 272_000,
          recheckTargetPressure: true,
          confirmedTargetPressure: true,
        }),
      ).resolves.toBe('rebuilt');
      expect(deps.commitRebuild).toHaveBeenCalledWith(
        's1',
        expect.any(String),
        expect.objectContaining({ reason: 'model-window-switch' }),
      );
    },
  );

  it('requires an exact confirmation before rebuilding a 1M Claude task for a 200K subscription route', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'cc',
      contextTokens: 180_000,
      contextWindow: 1_000_000,
      model: 'claude-opus',
      providerId: 'xd',
    });
    deps.resolveVerifiedWindow.mockReturnValue(1_000_000);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', {
        contextWindow: 200_000,
        recheckTargetPressure: true,
      }),
    ).resolves.toBe('confirmation-required');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();

    await expect(
      rollover.prepareModelWindowSwitch('s1', {
        contextWindow: 200_000,
        recheckTargetPressure: true,
        confirmedTargetPressure: true,
      }),
    ).resolves.toBe('rebuilt');
    expect(deps.commitRebuild).toHaveBeenCalledTimes(1);
    const commitCalls = deps.commitRebuild.mock.calls as unknown as Array<[string, string]>;
    expect(String(commitCalls[0]?.[1] ?? '')).toContain(
      'switching to a model with a smaller context window',
    );
    expect(deps.setPendingHandoff).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('does not rebuild after Pi final-window verification below the pressure line', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'pi',
      contextTokens: 200_000,
      contextWindow: 500_000,
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 200_000, contextWindow: 272_000 }),
    });
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', {
        contextWindow: 272_000,
        recheckTargetPressure: true,
      }),
    ).resolves.toBe('not-needed');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it('rehydrates cold Pi before using its runtime-verified window', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'pi',
      sdkSessionId: '/tmp/cold-pi-session.jsonl',
      contextTokens: 300_000,
      contextWindow: 200_000,
      model: 'runtime-wide-model',
      providerId: 'xd',
    });
    deps.getLiveSession.mockReturnValueOnce(undefined).mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 0, contextWindow: 1_000_000 }),
    });
    deps.resolveVerifiedWindow.mockReturnValue(200_000);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('rebuilt');
    expect(deps.rehydrateColdPiRuntimeForWindowVerification).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ reason: 'model-window-switch' }),
    );
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('keeps a provenance-less persisted Pi window fail-closed', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'pi',
      contextTokens: 300_000,
      contextWindow: 200_000,
      model: 'unknown-model',
    });
    deps.getLiveSession.mockReturnValue(undefined);
    deps.resolveVerifiedWindow.mockReturnValue(200_000);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('unknown-context');
    expect(deps.rehydrateColdPiRuntimeForWindowVerification).toHaveBeenCalledWith('s1');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('rebuilds a pressured cold local session before its persisted SDK session can resume', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      agentKind: 'cc',
      sdkSessionId: '/tmp/cold-session.jsonl',
      contextTokens: 300_000,
      contextWindow: 500_000,
      model: 'wide-model',
    });
    deps.getLiveSession.mockReturnValue(undefined);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('rebuilt');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ reason: 'model-window-switch' }),
    );
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('fails closed for a pressured cold SSH session without closing or rebuilding it', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      remoteHostId: 'remote-1',
      sdkSessionId: '/tmp/remote-cold-session.jsonl',
      contextTokens: 300_000,
      contextWindow: 500_000,
      model: 'wide-model',
    });
    deps.getLiveSession.mockReturnValue(undefined);
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('remote-unsupported');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it.each([
    [500_000, 0, 'not-needed'],
    [600_000, 0, 'not-needed'],
    [272_000, 244_799, 'not-needed'],
    [272_000, 244_800, 'remote-unsupported'],
  ] as const)(
    'uses persisted cold SSH Pi facts for target %i at usage %i before deciding remote rebuild support',
    async (targetContextWindow, contextTokens, expected) => {
      const deps = makeDeps([msg('user', '继续', 'u1')]);
      deps.getSessionRow.mockResolvedValue({
        ...(await deps.getSessionRow()),
        agentKind: 'pi',
        remoteHostId: 'remote-1',
        sdkSessionId: '/tmp/remote-cold-pi-session.jsonl',
        contextTokens,
        contextWindow: 500_000,
        model: 'wide-model',
      });
      deps.getLiveSession.mockReturnValue(undefined);
      const rollover = createContextOverflowRollover(deps);

      await expect(
        rollover.prepareModelWindowSwitch('s1', { contextWindow: targetContextWindow }),
      ).resolves.toBe(expected);
      expect(deps.rehydrateColdPiRuntimeForWindowVerification).not.toHaveBeenCalled();
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.commitRebuild).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    },
  );

  it('falls back to persisted usage when a lazy live snapshot still reports placeholder zero', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      contextTokens: 300_000,
      contextWindow: 500_000,
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 0, contextWindow: 500_000 }),
    });
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('rebuilt');
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({ reason: 'model-window-switch' }),
    );
  });

  it('keeps a persisted and live zero as authoritative empty usage', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      contextTokens: 0,
      contextWindow: 500_000,
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({ contextTokens: 0, contextWindow: 500_000 }),
    });
    const rollover = createContextOverflowRollover(deps);

    await expect(
      rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
    ).resolves.toBe('not-needed');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it.each([
    [244_799, 'not-needed', false],
    [244_800, 'rebuilt', true],
  ] as const)(
    'uses authoritative positive live usage %i at the 90%% boundary',
    async (contextTokens, expected, rebuilt) => {
      const deps = makeDeps([msg('user', '继续', 'u1')]);
      deps.getSessionRow.mockResolvedValue({
        ...(await deps.getSessionRow()),
        contextTokens: 300_000,
        contextWindow: 500_000,
      });
      deps.getLiveSession.mockReturnValue({
        isTurnRunning: () => false,
        getUsageSnapshot: () => ({ contextTokens, contextWindow: 500_000 }),
      });
      const rollover = createContextOverflowRollover(deps);

      await expect(
        rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 }),
      ).resolves.toBe(expected);
      expect(deps.closeSession).toHaveBeenCalledTimes(rebuilt ? 1 : 0);
      expect(deps.commitRebuild).toHaveBeenCalledTimes(rebuilt ? 1 : 0);
    },
  );

  it('does not retire the native session below the target pressure line', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()),
      contextTokens: 244_799,
      contextWindow: 500_000,
    });
    const beforeClose = vi.fn();
    const rollover = createContextOverflowRollover(deps);
    await expect(
      rollover.prepareModelWindowSwitch('s1', {
        contextWindow: 272_000,
        beforeClose,
      }),
    ).resolves.toBe('not-needed');
    expect(beforeClose).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it('fails closed without mutating a busy or remote pressured session', async () => {
    const busyDeps = makeDeps([msg('user', '继续', 'u1')]);
    busyDeps.getSessionRow.mockResolvedValue({
      ...(await busyDeps.getSessionRow()),
      contextTokens: 244_800,
      contextWindow: 500_000,
    });
    busyDeps.getLiveSession.mockReturnValue({ isTurnRunning: () => true });
    const busy = createContextOverflowRollover(busyDeps);
    await expect(
      busy.prepareModelWindowSwitch('s1', {
        contextWindow: 272_000,
      }),
    ).resolves.toBe('busy');
    expect(busyDeps.closeSession).not.toHaveBeenCalled();

    const remoteDeps = makeDeps([msg('user', '继续', 'u1')]);
    remoteDeps.getSessionRow.mockResolvedValue({
      ...(await remoteDeps.getSessionRow()),
      remoteHostId: 'remote-1',
      contextTokens: 244_800,
      contextWindow: 500_000,
    });
    const remote = createContextOverflowRollover(remoteDeps);
    await expect(
      remote.prepareModelWindowSwitch('s1', {
        contextWindow: 272_000,
      }),
    ).resolves.toBe('remote-unsupported');
    expect(remoteDeps.closeSession).not.toHaveBeenCalled();
  });

  it('rebuilds Codex remote compact encrypted-content failures without a context-overflow reason key', async () => {
    const deps = makeDeps([
      msg('user', '先做 A', 'u1', 1),
      msg('assistant', '做完 A', 'a1', 2),
      msg('user', '再做 B', 'u2', 3),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-1',
      contextTokens: 12_000,
      contextWindow: 200_000,
      model: 'gpt-5.6-sol',
      providerId: 'openai',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', {
        message:
          'Error running remote compact task: { "type": "error", "error": { "code": "invalid_encrypted_content" } }',
      }),
    ).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      expect.objectContaining({
        reason: 'context-overflow',
        sourceUserClientId: 'u2',
        sourceAgentKind: 'codex',
      }),
    );
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '再做 B');
  });

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

  it('rebuilds before send when the trailing error is a Codex remote compact encrypted-content 400', async () => {
    const compactError =
      'Error running remote compact task: { "type": "error", "error": { "code": "invalid_encrypted_content" } }';
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('error', compactError, 'e1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-1',
      contextTokens: 12_000,
      contextWindow: 200_000,
      model: 'gpt-5.6-sol',
      providerId: 'openai',
    });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
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

  it('does not rebuild before send at the compact threshold when the window is not full', async () => {
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
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it('rebuilds before send when occupancy is already full', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'cc',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead-cc',
      contextTokens: 500_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('rebuilds before send when host auto-compact has latched a deterministic failure', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'cc',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: '/tmp/dead-cc',
      contextTokens: 437_712,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
    deps.getLiveSession.mockReturnValue({
      isTurnRunning: () => false,
      getUsageSnapshot: () => ({
        contextTokens: 437_712,
        contextWindow: 500_000,
        needsRollover: true,
      }),
    });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('uses the same full-window pressure guard for Claude Code and Codex before send', async () => {
    for (const agentKind of ['cc', 'codex'] as const) {
      const deps = makeDeps([msg('user', '继续', 'u1'), msg('assistant', '好', 'a1')]);
      deps.getSessionRow.mockResolvedValue({
        status: 'active',
        agentKind,
        remoteHostId: null,
        clearedAt: null,
        sdkSessionId: `/tmp/dead-${agentKind}`,
        contextTokens: 500_000,
        contextWindow: 500_000,
        model: 'model',
        providerId: 'xd',
      });
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
      contextTokens: 500_000,
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
      contextTokens: 500_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
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
      contextTokens: 500_000,
      contextWindow: 500_000,
      model: 'x-ai/grok-4.6',
      providerId: 'xai',
    });
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
      getUsageSnapshot: () => ({ contextTokens: 500_000, contextWindow: 500_000 }),
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
      contextTokens: 500_000,
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

  it('keeps SSH remote sessions out of automatic rollover', async () => {
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

  it('strips oversized Codex history in place instead of forking a Cindy session', async () => {
    const deps = makeDeps([
      msg('user', '继续', 'u1'),
      msg('error', { reason: 'codex_history_oversized', message: 'oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-fat',
      contextTokens: 20_000,
      contextWindow: 200_000,
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    const tryStrip = vi.fn(async () => 'recovered' as const);
    const rollover = createContextOverflowRollover({
      ...deps,
      tryStripOversizedCodexHistory: tryStrip,
    });
    rollover.claim('s1');

    await expect(
      rollover.tryRecover('s1', { reason: 'codex_history_oversized', message: 'oversized' }),
    ).resolves.toBe(true);
    expect(tryStrip).toHaveBeenCalledWith({
      sessionId: 's1',
      threadId: 'thread-fat',
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
  });

  it('falls back to rollover when oversized strip fails', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-fat',
      contextTokens: 20_000,
      contextWindow: 200_000,
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    const rollover = createContextOverflowRollover({
      ...deps,
      tryStripOversizedCodexHistory: vi.fn(async () => 'failed' as const),
    });
    rollover.claim('s1');

    await expect(
      rollover.tryRecover('s1', { reason: 'codex_history_oversized', message: 'oversized' }),
    ).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
  });

  it('does not rebuild when strip reports the turn is still running', async () => {
    const deps = makeDeps([
      msg('user', '继续', 'u1'),
      msg('error', { reason: 'codex_history_oversized', message: 'oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-fat',
      contextTokens: 20_000,
      contextWindow: 200_000,
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    const rollover = createContextOverflowRollover({
      ...deps,
      tryStripOversizedCodexHistory: vi.fn(async () => 'busy' as const),
    });
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'codex_history_oversized', message: 'oversized' }),
    ).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.onRebuilt).not.toHaveBeenCalled();
  });

  it('does not rebuild when oversized strip finds a stale owner', async () => {
    const deps = makeDeps([
      msg('user', '继续', 'u1'),
      msg('error', { reason: 'codex_history_oversized', message: 'oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-fat',
      contextTokens: 20_000,
      contextWindow: 200_000,
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    const rollover = createContextOverflowRollover({
      ...deps,
      tryStripOversizedCodexHistory: vi.fn(async () => 'stale' as const),
    });
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'codex_history_oversized', message: 'oversized' }),
    ).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it('does not rollover before send when current Codex thread is already slim', async () => {
    const deps = makeDeps([
      msg('user', '继续', 'u1'),
      msg('error', { reason: 'codex_history_oversized', message: 'oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'codex',
      remoteHostId: null,
      clearedAt: null,
      sdkSessionId: 'thread-slim',
      contextTokens: 20_000,
      contextWindow: 200_000,
      model: 'gpt-5.6',
      providerId: 'openai',
      workingDir: '/work',
    });
    const rollover = createContextOverflowRollover({
      ...deps,
      tryStripOversizedCodexHistory: vi.fn(async () => 'not-needed' as const),
    });

    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
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
