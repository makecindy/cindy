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

import { useAppShortcut, useAppShortcutEvents } from '../useAppShortcut';
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

  it('lets IME, repeated keys and shortcut recording pass without invoking a dynamic shortcut', () => {
    const handler = vi.fn(() => true);
    const matches = vi.fn(() => true);
    function Harness() {
      useAppShortcutEvents(matches, handler);
      return null;
    }
    render(<Harness />);

    window.dispatchEvent(new KeyboardEvent('keydown', { repeat: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { isComposing: true, cancelable: true }));
    document.body.dataset.appShortcutRecording = '1';
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true }));
    } finally {
      delete document.body.dataset.appShortcutRecording;
    }
    expect(matches).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('only consumes a matching dynamic shortcut when the app is locked', () => {
    const handler = vi.fn(() => true);
    function Harness() {
      useAppShortcutEvents(event => event.code === 'KeyJ', handler);
      return null;
    }
    render(<Harness />);
    const release = acquireAppInteractionLock();
    try {
      const other = new KeyboardEvent('keydown', { code: 'KeyK', cancelable: true });
      const matching = new KeyboardEvent('keydown', { code: 'KeyJ', cancelable: true });
      window.dispatchEvent(other);
      window.dispatchEvent(matching);
      expect(other.defaultPrevented).toBe(false);
      expect(matching.defaultPrevented).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
