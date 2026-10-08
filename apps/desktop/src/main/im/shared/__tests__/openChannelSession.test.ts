/**
 * IM 渠道新建任务经公共入口 openSession: 准入前的路由原样送进 openSession, 回调拿到
 * 准入后的路由; 渠道没给过的字段(effort / fastMode)不把准入默认值回写给调用方。
 */
import { describe, expect, it, vi } from 'vitest';

const openSession = vi.hoisted(() => vi.fn());
vi.mock('../../../localDb/sessionOpening', () => ({ openSession }));

import { openChannelSession } from '../openChannelSession';

describe('openChannelSession', () => {
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
