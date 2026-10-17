import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearGhostOverlayWebContents,
  ghostIdForOverlayWebContents,
  isGhostOverlayWebContents,
  markGhostOverlayWebContentsId,
} from '../registry.js';

describe('ghost overlay webContents registry', () => {
  beforeEach(() => {
    clearGhostOverlayWebContents(1);
    clearGhostOverlayWebContents(2);
  });

  it('binds, looks up and clears a webContents id', () => {
    expect(isGhostOverlayWebContents(1)).toBe(false);
    expect(ghostIdForOverlayWebContents(1)).toBeNull();

    markGhostOverlayWebContentsId(1, 'acme-overlay');
    expect(isGhostOverlayWebContents(1)).toBe(true);
    expect(ghostIdForOverlayWebContents(1)).toBe('acme-overlay');

    clearGhostOverlayWebContents(1);
    expect(isGhostOverlayWebContents(1)).toBe(false);
    expect(ghostIdForOverlayWebContents(1)).toBeNull();
  });

  it('keeps distinct ghost ids separated and supports rebinding', () => {
    markGhostOverlayWebContentsId(1, 'acme-overlay');
    markGhostOverlayWebContentsId(2, 'other-overlay');
    expect(ghostIdForOverlayWebContents(1)).toBe('acme-overlay');
    expect(ghostIdForOverlayWebContents(2)).toBe('other-overlay');

    markGhostOverlayWebContentsId(1, 'acme-overlay-rebound');
    expect(ghostIdForOverlayWebContents(1)).toBe('acme-overlay-rebound');
    expect(ghostIdForOverlayWebContents(2)).toBe('other-overlay');
  });
});
