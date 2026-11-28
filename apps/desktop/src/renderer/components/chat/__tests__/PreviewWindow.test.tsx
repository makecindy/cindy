// @vitest-environment jsdom
/**
 * PreviewWindow.test.tsx — shared non-modal preview window.
 *
 * Production entry: the real `PreviewWindow` shell (used by every converted
 * attachment viewer) plus the pure geometry module behind its drag/resize.
 * Observable results: the conversation behind stays focusable/editable, Tab is
 * not trapped, focus enters on open and returns to the opener on close, the
 * window can be dragged and resized inside the viewport, and clicking the
 * conversation does not close it.
 *
 * Bug / rule basis: 2026-11-25 regression — a Markdown attachment covered the
 * conversation with a modal scrim and a trapped FocusScope; DESIGN.md §14.2
 * (ordinary Tab traversal) and docs/design-rules/attachment-preview.md.
 * Gap: TextLightboxInteraction.test.tsx covers one real viewer (.md) but not
 * the shared geometry, drag/resize, focus return or close paths.
 * Minimum failing input: one mounted preview with a background composer.
 * Tier: unit (jsdom, no I/O, no real timers beyond a 0ms focus-restore tick).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import {
  getActivePreviewFindHost,
} from '@/components/find-in-page/findInPageOwnership';
import {
  claimPreviewWindowEscape,
  previewOwnsKeyboardFocus,
  previewWindowOwnsEscape,
  previewWindowOwnsShortcut,
} from '../previewWindowKeyOwnership';
import {
  clampPreviewWindowRect,
  initialPreviewWindowRect,
  movePreviewWindowRect,
  previewWindowStyle,
  resizePreviewWindowRect,
} from '../previewWindowGeometry';
import { PreviewWindow } from '../PreviewWindow';

const VIEWPORT = { width: 1280, height: 800 };

// jsdom has no PointerEvent; the shell keys gestures by pointerId.
if (!('PointerEvent' in window)) {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    PointerEventStub as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderShell() {
  const onBackgroundClick = vi.fn();
  const opener = render(<button type="button">opener</button>);
  const openerButton = opener.getByRole('button', { name: 'opener' });
  openerButton.focus();
  const view = render(
    <>
      <div data-scroll-container="">
        <p>background message</p>
        <input aria-label="composer" />
      </div>
      <PreviewWindow ariaLabel="preview" onBackgroundClick={onBackgroundClick}>
        <div data-testid="content">preview content</div>
      </PreviewWindow>
    </>,
  );
  const panel = document.querySelector('[data-preview-window-panel]') as HTMLElement;
  const layer = document.querySelector('[data-preview-window-layer]') as HTMLElement;
  return { openerButton, onBackgroundClick, panel, layer, ...view };
}

describe('preview window geometry', () => {
  it('docks to the right, leaving the conversation column visible', () => {
    const rect = initialPreviewWindowRect(VIEWPORT);
    expect(rect.left).toBeGreaterThan(VIEWPORT.width / 2);
    expect(rect.top).toBe(40);
    expect(rect.left + rect.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(rect.top + rect.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('centers the compact surface for files that cannot be rendered', () => {
    const rect = initialPreviewWindowRect(VIEWPORT, { compact: true, extraHeight: 64 });
    expect(rect.width).toBe(480);
    expect(rect.height).toBe(424);
    expect(Math.abs(rect.left - (VIEWPORT.width - rect.width) / 2)).toBeLessThanOrEqual(1);
  });

  it.each([
    { width: 1280, height: 800 },
    { width: 900, height: 600 },
    { width: 320, height: 480 },
  ])('keeps every gesture inside %o', (viewport) => {
    const start = initialPreviewWindowRect(viewport);
    for (const rect of [
      start,
      clampPreviewWindowRect(start, viewport),
      movePreviewWindowRect(start, 9999, 9999, viewport),
      movePreviewWindowRect(start, -9999, -9999, viewport),
      resizePreviewWindowRect(start, 9999, 9999, viewport),
    ]) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width);
      expect(rect.top + rect.height).toBeLessThanOrEqual(viewport.height);
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  // Regression: shrinking the main window used to leave the footer and resize
  // handle below the bottom edge, because height was capped to the full
  // viewport while top was still pinned to the 40px title-bar strip.
  it('keeps the whole window on screen after the viewport shrinks', () => {
    const opened = initialPreviewWindowRect({ width: 1280, height: 800 });
    for (const viewport of [
      { width: 1280, height: 600 },
      { width: 900, height: 420 },
      { width: 400, height: 320 },
    ]) {
      const rect = clampPreviewWindowRect(opened, viewport);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.top + rect.height).toBeLessThanOrEqual(viewport.height);
      expect(rect.left + rect.width).toBeLessThanOrEqual(viewport.width);
      expect(rect.height).toBeGreaterThan(0);
    }
  });

  it('moves by the pointer delta and grows from the bottom-right corner', () => {
    const start = initialPreviewWindowRect(VIEWPORT);
    expect(movePreviewWindowRect(start, -40, 20, VIEWPORT)).toMatchObject({
      left: start.left - 40,
      top: start.top + 20,
    });
    // The right dock has no room to grow to the right until it is moved left.
    const moved = movePreviewWindowRect(start, -120, 0, VIEWPORT);
    const bigger = resizePreviewWindowRect(moved, 60, 30, VIEWPORT);
    expect(bigger.width).toBeGreaterThan(moved.width);
    expect(bigger.height).toBeGreaterThan(moved.height);
  });

  it('publishes the real window size through the shared CSS variables', () => {
    const style = previewWindowStyle(initialPreviewWindowRect(VIEWPORT)) as Record<string, unknown>;
    expect(style.pointerEvents).toBe('auto');
    expect(style['--preview-width']).toMatch(/^\d+px$/);
    expect(style['--preview-height']).toMatch(/^\d+px$/);
  });
});

describe('PreviewWindow shell', () => {
  it('has no scrim, no Tab trap and no scroll lock; the composer stays usable', () => {
    renderShell();
    expect(document.querySelector('[data-preview-scrim], .modal-scrim')).toBeNull();
    const panel = document.querySelector('[data-preview-window-panel]') as HTMLElement;
    const layer = document.querySelector('[data-preview-window-layer]') as HTMLElement;
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(layer.style.pointerEvents).toBe('none');
    expect(panel.style.pointerEvents).toBe('auto');
    expect(panel.style.position).toBe('absolute');
    expect((document.querySelector('[data-scroll-container]') as HTMLElement).style.overflowY).toBe('');
    // An untrapped FocusScope leaves Tab alone.
    expect(fireEvent.keyDown(panel, { key: 'Tab' })).toBe(true);

    const composer = screen.getByLabelText('composer') as HTMLInputElement;
    composer.focus();
    fireEvent.focusIn(composer);
    expect(document.activeElement).toBe(composer);
    fireEvent.change(composer, { target: { value: 'still typing' } });
    expect(composer.value).toBe('still typing');
  });

  it('focuses the window on open and restores the opener on close', async () => {
    const { openerButton, panel, unmount } = renderShell();
    expect(document.activeElement).toBe(panel);
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(openerButton));
  });

  it('drags from the header grip and ends the gesture on pointer up', () => {
    const { panel } = renderShell();
    const grip = document.querySelector('[data-preview-window-drag-handle]') as HTMLElement;
    const before = { left: Number.parseFloat(panel.style.left), top: Number.parseFloat(panel.style.top) };
    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 60, clientY: 50 });
    expect(Number.parseFloat(panel.style.left)).toBe(before.left - 40);
    expect(Number.parseFloat(panel.style.top)).toBe(before.top + 30);
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 60, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 10, clientY: 80 });
    expect(Number.parseFloat(panel.style.left)).toBe(before.left - 40);
  });

  it('resizes from the bottom-right handle within the viewport', () => {
    const { panel } = renderShell();
    const handle = document.querySelector('[data-preview-window-resize-handle]') as HTMLElement;
    const before = {
      width: Number.parseFloat(panel.style.width),
      height: Number.parseFloat(panel.style.height),
    };
    fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 140, clientY: 170 });
    const shrunk = Number.parseFloat(panel.style.width);
    expect(shrunk).toBeLessThan(before.width);
    expect(Number.parseFloat(panel.style.height)).toBeLessThan(before.height);
    // The default right dock already reaches the right edge; growing back is
    // bounded by the viewport, but must never shrink further.
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 240, clientY: 230 });
    expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(shrunk);
    expect(Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
    fireEvent.pointerUp(window, { pointerId: 8, clientX: 240, clientY: 230 });
  });

  it('closes only on the bare panel background, never on the conversation', () => {
    const { onBackgroundClick, panel } = renderShell();
    fireEvent.click(document.querySelector('[data-scroll-container]') as HTMLElement);
    fireEvent.click(screen.getByTestId('content'));
    expect(onBackgroundClick).not.toHaveBeenCalled();
    fireEvent.click(panel);
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
  });
});

describe('preview keyboard ownership', () => {
  const key = (init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });

  it('gives Escape only to the foreground preview and marks it consumed', () => {
    render(<PreviewWindow ariaLabel="older"><div>older</div></PreviewWindow>);
    const older = document.querySelectorAll<HTMLElement>('[data-preview-window-panel]')[0];
    render(<PreviewWindow ariaLabel="newer"><div>newer</div></PreviewWindow>);
    const newer = document.querySelectorAll<HTMLElement>('[data-preview-window-panel]')[1];
    const event = key();
    expect(previewWindowOwnsEscape(event, older)).toBe(false);
    expect(previewWindowOwnsEscape(event, newer)).toBe(true);
    expect(claimPreviewWindowEscape(event, newer)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(previewWindowOwnsEscape(event, newer)).toBe(false);
  });

  it('gives app shortcuts to the preview only while focus is inside it', () => {
    const { panel } = renderShell();
    const composer = screen.getByLabelText('composer') as HTMLInputElement;
    panel.focus();
    expect(previewOwnsKeyboardFocus(panel)).toBe(true);
    expect(previewWindowOwnsShortcut(key({ key: 'f', ctrlKey: true }), panel)).toBe(true);
    composer.focus();
    expect(previewOwnsKeyboardFocus(panel)).toBe(false);
    expect(previewWindowOwnsShortcut(key({ key: 'f', ctrlKey: true }), panel)).toBe(false);
    // The foreground preview still owns Escape while focus is in the composer.
    expect(previewWindowOwnsEscape(key(), panel)).toBe(true);
  });

  it('releases preview find ownership when focus moves to the conversation', () => {
    const { panel } = renderShell();
    panel.setAttribute('data-text-lightbox-search-host', '');
    panel.focus();
    expect(getActivePreviewFindHost()).toBe(panel);
    (screen.getByLabelText('composer') as HTMLInputElement).focus();
    expect(getActivePreviewFindHost()).toBeNull();
  });
});
