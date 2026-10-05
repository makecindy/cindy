// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { MyDevicesPanel } from '@/components/settings/MyDevicesPanel';

describe('MyDevicesPanel rename guards', () => {
  it('does not write a manual name when rename is confirmed without changes', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/settings/MyDevicesPanel.tsx'),
      'utf8',
    );

    expect(source).toContain('const currentName =');
    expect(source).toContain('if (name && name === currentName) return;');
    expect(source).toContain('await s.rename(deviceId, name || null);');
  });
});

function device(deviceId: string, name: string, isSelf = false) {
  return {
    deviceId,
    name,
    platform: isSelf ? 'darwin' : 'ios',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: false,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf,
  };
}

function settings(): DeviceLinkSettings {
  const noop = vi.fn(async () => undefined);
  return {
    enabled: true,
    linkStatus: 'online',
    connectionIssue: null,
    standby: false,
    devices: [device('self', 'Studio Mac', true), device('phone-1', 'iPhone'), device('pad-1', 'iPad')],
    controlledBy: [],
    revokedControllers: [],
    disabledControlDeviceIds: [],
    listError: null,
    refreshing: false,
    refresh: noop,
    setEnabled: noop,
    rename: noop,
    remove: vi.fn(async () => true),
    disconnectAll: noop,
    revoke: noop,
    restore: noop,
    setDeviceControlEnabled: noop,
  } as unknown as DeviceLinkSettings;
}

describe('MyDevicesPanel device focus deep link', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const row = (id: string) => document.querySelector<HTMLElement>(`[data-device-id="${id}"]`);
  const flushFrames = async () => {
    // 两帧:排在设置页 section 深链滚动之后。
    await act(async () => {
      vi.advanceTimersToNextFrame();
      vi.advanceTimersToNextFrame();
    });
  };

  it('scrolls the focused device into view and briefly highlights it', async () => {
    render(
      createElement(MyDevicesPanel, {
        s: settings(),
        variant: 'others',
        focusDeviceId: 'phone-1',
        focusRequestKey: 'phone-1:k1',
      }),
    );
    await flushFrames();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(row('phone-1'));
    expect(row('phone-1')?.classList.contains('settings-search-target-highlight')).toBe(true);
    expect(row('pad-1')?.classList.contains('settings-search-target-highlight')).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(row('phone-1')?.classList.contains('settings-search-target-highlight')).toBe(false);
  });

  it('focuses each request once and again for a new request key', async () => {
    const s = settings();
    const view = render(
      createElement(MyDevicesPanel, {
        s,
        variant: 'others',
        focusDeviceId: 'phone-1',
        focusRequestKey: 'phone-1:k1',
      }),
    );
    await flushFrames();
    view.rerender(
      createElement(MyDevicesPanel, {
        s,
        variant: 'others',
        focusDeviceId: 'phone-1',
        focusRequestKey: 'phone-1:k1',
      }),
    );
    await flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(
      createElement(MyDevicesPanel, {
        s,
        variant: 'others',
        focusDeviceId: 'phone-1',
        focusRequestKey: 'phone-1:k2',
      }),
    );
    await flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('leaves the device to the panel instance that renders it', async () => {
    render(
      createElement(MyDevicesPanel, {
        s: settings(),
        variant: 'self',
        focusDeviceId: 'phone-1',
        focusRequestKey: 'phone-1:k1',
      }),
    );
    await flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does nothing for a device that is no longer in the list', async () => {
    render(
      createElement(MyDevicesPanel, {
        s: settings(),
        variant: 'others',
        focusDeviceId: 'gone',
        focusRequestKey: 'gone:k1',
      }),
    );
    await flushFrames();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
