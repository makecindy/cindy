// @vitest-environment jsdom
/**
 * ImageLightbox 非模态浮窗的 DOM 行为与几何边界。
 *
 * 测试价值
 * - 生产入口与可观察结果：挂载真实 ImageLightbox / AttachmentCollectionPreview /
 *   useImagePreviewWindow 纯几何入口，断言无遮罩、无滚动锁、标题栏拖动移动整个浮窗、
 *   停靠/调整尺寸改变面板矩形、Esc 与关闭按钮仍工作、放大后图片内容仍走 pan；
 *   换图后显示新源、重操作浮窗后键盘焦点归位、Esc 只关最上层、集合方向键不抢背景；
 *   混合集合从图片切到文档后清除旧图片面板的键盘范围。
 * - Bug／规则依据：主人 2026-11-20 报告「预览窗无法拖动且盖住主要对话区域」；
 *   #11952 review threads 指出复用浮窗换图、键盘焦点归属、多浮窗 Esc 与集合方向键
 *   的对称路径；后续 thread 指出混合集合卸载时 scopeRef 清理失效。
 * - 现有覆盖缺口：chatMediaLightboxFocus / ImageLightboxAnnotate 只覆盖焦点、标注和
 *   图片点击；没有覆盖浮窗位置、非模态背景交互、视口边界、换源、多浮窗叠放，
 *   也没有覆盖图片切到非图片查看器后共享集合键盘范围的生命周期。
 * - 最小失败输入：1280×800 视口打开一张图；标题栏 pointerdown→pointermove→pointerup；
 *   320×600 视口或超出视口的 resize 位移；rerender 换 src；背景焦点按方向键；
 *   两个浮窗同时挂载后按一次 Escape；图片→文档混合集合切换后在文档焦点按方向键。
 * - tier：unit（进程内 DOM，无真实 I/O；仅文档查看器用最小替身隔离文件 I/O）。
 * - 实测耗时：单独运行 9.99s 墙钟（Vitest 7.75s：transform 2.78s /
 *   setup 1.84s / collect 2.73s / 用例本体 1.71s）。超过 5s 的原因是真实 Desktop
 *   jsdom + i18n + Radix Tooltip 生产组件收集成本；11 条用例合并在同一文件，未再新增小文件。
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import {
  AttachmentCollectionContext,
  type AttachmentCollectionItem,
} from '@/components/chat/AttachmentCollectionContext';
import {
  clampPreviewRect,
  dockPreviewRect,
  resizePreviewRect,
} from '@/components/chat/imagePreviewWindow';

// Only the document viewer is stubbed: collection routing, the real image
// preview and the shared keyboard listener remain production code.
vi.mock('../TextLightbox', async () => {
  const { createElement } = await import('react');
  return {
    TextLightbox: ({ fileName }: { fileName: string }) =>
      createElement(
        'div',
        { 'data-lightbox-layer': '', role: 'dialog', 'aria-label': fileName },
        createElement('button', { type: 'button' }, 'document control'),
      ),
  };
});

const SRC = 'cindy-media://blobs/source.png';
const NEXT_SRC = 'cindy-media://blobs/next.png';

function panel(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[data-lightbox-layer]');
  if (!node) throw new Error('image preview panel missing');
  return node;
}

function panels(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[data-lightbox-layer]'));
}

function previewImage(): HTMLImageElement {
  const node = document.body.querySelector<HTMLImageElement>('img[alt=""]');
  if (!node) throw new Error('preview image missing');
  return node;
}

function dragHandle(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[data-preview-drag-handle]');
  if (!node) throw new Error('preview drag handle missing');
  return node;
}

function imageSurface(): HTMLElement {
  const image = document.body.querySelector<HTMLImageElement>('img[alt=""]');
  const surface = image?.parentElement;
  if (!surface) throw new Error('image transform container missing');
  return surface;
}

function renderLightbox(onClose = vi.fn()) {
  const view = render(
    <>
      <div data-scroll-container="" style={{ overflowY: 'auto' }}>
        背景消息：请对照图片与这段文字。
      </div>
      <ImageLightbox src={SRC} onClose={onClose} />
    </>,
  );
  return { ...view, onClose };
}

function flushFrame(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pointerGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  target: HTMLElement | Window = window,
) {
  fireEvent.pointerDown(target === window ? dragHandle() : target, {
    pointerId: 3,
    button: 0,
    buttons: 1,
    clientX: start.x,
    clientY: start.y,
  });
  fireEvent.pointerMove(window, {
    pointerId: 3,
    buttons: 1,
    clientX: end.x,
    clientY: end.y,
  });
  fireEvent.pointerUp(window, {
    pointerId: 3,
    buttons: 0,
    clientX: end.x,
    clientY: end.y,
  });
}

const viewportDescriptors = {
  width: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  height: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
};

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (viewportDescriptors.width) Object.defineProperty(window, 'innerWidth', viewportDescriptors.width);
  if (viewportDescriptors.height) Object.defineProperty(window, 'innerHeight', viewportDescriptors.height);
});

describe('ImageLightbox non-modal window', () => {
  it('opens as a right-docked non-modal panel without a scrim or background scroll lock', () => {
    renderLightbox();
    const node = panel();
    expect(document.body.querySelector('[data-preview-scrim]')).toBeNull();
    expect(node.getAttribute('aria-modal')).toBe('false');
    expect(node.getAttribute('data-preview-window-mode')).toBe('right');
    expect(Number.parseFloat(node.style.left)).toBeGreaterThan(1280 * 0.45);
    const scroller = document.body.querySelector<HTMLElement>('[data-scroll-container]');
    expect(scroller?.style.overflowY).toBe('auto');
    expect(screen.getByText(/背景消息/).textContent).toContain('对照图片');
    expect(screen.getByRole('button', { name: i18n.t('chat.lightbox.close') })).toBeTruthy();
  });

  it('drags the whole panel from the header while panned image content stays independent', async () => {
    const { onClose } = renderLightbox();
    const node = panel();
    const initialLeft = node.style.left;

    // Zoom first: the existing content drag must remain a transform translate, not a window move.
    fireEvent.keyDown(node, { key: '+' });
    const surface = imageSurface();
    expect(surface.style.transform).toContain('scale(');
    expect(surface.style.transform).not.toContain('scale(1)');
    const beforePan = surface.style.transform;
    fireEvent.mouseDown(surface, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 340, clientY: 330 });
    fireEvent.mouseUp(window);
    expect(surface.style.transform).not.toBe(beforePan);
    expect(surface.style.transform).toContain('translate(');

    pointerGesture({ x: 200, y: 60 }, { x: 80, y: 140 });
    await flushFrame();

    expect(panel().style.left).not.toBe(initialLeft);
    expect(document.body.querySelector('[data-lightbox-layer]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('docks left and resizes within the viewport', async () => {
    renderLightbox();
    fireEvent.click(screen.getByRole('button', { name: 'Dock preview left' }));
    const node = panel();
    expect(node.getAttribute('data-preview-window-mode')).toBe('left');
    expect(Number.parseFloat(node.style.left)).toBeLessThanOrEqual(20);

    const beforeWidth = Number.parseFloat(node.style.width);
    const beforeHeight = Number.parseFloat(node.style.height);
    const resize = document.body.querySelector<HTMLElement>('[data-preview-resize-handle="se"]');
    expect(resize).not.toBeNull();
    pointerGesture({ x: 400, y: 700 }, { x: 320, y: 640 }, resize!);
    await flushFrame();
    const after = panel();
    expect(Number.parseFloat(after.style.width)).toBeLessThan(beforeWidth);
    expect(Number.parseFloat(after.style.height)).toBeLessThan(beforeHeight);
    expect(after.getAttribute('data-preview-window-mode')).toBe('free');
    expect(Number.parseFloat(after.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(after.style.left) + Number.parseFloat(after.style.width)).toBeLessThanOrEqual(1280);
  });

  it('does not close on a background click but still closes with Esc', async () => {
    const { onClose } = renderLightbox();
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it('closes with the header close button', async () => {
    const { onClose } = renderLightbox();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.lightbox.close') }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
  });

  it('keeps dock and resize geometry inside a 320px viewport', () => {
    const viewport = { width: 320, height: 600 };
    const right = dockPreviewRect('right', viewport);
    expect(right.x).toBeGreaterThanOrEqual(0);
    expect(right.x + right.width).toBeLessThanOrEqual(viewport.width);
    expect(right.y + right.height).toBeLessThanOrEqual(viewport.height);

    const enlarged = resizePreviewRect(right, 'se', 1000, 1000, viewport);
    expect(enlarged.x + enlarged.width).toBeLessThanOrEqual(viewport.width);
    expect(enlarged.y + enlarged.height).toBeLessThanOrEqual(viewport.height);

    const clamped = clampPreviewRect({ x: -100, y: -100, width: 1000, height: 1000 }, viewport);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.y).toBeGreaterThanOrEqual(40);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(viewport.width);
  });

  it('switches the reused preview when the host opens another image', async () => {
    const onClose = vi.fn();
    const view = render(
      <>
        <div data-scroll-container="" style={{ overflowY: 'auto' }}>背景消息</div>
        <ImageLightbox src={SRC} onClose={onClose} />
      </>,
    );
    expect(previewImage().getAttribute('src')).toBe(SRC);
    view.rerender(
      <>
        <div data-scroll-container="" style={{ overflowY: 'auto' }}>背景消息</div>
        <ImageLightbox src={NEXT_SRC} onClose={onClose} />
      </>,
    );
    await waitFor(() => expect(previewImage().getAttribute('src')).toBe(NEXT_SRC));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns keyboard focus to the preview on image and titlebar gestures', () => {
    render(
      <>
        <input aria-label="background input" />
        <ImageLightbox src={SRC} onClose={vi.fn()} />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'background input' });
    const node = panel();

    input.focus();
    fireEvent.mouseDown(imageSurface(), { button: 0, clientX: 200, clientY: 200 });
    expect(document.activeElement).toBe(node);

    input.focus();
    fireEvent.pointerDown(dragHandle(), {
      pointerId: 9,
      button: 0,
      buttons: 1,
      clientX: 200,
      clientY: 60,
    });
    fireEvent.pointerUp(window, { pointerId: 9, buttons: 0, clientX: 200, clientY: 60 });
    expect(document.activeElement).toBe(panel());
  });

  it('closes only the foreground preview on Escape', async () => {
    const backgroundClose = vi.fn();
    const foregroundClose = vi.fn();
    render(
      <>
        <ImageLightbox src={SRC} onClose={backgroundClose} />
        <ImageLightbox src={NEXT_SRC} onClose={foregroundClose} />
      </>,
    );
    expect(panels()).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(foregroundClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(backgroundClose).not.toHaveBeenCalled();
  });

  it('keeps collection arrow keys inside the non-modal preview focus scope', async () => {
    const items: AttachmentCollectionItem[] = [
      { id: 'first', name: 'first.png', source: SRC, kind: 'image', media: true },
      { id: 'second', name: 'second.png', source: NEXT_SRC, kind: 'image', media: true },
    ];
    render(
      <AttachmentCollectionContext.Provider value={items}>
        <button type="button">background control</button>
        <ImageLightbox src={SRC} onClose={vi.fn()} />
      </AttachmentCollectionContext.Provider>,
    );
    expect(previewImage().getAttribute('src')).toBe(SRC);

    const background = screen.getByRole('button', { name: 'background control' });
    background.focus();
    fireEvent.keyDown(background, { key: 'ArrowRight' });
    expect(previewImage().getAttribute('src')).toBe(SRC);

    const node = panels().at(-1)!;
    node.focus();
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    await waitFor(() => expect(previewImage().getAttribute('src')).toBe(NEXT_SRC));
  });

  it('clears the image keyboard scope after a mixed collection switches to a document', async () => {
    const items: AttachmentCollectionItem[] = [
      { id: 'first', name: 'first.png', source: SRC, kind: 'image', media: true },
      { id: 'second', name: 'second.txt', source: '/second.txt', kind: 'text' },
    ];
    render(
      <AttachmentCollectionContext.Provider value={items}>
        <ImageLightbox src={SRC} onClose={vi.fn()} />
      </AttachmentCollectionContext.Provider>,
    );
    const imagePanel = panels().at(-1)!;
    imagePanel.focus();
    fireEvent.keyDown(imagePanel, { key: 'ArrowRight' });
    await screen.findByRole('dialog', { name: 'second.txt' });

    const documentControl = screen.getByRole('button', { name: 'document control' });
    documentControl.focus();
    fireEvent.keyDown(documentControl, { key: 'ArrowLeft' });
    await waitFor(() => expect(previewImage().getAttribute('src')).toBe(SRC));
  });

  it('lets a reactivated older preview own shortcuts and Escape', async () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    render(
      <>
        <ImageLightbox src={SRC} onClose={firstClose} />
        <ImageLightbox src={NEXT_SRC} onClose={secondClose} />
      </>,
    );
    const [first, second] = panels();
    const firstSurface = first.querySelector<HTMLElement>('img[alt=""]')?.parentElement;
    const secondSurface = second.querySelector<HTMLElement>('img[alt=""]')?.parentElement;
    expect(firstSurface && secondSurface).toBeTruthy();

    fireEvent.mouseDown(firstSurface!, { button: 0, clientX: 200, clientY: 200 });
    expect(first.hasAttribute('data-preview-active')).toBe(true);
    const secondTransform = secondSurface!.style.transform;
    fireEvent.keyDown(first, { key: '+' });
    expect(firstSurface!.style.transform).not.toBe(secondSurface!.style.transform);
    expect(secondSurface!.style.transform).toBe(secondTransform);

    fireEvent.keyDown(first, { key: 'Escape' });
    await waitFor(() => expect(firstClose).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(secondClose).not.toHaveBeenCalled();
  });

  it('does not close a newer preview from an older close animation', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const view = render(<ImageLightbox src={SRC} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.lightbox.close') }));
    view.rerender(<ImageLightbox src={NEXT_SRC} onClose={onClose} />);
    expect(previewImage().getAttribute('src')).toBe(NEXT_SRC);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets a newer mounted layer supersede an activated older preview', async () => {
    vi.useFakeTimers();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    render(
      <>
        <ImageLightbox src={SRC} onClose={firstClose} />
        <ImageLightbox src={NEXT_SRC} onClose={secondClose} />
      </>,
    );
    const [first] = panels();
    const firstSurface = first.querySelector<HTMLElement>('img[alt=""]')?.parentElement;
    expect(firstSurface).toBeTruthy();
    fireEvent.mouseDown(firstSurface!, { button: 0, clientX: 200, clientY: 200 });
    expect(first.hasAttribute('data-preview-active')).toBe(true);

    const newer = document.createElement('div');
    newer.setAttribute('data-lightbox-layer', '');
    document.body.append(newer);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(firstClose).not.toHaveBeenCalled();
      expect(secondClose).not.toHaveBeenCalled();
    } finally {
      newer.remove();
    }
  });
});
