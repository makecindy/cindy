import { describe, expect, it } from 'vitest';
import { hasActiveSessionWatcher } from '../mobileNotify';

/**
 * Regression for #9218:
 * `sendMobileSessionNotify` used to skip the push whenever any controller was
 * subscribed to `session:<id>`. A phone that locks / backgrounds the app keeps
 * that topic in the subscription registry while its link goes away, so the push
 * was suppressed exactly when it was needed.
 */
describe('hasActiveSessionWatcher', () => {
  const ready = new Set(['phone-1', 'desktop-2']);
  const offline = new Set<string>();
  const args = (subscriberIds: string[]) => ({
    subscriberIds,
    isLinkReady: (id: string) => ready.has(id),
    isExplicitlyOffline: (id: string) => offline.has(id),
  });

  it('returns false when there is no subscriber at all', () => {
    expect(hasActiveSessionWatcher(args([]))).toBe(false);
  });

  it('suppresses notification when a subscribed controller has a ready link', () => {
    expect(hasActiveSessionWatcher(args(['phone-1']))).toBe(true);
    expect(hasActiveSessionWatcher(args(['phone-1', 'desktop-2']))).toBe(true);
  });

  it('does NOT suppress when the only subscriber link is gone (phone locked / backgrounded)', () => {
    // This is the exact #9218 failure: stale topic, dead link.
    expect(hasActiveSessionWatcher(args(['phone-locked']))).toBe(false);
  });

  it('does NOT suppress when presence explicitly says the subscriber is offline', () => {
    offline.add('phone-1');
    expect(hasActiveSessionWatcher(args(['phone-1']))).toBe(false);
    offline.delete('phone-1');
  });

  it('keeps suppressing if at least one of several subscribers is still live', () => {
    expect(hasActiveSessionWatcher(args(['phone-locked', 'desktop-2']))).toBe(true);
  });

  it('is fail-open on unknown presence (fresh reconnect, first presence frame not yet seen)', () => {
    // isExplicitlyOffline=false for unknown views; a ready link still counts as watching.
    expect(hasActiveSessionWatcher(args(['phone-1']))).toBe(true);
  });

  it('does not mutate the caller-provided subscriber list', () => {
    const ids = ['phone-locked', 'desktop-2'];
    const snapshot = [...ids];
    hasActiveSessionWatcher(args(ids));
    expect(ids).toEqual(snapshot);
  });
});
