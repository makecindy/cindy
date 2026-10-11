import { describe, expect, it } from 'vitest';
import { getRenderWatchdogContext } from '../renderWatchdogContext';

const contents = {
  id: 7,
  isDestroyed: () => false,
  getOSProcessId: () => 42,
  getBackgroundThrottling: () => false,
};
const win = {
  id: 3,
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => true,
};

describe('render watchdog native context', () => {
  it('captures sender identity and real window/throttling state without URLs or titles', () => {
    expect(getRenderWatchdogContext(contents, win)).toEqual({
      webContentsId: 7,
      windowId: 3,
      nativeObservedAt: expect.any(Number),
      rendererPid: 42,
      backgroundThrottling: false,
      nativeVisible: true,
      nativeMinimized: true,
    });
  });

  it('marks a missing native window as unknown rather than visible', () => {
    expect(getRenderWatchdogContext(contents, null)).toMatchObject({
      windowId: null,
      nativeVisible: null,
      nativeMinimized: null,
    });
  });

  it('does not throw when shutdown destroys the sender or a native getter fails', () => {
    expect(getRenderWatchdogContext({ ...contents, isDestroyed: () => true }, win)).toMatchObject({
      nativeStateUnavailable: true,
    });
    expect(getRenderWatchdogContext(contents, { ...win, isDestroyed: () => true })).toMatchObject({
      nativeStateUnavailable: true,
    });
    expect(
      getRenderWatchdogContext(
        {
          ...contents,
          getOSProcessId: () => {
            throw new Error('Object has been destroyed');
          },
        },
        win,
      ),
    ).toMatchObject({ nativeStateUnavailable: true });
  });
});
