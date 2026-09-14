import { describe, expect, it } from 'vitest';

import { computeSwitch2UsbWanted } from '../switch2UsbWanted.js';

describe('computeSwitch2UsbWanted', () => {
  it('turns USB off while task slots are suspended even if preview still claims Nintendo', () => {
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: true,
        nintendoDeviceEnabled: true,
        previewFamily: 'nintendo',
      }),
    ).toBe(false);
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: true,
        nintendoDeviceEnabled: false,
        previewFamily: 'nintendo',
      }),
    ).toBe(false);
  });

  it('allows USB when slots are live and Nintendo is enabled or previewed', () => {
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: false,
        nintendoDeviceEnabled: true,
        previewFamily: null,
      }),
    ).toBe(true);
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: false,
        nintendoDeviceEnabled: false,
        previewFamily: 'nintendo',
      }),
    ).toBe(true);
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: false,
        nintendoDeviceEnabled: false,
        previewFamily: 'xbox',
      }),
    ).toBe(false);
    expect(
      computeSwitch2UsbWanted({
        taskSlotsSuspended: false,
        nintendoDeviceEnabled: false,
        previewFamily: null,
      }),
    ).toBe(false);
  });
});
