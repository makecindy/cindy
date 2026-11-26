import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isRemoteSessionSticky: vi.fn(() => false),
  prewarmSessionFor: vi.fn(async (_sessionId: string, _createOpts: unknown) => ({ accepted: true })),
}));

vi.mock('@/lib/makerTransport', () => ({
  prewarmSessionFor: mocks.prewarmSessionFor,
  isRemoteSession: vi.fn(() => false),
  isRemoteSessionSticky: mocks.isRemoteSessionSticky,
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => 'this computer only',
}));

import { makerChatStore } from '@/lib/makerChatStore';

describe('makerChatStore.prewarmSession', () => {
  beforeEach(() => {
    mocks.prewarmSessionFor.mockClear();
    mocks.isRemoteSessionSticky.mockReturnValue(false);
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => vi.useRealTimers());

  // Unit regression: a remote prewarm with a saved controller prompt used to
  // tunnel the body. The timing test below only covers local request throttling.
  it.each([false, true])('includes personal instructions only for local prewarm (remote=%s)', remote => {
    mocks.isRemoteSessionSticky.mockReturnValue(remote);
    makerChatStore.prewarmSession(`personalization-prewarm-${remote}`, 'model-a', 'high', 'auto', '/repo');
    const options = mocks.prewarmSessionFor.mock.calls[0]?.[1];
    expect(options).toMatchObject({ model: 'model-a' });
    if (remote) expect(options).not.toHaveProperty('userPrompt');
    else expect(options).toHaveProperty('userPrompt', 'this computer only');
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
  });
});
