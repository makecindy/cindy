import { describe, expect, it, vi } from 'vitest';

import { VOICE_INPUT_POWER_STATE_CHANNEL } from '../../../shared/voiceInputPowerIpc';
import {
  broadcastVoiceInputPowerState,
  installVoiceInputPowerRelease,
  type VoicePowerMonitorLike,
} from '../powerReleaseNotifier';

function createFakePowerMonitor(): VoicePowerMonitorLike & { emit: (event: string) => void } {
  const listeners = new Map<string, Array<() => void>>();
  return {
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    emit(event: string) {
      (listeners.get(event) ?? []).forEach((listener) => listener());
    },
  } as VoicePowerMonitorLike & { emit: (event: string) => void };
}

describe('installVoiceInputPowerRelease', () => {
  it('broadcasts a release reason on suspend and lock-screen', () => {
    const powerMonitor = createFakePowerMonitor();
    const broadcast = vi.fn();

    installVoiceInputPowerRelease({
      powerMonitor,
      broadcast,
      logger: { debug: vi.fn() },
    });

    powerMonitor.emit('suspend');
    powerMonitor.emit('lock-screen');

    expect(broadcast).toHaveBeenNthCalledWith(1, VOICE_INPUT_POWER_STATE_CHANNEL, {
      reason: 'system_suspend',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, VOICE_INPUT_POWER_STATE_CHANNEL, {
      reason: 'screen_locked',
    });
  });

  it('keeps broadcasting after one window fails mid-teardown', () => {
    const delivered: string[] = [];
    const makeWindow = (name: string, behaviour: 'ok' | 'destroyed' | 'throws') => ({
      isDestroyed: () => behaviour === 'destroyed',
      webContents: {
        send: () => {
          if (behaviour === 'throws') throw new Error('Object has been destroyed');
          delivered.push(name);
        },
      },
    });
    const warn = vi.fn();

    broadcastVoiceInputPowerState(
      [makeWindow('first', 'ok'), makeWindow('racing', 'throws'), makeWindow('skipped', 'destroyed'), makeWindow('owner', 'ok')],
      VOICE_INPUT_POWER_STATE_CHANNEL,
      { reason: 'screen_locked' },
      { warn },
    );

    // The one-shot release must still reach the window after the failing one —
    // that may be the renderer holding the live microphone.
    expect(delivered).toEqual(['first', 'owner']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast before a power event fires', () => {
    const powerMonitor = createFakePowerMonitor();
    const broadcast = vi.fn();

    installVoiceInputPowerRelease({ powerMonitor, broadcast, logger: { debug: vi.fn() } });

    expect(broadcast).not.toHaveBeenCalled();
  });
});
