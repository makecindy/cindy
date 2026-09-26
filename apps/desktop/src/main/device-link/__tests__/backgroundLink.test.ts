import { describe, expect, it, vi } from 'vitest';
import { DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1 } from '@cindy/device-link';

import { assertBackgroundLinkAccepted, linkOpenCapabilities } from '../backgroundLink';

describe('background link capability', () => {
  it('declares a background link only while this computer controls nothing on the peer', () => {
    expect(linkOpenCapabilities(['base'], false)).toEqual([
      'base',
      DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
    ]);
    expect(linkOpenCapabilities(['base'], true)).toEqual(['base']);
  });

  it('accepts a peer that declares background support without closing the link', () => {
    const closeLink = vi.fn();
    assertBackgroundLinkAccepted(
      { capabilities: ['history-view-v1', DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] },
      { hasOutboundSubscriptions: () => false, closeLink },
    );
    expect(closeLink).not.toHaveBeenCalled();
  });

  it('closes the link it opened on an old peer and fails as unsupported', () => {
    const closeLink = vi.fn();
    expect(() =>
      assertBackgroundLinkAccepted(
        { capabilities: ['history-view-v1'] },
        { hasOutboundSubscriptions: () => false, closeLink },
      ),
    ).toThrow(/^\[UNSUPPORTED_CAPABILITY\]/);
    expect(closeLink).toHaveBeenCalledOnce();
  });

  it('keeps the link when the user started controlling the peer meanwhile', () => {
    const closeLink = vi.fn();
    expect(() =>
      assertBackgroundLinkAccepted({}, { hasOutboundSubscriptions: () => true, closeLink }),
    ).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(closeLink).not.toHaveBeenCalled();
  });
});
