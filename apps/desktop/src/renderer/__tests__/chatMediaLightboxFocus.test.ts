// @vitest-environment jsdom
/**
 * chatMediaLightboxFocus.test.ts — 图片/模型预览的键盘焦点契约。
 *
 * 与 chatVideoView.test.ts 对位,覆盖 review 指出的"image/model 路径同样
 * 没有把焦点移进 lightbox"的一半:不 mock ImageLightbox / ModelLightbox,
 * 用真实组件断言键盘打开后焦点进入弹窗(FocusScope 挂载焦点)、Esc 延迟
 * 关闭后回到预览触发器。图片路径同时保留 gallery 定位标记的既有断言。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/hooks/useRemoteMediaUrl', () => ({
  useRemoteMediaUrl: (url: string) => url,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

// ModelLightbox now hosts the mivo-model-viewer SDK. Mock the SDK loader and the byte
// reader so these tests exercise the real lightbox (focus, close, failure handling,
// lifecycle) without WebGL or IPC.
const viewerLoad = vi.fn(async () => undefined);
const viewerDispose = vi.fn();
const createModelViewer = vi.fn(() => ({ load: viewerLoad, dispose: viewerDispose }));
vi.mock('@/lib/model3d/modelViewerSdk', () => ({
  loadModelViewerSdk: vi.fn(async () => ({ createModelViewer })),
}));
const readModel3DBlob = vi.fn(async () => ({
  blob: new Blob([new Uint8Array([1, 2, 3])]),
  fileName: 'f.glb',
}));
vi.mock('@/lib/model3d/readModel3DBlob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model3d/readModel3DBlob')>()),
  readModel3DBlob: (...args: unknown[]) => (readModel3DBlob as (...a: unknown[]) => unknown)(...args),
}));

import { ChatImageView } from '../components/chat/ChatImageView';
import { ModelLightbox } from '../components/chat/ModelLightbox';
import { toast } from '@/lib/toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  viewerLoad.mockImplementation(async () => undefined);
});

describe('ChatImageView 键盘交互(真实 ImageLightbox / ModelLightbox)', () => {
  // ModelLightbox's 2026-06 scheme regression: the viewer fails to load the model, but the
  // lightbox must stay open (poster / right-click menu still usable) and the user gets a
  // toast. Silent failure used to look like a frozen 2D image.
  it('reports a model load error and keeps the preview open', async () => {
    vi.useFakeTimers();
    viewerLoad.mockRejectedValueOnce(new Error('parse failed'));
    const onClose = vi.fn();
    const url = 'cindy-media://blobs/' + 'f'.repeat(64) + '.glb';
    render(React.createElement(ModelLightbox, { source: { kind: 'blob', url }, onClose }));
    const host = document.body.querySelector('[data-model3d-viewer]')!;
    expect(host).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Failed to load 3D model');
    expect(onClose).not.toHaveBeenCalled();
    expect(host.isConnected).toBe(true);
  });

  it('tells the user when a model is too large to preview, without closing', async () => {
    vi.useFakeTimers();
    const { Model3DTooLargeError } = await import('@/lib/model3d/readModel3DBlob');
    readModel3DBlob.mockRejectedValueOnce(new Model3DTooLargeError(200 * 1024 * 1024, 128 * 1024 * 1024));
    const onClose = vi.fn();
    render(React.createElement(ModelLightbox, { source: { kind: 'local', absPath: '/work/huge.fbx' }, onClose }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('This 3D model is too large to preview');
    expect(createModelViewer).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('loads the bytes into the SDK viewer with a file name, and disposes it on unmount', async () => {
    const url = 'cindy-media://blobs/' + 'f'.repeat(64) + '.glb';
    const { unmount } = render(
      React.createElement(ModelLightbox, { source: { kind: 'blob', url }, onClose: vi.fn() }),
    );
    await waitFor(() => expect(viewerLoad).toHaveBeenCalledTimes(1));
    expect(readModel3DBlob).toHaveBeenCalledWith({ kind: 'blob', url }, expect.objectContaining({}));
    const [host, options] = createModelViewer.mock.calls[0] as unknown as [HTMLElement, Record<string, any>];
    expect(host).toBe(document.body.querySelector('[data-model3d-viewer]'));
    // host-irrelevant controls are off; the SDK's own info / settings / toolbar stay on
    expect(options.ui).toMatchObject({ import: false, export: false, panorama: false });
    expect((viewerLoad.mock.calls[0] as unknown[])[1]).toEqual({ fileName: 'f.glb' });
    expect(viewerDispose).not.toHaveBeenCalled();
    unmount();
    expect(viewerDispose).toHaveBeenCalledTimes(1);
  });

  it('does not create a viewer for a lightbox closed before the bytes arrive', async () => {
    let resolveBytes: (v: { blob: Blob; fileName: string }) => void = () => undefined;
    readModel3DBlob.mockImplementationOnce(
      () => new Promise((resolve) => { resolveBytes = resolve as typeof resolveBytes; }),
    );
    const { unmount } = render(
      React.createElement(ModelLightbox, {
        source: { kind: 'local', absPath: '/work/a.obj' },
        onClose: vi.fn(),
      }),
    );
    unmount();
    await act(async () => {
      resolveBytes({ blob: new Blob([new Uint8Array([1])]), fileName: 'a.obj' });
      await Promise.resolve();
    });
    expect(createModelViewer).not.toHaveBeenCalled();
    expect(viewerDispose).not.toHaveBeenCalled();
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
    // 注:gallery 定位标记(data-gallery-active)是瞬时信号——真实
    // ImageLightbox 挂载后立即清掉(见其 mount effect),这里断不到;它的
    // 设置路径由 chatImageView.test.ts 的 mock 用例覆盖。
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
    // 真实 ModelLightbox:portal 内出现 SDK 查看器的容器节点。
    const modelViewer = document.body.querySelector('[data-model3d-viewer]');
    expect(modelViewer).not.toBeNull();

    // 焦点进入 lightbox(FocusScope 挂载焦点落在 overlay 根)。
    expect(document.activeElement?.contains(modelViewer as Element)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    // Esc 延迟关闭后回到触发器。
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(trigger);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.querySelector('[data-model3d-viewer]')).toBeNull();
    expect(screen.getByRole('button', { name: 'model-preview.png' })).toBeTruthy();
  });
});
