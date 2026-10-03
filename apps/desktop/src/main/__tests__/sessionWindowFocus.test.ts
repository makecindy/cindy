import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ focused: null as unknown }));
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => state.focused },
}));

import {
  clearSessionWindowFocus,
  focusedWindowForSession,
  noteSessionWindowFocus,
} from '../maker-host/session-window-focus';

function makeWindow(id: number) {
  const listeners: Array<() => void> = [];
  const webContents = {
    id,
    isDestroyed: () => false,
    once: (_event: string, callback: () => void) => listeners.push(callback),
  };
  return { webContents, isDestroyed: () => false, destroy: () => listeners.forEach((cb) => cb()) };
}

describe('session window focus for Git consent', () => {
  beforeEach(() => {
    state.focused = null;
  });

  it('only returns the focused window when it displays that session', () => {
    const first = makeWindow(101);
    const other = makeWindow(102);
    noteSessionWindowFocus(first.webContents as never, 'session-a');
    noteSessionWindowFocus(other.webContents as never, 'session-b');
    state.focused = other;
    expect(focusedWindowForSession('session-a')).toBeNull();
    state.focused = first;
    expect(focusedWindowForSession('session-a')).toBe(first);
    noteSessionWindowFocus(first.webContents as never, 'session-b');
    expect(focusedWindowForSession('session-a')).toBeNull();
    first.destroy();
    expect(focusedWindowForSession('session-b')).toBeNull();
    state.focused = other;
    clearSessionWindowFocus();
    expect(focusedWindowForSession('session-b')).toBeNull();
  });
});
