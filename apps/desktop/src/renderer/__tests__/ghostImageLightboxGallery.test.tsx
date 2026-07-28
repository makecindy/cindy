// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ImageGalleryContext } from '@/components/chat/ImageGalleryContext';
import { ImageLightbox } from '@/components/chat/ImageLightbox';

afterEach(() => {
  cleanup();
});

describe('Ghost card ImageLightbox gallery positioning', () => {
  it('opens the exact duplicate image selected inside a plugin card iframe', () => {
    const repeated = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    render(
      <ImageGalleryContext.Provider
        value={[
          { src: repeated, galleryId: 'ghost-card:first:0' },
          { src: repeated, galleryId: 'ghost-card:second:0' },
        ]}
      >
        <ImageLightbox
          src={repeated}
          galleryId="ghost-card:second:0"
          enableGallery
          onClose={vi.fn()}
        />
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('2 / 2')).toBeTruthy();
  });
});
