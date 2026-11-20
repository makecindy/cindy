// @vitest-environment jsdom
/**
 * ImageLightbox 非模态浮窗的 DOM 行为与几何边界。
 *
 * 测试价值
 * - 生产入口与可观察结果：挂载真实 ImageLightbox / useImagePreviewWindow 纯几何入口，
 *   断言无遮罩、无滚动锁、标题栏拖动移动整个浮窗、停靠/调整尺寸改变面板矩形、
 *   Esc 与关闭按钮仍工作、放大后图片内容仍走 pan。
 * - Bug／规则依据：主人 2026-11-20 报告「预览窗无法拖动且盖住主要对话区域」；
 *   DESIGN.md §4 Dialog & Modal 图片预览例外、product-rules/attachment-preview.md
 *   「打开与返回」、engineering-conventions.md §3.2。
 * - 现有覆盖缺口：chatMediaLightboxFocus / ImageLightboxAnnotate 只覆盖焦点、标注和
 *   图片点击；没有覆盖浮窗位置、非模态背景交互、视口边界与两种拖动手势的区分。
 * - 最小失败输入：1280×800 视口打开一张图；标题栏 pointerdown→pointermove→pointerup；
 *   320×600 视口或超出视口的 resize 位移。修复前没有拖动/停靠入口且存在遮罩。
 * - tier：unit（进程内 DOM，无真实 I/O）。
 * - 实测耗时：单独运行 24.45s（transform 8.33s / setup 8.05s / collect 6.95s，
 *   用例本体 1.26s）。超过 10s 的原因是真实 Desktop jsdom + i18n + Radix Tooltip
 *   生产组件收集成本；6 条用例合并在同一文件，未再新增小文件。
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import {
  clampPreviewRect,
  dockPreviewRect,
  resizePreviewRect,
} from '@/components/chat/imagePreviewWindow';

const SRC = 'cindy-media://blobs/source.png';

function panel(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[data-lightbox-layer]');
  if (!node) throw new Error('image preview panel missing');
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
});
