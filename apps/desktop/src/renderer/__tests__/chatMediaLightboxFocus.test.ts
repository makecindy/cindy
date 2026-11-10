// @vitest-environment jsdom
/** Image preview keyboard focus and return-to-trigger behavior. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('@/hooks/useRemoteMediaUrl', () => ({
  useRemoteMediaUrl: (url: string) => url,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { ChatImageView } from '../components/chat/ChatImageView';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('ChatImageView keyboard focus', () => {
  it('Enter 打开图片预览:焦点进入 lightbox,Esc 延迟关闭后回到触发器', async () => {
    render(
      React.createElement(ChatImageView, {
        src: 'xdt-image://control/focus.png',
        filename: 'focus.png',
        variant: 'tool-output',
      }),
    );
    fireEvent.load(screen.getByAltText('focus.png'));
    const trigger = screen.getByRole('button', { name: 'focus.png' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    // 真实 ImageLightbox:portal 内出现 alt="" 的大图(触发器缩略图 alt 是
    // 文件名,不会撞)。
    const lightboxImg = document.body.querySelector('img[alt=""]');
    expect(lightboxImg).not.toBeNull();
    expect(lightboxImg?.getAttribute('src')).toBe('xdt-image://control/focus.png');

    // 焦点进入 lightbox(FocusScope 挂载焦点落在 overlay 根),不再留在被
    // 遮罩挡住的预览触发器上。
    expect(document.activeElement?.contains(lightboxImg as Element)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    // Esc 延迟关闭:onClose 排在 200ms 渐隐后,此刻焦点仍在 lightbox 内。
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(trigger);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.querySelector('img[alt=""]')).toBeNull();
    expect(screen.getByRole('button', { name: 'focus.png' })).toBeTruthy();
  });

  it('历史模型封面按普通图片打开并归还焦点', async () => {
    render(
      React.createElement(ChatImageView, {
        src: 'cindy-media://blobs/' + 'e'.repeat(64) + '.png',
        filename: 'model-preview.png',
        variant: 'tool-output',
        modelFile: {
          provider: 'cindy',
          url: 'cindy-media://blobs/' + 'f'.repeat(64) + '.glb',
          format: 'GLB',
        },
      }),
    );
    fireEvent.load(screen.getByAltText('model-preview.png'));
    const trigger = screen.getByRole('button', { name: 'model-preview.png' });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    const modelViewer = document.body.querySelector('img[alt=""]');
    expect(modelViewer).not.toBeNull();

    // 焦点进入 lightbox(FocusScope 挂载焦点落在 overlay 根)。
    expect(document.activeElement?.contains(modelViewer as Element)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    // Esc 延迟关闭后回到触发器。
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(trigger);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.querySelector('model-viewer')).toBeNull();
    expect(screen.getByRole('button', { name: 'model-preview.png' })).toBeTruthy();
  });
});
