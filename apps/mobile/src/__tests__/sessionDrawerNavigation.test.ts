import { describe, expect, it, vi } from 'vitest';
import { switchDrawerSessionInPlace } from '@/session/sessionDrawerNavigation';

describe('wide session drawer navigation', () => {
  it('switches the current route in place with only the target session identity', () => {
    const replaceParams = vi.fn();

    switchDrawerSessionInPlace(
      { replaceParams },
      {
        deviceId: 'device-b',
        deviceName: 'Desktop B',
        sessionId: 'session-b',
      },
    );

    expect(replaceParams).toHaveBeenCalledOnce();
    expect(replaceParams).toHaveBeenCalledWith({
      deviceId: 'device-b',
      deviceName: 'Desktop B',
      sessionId: 'session-b',
    });
  });

  it('keeps companion history identity and the matched message when opening a search result', () => {
    const replaceParams = vi.fn();
    const target = {
      deviceId: 'device-b',
      deviceName: 'Desktop B',
      sessionId: 'old-chat',
      focusClientId: 'matched-message',
      resourceCollectionId: 'teammates',
      resourceKind: 'bot',
      resourceId: 'companion-b',
      resourceHistorySessionId: 'old-chat',
    };

    switchDrawerSessionInPlace({ replaceParams }, target);

    expect(replaceParams).toHaveBeenCalledWith(target);
  });
});

it('preserves sidebar presentation while replacing every old conversation parameter', () => {
  const replaceParams = vi.fn();
  switchDrawerSessionInPlace({ replaceParams }, { deviceId: 'mac', deviceName: 'Mac', sessionId: 'next', taskListEntry: 'sidebar' });
  expect(replaceParams).toHaveBeenCalledExactlyOnceWith({ deviceId: 'mac', deviceName: 'Mac', sessionId: 'next', taskListEntry: 'sidebar' });
});
