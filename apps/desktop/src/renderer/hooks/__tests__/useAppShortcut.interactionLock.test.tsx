// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/appShortcuts', () => ({
  formatAppShortcutCombo: () => '',
  matchesKeyboardEvent: () => true,
}));

vi.mock('../../lib/appShortcutStore', () => ({
  getAppShortcutCombos: () => [{}],
  getAppShortcutPlatform: () => 'win32',
  subscribeAppShortcuts: () => () => undefined,
}));

import { useAppShortcut } from '../useAppShortcut';
import { acquireAppInteractionLock } from '../../lib/appInteractionLock';

afterEach(cleanup);

describe('useAppShortcut interaction lock', () => {
  it('consumes matching shortcuts without invoking handlers while the app is locked', () => {
    const handler = vi.fn(() => true);
    function Harness() {
      useAppShortcut('toggle-sidebar', handler);
      return null;
    }
    render(<Harness />);

    const release = acquireAppInteractionLock();
    try {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
      window.dispatchEvent(event);

      expect(handler).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    } finally {
      release();
    }
  });
});
