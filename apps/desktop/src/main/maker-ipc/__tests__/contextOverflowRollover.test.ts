import { describe, expect, it, vi } from 'vitest';

import {
  createContextOverflowRollover,
  isContextOverflowErrorData,
  isPiPromptRpcTimeoutError,
  persistedUserContentToWireMessage,
  planContextOverflowRollover,
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
    expect(isContextOverflowErrorData({ message: 'Rate limit exceeded: too many tokens per minute' })).toBe(
      false,
    );
  });
});

describe('shouldRebuildPiNativeSession', () => {
  it('treats a PI prompt RPC timeout as an unhealthy native session', () => {
    expect(
      isPiPromptRpcTimeoutError({ message: 'pi rpc timeout after 30000ms: prompt' }),
    ).toBe(true);
    expect(shouldRebuildPiNativeSession({ message: 'pi rpc timeout after 30000ms: prompt' })).toBe(
      true,
    );
  });

  it('does not rebuild on other PI RPC timeouts', () => {
    expect(
      shouldRebuildPiNativeSession({ message: 'pi rpc timeout after 30000ms: set_model' }),
    ).toBe(false);
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
      planContextOverflowRollover([
        msg('user', '继续', 'u1'),
        msg('assistant', '先说一句', 'a1'),
      ]),
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
    expect(
      planContextOverflowRollover([msg('user', '继续', 'u1')], 'u1'),
    ).toMatchObject({ action: 'stop', reason: 'already-rolled' });
  });
});

describe('createContextOverflowRollover', () => {
  function makeDeps(source: OverflowSourceMessage[]) {
    return {
      getSessionRow: vi.fn(async () => ({
        status: 'active',
        agentKind: 'pi',
        remoteHostId: null,
        clearedAt: null,
      })),
      listMessages: vi.fn(async () => source),
      findLatestRebuildMeta: vi.fn(async () => null),
      getLiveSession: vi.fn(() => ({ isTurnRunning: () => false })),
      closeSession: vi.fn(async () => undefined),
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
      expect.stringContaining('exceeded the model\'s context window'),
      { reason: 'context-overflow', sourceUserClientId: 'u2', expectedClearedAt: null },
    );
    expect(deps.setPendingHandoff).toHaveBeenCalledWith('s1', expect.any(String), 3);
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).toContain('先做 A');
    expect(deps.setPendingHandoff.mock.calls[0]?.[1]).not.toContain('再做 B');
    expect(deps.replayUserMessage).toHaveBeenCalledWith('s1', '再做 B');
    expect(deps.onRebuilt).toHaveBeenCalledWith('s1');
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

  it('treats an unaccepted replay as recovery failure', async () => {
    const deps = makeDeps([msg('user', '再做 B', 'u2')]);
    deps.replayUserMessage.mockResolvedValue({ accepted: false });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
  });

  it('does not rollover a non-Pi session', async () => {
    const deps = makeDeps([msg('user', '继续', 'u1')]);
    deps.getSessionRow.mockResolvedValue({
      status: 'active',
      agentKind: 'cc',
      remoteHostId: null,
      clearedAt: null,
    });
    const rollover = createContextOverflowRollover(deps);
    rollover.claim('s1');
    await expect(
      rollover.tryRecover('s1', { reason: 'context-overflow', message: 'prompt too long' }),
    ).resolves.toBe(false);
    expect(deps.closeSession).not.toHaveBeenCalled();
  });
});

describe('persistedUserContentToWireMessage', () => {
  it('keeps images from the persist envelope instead of flattening to text', () => {
    expect(
      persistedUserContentToWireMessage({
        text: '看这张图',
        images: [{ url: 'xdt-image://sess/a.png' }],
        files: [],
      }),
    ).toEqual({
      type: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', path: 'xdt-image://sess/a.png' },
      ],
    });
  });
});
