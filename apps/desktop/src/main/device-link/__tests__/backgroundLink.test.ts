import { describe, expect, it, vi } from 'vitest';
import { DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1 } from '@cindy/device-link';

import { assertBackgroundLinkAccepted, assertSubscriptionLinkAccepted, hasControlSubscription, linkOpenCapabilities } from '../backgroundLink';

describe('background link capability', () => {
  it('keeps task-list and file-watch subscriptions in the background', () => {
    expect(hasControlSubscription(['sessions', 'fs-watch:/project'])).toBe(false);
    expect(hasControlSubscription(['sessions', 'session:task-1'])).toBe(true);
    expect(linkOpenCapabilities(['base'], [])).toEqual([
      'base',
      DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
    ]);
    expect(linkOpenCapabilities(['base'], ['sessions', 'fs-watch:/project'])).toEqual([
      'base',
      DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
    ]);
    expect(linkOpenCapabilities(['base'], ['sessions', 'session:task-1'])).toEqual(['base']);
    expect(linkOpenCapabilities(['base'], ['*'])).toEqual(['base']);
  });

  it('accepts a peer that declares background support without closing the link', () => {
    const closeLink = vi.fn();
    assertBackgroundLinkAccepted(
      { capabilities: ['history-view-v1', DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] },
      { hasOutboundControlSubscription: () => false, closeLink },
    );
    expect(closeLink).not.toHaveBeenCalled();
  });

  it('closes the link it opened on an old peer and fails as unsupported', () => {
    const closeLink = vi.fn();
    expect(() =>
      assertBackgroundLinkAccepted(
        { capabilities: ['history-view-v1'] },
        { hasOutboundControlSubscription: () => false, closeLink },
      ),
    ).toThrow(/^\[UNSUPPORTED_CAPABILITY\]/);
    expect(closeLink).toHaveBeenCalledOnce();
  });

  it('keeps the link when the user started controlling the peer meanwhile', () => {
    const closeLink = vi.fn();
    expect(() =>
      assertBackgroundLinkAccepted({}, { hasOutboundControlSubscription: () => true, closeLink }),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(closeLink).not.toHaveBeenCalled();
  });

  it('closes an old-peer link when only background subscriptions remain', () => {
    const closeLink = vi.fn();
    const topics = ['sessions', 'fs-watch:/project'];
    expect(() => assertBackgroundLinkAccepted(
      { capabilities: [] },
      { hasOutboundControlSubscription: () => hasControlSubscription(topics), closeLink },
    )).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(closeLink).toHaveBeenCalledOnce();
  });

  it('keeps an old-peer link when a foreground subscription joins an in-flight background open', () => {
    const closeLink = vi.fn();
    const topics = ['sessions', 'session:task-1'];
    expect(() => assertSubscriptionLinkAccepted(
      { capabilities: [] },
      { hasOutboundControlSubscription: () => hasControlSubscription(topics), closeLink },
    )).not.toThrow();
    expect(closeLink).not.toHaveBeenCalled();
  });

  it('keeps a foreground remote desktop link when a background read is unsupported', () => {
    const closeLink = vi.fn();
    expect(() => assertBackgroundLinkAccepted(
      { capabilities: [] },
      { hasOutboundControlSubscription: () => false, hasForegroundInvoke: () => true, closeLink },
    )).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(closeLink).not.toHaveBeenCalled();
  });

  it('rejects a background-only subscription on an old peer', () => {
    const closeLink = vi.fn();
    expect(() => assertSubscriptionLinkAccepted(
      { capabilities: [] },
      { hasOutboundControlSubscription: () => hasControlSubscription(['sessions']), closeLink },
    )).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(closeLink).toHaveBeenCalledOnce();
  });

  it('keeps an old-peer link while a foreground remote desktop invoke is opening it', () => {
    const closeLink = vi.fn();
    expect(() => assertSubscriptionLinkAccepted(
      { capabilities: [] },
      { hasOutboundControlSubscription: () => false, hasForegroundInvoke: () => true, closeLink },
    )).not.toThrow();
    expect(closeLink).not.toHaveBeenCalled();
  });
});
