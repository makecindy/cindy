import { describe, expect, it } from 'vitest';

import {
  joinSourceTooltip,
  myDevicesFocusPath,
  resolveSourceDeviceDisplay,
  shouldShowSourceDeviceForViewer,
} from '@/lib/messageSourceLabel';

const phone = { deviceId: 'phone-abcdef123', name: 'Old iPhone', platform: 'mobile' as const };

describe('resolveSourceDeviceDisplay', () => {
  it('prefers the live device name so a rename updates the label', () => {
    expect(
      resolveSourceDeviceDisplay(phone, [{ deviceId: 'phone-abcdef123', name: 'New iPhone' }]),
    ).toEqual({ name: 'New iPhone', present: true });
  });

  it('falls back to the snapshot name while the device list is not loaded', () => {
    expect(resolveSourceDeviceDisplay(phone, null)).toEqual({ name: 'Old iPhone', present: null });
  });

  it('reports a device missing from a loaded list as removed and keeps the snapshot name', () => {
    expect(resolveSourceDeviceDisplay(phone, [{ deviceId: 'other', name: 'Mac' }])).toEqual({
      name: 'Old iPhone',
      present: false,
    });
  });

  it('appends a short id only when another known device shares the name', () => {
    expect(
      resolveSourceDeviceDisplay(phone, [
        { deviceId: 'phone-abcdef123', name: 'iPhone' },
        { deviceId: 'phone-999', name: ' iphone ' },
      ]),
    ).toEqual({ name: 'iPhone (phone-)', present: true });
    expect(
      resolveSourceDeviceDisplay(phone, [
        { deviceId: 'phone-abcdef123', name: 'iPhone' },
        { deviceId: 'mac', name: 'MacBook' },
      ]).name,
    ).toBe('iPhone');
  });

  it('has no name when neither the list nor the snapshot has one', () => {
    expect(
      resolveSourceDeviceDisplay({ deviceId: 'pc', platform: 'desktop' }, [
        { deviceId: 'pc', name: '  ' },
      ]),
    ).toEqual({ present: true });
  });
});

describe('shouldShowSourceDeviceForViewer', () => {
  it('hides the label on the sending device itself', () => {
    expect(
      shouldShowSourceDeviceForViewer(phone, { authDeviceId: 'phone-abcdef123', devices: null }),
    ).toBe(false);
    expect(
      shouldShowSourceDeviceForViewer(phone, {
        authDeviceId: null,
        devices: [{ deviceId: 'phone-abcdef123', name: 'iPhone', isSelf: true }],
      }),
    ).toBe(false);
  });

  it('shows the label on every other device, including the controlled host', () => {
    expect(
      shouldShowSourceDeviceForViewer(phone, {
        authDeviceId: 'host',
        devices: [
          { deviceId: 'host', name: 'Host', isSelf: true },
          { deviceId: 'phone-abcdef123', name: 'iPhone', isSelf: false },
        ],
      }),
    ).toBe(true);
    expect(shouldShowSourceDeviceForViewer(phone, { authDeviceId: null, devices: null })).toBe(
      true,
    );
  });

  it('never shows a label for messages without a source device', () => {
    expect(shouldShowSourceDeviceForViewer(undefined, { authDeviceId: 'x', devices: null })).toBe(
      false,
    );
  });
});

describe('source label helpers', () => {
  it('builds the My devices focus deep link alongside the devices section', () => {
    expect(myDevicesFocusPath('a b')).toBe(
      '/settings?tab=remote-control&section=devices&device=a%20b',
    );
  });

  it('joins tooltip lines and drops empty ones', () => {
    expect(joinSourceTooltip([false, 'ID: 1'])).toBe('ID: 1');
    expect(joinSourceTooltip(['View', null, 'ID: 1'])).toBe('View\nID: 1');
    expect(joinSourceTooltip([undefined])).toBeUndefined();
  });
});
