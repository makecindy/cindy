/**
 * Regression: a shared-profile preview must not announce global bot presence.
 * Calls the runtime predicate used by both Desktop Feishu factories; existing
 * transport tests do not know Electron's resolved profile. Minimal input is
 * dev + XDT_PASSIVE_SHARED_USER_DATA=1. Unit tier, no external resources;
 * standalone wall time: 274ms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldAnnounceFeishuLifecycle } from '../feishu/lifecycleAnnouncements';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock('electron', () => electron);

afterEach(() => {
  vi.unstubAllEnvs();
  electron.app.isPackaged = false;
});

describe('Desktop Feishu lifecycle notice ownership', () => {
  it.each([
    [true, '1', true],
    [false, '1', false],
    [false, undefined, true],
    [false, '0', true],
  ])('packaged=%s shared-passive=%s allows notices=%s', (packaged, sharedPassive, expected) => {
    electron.app.isPackaged = packaged;
    vi.stubEnv('XDT_PASSIVE_SHARED_USER_DATA', sharedPassive);
    expect(shouldAnnounceFeishuLifecycle()).toBe(expected);
  });

  it('checks the resolved profile at send time, keeping isolated passive sandboxes eligible', () => {
    vi.stubEnv('XDT_PASSIVE_SHARED_USER_DATA', undefined);
    vi.stubEnv('XDT_SCHEDULER_PASSIVE', '1');
    expect(shouldAnnounceFeishuLifecycle()).toBe(true);
    vi.stubEnv('XDT_PASSIVE_SHARED_USER_DATA', '1');
    expect(shouldAnnounceFeishuLifecycle()).toBe(false);
  });
});
