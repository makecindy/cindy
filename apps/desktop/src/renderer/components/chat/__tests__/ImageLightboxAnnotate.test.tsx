// @vitest-environment jsdom
/**
 * ImageLightbox 标注模式的 DOM 行为。
 *
 * - 画笔走 Pointer Events(鼠标 / 触屏 / 笔统一),归一化坐标交给保存回调;
 * - 撤销 / 重做(按钮与快捷键),画新笔迹清空重做栈;
 * - SVG 预览与 canvas 烧录同一分层:先全部白描边、后全部红线;
 * - Esc / X:笔迹未偏离基线时行为同旧版(立即退出,不弹确认);有改动时经统一
 *   确认框,关闭确认框的那次 Esc 不会再次触发放弃;
 * - Space / 中键拖拽平移时不落笔;
 * - 历史标注图原图丢失时退回烧录图,而不是提示丢失并关闭。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

const SRC = 'cindy-media://blobs/source.png';

type Stroke = { points: Array<{ x: number; y: number }> };

function label(key: string): string {
  return i18n.t(key);
}

/** 让 <img> 以 200×100 的自然尺寸"加载完成",显示矩形同为 (0,0,200,100)。 */
function loadImage(img: HTMLImageElement) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 200 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 100 });
  vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.load(img);
}

function lightboxImage(): HTMLImageElement {
  const img = document.body.querySelector<HTMLImageElement>('img');
  if (!img) throw new Error('lightbox image not rendered');
  return img;
}

function surface(): HTMLElement {
  const parent = lightboxImage().parentElement;
  if (!parent) throw new Error('transform container missing');
  return parent;
}

function drawStroke(
  from: { x: number; y: number },
  to: { x: number; y: number },
  pointerId = 1,
  button = 0,
) {
  const el = surface();
  fireEvent.pointerDown(el, { pointerId, button, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(el, { pointerId, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(el, { pointerId, button, clientX: to.x, clientY: to.y });
}

function committedPaths(layer: 'outline' | 'stroke'): Element[] {
  return Array.from(
    document.body.querySelectorAll(
      `[data-annotation-layer="${layer}"] path:not([data-annotation-draft])`,
    ),
  );
}

function openAnnotate() {
  fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotate') }));
}

function pressKey(init: KeyboardEventInit & { key: string }) {
  fireEvent.keyDown(document.activeElement ?? document.body, init);
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ImageLightbox annotate mode', () => {
  it('draws with pointer events and saves normalized strokes', async () => {
    const onSave = vi.fn();
    render(
      <ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave }} />,
    );
    loadImage(lightboxImage());
    openAnnotate();

    drawStroke({ x: 20, y: 20 }, { x: 100, y: 50 });

    expect(committedPaths('stroke')).toHaveLength(1);
    expect(surface().style.touchAction).toBe('none');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotateSave') }));
    });
    expect(onSave).toHaveBeenCalledWith({
      strokes: [
        {
          points: [
            { x: 0.1, y: 0.2 },
            { x: 0.5, y: 0.5 },
          ],
        },
      ],
    });
  });

  it('renders all white outlines before all red strokes (burn-in parity)', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 190, y: 90 });
    drawStroke({ x: 190, y: 10 }, { x: 10, y: 90 });

    const layers = Array.from(document.body.querySelectorAll('[data-annotation-layer]')).map(
      (el) => el.getAttribute('data-annotation-layer'),
    );
    expect(layers).toEqual(['outline', 'stroke']);
    expect(committedPaths('outline')).toHaveLength(2);
    expect(committedPaths('stroke')).toHaveLength(2);
    const outlineWidth = Number(
      document.body.querySelector('[data-annotation-layer="outline"]')?.getAttribute('stroke-width'),
    );
    const strokeWidth = Number(
      document.body.querySelector('[data-annotation-layer="stroke"]')?.getAttribute('stroke-width'),
    );
    expect(outlineWidth).toBe(Math.round(strokeWidth * 1.8));
  });

  it('undoes and redoes via toolbar and shortcuts; a new stroke clears redo', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    drawStroke({ x: 60, y: 10 }, { x: 90, y: 50 });
    expect(committedPaths('stroke')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotateUndo') }));
    expect(committedPaths('stroke')).toHaveLength(1);
    pressKey({ key: 'z', ctrlKey: true });
    expect(committedPaths('stroke')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotateRedo') }));
    expect(committedPaths('stroke')).toHaveLength(1);
    pressKey({ key: 'Z', ctrlKey: true, shiftKey: true });
    expect(committedPaths('stroke')).toHaveLength(2);

    pressKey({ key: 'z', metaKey: true });
    expect(committedPaths('stroke')).toHaveLength(1);
    drawStroke({ x: 100, y: 10 }, { x: 150, y: 50 });
    expect(committedPaths('stroke')).toHaveLength(2);
    pressKey({ key: 'y', ctrlKey: true });
    expect(committedPaths('stroke')).toHaveLength(2);
  });

  it('pointercancel drops a tiny interrupted stroke but keeps a real one', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    const el = surface();
    // 起笔后几乎没动就被系统接管:视为误触,不留红点。
    fireEvent.pointerDown(el, { pointerId: 7, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 24, clientY: 22 });
    fireEvent.pointerCancel(el, { pointerId: 7, clientX: 24, clientY: 22 });
    expect(committedPaths('stroke')).toHaveLength(0);
    // 已经画了一段的笔迹被打断:照常保留。
    fireEvent.pointerDown(el, { pointerId: 8, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(el, { pointerId: 8, clientX: 120, clientY: 60 });
    fireEvent.pointerCancel(el, { pointerId: 8, clientX: 120, clientY: 60 });
    expect(committedPaths('stroke')).toHaveLength(1);
  });

  it('greys out undo / redo when there is nothing to undo or redo', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    const undo = () => screen.getByRole('button', { name: label('chat.media.annotateUndo') });
    const redo = () => screen.getByRole('button', { name: label('chat.media.annotateRedo') });
    expect(undo().getAttribute('aria-disabled')).toBe('true');
    expect(redo().getAttribute('aria-disabled')).toBe('true');

    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    expect(undo().getAttribute('aria-disabled')).toBeNull();
    expect(redo().getAttribute('aria-disabled')).toBe('true');

    pressKey({ key: 'z', ctrlKey: true });
    expect(undo().getAttribute('aria-disabled')).toBe('true');
    expect(redo().getAttribute('aria-disabled')).toBeNull();
    // 不可用时点击无效。
    fireEvent.click(undo());
    expect(committedPaths('stroke')).toHaveLength(0);

    fireEvent.click(redo());
    expect(committedPaths('stroke')).toHaveLength(1);
    expect(redo().getAttribute('aria-disabled')).toBe('true');

    // 撤销后画新笔迹,重做失效。
    pressKey({ key: 'z', ctrlKey: true });
    drawStroke({ x: 60, y: 10 }, { x: 90, y: 50 });
    expect(redo().getAttribute('aria-disabled')).toBe('true');
  });

  it('Esc without changes exits annotate mode immediately (no confirm)', () => {
    const baseline: Stroke[] = [{ points: [{ x: 0.5, y: 0.5 }] }];
    render(
      <ConfirmDialogProvider>
        <ImageLightbox
          src={SRC}
          onClose={vi.fn()}
          annotationEdit={{ initialStrokes: baseline, onSave: vi.fn() }}
        />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    openAnnotate();
    // 撤销再重做回到基线:仍视为未改动。
    pressKey({ key: 'z', ctrlKey: true });
    pressKey({ key: 'z', ctrlKey: true, shiftKey: true });

    pressKey({ key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: label('chat.media.annotate') })).toBeTruthy();
    expect(committedPaths('stroke')).toHaveLength(1);
  });

  it('Esc with changes asks first; the Esc that closes the dialog does not discard', async () => {
    render(
      <ConfirmDialogProvider>
        <ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      pressKey({ key: 'Escape' });
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toBeTruthy();
    expect(committedPaths('stroke')).toHaveLength(1);

    // 关闭确认框的 Esc:取消放弃,笔迹与标注模式都保留。
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(committedPaths('stroke')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: label('chat.media.annotateUndo') }),
    ).toBeTruthy();

    // 等确认框退场后再次放弃并确认:恢复到基线(空)并退出标注模式。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotateDiscard') }));
    });
    const confirmButton = await screen.findByRole('button', {
      name: label('chat.media.annotateDiscardConfirmAction'),
    });
    await act(async () => {
      fireEvent.click(confirmButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(committedPaths('stroke')).toHaveLength(0);
    expect(screen.getByRole('button', { name: label('chat.media.annotate') })).toBeTruthy();
  });

  it('autoAnnotate: Esc without changes closes the lightbox as before', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <ConfirmDialogProvider>
        <ImageLightbox src={SRC} onClose={onClose} sessionId="s1" autoAnnotate />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    // 越过 Esc 的"菜单刚关闭"吞键窗口(假时钟下 performance.now 从 0 起步)。
    act(() => {
      vi.advanceTimersByTime(200);
    });
    pressKey({ key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not draw while panning with Space held or the middle button', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    expect(surface().style.cursor).toBe('crosshair');

    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 }, 1, 1);
    expect(committedPaths('stroke')).toHaveLength(0);

    // 放大后按住 Space:光标变为抓手,拖动不落笔。
    pressKey({ key: '+' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: ' ', code: 'Space' });
    expect(surface().style.cursor).toBe('grab');
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    expect(committedPaths('stroke')).toHaveLength(0);
    fireEvent.keyUp(document.activeElement ?? document.body, { key: ' ', code: 'Space' });
    expect(surface().style.cursor).toBe('crosshair');

    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    expect(committedPaths('stroke')).toHaveLength(1);
  });

  it('falls back to the burned image when the unburned source is missing', () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src={SRC}
        onClose={onClose}
        initialStrokes={[{ points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }] }]}
        annotationFallbackSrc="cindy-media://blobs/burned.png"
      />,
    );
    expect(lightboxImage().getAttribute('src')).toBe(SRC);

    fireEvent.error(lightboxImage());

    expect(lightboxImage().getAttribute('src')).toBe('cindy-media://blobs/burned.png');
    loadImage(lightboxImage());
    expect(committedPaths('stroke')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still reports a missing image and closes when there is no burned fallback', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <ImageLightbox
        src={SRC}
        onClose={onClose}
        initialStrokes={[{ points: [{ x: 0.2, y: 0.2 }] }]}
      />,
    );
    fireEvent.error(lightboxImage());
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
