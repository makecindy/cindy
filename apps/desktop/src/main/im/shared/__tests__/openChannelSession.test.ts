/**
 * IM 渠道新建任务经公共入口 openSession: 准入前的路由原样送进 openSession, 回调拿到
 * 准入后的路由; 渠道没给过的字段(effort / fastMode)不把准入默认值回写给调用方。
 */
import { describe, expect, it, vi } from 'vitest';

const openSession = vi.hoisted(() => vi.fn());
vi.mock('../../../localDb/sessionOpening', () => ({ openSession }));
// 档位判据单独测过；这里只验证入口是否按它省略 effort。
vi.mock('../../defaultSessionSettings', () => ({
  // 用模型名当开关：只有 'model-without-high' 这个模型「不接受 high」，避免影响既有用例。
  isImEffortAcceptedByModel: (_agent: unknown, model: string, effort: string) =>
    !(model === 'model-without-high' && effort === 'high'),
}));

import { openChannelSession } from '../openChannelSession';

describe('openChannelSession', () => {
  it('passes shared execution location into new-session admission', async () => {
    openSession.mockImplementationOnce(async (input, commit) => ({ row: input.body, value: await commit(input.body, () => undefined) }));
    const route = { agentDeviceId: 'share:owner', agentKind: 'codex' as const, model: 'm', providerId: 'p', permissionMode: 'auto' as const, workingDir: '/w' };
    await openChannelSession('shared', route, async () => 'created');
    expect(openSession).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.objectContaining({ agentDeviceId: 'share:owner', providerId: 'p' }) }), expect.any(Function));
    openSession.mockClear();
  });
  it('把渠道路由送进 openSession(agentKind 用库值), 回调拿到准入后的路由', async () => {
    openSession.mockImplementationOnce(async (input, commit) => ({
      row: {
        ...input.body,
        model: 'm-admitted',
        providerId: 'p-admitted',
        effort: 'medium',
        fastMode: false,
      },
      value: await commit(
        {
          ...input.body,
          model: 'm-admitted',
          providerId: 'p-admitted',
          effort: 'medium',
          fastMode: false,
        },
        () => undefined,
      ),
    }));
    const commit = vi.fn(async (_admitted: unknown) => 'created');
    await expect(
      openChannelSession(
        's-1',
        {
          agentKind: 'claude-code',
          model: 'm',
          providerId: null,
          effort: 'high',
          permissionMode: 'auto',
          workingDir: '/w',
          workspaceKind: 'dialogue',
          title: 'Telegram',
        },
        commit,
      ),
    ).resolves.toBe('created');
    expect(openSession.mock.calls[0][0]).toEqual({
      id: 's-1',
      body: {
        title: 'Telegram',
        agentKind: 'cc',
        model: 'm',
        providerId: null,
        effort: 'high',
        permissionMode: 'auto',
        workspaceKind: 'dialogue',
        workingDir: '/w',
      },
    });
    // 渠道给过 effort → 回写准入后的值; 没给过 fastMode → 不回写准入默认值。
    expect(commit.mock.calls[0][0]).toEqual({
      model: 'm-admitted',
      providerId: 'p-admitted',
      effort: 'medium',
    });
  });

  it('准入拒绝时抛出, 建行回调不执行(不静默换模型)', async () => {
    openSession.mockRejectedValueOnce(new Error('模型不可用，不会自动更换模型或供应商'));
    const commit = vi.fn();
    await expect(
      openChannelSession(
        's-2',
        {
          agentKind: 'codex',
          model: 'gone',
          providerId: 'p',
          permissionMode: 'ask',
          workingDir: '/w',
        },
        commit,
      ),
    ).rejects.toThrow('不会自动更换模型或供应商');
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('openChannelSession 渠道默认档位', () => {
  const route = (model: string, effort: 'high' | 'medium') => ({
    agentKind: 'codex' as const, model, providerId: 'p',
    permissionMode: 'auto' as const, workingDir: '/w', effort,
  });

  it('模型不接受时省略 effort（模型按自身默认档运行）', async () => {
    openSession.mockImplementationOnce(async (input, commit) => ({
      row: input.body, value: await commit(input.body, () => undefined),
    }));
    await openChannelSession('drops', route('model-without-high', 'high'), async () => 'created');
    const body = openSession.mock.calls.at(-1)?.[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('effort');
    openSession.mockClear();
  });

  it('模型接受时原样传下去', async () => {
    openSession.mockImplementationOnce(async (input, commit) => ({
      row: input.body, value: await commit(input.body, () => undefined),
    }));
    await openChannelSession('keeps', route('m', 'medium'), async () => 'created');
    const body = openSession.mock.calls.at(-1)?.[0]?.body as Record<string, unknown>;
    expect(body.effort).toBe('medium');
    openSession.mockClear();
  });
});
