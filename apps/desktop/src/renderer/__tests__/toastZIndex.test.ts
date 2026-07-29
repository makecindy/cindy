/**
 * toastZIndex.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for: file-modal-and-toast-polish (2026-04-19) — symptom #1
 *
 * Toast must always sit ABOVE every Modal/Lightbox/Dialog. The whole
 * application uses 9999 as the "max" stacking layer for overlays (TextLightbox,
 * ImageLightbox, SplashScreen). To guarantee the Toast wins the z-index race
 * even when Modals + Lightboxes are stacked in document.body via Portals,
 * ToastContainer is above the z-[10000] Radix Dialog layer at 10100.
 *
 * Static-source scanning (matches the project convention used by
 * textLightbox.test.ts and imageLightboxCloseAnywhere.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  it('ToastContainer class uses z-[10100] (above lightboxes and Radix dialogs)', () => {
    expect(toastContainerSource).toMatch(
      /className="[^"]*\bz-\[10100\][^"]*"/,
    );
  });

  it('TextLightbox overlay still uses zIndex 9999 (below toast layer)', () => {
    // The lightbox sits at 9999; the toast sits at 10100. The strict ordering
    // is what guarantees the Toast wins even when the Lightbox Portal mounts
    // later in document.body.
    expect(textLightboxSource).toMatch(/TEXT_LIGHTBOX_OVERLAY_Z_INDEX\s*=\s*9999/);
  });

  it('ImageLightbox overlay still uses zIndex 9999 (below toast layer)', () => {
    expect(imageLightboxSource).toMatch(/zIndex:\s*9999/);
  });
});
