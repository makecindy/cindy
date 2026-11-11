import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import { isResourceUsageOpenSender } from '../open-sender.js';

function fakeWindow(sender: WebContents, destroyed = false): BrowserWindow {
  return {
    webContents: sender,
    isDestroyed: () => destroyed,
  } as unknown as BrowserWindow;
}

describe('resource usage open sender boundary', () => {
  it('allows the main window and registered session secondary windows', () => {
    const mainSender = { id: 1 } as WebContents;
    const secondarySender = { id: 2 } as WebContents;
    const mainWindow = fakeWindow(mainSender);
    const secondaryWindow = fakeWindow(secondarySender);
    const isSecondaryAppWindow = vi.fn((win) => win === secondaryWindow);

    expect(
      isResourceUsageOpenSender({
        sender: mainSender,
        mainWindow,
        senderWindow: mainWindow,
        isSecondaryAppWindow,
      }),
    ).toBe(true);
    expect(
      isResourceUsageOpenSender({
        sender: secondarySender,
        mainWindow,
        senderWindow: secondaryWindow,
        isSecondaryAppWindow,
      }),
    ).toBe(true);
  });

  it('rejects unrelated app-content windows and a destroyed main window', () => {
    const mainSender = { id: 1 } as WebContents;
    const otherSender = { id: 3 } as WebContents;
    const otherWindow = fakeWindow(otherSender);
    const isSecondaryAppWindow = vi.fn(() => false);

    expect(
      isResourceUsageOpenSender({
        sender: otherSender,
        mainWindow: fakeWindow(mainSender),
        senderWindow: otherWindow,
        isSecondaryAppWindow,
      }),
    ).toBe(false);
    expect(
      isResourceUsageOpenSender({
        sender: mainSender,
        mainWindow: fakeWindow(mainSender, true),
        senderWindow: null,
        isSecondaryAppWindow,
      }),
    ).toBe(false);
  });
});
