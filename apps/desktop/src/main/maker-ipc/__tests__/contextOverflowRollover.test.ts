import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_HISTORY_CONTINUE_MESSAGE,
  canContinueContextRecovery,
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
  type ContextOverflowRolloverDeps,
  type OverflowSourceMessage,
  withReplaySourceNotes,
} from '../contextOverflowRollover';
import { buildHandoffText } from '../agentHandoff';

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
    expect(isContextOverflowErrorData({
      reason: 'remote-compact-encrypted-content',
      message: 'Error running remote compact task',
    })).toBe(true);
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

  it('keeps per-row source metadata so the rebuilt handoff still names who sent each message', () => {
    const plan = planContextOverflowRollover([
      {
        ...msg('user', JSON.stringify({ orcaSource: 'worker', content: '报告完成' }), 'u1', 1),
        agentMeta: { origin: { kind: 'orca', senderLabel: 'Backend', senderSessionId: 'ws-1' } },
      },
      msg('assistant', '收到', 'a1', 2),
      {
        ...msg('user', '早报', 'u2', 3),
        agentMeta: { origin: { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: '每日早报' } },
      },
    ]);
    if (plan.action !== 'rebuild') throw new Error('expected rebuild');
    const handoff = buildHandoffText(plan.handoffMessages, {
      fromLabel: 'Codex',
      toLabel: 'Codex',
      reason: 'context-overflow',
    });
    expect(handoff).toContain('[User · 来自 Orca Worker「Backend」(session_id: ws-1)]\n报告完成');
    // 溢出那一条留给 wire 重放, 不进交接。
    expect(handoff).not.toContain('每日早报');
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
          source?: string;
          botRole?: string | null;
          agentKind: string;
          remoteHostId: string | null;
          clearedAt: number | null;
          sdkSessionId: string | null;
          contextTokens: number;
          contextWindow: number;
          model: string;
          providerId: string;
          workingDir?: string | null;
        }> => ({
          status: 'active',
          source: 'desktop',
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
          instanceId?: string;
          getTurnGeneration?(): number;
          isTurnRunning(): boolean;
          listBackgroundTasks?(): ReadonlyArray<unknown>;
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
      replayUserMessage: vi.fn<ContextOverflowRolloverDeps['replayUserMessage']>(async () => ({ accepted: true })),
      readPiNativeCompatOverride: vi.fn((): Record<string, unknown> | undefined => undefined),
      recordPiNativeCompatOverride: vi.fn(async () => true),
      hasExternalRecoveryOwner: vi.fn(() => false),
      onRebuilt: vi.fn(),
      withCloseSuppressed: async <T>(_sessionId: string, fn: () => Promise<T>) => fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };
  }

  it.each(['cc', 'pi'])('recovers a full %s companion through the ordinary Session guard, retaining outcomes without replay', async (agentKind) => {
    const deps = makeDeps([
      msg('user', 'Keep the game keyboard accessible', 'u1'),
      { ...msg('tool_use', { toolName: 'Write', input: { file_path: '/game/index.html' } }, 't1'), toolUseId: 'write-1' },
      { ...msg('tool_result', { fullText: 'Saved index.html; keyboard test passed' }, 'r1'), toolUseId: 'write-1' },
      msg('assistant', 'Keyboard controls are ready. Next: add touch controls.', 'a1'),
    ]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), agentKind, source: 'bot', botRole: 'canonical', contextTokens: 200_000 });
    const withOwn = { ...deps, listCompanionSessionIds: vi.fn(async () => ({ sessionIds: ['s1', 's-old', 's-bg'], chatsTruncated: false })) };
    const rollover = createContextOverflowRollover(withOwn);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    const handoff = deps.setPendingHandoff.mock.calls[0]![1] as string;
    expect(handoff).toContain('Keep the game keyboard accessible');
    expect(handoff).toContain('Saved index.html; keyboard test passed');
    expect(handoff).toContain('Next: add touch controls');
    // 伙伴主对话用"按需回忆"口径:宿主把自有会话 id 写进指引,第一步按 session_ids 限定。
    expect(withOwn.listCompanionSessionIds).toHaveBeenCalledWith('s1');
    expect(handoff).toContain('== Recalling earlier history (use when needed) ==');
    expect(handoff).toContain('{"query":"<keywords>","limit":10,"session_ids":["s1","s-old","s-bg"]}');
    expect(handoff).not.toContain('could list only your newest');
    expect(handoff.length).toBeLessThanOrEqual(16_000);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    // Persisted reset prevents another checkpoint after a cold restart.
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), sdkSessionId: null, contextTokens: 0 });
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.commitRebuild).toHaveBeenCalledTimes(1);
  });

  // Product decision 2026-10-23: companion age / token checkpoints must not
  // replace a healthy native session, regardless of the input channel.
  it.each(['cc', 'pi', 'codex'])('keeps healthy %s companion contexts for native compaction across repeated sends', async (agentKind) => {
    for (const botRole of ['canonical', 'thread', 'channel', 'group']) {
      const old = Date.now() - 48 * 60 * 60 * 1000;
      const source = [msg('user', 'Keep the plan', 'u1', old), msg('assistant', 'Plan retained', 'a1', old + 1)];
      const deps = makeDeps(source);
      const rollover = createContextOverflowRollover(deps);
      for (const contextTokens of [20_000, 140_000, 180_000, 199_999]) {
        deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), agentKind, source: 'bot', botRole, contextTokens });
        await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
        source.push(msg('user', '[UI_ACTION_TRIGGER] continue', 'background'));
        await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
        source.push(msg('user', 'A new question today', 'human', Date.now()));
        await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
      }
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.commitRebuild).not.toHaveBeenCalled();
      expect(deps.setPendingHandoff).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    }
  });

  it('recovers with current-session history when companion recall lookup fails', async () => {
    const deps = {
      ...makeDeps([msg('user', 'Keep going', 'u1'), msg('assistant', 'On it', 'a1')]),
      listCompanionSessionIds: vi.fn(async (): Promise<{ sessionIds: string[]; chatsTruncated: boolean }> => { throw new Error('db'); }),
    };
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', contextTokens: 200_000 });
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.setPendingHandoff.mock.calls[0]![1] as string).toContain('"session_ids":["s1"]}');
  });

  it.each([
    ['desktop', null, 180_000], ['bot', 'delegation', 180_000], ['bot', 'history', 180_000],
    ['bot', null, 180_000], ['bot', 'canonical', 179_999], ['bot', 'channel', 179_999],
    ['bot', 'group', 179_999], ['bot', 'canonical', 0],
  ] as const)('leaves healthy / non-chat bot contexts alone: %s %s %s', async (source, botRole, contextTokens) => {
    const deps = makeDeps([msg('user', 'hello', 'u1'), msg('assistant', 'hello', 'a1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source, botRole, contextTokens });
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['Error running remote compact task: summarization produced empty response', true],
    ['Error running remote compact task: invalid_request_error', true],
    ['Error during compaction: invalid-argument', true],
    ['Error running remote compact task: connection timed out', false],
    ['Error running remote compact task: HTTP 401 unauthorized', false],
    ['Error running remote compact task: HTTP 429 usage limit exceeded', false],
    ['summarization produced empty response', false],
    ['invalid_request_error', false],
  ])('new companion input handles only proven compact failures: %s', async (message, expected) => {
    const deps = makeDeps([msg('user', 'save the game', 'u1'), msg('assistant', 'Saved', 'a1'), msg('error', { message }, 'e1')]);
    const row = { ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', agentKind: 'codex' };
    deps.getSessionRow.mockResolvedValue(row);
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(expected);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    // The new policy is scoped to companions, not all ordinary/manual compaction.
    deps.getSessionRow.mockResolvedValue({ ...row, source: 'desktop', botRole: null });
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(false);
  });

  it.each(['healthy', 'unknown', 'oversized'] as const)('does not scan healthy companion history for speculative rebuilds: %s', async (health) => {
    const deps = makeDeps([msg('user', 'continue the game', 'u1'), msg('assistant', 'ready', 'a1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', agentKind: 'codex' });
    const classifyCodexHistory = vi.fn(async () => health);
    await expect(createContextOverflowRollover({ ...deps, classifyCodexHistory }).prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(classifyCodexHistory).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('continues a direct companion image failure once without replaying a completed tool', async () => {
    const deps = makeDeps([
      msg('user', 'save the game and then test it', 'u1'),
      { ...msg('tool_result', { fullText: 'Game saved successfully' }, 'r1'), toolUseId: 'write-1' },
    ]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', agentKind: 'codex' });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', CODEX_HISTORY_CONTINUE_MESSAGE, undefined,
      expect.objectContaining({ continueFromHistory: true, sourceUserClientId: 'u1' }));
    expect(deps.setPendingHandoff.mock.calls[0]![1]).toContain('Game saved successfully');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['group', 'delegation', null])('does not take over noncanonical Bot recovery: %s', async (botRole) => {
    const deps = makeDeps([msg('user', 'continue', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole, agentKind: 'codex' });
    expect(canContinueContextRecovery(await deps.getSessionRow())).toBe(false);
    await expect(createContextOverflowRollover(deps).tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it('keeps a companion external-dispatch turn with its original owner', async () => {
    const deps = makeDeps([{ ...msg('user', 'scheduled work', 'u1'), agentMeta: { origin: { kind: 'scheduler' } } }]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', agentKind: 'codex' });
    await expect(createContextOverflowRollover(deps).tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it('does not rebuild a full context while native background execution is still active', async () => {
    const deps = makeDeps([msg('user', 'continue', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', contextTokens: 200_000 });
    deps.getLiveSession.mockReturnValue({ isTurnRunning: () => false, listBackgroundTasks: () => [{ id: 'active' }] });
    await expect(createContextOverflowRollover(deps).prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it.each(['history', 'close'])('stopping companion preparation during %s forbids a late rebuild', async (stage) => {
    const deps = makeDeps([msg('user', 'continue', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical', contextTokens: 200_000 });
    const rollover = createContextOverflowRollover(deps);
    if (stage === 'history') deps.listMessages.mockImplementation(async () => { rollover.cancelRecovery('s1'); return [msg('user', 'continue', 'u1')]; });
    else deps.closeSession.mockImplementation(async () => { rollover.cancelRecovery('s1'); });
    await expect(rollover.prepareUnhealthySession('s1')).rejects.toThrow();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    if (stage === 'history') expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it('manual restart retains tool outcomes and strips image bodies even after a partial reply', async () => {
    const deps = makeDeps([
      msg('user', 'create the game', 'u1'),
      { ...msg('tool_result', { content: [{ type: 'text', text: 'Build completed; preview ready' }, { type: 'image', data: 'IMAGE_BYTES' }] }, 'r1'), toolUseId: 'build-1' },
      msg('assistant', 'Checking the preview next', 'a1'),
    ]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'canonical' });
    await createContextOverflowRollover(deps).prepareNativeSessionRecovery('s1', null, vi.fn());
    const handoff = deps.setPendingHandoff.mock.calls[0]![1];
    expect(handoff).toContain('Build completed; preview ready');
    expect(handoff).not.toContain('IMAGE_BYTES');
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  // 「消息平台」页对 IM 专线点「重新开始」走同一条显式重启: 交接要按伙伴对话口径(与空闲间隔
  // 刷新一致)带按需回忆指引, 不能像普通任务那样退化成无回忆的交接。
  it('explicit restart of an IM channel lane writes the companion handoff with recall guidance', async () => {
    const deps = makeDeps([msg('user', 'group asked about the release', 'u1', 1), msg('assistant', 'Release is Friday', 'a1', 2)]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', botRole: 'channel' });
    const withOwn = { ...deps, listCompanionSessionIds: vi.fn(async () => ({ sessionIds: ['s1', 's-main'], chatsTruncated: false })) };
    await createContextOverflowRollover(withOwn).prepareNativeSessionRecovery('s1', null, vi.fn());
    const handoff = deps.setPendingHandoff.mock.calls[0]![1] as string;
    expect(handoff).toContain('Release is Friday');
    expect(handoff).toContain('== Recalling earlier history (use when needed) ==');
    expect(handoff).toContain('"session_ids":["s1","s-main"]');
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it.each(['cc', 'codex', 'pi'] as const)('explicit Bot restart replaces a running %s context without replay', async (agentKind) => {
    const deps = makeDeps([msg('user', 'keep my request', 'u1', 1)]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', agentKind });
    deps.getLiveSession.mockReturnValue({ isTurnRunning: () => true });
    deps.closeSession.mockImplementation(async () => {
      deps.listMessages.mockResolvedValue([
        msg('user', 'keep my request', 'u1', 1),
        msg('assistant', 'saved before close', 'a1', 2),
      ]);
    });
    await createContextOverflowRollover(deps).prepareNativeSessionRecovery('s1', null, vi.fn());
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.stringContaining('saved before close'),
      expect.objectContaining({ reason: 'native-session-recovery', sourceAgentKind: agentKind }));
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.any(String),
      expect.not.objectContaining({ replacementRoute: expect.anything() }));
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('can restart a Bot before a native handle was ever created', async () => {
    const deps = makeDeps([]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot', sdkSessionId: null, contextTokens: 0 });
    await createContextOverflowRollover(deps).prepareNativeSessionRecovery('s1', null, vi.fn());
    expect(deps.commitRebuild).toHaveBeenCalledOnce();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('does not reset history bindings or publish success when the old Bot cannot close', async () => {
    const deps = makeDeps([msg('user', 'keep', 'u1', 1)]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), source: 'bot' });
    deps.getLiveSession.mockReturnValue({ isTurnRunning: () => true });
    deps.closeSession.mockRejectedValueOnce(new Error('close failed'));
    const recovery = createContextOverflowRollover(deps);
    await expect(recovery.prepareNativeSessionRecovery('s1', null, vi.fn())).rejects.toThrow('close failed');
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    await recovery.prepareNativeSessionRecovery('s1', null, vi.fn());
    expect(deps.commitRebuild).toHaveBeenCalledOnce();
  });

  it.each(['cc', 'codex', 'pi'] as const)('native recovery carries %s history and the full target route without replay', async (agentKind) => {
    const deps = makeDeps([msg('user', 'KEEP_CONTEXT', 'u1', 1), msg('assistant', 'already finished', 'a1', 2)]);
    const row = await deps.getSessionRow();
    deps.getSessionRow.mockResolvedValue({ ...row, agentKind });
    const target = { model: 'gpt-6-astra', providerId: 'openai', effort: 'high', fastMode: false };
    const assertCurrent = vi.fn();
    await createContextOverflowRollover(deps).prepareNativeSessionRecovery('s1', target, assertCurrent);
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.stringContaining('KEEP_CONTEXT'), expect.objectContaining({
      reason: 'native-session-recovery', sourceAgentKind: agentKind,
      replacementRoute: { ...target, expectedSdkSessionId: row.sdkSessionId },
    }));
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.stringContaining('already finished'), 3);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it('keeps the original native binding when the recorded conversation cannot be loaded', async () => {
    const deps = makeDeps([]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), contextTokens: 1200 });
    await expect(createContextOverflowRollover(deps).prepareNativeSessionRecovery('s1', {
      model: 'gpt-6-astra', providerId: 'openai', effort: null, fastMode: false,
    }, vi.fn())).rejects.toThrow('Cindy history is unavailable');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it.each(['commit', 'owner', 'busy'] as const)('native recovery failure at %s does not publish a handoff and remains retryable', async (failure) => {
    const deps = makeDeps([msg('user', 'keep', 'u1', 1)]);
    const assertCurrent = vi.fn();
    if (failure === 'commit') deps.commitRebuild.mockRejectedValueOnce(new Error('disk full'));
    if (failure === 'owner') assertCurrent.mockImplementationOnce(() => { throw new Error('owner changed'); });
    if (failure === 'busy') deps.getLiveSession.mockReturnValueOnce({ isTurnRunning: () => true });
    const recovery = createContextOverflowRollover(deps);
    const target = { model: 'gpt-6-astra', providerId: 'openai', effort: 'high', fastMode: true };
    await expect(recovery.prepareNativeSessionRecovery('s1', target, assertCurrent)).rejects.toThrow();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
    await recovery.prepareNativeSessionRecovery('s1', target, assertCurrent);
    expect(deps.setPendingHandoff).toHaveBeenCalledOnce();
  });

  it.each(['cc', 'pi'] as const)(
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

  it.each([
    'Error running remote compact task: { "type": "error", "error": { "code": "invalid_encrypted_content" } }',
    'CINDY_ENCRYPTED_COMPACTION_INCOMPATIBLE',
  ])('rebuilds proven Codex compaction failures without a context-overflow reason key: %s', async (message) => {
    const deps = makeDeps([
      msg('user', '先做 A', 'u1', 1),
      msg('assistant', '做完 A', 'a1', 2),
      msg('user', '再做 B', 'u2', 3),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      source: 'desktop',
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
        message,
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
      expect.any(AbortSignal),
    );
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '再做 B', undefined, { signal: expect.any(AbortSignal) });
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
      expect.any(AbortSignal),
    );
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.any(String), 3);
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).toContain('先做 A');
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).not.toContain('再做 B');
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '再做 B', undefined, { signal: expect.any(AbortSignal) });
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

  describe('pi provider compat self-heal', () => {
    const receipt = { piCacheRecoverySafe: true, piCacheCompatibility: { providerId: 'opencode-go', modelId: 'glm-5.3-flash', wireModelId: 'glm-5.3-flash', routeKey: 'a'.repeat(64), applied: false } };
    const rejection =
      '400: {"param":"prompt_cache_retention","type":"invalid_request_error","message":'
      + '"Error from provider (Console Go): Upstream request failed: [invalid_request_error] '
      + 'prompt_cache_retention is not supported by this endpoint; use prompt_cache_options"}';

    function makePiDeps(source: OverflowSourceMessage[]) {
      const deps = makeDeps(source);
      deps.getSessionRow.mockResolvedValue({
        status: 'active',
        source: 'desktop',
        agentKind: 'pi',
        remoteHostId: null,
        clearedAt: null,
        sdkSessionId: '/tmp/glm.jsonl',
        contextTokens: 0,
        contextWindow: 1_000_000,
        model: 'glm-5.3-flash',
        providerId: 'opencode-go',
      });
      return deps;
    }

    it('does not stack legacy rebuild or learning on a native cache recovery decision', async () => {
      const deps = makePiDeps([msg('user', 'Reply OK', 'u1', 1)]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      expect(await rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection,
        piCacheRecoveryHandled: true })).toBe(false);
      expect(deps.recordPiNativeCompatOverride).not.toHaveBeenCalled();
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it.each([
      rejection,
      ...['prompt_cache_key', 'prompt_cache_retention'].map(field => '400: ' + JSON.stringify({
        code: null, message: `Validation: Unsupported parameter(s): \`${field}\``, param: null, type: 'invalid_request_error',
      })),
    ])('learns the per-model compat fix once and replays the failed turn: %s', async (rejection) => {
      const deps = makePiDeps([
        msg('user', '继续修这个 bug', 'u1', 1),
        msg('assistant', '改完了，正在跑测试', 'a1', 2),
        msg('user', '再跑一遍', 'u2', 3),
      ]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(true);

      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledWith(
        'opencode-go',
        'glm-5.3-flash',
        { supportsLongCacheRetention: false },
        'a'.repeat(64),
      );
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      // 重建用的 models.json 已去掉被拒收字段，重放同一轮用户消息即重试。
      expect(deps.replayUserMessage).toHaveBeenCalledWith(
        's1',
        '再跑一遍',
        undefined,
        expect.objectContaining({
          continueFromHistory: true,
          sourceUserContent: '再跑一遍',
          sourceUserClientId: 'u2',
        }),
      );
      expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
      // 不发布 context-overflow 式的手递手重建文案。
      expect(deps.commitRebuild).not.toHaveBeenCalled();
      expect(deps.setPendingHandoff).not.toHaveBeenCalled();
    });

    it('preserves shared-member and device source notes on cache recovery', async () => {
      const source = msg('user', 'original text', 'u1', 1);
      source.agentMeta = { sharedTaskAuthor: { memberId: 'm-1', displayName: '张三' }, sourceDevice: { deviceId: 'phone-1', name: 'iPhone', platform: 'mobile' } };
      const deps = makePiDeps([source]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      expect(await rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection })).toBe(true);
      const call = deps.replayUserMessage.mock.calls[0];
      expect(call?.[1]).toBe('original text');
      expect(JSON.stringify(call?.[2])).toContain('本条由共享任务成员「张三」');
      expect(JSON.stringify(call?.[2])).toContain('[客户端说明]');
      expect(JSON.stringify(call?.[2])).toContain('phone-1');
      expect(call?.[3]).toMatchObject({ continueFromHistory: true, sourceCapabilitySelectionText: 'original text' });
    });

    it.each([{ instanceId: 'i2', generation: 1 }, { instanceId: 'i1', generation: 2 }])('keeps a fast replay failure after a new terminal aborts old recovery: %j', async next => {
      const deps = makePiDeps([msg('user', 'original', 'u1', 1)]);
      deps.getLiveSession.mockReturnValue({ instanceId: 'i1', getTurnGeneration: () => 1, isTurnRunning: () => false });
      const rollover = createContextOverflowRollover(deps);
      const old = { instanceId: 'i1', generation: 1 };
      deps.replayUserMessage.mockImplementation(async () => {
        expect(rollover.claim('s1', old)).toBe('in-flight');
        expect(rollover.claim('s1', next)).toBe('idle');
        return { accepted: true };
      });
      expect(rollover.claim('s1', old)).toBe('claimed');
      expect(await rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }, old)).toBe(true);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
      expect(deps.onRebuilt).not.toHaveBeenCalled();
      expect(rollover.claim('s1', next)).toBe('claimed');
    });

    it('leaves non-target 400s to the normal error surface', async () => {
      const deps = makePiDeps([msg('user', '继续', 'u1', 1)]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', {
          message: '400: {"type":"invalid_request_error","message":"prompt_cache_retention conflicts with prompt_cache_options"}',
        }),
      ).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).not.toHaveBeenCalled();
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it.each(['late-instance', 'late-generation', 'changed-instance', 'changed-generation', 'new-input', 'cancel'])('does not retire or replay a changed source: %s', async (scenario) => {
      const source = [msg('user', 'original', 'u1', 1)];
      const deps = makePiDeps(source);
      let instanceId = 'i1';
      let generation = 1;
      deps.getLiveSession.mockImplementation(() => ({ instanceId, getTurnGeneration: () => generation, isTurnRunning: () => false }));
      deps.recordPiNativeCompatOverride.mockImplementation(async () => {
        if (scenario === 'changed-instance') instanceId = 'i2';
        if (scenario === 'changed-generation') generation = 2;
        if (scenario === 'new-input') source.push(msg('user', 'new input', 'u2', 2));
        if (scenario === 'cancel') rollover.cancelRecovery('s1');
        return true;
      });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      const result = rollover.tryRecover('s1', { ...receipt, message: rejection }, {
        instanceId: scenario === 'late-instance' ? 'old' : 'i1',
        generation: scenario === 'late-generation' ? 0 : 1,
      });
      // Cancellation is consumed by the existing recovery abort handler.
      await expect(result).resolves.toBe(scenario === 'cancel');
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
      if (scenario.startsWith('late')) expect(deps.recordPiNativeCompatOverride).not.toHaveBeenCalled();
    });

    it.each(['missing-receipt', 'already-applied', 'wrong-provider', 'wrong-model'])('does not learn from an unverified route: %s', async (scenario) => {
      const deps = makePiDeps([msg('user', 'original', 'u1', 1)]);
      const route = { ...receipt.piCacheCompatibility };
      if (scenario === 'already-applied') route.applied = true;
      if (scenario === 'wrong-provider') route.providerId = 'another-connection';
      if (scenario === 'wrong-model') route.modelId = 'another-model';
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      await expect(rollover.tryRecover('s1', { message: rejection, piCacheCompatibility: scenario === 'missing-receipt' ? undefined : route, piCacheRecoverySafe: true })).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).not.toHaveBeenCalled();
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('learns but never replays output that has not reached persisted history', async () => {
      const deps = makePiDeps([msg('user', 'original', 'u1', 1)]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      await expect(rollover.tryRecover('s1', { ...receipt, message: rejection, piCacheRecoverySafe: false })).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledOnce();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('applies an already-learned override to a runtime that never had it', async () => {
      // 同一 provider/model 的另一个会话先学到并重建；本会话启动时的 models.json 还没
      // 有该覆盖，普通发送也不会刷新模型配置 —— 这里必须让它应用覆盖并重建一次。
      const deps = makePiDeps([
        msg('user', '继续修这个 bug', 'u1', 1),
        msg('assistant', '改完了，正在跑测试', 'a1', 2),
        msg('user', '再跑一遍', 'u2', 3),
      ]);
      deps.readPiNativeCompatOverride.mockReturnValue({ supportsLongCacheRetention: false });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(true);

      expect(deps.recordPiNativeCompatOverride).not.toHaveBeenCalled();
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.replayUserMessage).toHaveBeenCalledWith(
        's1',
        '再跑一遍',
        undefined,
        expect.objectContaining({ continueFromHistory: true, sourceUserClientId: 'u2' }),
      );
      expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
    });

    it('does not rebuild a runtime that already rebuilt with the learned fix', async () => {
      const deps = makePiDeps([
        msg('user', '继续修这个 bug', 'u1', 1),
        msg('assistant', '改完了，正在跑测试', 'a1', 2),
        msg('user', '再跑一遍', 'u2', 3),
      ]);
      deps.readPiNativeCompatOverride.mockReturnValue({ supportsLongCacheRetention: false });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      const failure = { ...receipt, reason: 'unsupported-request-option', message: rejection };

      // 第一次：旧 runtime 应用磁盘上的覆盖并重建、重放。
      await expect(
        rollover.tryRecover('s1', failure, { instanceId: 'i1', generation: 1 }),
      ).resolves.toBe(true);
      expect(deps.closeSession).toHaveBeenCalledTimes(1);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);

      // 重建后的新一轮仍然收到同一类 400：覆盖没解决问题，直接交常规错误面，
      // 绝不再次 close/重放（否则同一条 400 会无限重建）。
      await expect(
        rollover.tryRecover('s1', failure, { instanceId: 'i2', generation: 2 }),
      ).resolves.toBe(false);
      expect(deps.closeSession).toHaveBeenCalledTimes(1);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
      expect(deps.onRebuilt).toHaveBeenCalledTimes(1);
    });

    it('does not let one model rebuild block self-heal after a model switch', async () => {
      const row = {
        status: 'active',
        source: 'desktop',
        agentKind: 'pi',
        remoteHostId: null,
        clearedAt: null,
        sdkSessionId: '/tmp/glm.jsonl',
        contextTokens: 0,
        contextWindow: 1_000_000,
        model: 'glm-5.3-flash',
        providerId: 'opencode-go',
      };
      const deps = makePiDeps([
        msg('user', '继续修这个 bug', 'u1', 1),
        msg('assistant', '改完了，正在跑测试', 'a1', 2),
        msg('user', '再跑一遍', 'u2', 3),
      ]);
      deps.getSessionRow.mockResolvedValue(row);
      // 两个 pair 的覆盖都已被学到（另一个会话先学到的），唯一差别是本会话的重建历史。
      deps.readPiNativeCompatOverride.mockReturnValue({ supportsLongCacheRetention: false });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      const failure = { ...receipt, reason: 'unsupported-request-option', message: rejection };

      await expect(
        rollover.tryRecover('s1', failure, { instanceId: 'i1', generation: 1 }),
      ).resolves.toBe(true);
      expect(deps.closeSession).toHaveBeenCalledTimes(1);

      // 用户切到同 provider 的另一个模型：它的覆盖是别的会话后来学到的，本会话的
      // runtime 还没应用过 —— 不能被 glm 那次重建的记录挡住。
      row.model = 'other-model';
      failure.piCacheCompatibility = { ...receipt.piCacheCompatibility, modelId: 'other-model', wireModelId: 'other-model' };
      deps.listMessages.mockResolvedValue([msg('user', 'new input', 'u3', 4)]);
      await expect(
        rollover.tryRecover('s1', failure, { instanceId: 'i2', generation: 2 }),
      ).resolves.toBe(true);
      expect(deps.closeSession).toHaveBeenCalledTimes(2);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(2);
    });

    it('learns the fix but does not replay when the plan cannot replay', async () => {
      // 零产出守卫（无用户消息/已有副作用）不阻止学习：关掉旧 runtime 并把修正落盘，
      // 下一次发送重建时就生效。
      const deps = makePiDeps([
        msg('assistant', '已经改了文件', 'a1', 1),
        msg('error', { ...receipt, reason: 'unsupported-request-option', message: rejection }, 'e1', 2),
      ]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledWith(
        'opencode-go',
        'glm-5.3-flash',
        { supportsLongCacheRetention: false },
        'a'.repeat(64),
      );
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('learns the fix but leaves replay to an external dispatcher turn', async () => {
      // Orca/scheduler 派单轮次：正文经 wire 投影可能退化，且 owner 有自己的重试语义，
      // 不能代它重放（会双跑或空转）；仍要学习并关掉旧 runtime。
      const dispatched = { ...msg('user', '{"orcaSource":"lead","content":"do it"}', 'u1', 1),
        agentMeta: { origin: { kind: 'orca' } } };
      const deps = makePiDeps([dispatched]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledWith(
        'opencode-go',
        'glm-5.3-flash',
        { supportsLongCacheRetention: false },
        'a'.repeat(64),
      );
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
      expect(deps.onRebuilt).not.toHaveBeenCalled();
      // Persist before retiring the runtime: failed writes must leave it intact.
      expect(deps.recordPiNativeCompatOverride.mock.invocationCallOrder[0]).toBeLessThan(
        deps.closeSession.mock.invocationCallOrder[0],
      );
    });

    it('learns the fix but leaves replay to a headless/bound owner', async () => {
      const deps = makePiDeps([msg('user', '继续', 'u1', 1)]);
      deps.hasExternalRecoveryOwner.mockReturnValue(true);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledOnce();
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('preserves external ownership released during terminal processing', async () => {
      const deps = makePiDeps([msg('user', '继续', 'u1', 1)]);
      deps.hasExternalRecoveryOwner.mockReturnValue(true);
      deps.drainPersistQueue.mockImplementation(async () => {
        deps.hasExternalRecoveryOwner.mockReturnValue(false);
      });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(rollover.tryRecover('s1', {
        ...receipt, reason: 'unsupported-request-option', message: rejection,
      })).resolves.toBe(false);
      expect(deps.recordPiNativeCompatOverride).toHaveBeenCalledOnce();
      expect(deps.closeSession).toHaveBeenCalledWith('s1');
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('does not replay when the learned override never reached disk', async () => {
      // 存储返回 false（键不合法/磁盘失败）时不能重放：闩锁永远为假，会无限重试同一个 400。
      const deps = makePiDeps([msg('user', '再跑一遍', 'u2', 1)]);
      deps.recordPiNativeCompatOverride.mockResolvedValue(false);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(false);
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
      expect(deps.onRebuilt).not.toHaveBeenCalled();
    });

    it('does not replay when persisting the learned override throws', async () => {
      const deps = makePiDeps([msg('user', '再跑一遍', 'u2', 1)]);
      deps.recordPiNativeCompatOverride.mockRejectedValue(new Error('disk full'));
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');

      await expect(
        rollover.tryRecover('s1', { ...receipt, reason: 'unsupported-request-option', message: rejection }),
      ).resolves.toBe(false);
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    });

    it('drops a repeated terminal error after the self-heal already replayed the turn', async () => {
      const deps = makePiDeps([msg('user', '再跑一遍', 'u2', 1)]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      await expect(
        rollover.tryRecover(
          's1',
          { ...receipt, reason: 'unsupported-request-option', message: rejection },
          { instanceId: 'inst-1', generation: 1 },
        ),
      ).resolves.toBe(true);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);

      // 同一轮重复终态 error（此时历史里已有重放产出的 assistant）：直接丢弃，
      // 不再 surface —— 否则已自动续跑的任务里会挂一张 400 错误卡。
      deps.listMessages.mockResolvedValue([
        msg('user', '再跑一遍', 'u2', 1),
        msg('assistant', '已经回复过了', 'a1', 2),
      ]);
      rollover.claim('s1');
      await expect(
        rollover.tryRecover(
          's1',
          { ...receipt, reason: 'unsupported-request-option', message: rejection },
          { instanceId: 'inst-1', generation: 1 },
        ),
      ).resolves.toBe(true);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
      expect(deps.onRebuilt).toHaveBeenCalledTimes(1);
    });

    it('surfaces a same-signature failure from the replayed turn (new turn identity)', async () => {
      // 重放产生的新一轮失败必须如实上报：不能因为 clientId 相同就被当成旧终态的重复投递。
      const deps = makePiDeps([msg('user', '再跑一遍', 'u2', 1)]);
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      await expect(
        rollover.tryRecover(
          's1',
          { ...receipt, reason: 'unsupported-request-option', message: rejection },
          { instanceId: 'inst-1', generation: 1 },
        ),
      ).resolves.toBe(true);

      deps.listMessages.mockResolvedValue([
        msg('user', '再跑一遍', 'u2', 1),
        msg('assistant', '重放又失败了', 'a1', 2),
      ]);
      rollover.claim('s1');
      await expect(
        rollover.tryRecover(
          's1',
          { ...receipt, reason: 'unsupported-request-option', message: rejection },
          { instanceId: 'inst-2', generation: 2 },
        ),
      ).resolves.toBe(false);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
    });
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
    const rollover = createContextOverflowRollover({ ...deps, hasExternalRecoveryOwner: () => true });
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

  // Regression: the empty model-switch divider used to count as a side effect.
  // Exercise the recovery entry point: only metadata may be ignored, never output.
  it.each([
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra', modelOnly: true } }, true],
    ['Already sent the approval.', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra', modelOnly: true } }, false],
    ['', null, false],
    ['', { modelChange: {} }, false],
    ['', { modelChange: { toModel: 'gpt-6-astra', modelOnly: true } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', modelOnly: true } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra' } }, false],
    ['', { modelChange: { fromModel: 1, toModel: 'gpt-6-astra', modelOnly: true } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: null, modelOnly: true } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra', modelOnly: false } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra', modelOnly: 1 } }, false],
    ['', { modelChange: { fromModel: 'gpt-6-sol', toModel: 'gpt-6-astra', modelOnly: 'true' } }, false],
    ['', { modelChange: [] }, false],
  ])('recovers remote compact failure only for a pure model marker (%j)', async (content, agentMeta, expected) => {
    const deps = makeDeps([
      msg('user', 'Continue the pending work', 'u1'),
      { ...msg('assistant', content, 'm1'), agentMeta },
    ]);
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', {
      message: 'Error running remote compact task: invalid_encrypted_content',
    })).resolves.toBe(expected);
    if (expected) {
      expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.any(String), expect.objectContaining({ sourceUserClientId: 'u1' }), expect.anything());
      expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', 'Continue the pending work', undefined, expect.anything());
    } else {
      expect(deps.commitRebuild).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    }
  });

  it('rebuilds before send when the trailing error is a Codex remote compact encrypted-content 400', async () => {
    const compactError =
      'Error running remote compact task: { "type": "error", "error": { "code": "invalid_encrypted_content" } }';
    const deps = makeDeps([msg('user', '继续', 'u1'), msg('error', compactError, 'e1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      source: 'desktop',
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

  it.each(['pi compact failed: 413', 'pi rpc timeout after 1000ms: compact', 'pi compact failed: upstream connection closed'])(
    'recovers a persisted Pi byte-limit compaction failure after its runtime closed: %s', async error => {
    const deps = makeDeps([
      msg('user', 'Continue', 'u1'),
      msg('error', JSON.stringify({ message: `PI_REQUEST_BODY_RECOVERY_EXHAUSTED: ${error}` }), 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active', agentKind: 'pi', remoteHostId: null, clearedAt: null,
      sdkSessionId: '/tmp/pi-session', contextTokens: 0, contextWindow: 1_000_000,
      model: 'test-model', providerId: 'local-test',
    });
    deps.getLiveSession.mockReturnValue(undefined);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it.each([
    '413 Failed to buffer the request body: length limit exceeded',
    'PI_REQUEST_BODY_RECOVERY_EXHAUSTED: pi compact failed: upstream connection closed',
  ])('recovers a Pi byte-limit failure on the failed turn without resending old images: %s', async message => {
    const imageMessage = JSON.stringify({ text: '查看图片', images: [{ data: 'data:image/png;base64,AAAA' }], files: [] });
    const deps = makeDeps([
      msg('user', imageMessage, 'u1', 1),
      msg('assistant', '图片中有一只猫', 'a1', 2),
      msg('user', '接着做', 'u2', 3),
    ]);
    const rollover = createContextOverflowRollover(deps);
    expect(rollover.claim('s1')).toBe('claimed');
    await expect(rollover.tryRecover('s1', { message })).resolves.toBe(true);
    expect(deps.closeSession).toHaveBeenCalledWith('s1');
    expect(deps.commitRebuild).toHaveBeenCalledOnce();
    const handoff = (deps.commitRebuild.mock.calls as unknown as Array<[string, string]>)[0]?.[1] ?? '';
    expect(handoff).toContain('图片中有一只猫');
    expect(handoff).not.toContain('data:image/png;base64');
    expect(handoff).not.toContain('接着做');
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '接着做', undefined, { signal: expect.any(AbortSignal) });
    expect(deps.onRebuilt).toHaveBeenCalledOnce();
  });

  it('rebuilds a Pi session after its first request-body 413 without retrying the oversized history', async () => {
    const error = { message: '413 Failed to buffer the request body: length limit exceeded' };
    const imageMessage = JSON.stringify({ text: '之前的内容', images: [{ data: 'data:image/png;base64,AAAA' }], files: [] });
    const source = [msg('user', imageMessage, 'u1'), msg('assistant', '已完成', 'a1'),
      msg('user', '继续', 'u2'), msg('error', JSON.stringify(error), 'e1')];
    expect(findLatestRebuildableError(source, true)).toEqual(error);
    expect(findLatestRebuildableError(source, false)).toBeNull();
    expect(shouldRebuildPiNativeSession(error)).toBe(true);
    expect(shouldRebuildPiNativeSession({ sdkError: '413 length limit exceeded' })).toBe(true);
    expect(shouldRebuildPiNativeSession({ message: '413 invalid authentication' })).toBe(false);

    const deps = makeDeps(source);
    deps.getSessionRow.mockResolvedValue({
      status: 'active', agentKind: 'pi', remoteHostId: null, clearedAt: null,
      sdkSessionId: '/tmp/pi-session', contextTokens: 10_000, contextWindow: 1_000_000,
      model: 'test-model', providerId: 'local-test',
    });
    deps.getLiveSession.mockReturnValue(undefined);
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledOnce();
    expect(deps.commitRebuild).toHaveBeenCalledWith(
      's1', expect.stringContaining('已完成'),
      expect.objectContaining({ sourceUserClientId: 'u2' }), expect.anything(),
    );
    const handoff = (deps.commitRebuild.mock.calls as unknown as Array<[string, string]>)[0]?.[1] ?? '';
    expect(handoff).not.toContain('继续');
    expect(handoff).not.toContain('data:image/png;base64');
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

  it('lets Codex handle full-window pressure natively while keeping the Claude guard', async () => {
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

      await expect(rollover.prepareUnhealthySession(`session-${agentKind}`)).resolves.toBe(agentKind === 'cc');
      expect(deps.commitRebuild).toHaveBeenCalledTimes(agentKind === 'cc' ? 1 : 0);
      deps.commitRebuild.mockClear();
    }
  });

  // Unit: the direct/Orca switch path must not bypass the native-first gate.
  // Both persisted and live usage can exceed the target without any native error.
  it.each([false, true])('preserves Codex history through shrink and send preflight (companion=%s)', async (companion) => {
    const deps = makeDeps([msg('user', 'Continue the task', 'u1'), msg('assistant', 'Progress', 'a1')]);
    deps.getSessionRow.mockResolvedValue({ ...await deps.getSessionRow(), agentKind: 'codex',
      ...(companion ? { source: 'bot', botRole: 'canonical' } : {}),
      contextTokens: 480_000, contextWindow: 500_000 });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareModelWindowSwitch('s1', { contextWindow: 272_000 })).resolves.toBe('not-needed');
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.setPendingHandoff).not.toHaveBeenCalled();
  });

  it('fails closed when a pre-send rebuild cannot commit', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1'),
      msg('error', { reason: 'context-overflow', message: 'Context window exceeded' }, 'e1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      source: 'desktop',
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
      expect.any(AbortSignal),
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
      expect.any(AbortSignal),
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
      source: 'desktop',
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
      source: 'desktop',
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

  it('rebuilds oversized history after tool execution and continues without replaying the request', async () => {
    const deps = makeDeps([
      msg('user', 'Send the report once, then check delivery', 'u1'),
      msg('tool_use', { toolUseId: 't1', toolName: 'send_report', input: { report: 'weekly' } }, 't1'),
      { ...msg('tool_result', 'Report sent: delivery id 42', 'r1'), toolUseId: 't1' },
      msg('assistant', 'Report sent; checking delivery', 'a1'),
    ]);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()), agentKind: 'codex', sdkSessionId: 'fat-thread',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.stringContaining('Report sent: delivery id 42'),
      expect.objectContaining({ sourceUserClientId: 'u1' }), expect.any(AbortSignal));
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', CODEX_HISTORY_CONTINUE_MESSAGE, undefined,
      expect.objectContaining({ continueFromHistory: true, sourceUserClientId: 'u1' }));
  });

  it('inherits input intent and allows only one continuation per user input', async () => {
    const source = [
      { ...msg('user', '继续', 'u1'), agentMeta: { agentFacingWireContent: {
        type: 'user', content: [
          { type: 'text', text: 'Use $image-plugin to finish this image' },
          { type: 'image', path: '/retained/image.png' },
        ],
      } } },
      msg('assistant', 'Already changed files; still checking the result', 'a1'),
    ];
    const deps = makeDeps(source);
    deps.getSessionRow.mockResolvedValue({
      ...(await deps.getSessionRow()), agentKind: 'codex', sdkSessionId: 'fat-thread',
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.replayUserMessage).toHaveBeenCalledWith(
      's1', CODEX_HISTORY_CONTINUE_MESSAGE, undefined,
      { signal: expect.any(AbortSignal), continueFromHistory: true, sourceUserContent: '继续', sourceUserClientId: 'u1',
        sourceCapabilitySelectionText: 'Use $image-plugin to finish this image' },
    );
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.commitRebuild).toHaveBeenCalledTimes(1);
    expect(deps.replayUserMessage).toHaveBeenCalledTimes(1);
    source.push(msg('user', 'Now check a different image', 'u2'));
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.replayUserMessage).toHaveBeenCalledTimes(2);
  });

  it('does not repeat a committed image recovery after a host restart', async () => {
    const deps = makeDeps([msg('user', 'finish the task', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    const rollover = createContextOverflowRollover({
      ...deps,
      findLatestRebuildMeta: async () => ({ reason: 'context-overflow', sourceUserClientId: 'u1' }),
    });
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('recovers the input identity outside a tool-heavy history window', async () => {
    const deps = makeDeps([
      { ...msg('tool_result', 'Saved revision 42', 'r1'), toolUseId: 't1' },
    ]);
    deps.findLatestUser.mockResolvedValue(msg('user', 'Save once then verify', 'u1'));
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.stringContaining('Save once then verify'),
      expect.objectContaining({ sourceUserClientId: 'u1' }), expect.any(AbortSignal));
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', CODEX_HISTORY_CONTINUE_MESSAGE, undefined,
      expect.objectContaining({ sourceUserClientId: 'u1' }));
  });

  it.each(['claimed', 'plan', 'close', 'commit', 'dispatch'] as const)(
    'cancels image recovery during %s without advancing the old request', async (phase) => {
      const deps = makeDeps([msg('user', 'old request', 'u1')]);
      deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
      const cancelAt = (point: string) => {
        if (phase === point) rollover.cancelRecovery('s1');
      };
      const rollover = createContextOverflowRollover({
        ...deps,
        findLatestRebuildMeta: async () => { cancelAt('plan'); return null; },
        closeSession: async () => { await deps.closeSession(); cancelAt('close'); },
        commitRebuild: async (...args) => {
          expect(args[3]?.aborted).toBe(false);
          await deps.commitRebuild();
          cancelAt('commit');
        },
        replayUserMessage: async (...args) => {
          await deps.replayUserMessage(...args);
          cancelAt('dispatch');
          expect(args[3]?.signal?.aborted).toBe(true);
          throw new Error('dispatch cancelled');
        },
      });
      rollover.claim('s1');
      cancelAt('claimed');
      await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
      expect(deps.closeSession).toHaveBeenCalledTimes(['claimed', 'plan'].includes(phase) ? 0 : 1);
      expect(deps.commitRebuild).toHaveBeenCalledTimes(['commit', 'dispatch'].includes(phase) ? 1 : 0);
      expect(deps.replayUserMessage).toHaveBeenCalledTimes(phase === 'dispatch' ? 1 : 0);
      expect(deps.onRebuilt).not.toHaveBeenCalled();
      expect(rollover.claim('s1')).toBe('claimed');
    },
  );

  it('honors the coordinator cancellation signal while closing the old runtime', async () => {
    const deps = makeDeps([msg('user', 'old request', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    const cancellation = new AbortController();
    const rollover = createContextOverflowRollover({
      ...deps, getRecoveryAbortSignal: () => cancellation.signal,
      closeSession: async () => { cancellation.abort(); },
    });
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(true);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it.each(['slack-hook', 'telegram', undefined, 'bound', 'detached-active'])(
    'leaves oversized recovery to its external owner: %s', async (origin) => {
      const deps = makeDeps([msg('user', 'old desktop request', 'u1')]);
      deps.getSessionRow.mockResolvedValue({
        ...(await deps.getSessionRow()), agentKind: 'codex',
        source: origin === 'bound' || origin === 'detached-active' ? 'desktop' : origin,
      });
      let externalTurnActive = origin === 'bound' || origin === 'detached-active';
      const rollover = createContextOverflowRollover({
        ...deps, hasExternalRecoveryOwner: () => externalTurnActive,
      });
      rollover.claim('s1');
      const recovery = rollover.tryRecover('s1', { reason: 'codex_history_oversized' });
      externalTurnActive = false;
      await expect(recovery).resolves.toBe(false);
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
      expect(deps.commitRebuild).not.toHaveBeenCalled();
    },
  );

  it.each([{ origin: { kind: 'scheduler' } }, { origin: { kind: 'orca' } }, { hookSource: 'im' }])(
    'does not rebuild or continue an externally authored input: %j', async (agentMeta) => {
      const deps = makeDeps([{ ...msg('user', 'external task', 'u1'), agentMeta }]);
      deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
      const rollover = createContextOverflowRollover(deps);
      rollover.claim('s1');
      await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
      expect(deps.closeSession).not.toHaveBeenCalled();
      expect(deps.replayUserMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['plan', 'close', 'commit'] as const)('stops when an external owner takes over during %s', async (phase) => {
    const deps = makeDeps([msg('user', 'finish editing', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    let external = false;
    const rollover = createContextOverflowRollover({
      ...deps,
      hasExternalRecoveryOwner: () => external,
      findLatestRebuildMeta: async () => { if (phase === 'plan') external = true; return null; },
      closeSession: async () => { await deps.closeSession(); if (phase === 'close') external = true; },
      commitRebuild: async () => { await deps.commitRebuild(); if (phase === 'commit') external = true; },
    });
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.closeSession).toHaveBeenCalledTimes(phase === 'plan' ? 0 : 1);
    expect(deps.commitRebuild).toHaveBeenCalledTimes(phase === 'commit' ? 1 : 0);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it.each(['commit', 'dispatch'] as const)('surfaces a %s failure without retrying automatically', async (phase) => {
    const deps = makeDeps([msg('user', 'finish editing', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    if (phase === 'commit') deps.commitRebuild.mockRejectedValue(new Error('owner changed before commit'));
    else deps.replayUserMessage.mockResolvedValue({ accepted: false });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.onRebuilt).not.toHaveBeenCalled();
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.commitRebuild).toHaveBeenCalledTimes(1);
    expect(deps.replayUserMessage).toHaveBeenCalledTimes(phase === 'commit' ? 0 : 1);
  });

  it('does not rebuild a running turn', async () => {
    const deps = makeDeps([msg('user', 'continue', 'u1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    deps.getLiveSession.mockReturnValue({ isTurnRunning: () => true });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(rollover.tryRecover('s1', { reason: 'codex_history_oversized' })).resolves.toBe(false);
    expect(deps.commitRebuild).not.toHaveBeenCalled();
    expect(deps.closeSession).not.toHaveBeenCalled();
  });

  it.each(['healthy', 'oversized', 'unknown'] as const)('rechecks a persisted image error against the current thread: %s', async (health) => {
    const deps = makeDeps([
      msg('user', 'old request', 'u1'),
      msg('error', { reason: 'codex_history_oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex', sdkSessionId: 'current-thread' });
    const classifyCodexHistory = vi.fn(async () => health);
    const rollover = createContextOverflowRollover({ ...deps, classifyCodexHistory });
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(health !== 'healthy');
    expect(classifyCodexHistory).toHaveBeenCalledWith('current-thread');
    expect(deps.commitRebuild).toHaveBeenCalledTimes(health === 'healthy' ? 0 : 1);
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
  });

  it('does not close or rebuild when the owner changes during history inspection', async () => {
    const deps = makeDeps([msg('user', 'old request', 'u1'), msg('error', { reason: 'codex_history_oversized' }, 'e1')]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    const rollover = createContextOverflowRollover({
      ...deps, classifyCodexHistory: async () => { throw new Error('owner changed'); },
    });
    await expect(rollover.prepareUnhealthySession('s1')).rejects.toThrow('owner changed');
    expect(deps.closeSession).not.toHaveBeenCalled();
    expect(deps.commitRebuild).not.toHaveBeenCalled();
  });

  it('rebuilds image history before an explicit send without sending an extra continuation', async () => {
    const deps = makeDeps([
      msg('user', 'Save then verify', 'u1'),
      { ...msg('tool_result', 'Saved revision 42', 'r1'), toolUseId: 't1' },
      msg('error', { reason: 'codex_history_oversized' }, 'e1'),
    ]);
    deps.getSessionRow.mockResolvedValue({ ...(await deps.getSessionRow()), agentKind: 'codex' });
    const rollover = createContextOverflowRollover(deps);
    await expect(rollover.prepareUnhealthySession('s1')).resolves.toBe(true);
    expect(deps.commitRebuild).toHaveBeenCalledWith('s1', expect.stringContaining('Saved revision 42'),
      expect.objectContaining({ sourceUserClientId: 'u1' }), expect.any(AbortSignal));
    expect(deps.replayUserMessage).not.toHaveBeenCalled();
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
      '请处理 [Referenced project]\nName: "src"\nWorking directory: "/repos/cindy"\n[/Referenced project]',
    );
  });
});

describe('withReplaySourceNotes', () => {
  it('rebuilds the source notes from agentMeta so replayed plugin / shared-member / remote input keeps its attribution', () => {
    const plugin = withReplaySourceNotes('run the report', {
      sourcePlugin: { pluginId: 'ghost-gh', name: 'GitHub' },
    });
    expect(plugin).toEqual({
      type: 'user',
      content: expect.stringContaining('[消息来源] 本条由插件「GitHub」(plugin_id: ghost-gh) 发送'),
    });
    const member = withReplaySourceNotes({ type: 'user', content: [{ type: 'text', text: 'hi' }] }, {
      sharedTaskAuthor: { memberId: 'm-1', displayName: '张三' },
      sourceDevice: { deviceId: 'phone-1', name: 'iPhone', platform: 'mobile' },
    });
    const text = JSON.stringify(member);
    expect(text).toContain('本条由共享任务成员「张三」(member_id: m-1) 发送');
    expect(text).toContain('[客户端说明]');
    expect(text).toContain('phone-1');
  });

  it('leaves local input untouched and never hands a bare string back for re-parsing', () => {
    const wire = '{"a":1}';
    expect(withReplaySourceNotes(wire, {})).toBe(wire);
    expect(withReplaySourceNotes(wire, null)).toBe(wire);
    const withNote = withReplaySourceNotes(wire, { sourcePlugin: { pluginId: 'p' } });
    expect(typeof withNote).toBe('object');
  });

  it('adds no source note to hidden host instructions or auto-resume rows', () => {
    expect(
      withReplaySourceNotes('继续', { sourcePlugin: { pluginId: 'p' }, autoResume: true }),
    ).toBe('继续');
  });
});

it.each([undefined, { instanceId: 'i1', generation: 1 }])('keeps ordinary errors visible during recovery without starting a second claim: %j', identity => {
  const rollover = createContextOverflowRollover({} as never);
  expect(rollover.claim('s1', identity)).toBe('claimed');
  expect(rollover.claim('s1', identity, false)).toBe('idle');
  expect(rollover.claim('s1', identity)).toBe('in-flight');
});
