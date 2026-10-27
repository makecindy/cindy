import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prewarmSessionFor: vi.fn(async (_sessionId: string, _createOpts: unknown) => ({ accepted: true })),
}));

vi.mock('@/lib/makerTransport', () => ({
  prewarmSessionFor: mocks.prewarmSessionFor,
  isRemoteSession: vi.fn(() => false),
  isRemoteSessionSticky: vi.fn(() => false),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => '',
}));

import { makerChatStore } from '@/lib/makerChatStore';

describe('makerChatStore.prewarmSession', () => {
  beforeEach(() => {
    mocks.prewarmSessionFor.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  it('asks once per window while typing, but again right away after a settings change', () => {
    const sid = `prewarm-${Math.random()}`;
    makerChatStore.prewarmSession(sid, 'model-a', 'high', 'auto', '/repo');
    makerChatStore.prewarmSession(sid, 'model-a', 'high', 'auto', '/repo');
    expect(mocks.prewarmSessionFor).toHaveBeenCalledTimes(1);

    // Switching model may have closed the warm runtime on the task's computer.
    makerChatStore.prewarmSession(sid, 'model-b', 'high', 'auto', '/repo');
    expect(mocks.prewarmSessionFor).toHaveBeenCalledTimes(2);
    expect(mocks.prewarmSessionFor.mock.calls[1]?.[1]).toMatchObject({ model: 'model-b' });

    makerChatStore.prewarmSession(sid, 'model-b', 'low', 'auto', '/repo');
    expect(mocks.prewarmSessionFor).toHaveBeenCalledTimes(3);

    makerChatStore.prewarmSession(sid, 'model-b', 'low', 'auto', '/repo');
    expect(mocks.prewarmSessionFor).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(30_000);
    makerChatStore.prewarmSession(sid, 'model-b', 'low', 'auto', '/repo');
    expect(mocks.prewarmSessionFor).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
