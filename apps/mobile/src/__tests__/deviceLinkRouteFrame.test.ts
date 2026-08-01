import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@cindy/device-link';
import {
  handlePeerLinkCloseFrame,
  invalidatePeerLinkState,
} from '@/device-link/linkClose';

describe('handlePeerLinkCloseFrame', () => {
  it.each(['user', 'toggle-off', 'shutdown', 'revoked'] as const)(
    'invalidates retained links on peer link-close (%s)',
    (reason) => {
      const onLinkClosed = vi.fn();
      const handled = handlePeerLinkCloseFrame({
        v: 1,
        kind: 'link-close',
        src: 'desktop-a',
        payload: { reason },
      } as Envelope, onLinkClosed);

      expect(handled).toBe(true);
      expect(onLinkClosed).toHaveBeenCalledWith('desktop-a');
    },
  );

  it('ignores unrelated frames', () => {
    const onLinkClosed = vi.fn();
    expect(handlePeerLinkCloseFrame({
      v: 1,
      kind: 'push',
      src: 'desktop-a',
    } as Envelope, onLinkClosed)).toBe(false);
    expect(onLinkClosed).not.toHaveBeenCalled();
  });
});

describe('invalidatePeerLinkState', () => {
  it('clears retained link state and reports invalidated session topic ACKs', () => {
    const openLinks = new Map<string, unknown>([
      ['desktop-a', Promise.resolve()],
      ['desktop-b', Promise.resolve()],
    ]);
    const remoteTopicAcks = new Map<string, Set<string>>([
      ['desktop-a', new Set(['sessions', 'session:s1', 'session:s2'])],
      ['desktop-b', new Set(['sessions'])],
    ]);
    const onTopicsInterrupted = vi.fn();

    invalidatePeerLinkState(
      'desktop-a',
      openLinks,
      remoteTopicAcks,
      onTopicsInterrupted,
    );

    expect(openLinks.has('desktop-a')).toBe(false);
    expect(remoteTopicAcks.has('desktop-a')).toBe(false);
    expect(openLinks.has('desktop-b')).toBe(true);
    expect(remoteTopicAcks.has('desktop-b')).toBe(true);
    expect(onTopicsInterrupted).toHaveBeenCalledWith([
      'sessions',
      'session:s1',
      'session:s2',
    ]);
  });
});
