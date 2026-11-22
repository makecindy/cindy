/**
 * toastZIndex.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for: file-modal-and-toast-polish (2026-04-19) — symptom #1
 *
 * Toast must always sit ABOVE every Modal/Lightbox/Dialog. Lightboxes and the
 * splash screen sit on the `fullscreen` layer (9999), dialogs on `modal`…
 * `modal-nested` (10000–10002), menus/tips on `dropdown`/`tooltip`; the Toast
 * container uses the `toast` layer (10100) so it wins the z-index race even when
 * Modals + Lightboxes are stacked in document.body via Portals
 * (DESIGN.md §6 z-index layers).
 *
 * Static-source scanning follows the existing renderer contract-test convention.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Z_INDEX_LAYERS } from '../styles/generated/token-mappings';

const toastContainerSource = readFileSync(
  resolve(__dirname, '..', 'components', 'ui', 'toast', 'ToastContainer.tsx'),
  'utf8',
);

const textLightboxSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'TextLightbox.tsx'),
  'utf8',
);

const imageLightboxSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'ImageLightbox.tsx'),
  'utf8',
);

describe('Toast z-index — sits above all overlays (symptom #1)', () => {
  it('ToastContainer class uses the toast layer, above lightboxes, dialogs and menus', () => {
    expect(toastContainerSource).toMatch(/className="[^"]*\bz-toast\b(?!-)[^"]*"/);
    for (const below of ['fullscreen', 'modal', 'modal-raised', 'modal-nested', 'dropdown', 'tooltip', 'modal-popover-nested'] as const) {
      expect(Z_INDEX_LAYERS.toast).toBeGreaterThan(Z_INDEX_LAYERS[below]);
    }
  });

  it('TextLightbox overlay still uses the fullscreen layer (below toast layer)', () => {
    // The strict ordering is what guarantees the Toast wins even when the
    // Lightbox Portal mounts later in document.body.
    expect(textLightboxSource).toMatch(/TEXT_LIGHTBOX_OVERLAY_Z_INDEX\s*=\s*Z_INDEX_LAYERS\.fullscreen\b/);
  });

  it('ImageLightbox overlay still uses the fullscreen layer (below toast layer)', () => {
    expect(imageLightboxSource).toMatch(/zIndex:\s*Z_INDEX_LAYERS\.fullscreen\b/);
  });
});
