// @vitest-environment jsdom
/**
 * ImageLightbox gallery positioning.
 *
 * Task image gallery (product rule docs/product-rules/attachment-preview.md, user decision
 * 2026-11-24): a task image browses every loaded image across turns and opens at the
 * clicked occurrence. Reply-image collection is covered in chatSessionFileContext.test.ts.
 * - Entry: ImageLightbox under the task gallery context; observable result is the
 *   "n / total" count and the header name.
 * - Gap: earlier tests only covered plugin-card ids within one message's list.
 * - Minimal failing input: before this change an image in an image+PDF message counted
 *   only that message, and the header kept the opener's filename after switching.
 * - tier: unit (jsdom component entry).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { AttachmentCollectionContext } from '@/components/chat/AttachmentCollection';
import {
  ImageGalleryContext,
  ImageGalleryScopeContext,
  type GalleryImage,
} from '@/components/chat/ImageGalleryContext';
import { ImageLightbox } from '@/components/chat/ImageLightbox';

afterEach(() => {
  cleanup();
});

const blob = (char: string) => `cindy-media://blobs/${char.repeat(64)}.png`;
const step = (key: 'chat.media.prevImage' | 'chat.media.nextImage') =>
  fireEvent.click(screen.getByRole('button', { name: i18n.t(key) }));

describe('ImageLightbox gallery positioning', () => {
  it('opens the exact duplicate image selected inside a plugin card iframe', () => {
    const repeated = blob('a');
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

  it('browses the task gallery from an image+PDF message, starting at the clicked repeat', () => {
    const repeated = blob('a');
    const other = blob('b');
    const gallery: GalleryImage[] = [
      { src: repeated, scope: 'u1', name: 'first.png' },
      { src: other, scope: 'u2', name: 'other.png' },
      { src: repeated, scope: 'u3', name: 'again.png' },
    ];
    render(
      <AttachmentCollectionContext.Provider
        value={[
          { id: 'img', name: 'again.png', source: repeated, kind: 'image', media: true },
          { id: 'pdf', name: 'spec.pdf', source: '/work/spec.pdf', kind: 'pdf' },
        ]}
      >
        <ImageGalleryContext.Provider value={gallery}>
          <ImageGalleryScopeContext.Provider value="u3">
            <ImageLightbox src={repeated} filename="again.png" enableGallery onClose={vi.fn()} />
          </ImageGalleryScopeContext.Provider>
        </ImageGalleryContext.Provider>
      </AttachmentCollectionContext.Provider>,
    );

    expect(screen.getByText('3 / 3')).toBeTruthy();
    step('chat.media.prevImage');
    expect(screen.getByText('2 / 3')).toBeTruthy();
    // The header names the image now shown, not the one the viewer opened on.
    expect(screen.getByText('other.png')).toBeTruthy();
    expect(screen.queryByText('again.png')).toBeNull();
    step('chat.media.nextImage');
    expect(screen.getByText('again.png')).toBeTruthy();
  });
});
