// @vitest-environment jsdom
/**
 * ChatImageView.test.tsx — 聊天图片错误态恢复契约。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('@/hooks/useRemoteMediaUrl', () => ({
  useRemoteMediaUrl: (url: string) => url,
}));

vi.mock('../components/chat/ImageLightbox', () => ({
  ImageLightbox: ({ onClose }: { onClose: () => void }) => React.createElement(
    'button', { 'data-testid': 'image-lightbox', onClick: onClose }, 'close preview',
  ),
}));

vi.mock('../components/chat/ModelLightbox', () => ({
  ModelLightbox: () => React.createElement('div', { 'data-testid': 'model-lightbox' }),
}));

vi.mock('../components/chat/ImageMissingPlaceholder', () => ({
  ImageMissingPlaceholder: ({ filename, status = 'unavailable' }: { filename: string; status?: string }) =>
    React.createElement('div', { 'data-testid': 'image-failure', 'data-status': status }, filename),
}));

import { ChatImageView } from '../components/chat/ChatImageView';
import { prepareShareMessageClone } from '../lib/shareConversationImage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ChatImageView', () => {
  // PR #6943 review: exporting a loaded long attachment must keep its image,
  // but omit the live-only click promise. Existing clone tests use synthetic DOM.
  it('omits the interactive long-image hint from the static share clone', () => {
    const { container } = render(React.createElement(ChatImageView, {
      src: 'data:image/png;base64,test', filename: 'long.png', variant: 'user-attached',
    }));
    const image = screen.getByAltText('long.png');
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 301 } });
    fireEvent.load(image);
    expect(screen.getByText('chat.media.longImagePreview')).toBeTruthy();
    const clone = prepareShareMessageClone(container);
    expect(clone?.querySelector('img')?.getAttribute('src')).toBe(image.getAttribute('src'));
    expect(clone?.textContent).not.toContain('chat.media.longImagePreview');
    expect(screen.getByText('chat.media.longImagePreview')).toBeTruthy();
  });

  // #6796, unit: existing coverage only exercised loading/errors and click routing.
  // A 100x301 user attachment must expose the crop warning; 100x300 must not.
  // Source replacement must not inherit the previous image's crop decision.
  it.each([
    ['user-attached', 100, 301, true],
    ['user-attached', 100, 300, false],
    ['user-attached', 100, 200, false],
    ['user-attached', 200, 100, false],
    ['user-attached', 0, 600, false],
    ['tool-output', 100, 600, false],
  ] as const)('%s %sx%s announces a partial preview: %s', (variant, width, height, cropped) => {
    render(React.createElement(ChatImageView, { src: 'data:image/png;base64,test', filename: 'sample.png', variant }));
    const image = screen.getByAltText('sample.png');
    expect(image.getAttribute('aria-describedby')).toBeNull();
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    fireEvent.load(image);
    const description = image.getAttribute('aria-describedby');
    expect(Boolean(description)).toBe(cropped);
    if (description) expect(document.getElementById(description)?.textContent).toBe('chat.media.longImagePreview');
  });

  it('forgets the crop warning on source replacement and keeps keyboard preview available', () => {
    const props = { filename: 'sample.png', variant: 'user-attached' as const };
    const { rerender } = render(React.createElement(ChatImageView, { ...props, src: 'first.png' }));
    const image = screen.getByAltText('sample.png');
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 600 } });
    fireEvent.load(image);
    expect(image.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.keyDown(image, { key: 'Enter' });
    expect(screen.getByTestId('image-lightbox')).toBeTruthy();
    fireEvent.click(screen.getByTestId('image-lightbox'));
    expect(document.activeElement).toBe(image);
    rerender(React.createElement(ChatImageView, { ...props, src: 'next.png' }));
    expect(screen.getByAltText('sample.png').getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('chat.media.longImagePreview')).toBeNull();
  });

  describe.each(['user-attached', 'tool-output'] as const)('%s diagnostics', (variant) => {
    it('keeps a loading frame until decode and resets it for a different source', async () => {
      const props = { filename: 'a.png', variant };
      const { rerender } = render(React.createElement(ChatImageView, {
        ...props, src: 'cindy-remote-media://m/device/a',
      }));
      expect(screen.getByRole('status').getAttribute('aria-label')).toBe('chat.imageMissing.loading');
      expect(screen.getByAltText('a.png').style.display).toBe('none');
      const image = screen.getByAltText('a.png') as HTMLImageElement;
      let finishDecode!: () => void;
      image.decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
      fireEvent.load(image);
      expect(image.decode).toHaveBeenCalledOnce();
      expect(screen.getByRole('status')).toBeTruthy();
      expect(image.style.display).toBe('none');
      await act(async () => { finishDecode(); });
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByRole('button', { name: 'a.png' }).style.display).toBe('');
      rerender(React.createElement(ChatImageView, {
        ...props, src: 'cindy-remote-media://m/device/b',
      }));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.getByAltText('a.png').style.display).toBe('none');
      fireEvent.load(screen.getByAltText('a.png'));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it.each(['resolve', 'reject'] as const)('ignores a late decode %s after changing source', async (outcome) => {
      const props = { filename: 'a.png', variant };
      const { rerender } = render(React.createElement(ChatImageView, {
        ...props, src: 'cindy-remote-media://m/device/a',
      }));
      const oldImage = screen.getByAltText('a.png') as HTMLImageElement;
      let finishDecode!: () => void;
      oldImage.decode = vi.fn(() => new Promise<void>((resolve, reject) => {
        finishDecode = outcome === 'resolve' ? resolve : () => reject(new Error('Stale decode'));
      }));
      fireEvent.load(oldImage);
      rerender(React.createElement(ChatImageView, {
        ...props, src: 'cindy-remote-media://m/device/b',
      }));
      await act(async () => { finishDecode(); });
      expect(screen.queryByTestId('image-failure')).toBeNull();
      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.getByAltText('a.png').getAttribute('src')).toBe('cindy-remote-media://m/device/b');
      fireEvent.load(screen.getByAltText('a.png'));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('routes decode failure through the existing image diagnostics', async () => {
      const read = vi.fn().mockRejectedValue(new Error('[NOT_FOUND] Image file not found'));
      vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
      const src = 'cindy-media://blobs/a.png';
      render(React.createElement(ChatImageView, { src, filename: 'a.png', variant }));
      const image = screen.getByAltText('a.png') as HTMLImageElement;
      image.decode = vi.fn().mockRejectedValue(new Error('Decode failed'));
      fireEvent.load(image);
      await waitFor(() => expect(screen.getByTestId('image-failure').dataset.status).toBe('missing'));
      expect(screen.queryByRole('status')).toBeNull();
      expect(read).toHaveBeenCalledExactlyOnceWith({ url: src });
    });

    it.each(['xdt-image://images/a.png', 'cindy-media://blobs/a.png'])(
      'confirms missing bytes via preload for %s',
      async (src) => {
        const read = vi.fn().mockRejectedValue(new Error('[NOT_FOUND] Image file not found'));
        vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
        render(React.createElement(ChatImageView, { src, filename: 'a.png', variant }));
        fireEvent.error(screen.getByAltText('a.png'));
        await waitFor(() => expect(screen.getByTestId('image-failure').dataset.status).toBe('missing'));
        expect(read).toHaveBeenCalledExactlyOnceWith({ url: src });
      },
    );

    it.each(['focus', 'online'])('retries after %s and ignores the previous diagnostic', async (event) => {
      let reject!: (error: Error) => void;
      const read = vi.fn().mockImplementationOnce(() => new Promise((_, r) => { reject = r; }))
        .mockRejectedValue(new Error('[PERMISSION_DENIED] Cannot read image'));
      vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
      render(React.createElement(ChatImageView, {
        src: 'cindy-media://blobs/a.png', filename: 'a.png', variant,
      }));
      fireEvent.error(screen.getByAltText('a.png'));
      expect(screen.getByTestId('image-failure').dataset.status).toBe('unavailable');
      fireEvent(window, new Event(event));
      expect(screen.getByAltText('a.png')).toBeTruthy();
      fireEvent.error(screen.getByAltText('a.png'));
      await act(async () => { reject(new Error('[NOT_FOUND] Stale result')); });
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('image-failure').dataset.status).toBe('unavailable');
    });
  });

  it('ignores a late local missing result after changing to a remote image', async () => {
    let reject!: (error: Error) => void;
    const read = vi.fn(() => new Promise((_, r) => { reject = r; }));
    vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
    const props = { filename: 'a.png', variant: 'tool-output' as const };
    const { rerender } = render(React.createElement(ChatImageView, { ...props, src: 'xdt-image://images/a.png' }));
    fireEvent.error(screen.getByAltText('a.png'));
    const remote = 'cindy-remote-media://m/device/a';
    rerender(React.createElement(ChatImageView, { ...props, src: remote }));
    await act(async () => { reject(new Error('[NOT_FOUND] Stale local result')); });
    expect(screen.getByAltText('a.png').getAttribute('src')).toBe(remote);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('preserves the three bounded remote retries without probing the local store', () => {
    vi.useFakeTimers();
    const read = vi.fn();
    vi.stubGlobal('electronAPI', { readCachedImageAsBase64: read });
    render(React.createElement(ChatImageView, {
      src: 'cindy-remote-media://m/device/a', filename: 'a.png', variant: 'tool-output',
    }));
    for (const delay of [2000, 4000, 8000]) {
      fireEvent.error(screen.getByAltText('a.png'));
      expect(screen.getByTestId('image-failure').dataset.status).toBe('unavailable');
      act(() => vi.advanceTimersByTime(delay));
      expect(screen.getByAltText('a.png')).toBeTruthy();
      expect(screen.getByRole('status')).toBeTruthy();
    }
    fireEvent.error(screen.getByAltText('a.png'));
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByTestId('image-failure').dataset.status).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
  });

  it('displaySrc 变化后清掉上一张图的错误占位', () => {
    const { rerender } = render(
      React.createElement(ChatImageView, {
        src: 'xdt-image://control/shot.png',
        filename: 'shot.png',
        variant: 'user-attached',
        sessionId: 'sess-1',
      }),
    );

    fireEvent.error(screen.getByAltText('shot.png'));
    expect(screen.queryByRole('button', { name: 'shot.png' })).toBeNull();
    expect(screen.getByText('shot.png')).toBeTruthy();

    rerender(
      React.createElement(ChatImageView, {
        src: 'cindy-remote-media://m/device/shot',
        filename: 'shot.png',
        variant: 'user-attached',
        sessionId: 'sess-1',
      }),
    );

    const image = screen.getByAltText('shot.png');
    expect(image.getAttribute('src')).toBe('cindy-remote-media://m/device/shot');
  });

  // 点击路由:GLB/GLTF(model-viewer 可原生渲染)→ ModelLightbox;其它格式
  // (FBX/OBJ 等)退回 2D ImageLightbox——FBX 应用内预览已被有意移除。
  it.each([
    ['GLB', true],
    ['GLTF', true],
    ['FBX', false],
    ['OBJ', false],
  ])('modelFile format %s → %s', (format, opensModel) => {
    render(
      React.createElement(ChatImageView, {
        src: 'xdt-image://control/preview.png',
        filename: 'preview.png',
        variant: 'user-attached',
        sessionId: 'sess-1',
        modelFile: { provider: 'cindy', url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.glb', format },
      }),
    );
    fireEvent.load(screen.getByAltText('preview.png'));
    fireEvent.click(screen.getByRole('button', { name: 'preview.png' }));
    expect(screen.queryByTestId('model-lightbox') !== null).toBe(opensModel);
  });

  // cindy 来源(意识 3D 链路):GLB 已在媒体总仓,点击同样进 ModelLightbox。
  it('cindy modelFile → 点击预览图打开 ModelLightbox', () => {
    render(
      React.createElement(ChatImageView, {
        src: 'cindy-media://blobs/' + 'e'.repeat(64) + '.png',
        filename: 'preview.png',
        variant: 'tool-output',
        sessionId: 'sess-1',
        modelFile: {
          provider: 'cindy',
          url: 'cindy-media://blobs/' + 'f'.repeat(64) + '.glb',
          format: 'GLB',
        },
      }),
    );
    fireEvent.load(screen.getByAltText('preview.png'));
    fireEvent.click(screen.getByRole('button', { name: 'preview.png' }));
    expect(screen.queryByTestId('model-lightbox')).not.toBeNull();
  });
  it.each(['Enter', ' '])('键盘 %s 可打开图片、保持 gallery 定位并在关闭后恢复焦点', (key) => {
    render(React.createElement(ChatImageView, {
      src: 'xdt-image://control/keyboard.png', filename: 'keyboard.png', variant: 'tool-output',
    }));
    fireEvent.load(screen.getByAltText('keyboard.png'));
    const trigger = screen.getByRole('button', { name: 'keyboard.png' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key });
    expect(screen.getByTestId('image-lightbox')).toBeTruthy();
    expect(trigger.dataset.galleryActive).toBe('1');
    const close = screen.getByTestId('image-lightbox');
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).toBe(trigger);
  });
});
