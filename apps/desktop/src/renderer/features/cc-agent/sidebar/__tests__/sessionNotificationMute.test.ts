/**
 * 会话级「消息免打扰」的乐观更新与回滚。
 *
 * 点下去侧栏必须先切文案（否则要等一次 IPC 往返才更新），写库失败必须翻回来——
 * 留着一个没落库的「已静音」会让用户以为不会被打扰，实际照旧。但回滚本身不能盖掉
 * 期间别处刚写进来的新值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';

const m = vi.hoisted(() => ({
  patchLocal: vi.fn(),
  patchMeta: vi.fn(),
  findById: vi.fn(),
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { patchLocal: m.patchLocal, findById: m.findById },
}));
vi.mock('@/lib/sessionService', () => ({ patchMeta: m.patchMeta }));

import { setSessionNotificationsMuted } from '../sessionNotificationMute';

const session = { id: 'task', title: 'Task' } as Session;

/** 让 mock 的 store 有真实语义：patchLocal 写进去，findById 读得到。 */
let stored: Session;

beforeEach(() => {
  vi.clearAllMocks();
  stored = { ...session };
  m.patchMeta.mockResolvedValue(session);
  m.patchLocal.mockImplementation((_id: string, patch: Partial<Session>) => {
    stored = { ...stored, ...patch };
  });
  m.findById.mockImplementation(() => stored);
});

describe('setSessionNotificationsMuted', () => {
  it('flips the row before the write and persists the same value', async () => {
    await setSessionNotificationsMuted(session, true);

    expect(m.patchLocal).toHaveBeenCalledWith('task', { notificationsMuted: true });
    expect(m.patchMeta).toHaveBeenCalledWith('task', { notificationsMuted: true });
  });

  it('rolls the row back and rethrows when the write fails', async () => {
    m.patchMeta.mockRejectedValue(new Error('write failed'));

    await expect(
      setSessionNotificationsMuted({ ...session, notificationsMuted: true }, false),
    ).rejects.toThrow('write failed');

    expect(m.patchLocal).toHaveBeenCalledWith('task', { notificationsMuted: false });
    expect(m.patchLocal).toHaveBeenLastCalledWith('task', { notificationsMuted: true });
  });

  it('does not roll back over a newer value another window wrote meanwhile', async () => {
    m.patchMeta.mockImplementation(async () => {
      // 等这一趟的过程中另一个窗口把值改回去了。
      stored = { ...stored, notificationsMuted: false };
      throw new Error('write failed');
    });

    await expect(setSessionNotificationsMuted(session, true)).rejects.toThrow('write failed');

    expect(m.patchLocal).toHaveBeenCalledTimes(1);
    expect(m.patchLocal).toHaveBeenCalledWith('task', { notificationsMuted: true });
  });

  it('does not roll back over a newer same-direction write that is still in flight', async () => {
    // 两个窗口（或连点两下）都在「关静音」：后发起的那次成功，先发起的那次稍后失败。
    // 只比布尔值分不出这种情况——失败的那次看到的仍是自己写进去的 false。
    let failFirst: (error: Error) => void = () => {};
    m.patchMeta
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => { failFirst = reject; }),
      )
      .mockImplementationOnce(async () => ({}));

    const first = setSessionNotificationsMuted({ ...session, notificationsMuted: true }, false);
    const second = setSessionNotificationsMuted({ ...session, notificationsMuted: true }, false);
    await second;
    failFirst(new Error('write failed'));
    await expect(first).rejects.toThrow('write failed');

    // 只有两次发起的乐观写，没有回滚写回 true。
    expect(m.patchLocal).toHaveBeenCalledTimes(2);
    expect(m.patchLocal).not.toHaveBeenLastCalledWith('task', { notificationsMuted: true });
  });
});
