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
});
