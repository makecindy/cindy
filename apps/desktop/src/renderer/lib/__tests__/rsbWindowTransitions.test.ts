import { describe, expect, it } from 'vitest';

import {
  detachedHostAfterOpen,
  didUserCloseDetachedSidebarWindow,
  nextDetachedHostAfterFocus,
  sessionIdForDetachedSidebarClose,
} from '../rsbWindowTransitions';

describe('didUserCloseDetachedSidebarWindow', () => {
  it('recognizes every close path by the detached open-to-closed transition', () => {
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: true, detached: true, open: true },
        { loaded: true, detached: true, open: false },
      ),
    ).toBe(true);
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: true, detached: true, open: true },
        { loaded: true, detached: true, open: false, userClose: false },
      ),
    ).toBe(false);
  });

  it('does not treat merge-back, bootstrap, or opening as a user close', () => {
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: true, detached: true, open: true },
        { loaded: true, detached: false, open: false },
      ),
    ).toBe(false);
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: false, detached: false, open: false },
        { loaded: true, detached: true, open: false },
      ),
    ).toBe(false);
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: true, detached: true, open: false },
        { loaded: true, detached: true, open: true },
      ),
    ).toBe(false);
  });

  it('attributes a detached close to the pinned host, not the focused session', () => {
    expect(
      sessionIdForDetachedSidebarClose(
        { loaded: true, detached: true, open: false, hostSessionId: 'session-a' }.hostSessionId,
        'session-b',
      ),
    ).toBe('session-a');
    expect(sessionIdForDetachedSidebarClose('session-a', 'session-b')).toBe('session-a');
    expect(sessionIdForDetachedSidebarClose(null, 'session-b')).toBe('session-b');
    expect(sessionIdForDetachedSidebarClose(null, null)).toBeNull();
    expect(nextDetachedHostAfterFocus('session-a', 'session-b')).toBe('session-a');
    expect(nextDetachedHostAfterFocus('session-a', 'session-a')).toBeNull();
    expect(sessionIdForDetachedSidebarClose(
      nextDetachedHostAfterFocus('session-a', 'session-a'),
      'session-c',
    )).toBe('session-c');
    expect(detachedHostAfterOpen({
      currentSessionId: 'session-a',
      targetSessionId: 'session-a',
      previousHostSessionId: null,
    })).toBeNull();
    expect(detachedHostAfterOpen({
      currentSessionId: 'session-b',
      targetSessionId: 'session-a',
      previousHostSessionId: null,
    })).toBe('session-a');
    expect(detachedHostAfterOpen({
      currentSessionId: 'session-b',
      targetSessionId: 'session-b',
      previousHostSessionId: 'session-a',
    })).toBeNull();
    expect(sessionIdForDetachedSidebarClose(
      nextDetachedHostAfterFocus(
        detachedHostAfterOpen({
          currentSessionId: 'session-a',
          targetSessionId: 'session-a',
          previousHostSessionId: null,
        }),
        'session-c',
      ),
      'session-c',
    )).toBe('session-c');
  });

  it('does not let a secondary window persist the primary detached close transition', () => {
    expect(
      didUserCloseDetachedSidebarWindow(
        { loaded: true, detached: true, open: true },
        { loaded: true, detached: true, open: false },
        false,
      ),
    ).toBe(false);
  });
});
