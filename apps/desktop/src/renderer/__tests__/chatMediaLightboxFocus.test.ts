// @vitest-environment jsdom
/**
 * chatMediaLightboxFocus.test.ts — 图片/模型预览的键盘焦点契约。
 *
 * 与 chatVideoView.test.ts 对位,覆盖 review 指出的"image/model 路径同样
 * 没有把焦点移进 lightbox"的一半:不 mock ImageLightbox / ModelLightbox,
 * 用真实组件断言键盘打开后焦点进入弹窗(FocusScope 挂载焦点)、Esc 延迟
 * 关闭后回到预览触发器。图片路径同时保留集合入口的键盘断言。
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
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { ChatImageView } from '../components/chat/ChatImageView';
import { ModelLightbox } from '../components/chat/ModelLightbox';
import { toast } from '@/lib/toast';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('ChatImageView 键盘交互(真实 ImageLightbox / ModelLightbox)', () => {
  // ModelLightbox's 2026-06 scheme regression: the custom element reports a
  // parse/load error, but its poster must stay usable and the user gets an
  // inline error with retry. Existing focus tests never dispatch that event. Reuse the real
  // lightbox unit harness, with fake time to detect delayed unwanted closure.
  it('reports a model load error and keeps the preview open', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const url = 'cindy-media://blobs/' + 'f'.repeat(64) + '.glb';
    render(React.createElement(ModelLightbox, { source: { kind: 'blob', url }, onClose }));
    const viewer = document.body.querySelector('model-viewer')!;
    expect(viewer).not.toBeNull();
    await act(async () => {
      fireEvent.error(viewer);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('chat.media.modelLoadFailed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'attachmentPreview.retry' })).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(viewer.isConnected).toBe(true);
    expect(viewer.getAttribute('src')).toBe(url);
  });

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

  it('Enter 打开模型预览:焦点进入 lightbox,Esc 延迟关闭后回到触发器', async () => {
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
    // 真实 ModelLightbox:portal 内出现 <model-viewer>(jsdom 不升级自定义
    // 元素,但节点在场)。
    const modelViewer = document.body.querySelector('model-viewer');
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
