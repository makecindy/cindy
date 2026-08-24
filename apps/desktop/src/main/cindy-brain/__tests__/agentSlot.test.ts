/**
 * agentSlot.test — 插件发起 Agent 新回合的纯 DI 单测。
 *
 * 覆盖清单权限、一次性点击票、后台会话边界、模板替换、审计内容、限速和
 * host runner 接线。测试不启动 Electron，也不创建真实 Agent 会话。
 */

import { describe, expect, it, vi } from 'vitest';

import type { InstalledGhost } from '../../../shared/ghost';
import {
  GhostAgentSlot,
  type GhostAgentSlotDeps,
  type GhostAgentTurnRunner,
} from '../agentSlot';

function fakeGhost(
  id: string,
  options: { agentSlot?: boolean; background?: boolean; enabled?: boolean } = {},
): InstalledGhost {
  const agentSlot = options.agentSlot ?? true;
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: id,
      version: '1.2.3',
      kind: 'chip',
      entry: 'main.js',
      slots: agentSlot ? ['agent'] : ['card'],
      ...(options.background ? { agent: { background: true } } : {}),
    },
    dir: `/fake/${id}`,
    enabled: options.enabled ?? true,
  } as InstalledGhost;
}

function userRequest(token: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent-request',
    mode: 'continue',
    promptTemplate: '用户要求：{{user_message}}\n事件：{{event_json}}',
    userMessage: '继续处理',
    event: { jobId: 7 },
    userActionToken: token,
    ...overrides,
  };
}

function acceptedRunner() {
  return vi.fn<GhostAgentTurnRunner>(async (request) => ({
    ok: true,
    sessionId: request.mode === 'continue' ? request.sourceSessionId : `target-${request.mode}`,
    disposition: request.mode === 'fork' ? 'forked' : request.mode === 'new' ? 'created' : 'active',
  }));
}

function makeSlot(options: {
  ghosts?: InstalledGhost[];
  runner?: GhostAgentTurnRunner | null;
  now?: () => number;
  onRevealSession?: (sessionId: string) => void;
} = {}) {
  const ghosts = options.ghosts ?? [fakeGhost('alpha')];
  let tokenIndex = 0;
  const deps: GhostAgentSlotDeps = {
    getGhost: (id) => ghosts.find((ghost) => ghost.manifest.id === id) ?? null,
    runner: options.runner,
    now: options.now ?? (() => 20_000),
    createToken: () => `token-${++tokenIndex}`,
    ...(options.onRevealSession ? { onRevealSession: options.onRevealSession } : {}),
  };
  return new GhostAgentSlot(deps);
}

describe('agentSlot · 清单与模板守门', () => {
  it('未申请 agent 槽或插件停用时拒绝', async () => {
    const runner = acceptedRunner();
    const noSlot = makeSlot({ ghosts: [fakeGhost('alpha', { agentSlot: false })], runner });
    const disabled = makeSlot({ ghosts: [fakeGhost('alpha', { enabled: false })], runner });

    expect((await noSlot.handleRequest('alpha', userRequest('x'))).ok).toBe(false);
    expect((await disabled.handleRequest('alpha', userRequest('x'))).ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('promptTemplate 必须且只能含一次 user_message 占位', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;
    const missing = await slot.handleRequest(
      'alpha',
      userRequest(token, { promptTemplate: '没有占位符' }),
    );
    const duplicate = await slot.handleRequest(
      'alpha',
      userRequest(token, {
        promptTemplate: '{{user_message}} 和 {{user_message}}',
      }),
    );

    expect(missing).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(duplicate).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('agentSlot · 真人点击一次性票', () => {
  it('票据绑定插件，别的插件不能使用', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ ghosts: [fakeGhost('alpha'), fakeGhost('beta')], runner });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;

    const result = await slot.handleRequest('beta', userRequest(token));
    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('票据成功使用一次后立即作废', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;

    expect((await slot.handleRequest('alpha', userRequest(token))).ok).toBe(true);
    expect(await slot.handleRequest('alpha', userRequest(token))).toMatchObject({
      ok: false,
      errorCode: 'TOKEN_EXPIRED',
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('clearGhost 同步吊销该插件的未消费活票,不吊销别家的', async () => {
    // 更新/重装同 id 包时旧代码拿到的点击票必须随 clearGhost 作废,
    // 否则 TTL 窗口内新装入的不同代码可以花旧票起 Agent 轮次。
    const runner = acceptedRunner();
    const slot = makeSlot({ ghosts: [fakeGhost('alpha'), fakeGhost('beta')], runner });
    const alphaToken = slot.issueUserActionToken('alpha', 'session-1')!;
    const betaToken = slot.issueUserActionToken('beta', 'session-1')!;

    slot.clearGhost('alpha');

    expect(await slot.handleRequest('alpha', userRequest(alphaToken))).toMatchObject({
      ok: false,
      errorCode: 'TOKEN_EXPIRED',
    });
    expect((await slot.handleRequest('beta', userRequest(betaToken))).ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('票据两分钟后过期', async () => {
    let now = 50_000;
    const runner = acceptedRunner();
    const slot = makeSlot({ runner, now: () => now });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;
    now += 2 * 60_000 + 1;

    expect(await slot.handleRequest('alpha', userRequest(token))).toMatchObject({
      ok: false,
      errorCode: 'TOKEN_EXPIRED',
    });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('agentSlot · 会话模式与审计', () => {
  it('continue / new / fork 原样交给主机 runner，来源会话由票据决定', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });

    for (const mode of ['continue', 'new', 'fork'] as const) {
      const token = slot.issueUserActionToken('alpha', 'session-source')!;
      const result = await slot.handleRequest(
        'alpha',
        userRequest(token, { mode, title: mode === 'new' ? '新任务' : undefined }),
      );
      expect(result).toMatchObject({ ok: true, mode });
    }

    expect(runner.mock.calls.map(([request]) => request.mode)).toEqual([
      'continue',
      'new',
      'fork',
    ]);
    expect(runner.mock.calls.every(([request]) => request.sourceSessionId === 'session-source')).toBe(true);
  });

  it('主机完成模板替换，并把插件、版本、模板与原始输入写入审计内容', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;

    await slot.handleRequest('alpha', userRequest(token));
    const request = runner.mock.calls[0][0];
    expect(request.prompt).toBe('用户要求：继续处理\n事件：{"jobId":7}');
    expect(JSON.parse(request.persistedContent)).toEqual({
      text: request.prompt,
      ghostAgent: {
        schemaVersion: 1,
        ghostId: 'alpha',
        ghostVersion: '1.2.3',
        mode: 'continue',
        trigger: 'user-action',
        promptTemplate: '用户要求：{{user_message}}\n事件：{{event_json}}',
        userMessage: '继续处理',
        eventJson: '{"jobId":7}',
      },
    });
  });

  it('用户原文里的 event_json 字样保持原样，只替换模板本身的占位符', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;

    await slot.handleRequest(
      'alpha',
      userRequest(token, {
        userMessage: '请保留 {{event_json}} 这几个字',
      }),
    );

    expect(runner.mock.calls[0][0].prompt).toBe(
      '用户要求：请保留 {{event_json}} 这几个字\n事件：{"jobId":7}',
    );
  });

  it('runner 尚未接好时返回 HOST_NOT_READY，不会假装成功', async () => {
    const slot = makeSlot({ runner: null });
    const token = slot.issueUserActionToken('alpha', 'session-1')!;
    expect(await slot.handleRequest('alpha', userRequest(token))).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
    });
  });
});

describe('agentSlot · 后台权限', () => {
  it('未申请 background 时，即使会话有点击关联也不能后台发起', async () => {
    const runner = acceptedRunner();
    const slot = makeSlot({ runner });
    slot.issueUserActionToken('alpha', 'session-1');

    const result = await slot.handleRequest('alpha', {
      ...userRequest('unused'),
      trigger: 'background',
      sessionId: 'session-1',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('有 background 权限也只能使用用户点过卡片的会话，并受十秒限速', async () => {
    let now = 20_000;
    const runner = acceptedRunner();
    const slot = makeSlot({
      ghosts: [fakeGhost('alpha', { background: true })],
      runner,
      now: () => now,
    });
    const request = (sessionId: string) => ({
      ...userRequest('unused'),
      trigger: 'background',
      sessionId,
    });

    expect(await slot.handleRequest('alpha', request('never-linked'))).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    slot.issueUserActionToken('alpha', 'session-1');
    expect((await slot.handleRequest('alpha', request('session-1'))).ok).toBe(true);
    expect(await slot.handleRequest('alpha', request('session-1'))).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    now += 10_000;
    expect((await slot.handleRequest('alpha', request('session-1'))).ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});

describe('agentSlot · 可见任务自动切过去', () => {
  it('user-action continue 切到原会话', async () => {
    const reveal = vi.fn();
    const slot = makeSlot({ runner: acceptedRunner(), onRevealSession: reveal });
    const token = slot.issueUserActionToken('alpha', 'session-source')!;
    await slot.handleRequest('alpha', userRequest(token));
    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith('session-source');
  });

  it('user-action new / fork 切到新任务', async () => {
    const reveal = vi.fn();
    const slot = makeSlot({ runner: acceptedRunner(), onRevealSession: reveal });
    for (const mode of ['new', 'fork'] as const) {
      const token = slot.issueUserActionToken('alpha', 'session-source')!;
      await slot.handleRequest(
        'alpha',
        userRequest(token, { mode, title: mode === 'new' ? '新任务' : undefined }),
      );
    }
    expect(reveal.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'target-new',
      'target-fork',
    ]);
  });

  it('后台 continue 不切任务', async () => {
    const reveal = vi.fn();
    const slot = makeSlot({
      ghosts: [fakeGhost('alpha', { background: true })],
      runner: acceptedRunner(),
      onRevealSession: reveal,
    });
    slot.issueUserActionToken('alpha', 'session-1');
    await slot.handleRequest('alpha', {
      ...userRequest('unused'),
      trigger: 'background',
      sessionId: 'session-1',
    });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('后台 new / fork 也不切任务', async () => {
    let now = 20_000;
    const reveal = vi.fn();
    const slot = makeSlot({
      ghosts: [fakeGhost('alpha', { background: true })],
      runner: acceptedRunner(),
      onRevealSession: reveal,
      now: () => now,
    });
    slot.issueUserActionToken('alpha', 'session-1');
    for (const mode of ['new', 'fork'] as const) {
      const result = await slot.handleRequest('alpha', {
        ...userRequest('unused'),
        trigger: 'background',
        mode,
        title: mode === 'new' ? '插件新任务' : undefined,
        sessionId: 'session-1',
      });
      expect(result.ok).toBe(true);
      now += 10_000;
    }
    expect(reveal).not.toHaveBeenCalled();
  });

  it('runner 失败不切', async () => {
    const reveal = vi.fn();
    const runner = vi.fn<GhostAgentTurnRunner>(async () => ({
      ok: false as const,
      errorCode: 'NOT_FOUND',
      message: 'gone',
    }));
    const slot = makeSlot({ runner, onRevealSession: reveal });
    const token = slot.issueUserActionToken('alpha', 'session-source')!;
    await slot.handleRequest('alpha', userRequest(token));
    expect(reveal).not.toHaveBeenCalled();
  });

  it('setRevealSession 可以后接线', async () => {
    const reveal = vi.fn();
    const slot = makeSlot({ runner: acceptedRunner() });
    slot.setRevealSession(reveal);
    const token = slot.issueUserActionToken('alpha', 'session-source')!;
    await slot.handleRequest('alpha', userRequest(token));
    expect(reveal).toHaveBeenCalledWith('session-source');
  });
});
