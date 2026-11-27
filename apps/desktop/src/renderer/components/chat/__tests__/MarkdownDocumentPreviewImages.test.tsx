// @vitest-environment jsdom
/**
 * Integration tests for Desktop Markdown document preview image viewing:
 * - Exercises real TextLightbox + real MarkdownRenderer + MarkdownCarouselBlock
 *   + ImageLightbox (without mocking MarkdownRenderer).
 * - Value: catches regressions in local/relative/HTML/carousel image rendering,
 *   remote session cindy-remote-media:// rewriting, document-level gallery
 *   navigation, and Escape layer ordering (ImageLightbox closes before TextLightbox).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatSessionFileProvider } from '../ChatSessionFileContext';
import { TextLightbox } from '../TextLightbox';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), parse: vi.fn() } }));
vi.mock('@/components/markdown/PlaintextEditor', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    PlaintextEditor: forwardRef(({ initialValue }: { initialValue: string }, ref) => {
      useImperativeHandle(ref, () => ({ scrollToLine: vi.fn(), search: { clear: vi.fn(), findAll: vi.fn(() => 0), setActive: vi.fn() } }));
      return <pre>{initialValue}</pre>;
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SAMPLE_MD = [
  '# Voice Input Screenshots',
  '',
  '````carousel',
  '![Dark 1](/Users/dash/.gemini/screenshots/01-dark.png)',
  '<!-- slide -->',
  '![Light 1](/Users/dash/.gemini/screenshots/01-light.png)',
  '````',
  '',
  '<p align="center"><img src="../shared/banner.png" alt="Banner" width="600" /></p>',
].join('\n');

function setupElectronApi(content: string) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      readTextFilePreview: vi.fn().mockResolvedValue({
        success: true,
        data: content,
        size: content.length,
      }),
      fileBrowser: {
        chatFetch: vi.fn().mockResolvedValue({
          ok: true,
          cachePath: '/tmp/cached-doc.md',
          size: content.length,
          stale: false,
        }),
        readCached: vi.fn().mockResolvedValue({
          ok: true,
          kind: 'text',
          content,
        }),
        onTransferProgress: vi.fn(() => () => {}),
      },
    },
  });
}

describe('TextLightbox Markdown document image preview', () => {
  it('renders carousel slides and HTML local images, switches slides, and opens document gallery with layered Escape', async () => {
    vi.useFakeTimers();
    setupElectronApi(SAMPLE_MD);
    const onClose = vi.fn();

    render(<TextLightbox filePath="/repo/docs/guide.md" onClose={onClose} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    // Carousel starts on slide 1/2 (Dark 1) and renders normalized ../ HTML image too.
    expect(document.querySelector('[data-markdown-carousel-counter]')?.textContent).toBe('1 / 2');
    const imgsBefore = Array.from(document.querySelectorAll('img')).map((el) => ({
      alt: el.getAttribute('alt'),
      src: el.getAttribute('src'),
    }));
    expect(imgsBefore).toEqual([
      {
        alt: 'Dark 1',
        src: `xdt-file://local/?path=${encodeURIComponent('/Users/dash/.gemini/screenshots/01-dark.png')}`,
      },
      {
        alt: 'Banner',
        src: `xdt-file://local/?path=${encodeURIComponent('/repo/shared/banner.png')}`,
      },
    ]);

    // Switch carousel to slide 2/2 (Light 1).
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.nextImage') }));
    expect(document.querySelector('[data-markdown-carousel-counter]')?.textContent).toBe('2 / 2');
    expect(screen.getByAltText('Light 1').getAttribute('src')).toBe(
      `xdt-file://local/?path=${encodeURIComponent('/Users/dash/.gemini/screenshots/01-light.png')}`,
    );

    // Click Light 1 → opens ImageLightbox stacked above TextLightbox with all 3 document images.
    fireEvent.click(screen.getByRole('button', { name: 'Light 1' }));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const layers = document.querySelectorAll('[data-lightbox-layer]');
    expect(layers.length).toBeGreaterThanOrEqual(2);
    // Gallery has 3 images (Dark 1, Light 1, Banner), opened at 2 / 3.
    expect(screen.getByText('2 / 3')).toBeTruthy();

    // First Escape closes ImageLightbox ONLY; TextLightbox stays open.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-text-lightbox-overlay]')).not.toBeNull();

    // Second Escape closes TextLightbox.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rewrites Markdown document images to cindy-remote-media:// in remote device sessions', async () => {
    vi.useFakeTimers();
    setupElectronApi(SAMPLE_MD);

    render(
      <ChatSessionFileProvider
        value={{
          sessionId: 'sess-remote',
          workingDir: '/remote/repo',
          origin: { kind: 'device', deviceId: 'dev-42' },
          localConfirmed: false,
        }}
      >
        <TextLightbox filePath="/remote/repo/docs/guide.md" onClose={vi.fn()} />
      </ChatSessionFileProvider>,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const srcs = Array.from(document.querySelectorAll('img')).map((el) => el.getAttribute('src'));
    expect(srcs).toHaveLength(2);
    for (const src of srcs) {
      expect(src).toMatch(/^cindy-remote-media:\/\/m\//);
    }
  });
});
