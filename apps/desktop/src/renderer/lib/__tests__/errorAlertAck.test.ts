// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ackErrorAlertHandled } from '@/lib/errorAlertAck';
import { clearSessionAttention } from '@/lib/sessionAttentionStore';

vi.mock('@/lib/sessionAttentionStore', () => ({
  clearSessionAttention: vi.fn(() => true),
}));

const clearSessionAttentionMock = vi.mocked(clearSessionAttention);
const ipcClearMock = vi.fn(() => Promise.resolve());

describe('ackErrorAlertHandled', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationClearSessionAttention: ipcClearMock,
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the store with explicit intent (store guarantees the IPC bridge)', () => {
    ackErrorAlertHandled('s1');
    expect(clearSessionAttentionMock).toHaveBeenCalledWith('s1', { intent: 'explicit' });
  });

  // 回归护栏:统一前存在一个「banner 聚焦驻留 1.5s 即 ack」的 hook,红点会在横幅
  // 仍展示时消失。现在展示不再产生 ack —— 本模块只导出显式处置这一条路径。
  it('exposes no display-dwell ack path', async () => {
    const mod = await import('@/lib/errorAlertAck');
    expect(Object.keys(mod)).toEqual(['ackErrorAlertHandled']);
  });
});
