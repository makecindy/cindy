// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { MyDevicesPanel } from '@/components/settings/MyDevicesPanel';

describe('MyDevicesPanel rename guards', () => {
  afterEach(cleanup);

  it('does not write a manual name when rename is confirmed without changes', () => {
    const s = settings();
    render(createElement(MyDevicesPanel, { s, variant: 'self' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.devices.rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.devices.renameConfirm' }));
    expect(s.rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settings.devices.rename' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed Mac' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.devices.renameConfirm' }));
    expect(s.rename).toHaveBeenCalledExactlyOnceWith('self', 'Renamed Mac');
  });
});

function device(deviceId: string, name: string, isSelf = false): DeviceLinkDeviceView {
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

describe('MyDevicesPanel device identity', () => {
  afterEach(cleanup);

  it('shows the reported versions and complete identities of same-name devices', () => {
    const s = settings();
    s.devices = [
      { ...device('self', 'Mac Studio', true), appVersion: '0.1.76' },
      { ...device('release-device', 'Mac Studio'), appVersion: '0.1.75' },
      { ...device('dev-dev-0123456789abcdef0123456789abcdef', 'Mac Studio'), appVersion: '0.1.76-beta.2' },
      { ...device('legacy', 'iPhone'), appVersion: null },
    ];
    render(createElement(MyDevicesPanel, { s }));

    for (const d of s.devices) {
      const row = document.querySelector(`[data-device-id="${d.deviceId}"]`);
      expect(row?.textContent).toContain(d.deviceId);
      if (d.appVersion) expect(row?.textContent).toContain(`Cindy ${d.appVersion}`);
      else {
        expect(row?.textContent).not.toContain('Cindy null');
        expect(row?.textContent).not.toContain('Cindy undefined');
      }
    }
  });
});

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


describe('MyDevicesPanel removal confirmation', () => {
  afterEach(cleanup);
  const deleteButton = () => within(document.querySelector('[data-device-id="phone-1"]') as HTMLElement).getByRole('button', { name: 'settings.devices.delete' });

  it('allows an online device to be removed only after confirmation', async () => {
    const s = settings();
    s.devices![1].online = true;
    render(createElement(MyDevicesPanel, { s }));
    expect(deleteButton().hasAttribute('disabled')).toBe(false);
    fireEvent.click(deleteButton());
    expect(s.remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('settings.devices.deleteMessage');
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'settings.devices.delete' })));
    expect(s.remove).toHaveBeenCalledExactlyOnceWith('phone-1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('cancels without deleting and keeps a failed deletion available for retry', async () => {
    const s = settings();
    s.remove = vi.fn(async () => false);
    render(createElement(MyDevicesPanel, { s }));
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    expect(s.remove).not.toHaveBeenCalled();
    fireEvent.click(deleteButton());
    await act(async () => fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'settings.devices.delete' })));
    expect(s.remove).toHaveBeenCalledExactlyOnceWith('phone-1');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('does not submit twice or dismiss while deletion is in flight', async () => {
    const s = settings();
    let finish!: (value: boolean) => void;
    s.remove = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(createElement(MyDevicesPanel, { s }));
    fireEvent.click(deleteButton());
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'settings.devices.delete' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(s.remove).toHaveBeenCalledExactlyOnceWith('phone-1');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => finish(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
