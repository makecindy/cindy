// @vitest-environment jsdom
import React, { type RefObject } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ImageHoverPreview } from '../ImageHoverPreview';

describe('ImageHoverPreview', () => {
  it('flips below the anchor when the shared 224×168 preview would leave the viewport', () => {
    const anchor = document.createElement('span');
    anchor.getBoundingClientRect = () =>
      ({
        top: 120,
        left: 100,
        width: 56,
        height: 24,
        right: 156,
        bottom: 144,
        x: 100,
        y: 120,
        toJSON: () => ({}),
      }) as DOMRect;
    const anchorRef = { current: anchor } as RefObject<HTMLElement | null>;

    const { rerender } = render(
      <ImageHoverPreview
        open
        anchorRef={anchorRef}
        src="xdt-file://preview.svg"
        alt="preview.svg"
      />,
    );

    const image = screen.getByRole('img', { name: 'preview.svg' });
    expect(image.getAttribute('src')).toBe('xdt-file://preview.svg');
    expect(image.className).toContain('max-w-[224px]');
    expect(image.style.maxHeight).toBe('168px');
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 225 },
      naturalHeight: { configurable: true, value: 150 },
    });
    fireEvent.load(image);
    expect(parseFloat(image.style.width)).toBeCloseTo(224);
    expect(parseFloat(image.style.height)).toBeCloseTo(149.33);
    expect(image.parentElement?.style.top).toBe('156px');
    expect(image.parentElement?.style.left).toBe('128px');
    expect(image.parentElement?.style.transform).toBe('translate(-50%, 0)');

    rerender(
      <ImageHoverPreview
        open={false}
        anchorRef={anchorRef}
        src="xdt-file://preview.svg"
        alt="preview.svg"
      />,
    );
    expect(screen.queryByRole('img', { name: 'preview.svg' })).toBeNull();
  });

  it('keeps the preview above the anchor when there is enough room', () => {
    const anchor = document.createElement('span');
    anchor.getBoundingClientRect = () =>
      ({
        top: 400,
        left: 300,
        width: 56,
        height: 24,
        right: 356,
        bottom: 424,
        x: 300,
        y: 400,
        toJSON: () => ({}),
      }) as DOMRect;
    const anchorRef = { current: anchor } as RefObject<HTMLElement | null>;

    render(
      <ImageHoverPreview
        open
        anchorRef={anchorRef}
        src="xdt-file://preview.svg"
        alt="preview-above.svg"
      />,
    );

    const image = screen.getByRole('img', { name: 'preview-above.svg' });
    expect(image.parentElement?.style.top).toBe('388px');
    expect(image.parentElement?.style.left).toBe('328px');
    expect(image.parentElement?.style.transform).toBe('translate(-50%, -100%)');
  });
});
