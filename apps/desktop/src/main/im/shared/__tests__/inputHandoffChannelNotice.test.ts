import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
import {
  bindInputHandoffChannelNotice,
  clearInputHandoffChannelNotices,
  sendInputHandoffChannelNotice,
} from '../inputHandoffChannelNotice';

function fakeSession(id: string) {
  const listeners = new Set<(status: string) => void>();
  const session = {
    id,
    onStatusChange: (listener: (status: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Session;
  return { session, setStatus: (status: string) => listeners.forEach((listener) => listener(status)) };
}

const log = { warn: vi.fn() };
afterEach(() => {
  clearInputHandoffChannelNotices();
  log.warn.mockClear();
});

describe('代输入 channel pointer', () => {
  it('goes to the chat that drives the task, and only while that task is open', async () => {
    const { session, setStatus } = fakeSession('s1');
    const deliver = vi.fn(async () => true);
    expect(sendInputHandoffChannelNotice('s1', 'pointer', log)).toBe(false);
    bindInputHandoffChannelNotice(session, deliver);
    expect(sendInputHandoffChannelNotice('s1', 'pointer', log)).toBe(true);
    expect(deliver).toHaveBeenCalledWith('pointer');
    expect(sendInputHandoffChannelNotice('other', 'pointer', log)).toBe(false);
    setStatus('closed');
    expect(sendInputHandoffChannelNotice('s1', 'pointer', log)).toBe(false);
  });

  it('a newer binding of the same task replaces the old chat and failures stay quiet', async () => {
    const first = fakeSession('s1');
    const second = fakeSession('s1');
    const old = vi.fn(async () => true);
    const latest = vi.fn(async () => {
      throw new Error('offline');
    });
    bindInputHandoffChannelNotice(first.session, old);
    bindInputHandoffChannelNotice(second.session, latest);
    expect(sendInputHandoffChannelNotice('s1', 'pointer', log)).toBe(true);
    expect(old).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());
    // The replaced runtime closing later does not drop the newer route.
    first.setStatus('closed');
    expect(sendInputHandoffChannelNotice('s1', 'pointer', log)).toBe(true);
  });
});
