// @vitest-environment jsdom
/**
 * ChatImageView.test.tsx — 聊天图片错误态恢复契约。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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
  ImageMissingPlaceholder: ({ filename }: { filename: string }) => React.createElement('div', null, filename),
}));

import { ChatImageView } from '../components/chat/ChatImageView';

describe('ChatImageView', () => {
  it('displaySrc 变化后清掉上一张图的错误占位', () => {
    const { rerender } = render(
      React.createElement(ChatImageView, {
        src: 'xdt-image://control/shot.png',
        filename: 'shot.png',
        variant: 'user-attached',
        sessionId: 'sess-1',
      }),
    );

    fireEvent.error(screen.getByRole('button', { name: 'shot.png' }));
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

    const image = screen.getByRole('button', { name: 'shot.png' });
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
    fireEvent.click(screen.getByRole('button', { name: 'preview.png' }));
    expect(screen.queryByTestId('model-lightbox')).not.toBeNull();
  });
  it.each(['Enter', ' '])('键盘 %s 可打开图片、保持 gallery 定位并在关闭后恢复焦点', (key) => {
    render(React.createElement(ChatImageView, {
      src: 'xdt-image://control/keyboard.png', filename: 'keyboard.png', variant: 'tool-output',
    }));
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
