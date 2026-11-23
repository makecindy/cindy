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
 * - 笔迹一经提交就写回待发附件草稿,发送/清空托盘不再依赖浮窗键盘守卫;
 *   当前浮窗菜单的方向键 / Enter 与缩放快捷键互不抢事件;
 *   离开确认锁在异步保存完成后才释放。
 * - 逐笔草稿回写不触发换图确认；换图只由宿主请求的不同图片上下文驱动。
 * - 集合重新挂载图片时读取最新草稿；宿主换图经过当前集合图片的离开守卫。
 * - 附件更新被锁定时预览只读，不能把空回调当作保存成功；解锁后当前草稿
 *   写入器恢复，once-bound 快捷键不会沿用锁定首帧的空写入器。
 * - 异步换图保存期间返回当前图或再切到第三张时，结算最新宿主请求。
 * - 历史标注图原图丢失时退回烧录图,而不是提示丢失并关闭。
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ChatSessionFileProvider } from '@/components/chat/ChatSessionFileContext';
import { AttachmentCollectionPreview } from '@/components/chat/AttachmentCollection';
import {
  AttachmentCollectionContext,
  type AttachmentCollectionItem,
} from '@/components/chat/AttachmentCollectionContext';
import { galleryImagePreviewItem } from '@/components/chat/ImageGalleryContext';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

const SRC = 'cindy-media://blobs/source.png';
const NEXT_SRC = 'cindy-media://blobs/next.png';
const THIRD_SRC = 'cindy-media://blobs/third.png';

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
  // Normal viewing must leave image clicks available for double-click zoom,
  // while background clicks close exactly once after the exit animation.
  it('keeps image clicks open and closes once for repeated background clicks', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<ImageLightbox src={SRC} onClose={onClose} />);
    const image = lightboxImage();
    loadImage(image);
    // viewBox-only SVGs also need an explicit fitted box after natural-size load.
    expect(image.style.width).toBe('200px');
    expect(image.style.height).toBe('100px');
    act(() => vi.advanceTimersByTime(200));
    const overlay = document.activeElement!;
    expect(overlay.contains(image)).toBe(true);
    fireEvent.click(image);
    act(() => vi.advanceTimersByTime(250));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(overlay);
    fireEvent.click(overlay);
    act(() => vi.advanceTimersByTime(250));
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  // Replaces the deleted source scan: a background misclick during annotation
  // must preserve unsaved strokes (engineering-conventions §3.2, user data).
  it('keeps unsaved strokes and the lightbox open after a background click', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<ImageLightbox src={SRC} onClose={onClose} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 90, y: 50 });
    act(() => vi.advanceTimersByTime(200));
    // FocusScope focuses the real overlay. Target that background itself so
    // the test cannot pass merely because an image child swallowed the click.
    fireEvent.click(document.activeElement!);
    act(() => vi.advanceTimersByTime(250));
    expect(onClose).not.toHaveBeenCalled();
    expect(committedPaths('stroke')).toHaveLength(1);
  });

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
      // real-wait: verify the production confirmation-exit animation has completed.
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

  it('keeps the close and retry controls available when the original image is missing', () => {
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
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: label('attachmentPreview.retry') })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: label('chat.lightbox.close') }));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('writes committed annotation edits to the owning attachment draft', () => {
    const onDraftChange = vi.fn();
    render(
      <ImageLightbox
        src={SRC}
        onClose={vi.fn()}
        annotationEdit={{ onSave: vi.fn(), onDraftChange }}
      />,
    );
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 20, y: 20 }, { x: 100, y: 80 });
    expect(onDraftChange).toHaveBeenLastCalledWith({
      strokes: [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.8 }] }],
    });
    fireEvent.click(screen.getByRole('button', { name: label('chat.media.annotateUndo') }));
    expect(onDraftChange).toHaveBeenLastCalledWith({ strokes: [] });
  });

  it('keeps the leave lock until annotation save settles', async () => {
    let resolveSave!: () => void;
    const save = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const onSave = vi.fn(() => save);
    render(
      <ConfirmDialogProvider>
        <ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave }} />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('chat.lightbox.close') }));
    });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: label('chat.media.annotateSave') }));
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('chat.lightbox.close') }));
      // The broken early-unlock path needs the confirmation exit animation to finish.
      // real-wait: confirmation exit animation must finish before another leave.
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const secondDialog = screen.queryByRole('alertdialog');
    if (secondDialog) {
      await act(async () => {
        fireEvent.click(
          within(secondDialog).getByRole('button', { name: label('chat.media.annotateSave') }),
        );
      });
    }
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSave();
      await save;
    });
  });

  it('leaves portaled preview menu keys to the menu', () => {
    render(<ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={{ onSave: vi.fn() }} />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 20, y: 20 }, { x: 120, y: 80 });

    // Minimal stand-in for a Radix menu portaled outside the preview panel.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.append(menu);
    for (const key of ['ArrowDown', 'Enter', '+']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      menu.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('restores the baseline annotation draft on close-discard', async () => {
    const baseline: Stroke[] = [{ points: [{ x: 0.5, y: 0.5 }] }];
    const onDraftChange = vi.fn();
    render(
      <ConfirmDialogProvider>
        <ImageLightbox
          src={SRC}
          onClose={vi.fn()}
          annotationEdit={{ initialStrokes: baseline, onDraftChange, onSave: vi.fn() }}
        />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    openAnnotate();
    pressKey({ key: 'z', ctrlKey: true });
    expect(onDraftChange).toHaveBeenLastCalledWith({ strokes: [] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('chat.lightbox.close') }));
    });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: label('chat.media.annotateDiscardConfirmAction'),
        }),
      );
    });
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith({
        strokes: [{ points: [{ x: 0.5, y: 0.5 }] }],
      }),
    );
  });

  it('restores the full displayed source snapshot after a cancelled leave', async () => {
    const onSourceChangeCancelled = vi.fn();
    function Host() {
      const [source, setSource] = useState<{ src: string; sessionId?: string }>({
        src: SRC,
        sessionId: 'task-A',
      });
      return (
        <ConfirmDialogProvider>
          <button type="button" onClick={() => setSource({ src: NEXT_SRC, sessionId: 'task-B' })}>
            open next
          </button>
          <ImageLightbox
            src={source.src}
            sessionId={source.sessionId}
            onClose={vi.fn()}
            annotationEdit={{ onSave: vi.fn(), onDraftChange: vi.fn() }}
            onSourceChangeCancelled={(displayed) => {
              onSourceChangeCancelled(displayed);
              setSource({ src: displayed.src, sessionId: displayed.sessionId });
            }}
          />
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open next' }));
    });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', {
          name: label('chat.media.annotateDiscardConfirmCancel'),
        }),
      );
    });
    await waitFor(() =>
      expect(onSourceChangeCancelled).toHaveBeenCalledWith(
        expect.objectContaining({ src: SRC, sessionId: 'task-A' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open next' }));
    });
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('keeps the newest source request while a save is busy', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onSourceChangeCancelled = vi.fn();
    function Host() {
      const [source, setSource] = useState<{ src: string; sessionId?: string }>({
        src: SRC,
        sessionId: 'task-A',
      });
      return (
        <ConfirmDialogProvider>
          <button type="button" onClick={() => setSource({ src: NEXT_SRC, sessionId: 'task-A' })}>
            open next
          </button>
          <button type="button" onClick={() => setSource({ src: THIRD_SRC, sessionId: 'task-A' })}>
            open third
          </button>
          <ImageLightbox
            src={source.src}
            sessionId={source.sessionId}
            onClose={vi.fn()}
            annotationEdit={{ onSave, onDraftChange: vi.fn() }}
            onSourceChangeCancelled={(displayed) => {
              onSourceChangeCancelled(displayed);
              setSource({ src: displayed.src, sessionId: displayed.sessionId });
            }}
          />
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open next' }));
    });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: label('chat.media.annotateSave') }),
      );
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open third' }));
    });
    expect(onSourceChangeCancelled).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave?.();
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(THIRD_SRC));
    expect(onSourceChangeCancelled).not.toHaveBeenCalled();
  });

  it('does not treat draft write-back as a source retarget', async () => {
    function Host() {
      const [strokes, setStrokes] = useState<Stroke[]>([]);
      return (
        <ConfirmDialogProvider>
          <ImageLightbox
            src={SRC}
            onClose={vi.fn()}
            annotationEdit={{
              initialStrokes: strokes,
              onDraftChange: ({ strokes: next }) => setStrokes(next),
              onSave: vi.fn(),
            }}
          />
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();

    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    await waitFor(() => expect(committedPaths('stroke')).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      screen.getByRole('button', { name: label('chat.media.annotateUndo') }),
    ).toBeTruthy();

    pressKey({ key: 'z', ctrlKey: true });
    await waitFor(() => expect(committedPaths('stroke')).toHaveLength(0));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      screen.getByRole('button', { name: label('chat.media.annotateUndo') }),
    ).toBeTruthy();
  });

  it('returns to a collection image with the latest saved draft', async () => {
    function Host() {
      const [strokesA, setStrokesA] = useState<Stroke[]>([]);
      const [strokesB, setStrokesB] = useState<Stroke[]>([]);
      const editA = {
        initialStrokes: strokesA,
        onDraftChange: ({ strokes }: { strokes: Stroke[] }) => setStrokesA(strokes),
        onSave: ({ strokes }: { strokes: Stroke[] }) => setStrokesA(strokes),
      };
      const editB = {
        initialStrokes: strokesB,
        onDraftChange: ({ strokes }: { strokes: Stroke[] }) => setStrokesB(strokes),
        onSave: ({ strokes }: { strokes: Stroke[] }) => setStrokesB(strokes),
      };
      const items: AttachmentCollectionItem[] = [
        {
          id: 'a',
          name: 'a.png',
          source: SRC,
          kind: 'image',
          media: true,
          image: { annotationEdit: editA },
        },
        {
          id: 'b',
          name: 'b.png',
          source: NEXT_SRC,
          kind: 'image',
          media: true,
          image: { annotationEdit: editB },
        },
      ];
      return (
        <ConfirmDialogProvider>
          <AttachmentCollectionContext.Provider value={items}>
            <ImageLightbox src={SRC} onClose={vi.fn()} annotationEdit={editA} />
          </AttachmentCollectionContext.Provider>
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    await waitFor(() => expect(committedPaths('stroke')).toHaveLength(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('attachmentPreview.next') }));
    });
    const saveDialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(saveDialog).getByRole('button', { name: label('chat.media.annotateSave') }),
      );
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(NEXT_SRC));
    loadImage(lightboxImage());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('attachmentPreview.previous') }));
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(SRC));
    loadImage(lightboxImage());
    expect(committedPaths('stroke')).toHaveLength(1);
  });

  it('routes a host source request through the active collection item guard', async () => {
    function Host() {
      const [hostSrc, setHostSrc] = useState(SRC);
      const [strokesA, setStrokesA] = useState<Stroke[]>([]);
      const [strokesB, setStrokesB] = useState<Stroke[]>([]);
      const editA = {
        initialStrokes: strokesA,
        onDraftChange: ({ strokes }: { strokes: Stroke[] }) => setStrokesA(strokes),
        onSave: ({ strokes }: { strokes: Stroke[] }) => setStrokesA(strokes),
      };
      const editB = {
        initialStrokes: strokesB,
        onDraftChange: ({ strokes }: { strokes: Stroke[] }) => setStrokesB(strokes),
        onSave: ({ strokes }: { strokes: Stroke[] }) => setStrokesB(strokes),
      };
      const items: AttachmentCollectionItem[] = [
        {
          id: 'a',
          name: 'a.png',
          source: SRC,
          kind: 'image',
          media: true,
          image: { annotationEdit: editA },
        },
        {
          id: 'b',
          name: 'b.png',
          source: NEXT_SRC,
          kind: 'image',
          media: true,
          image: { annotationEdit: editB },
        },
      ];
      return (
        <ConfirmDialogProvider>
          <AttachmentCollectionContext.Provider value={items}>
            <button type="button" onClick={() => setHostSrc(THIRD_SRC)}>
              open third
            </button>
            <ImageLightbox
              src={hostSrc}
              onClose={vi.fn()}
              annotationEdit={editA}
              onSourceChangeCancelled={(displayed) => setHostSrc(displayed.src)}
            />
          </AttachmentCollectionContext.Provider>
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label('attachmentPreview.next') }));
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(NEXT_SRC));
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open third' }));
    });
    const guardDialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(guardDialog).getByRole('button', {
          name: label('chat.media.annotateDiscardConfirmCancel'),
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(lightboxImage().getAttribute('src')).toBe(NEXT_SRC);
  });

  // 测试价值
  // - 生产入口与可观察结果：ImageLightbox 的宿主换图 effect；异步保存期间返回 A
  //   或再切到 C 后，显示的图片与宿主 src 都等于最新请求。
  // - Bug／规则依据：#11952 round 11 review PRRT_kwDOTgdRUs66qFSo；
  //   docs/dev-rules/engineering-conventions.md §3.2。
  // - 现有覆盖缺口：既有用例只覆盖 B->C 保存成功，未覆盖返回当前图与旧守卫取消。
  // - 最小失败输入：A 有未保存笔迹 -> 请求 B 并保存 -> 保存未完成时请求 A/C；
  //   修复前分别显示 B 或把宿主重置到 A。
  // - tier：unit；复用现有 jsdom 文件，定向套件实测约 2.5s。
  it('settles a save back to the latest host source when the request returns to the displayed image', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onSourceChangeCancelled = vi.fn();
    function Host() {
      const [source, setSource] = useState(SRC);
      return (
        <ConfirmDialogProvider>
          <button type="button" onClick={() => setSource(NEXT_SRC)}>
            open next
          </button>
          <button type="button" onClick={() => setSource(SRC)}>
            return first
          </button>
          <ImageLightbox
            src={source}
            onClose={vi.fn()}
            annotationEdit={{ onSave, onDraftChange: vi.fn() }}
            onSourceChangeCancelled={(displayed) => {
              onSourceChangeCancelled(displayed);
              setSource(displayed.src);
            }}
          />
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open next' }));
    });
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole('button', { name: label('chat.media.annotateSave') }),
      );
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'return first' }));
    });
    await act(async () => {
      resolveSave?.();
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(SRC));
    expect(onSourceChangeCancelled).not.toHaveBeenCalled();
  });

  it('keeps the newest source request after a stale leave guard is cancelled', async () => {
    const onSourceChangeCancelled = vi.fn();
    function Host() {
      const [source, setSource] = useState(SRC);
      return (
        <ConfirmDialogProvider>
          <button type="button" onClick={() => setSource(NEXT_SRC)}>
            open next
          </button>
          <button type="button" onClick={() => setSource(THIRD_SRC)}>
            open third
          </button>
          <ImageLightbox
            src={source}
            onClose={vi.fn()}
            annotationEdit={{ onSave: vi.fn(), onDraftChange: vi.fn() }}
            onSourceChangeCancelled={(displayed) => {
              onSourceChangeCancelled(displayed);
              setSource(displayed.src);
            }}
          />
        </ConfirmDialogProvider>
      );
    }
    render(<Host />);
    loadImage(lightboxImage());
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open next' }));
    });
    const firstDialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(screen.getByText('open third'));
    });
    await act(async () => {
      fireEvent.click(
        within(firstDialog).getByRole('button', {
          name: label('chat.media.annotateDiscardConfirmCancel'),
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeNull());
    const latestDialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(
        within(latestDialog).getByRole('button', {
          name: label('chat.media.annotateDiscardConfirmAction'),
        }),
      );
    });
    await waitFor(() => expect(lightboxImage().getAttribute('src')).toBe(THIRD_SRC));
    expect(onSourceChangeCancelled).not.toHaveBeenCalled();
  });

  it('keeps a locked attachment preview read-only', () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const props = {
      src: SRC,
      onClose: vi.fn(),
      annotationEdit: { initialStrokes: [], onDraftChange, onSave },
    };
    const view = render(
      <ConfirmDialogProvider>
        <ImageLightbox {...props} />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    expect(
      screen.getByRole('button', { name: label('chat.media.annotate') }),
    ).toBeTruthy();

    view.rerender(
      <ConfirmDialogProvider>
        <ImageLightbox {...props} annotationDisabled />
      </ConfirmDialogProvider>,
    );
    expect(
      screen.queryByRole('button', { name: label('chat.media.annotate') }),
    ).toBeNull();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  // 测试价值
  // - 生产入口与可观察结果：ImageLightbox 在同一张图锁定后解锁，标注入口恢复；
  //   绘制与 Cmd/Ctrl+Z 都写回当前附件草稿，不会只剩浮窗内的笔迹。
  // - Bug／规则依据：#11952 round 10 review PRRT_kwDOTgdRUs66pjK3、
  //   PRRT_kwDOTgdRUs66pjK6；docs/dev-rules/engineering-conventions.md §3.2。
  // - 现有覆盖缺口：既有只读测试只验证锁定态，既有撤销测试未在锁定首帧后解锁。
  // - 最小失败输入：先以 annotationDisabled 挂载，再不换源解锁并画一笔／按 Ctrl+Z；
  //   修复前分别缺少标注入口、快捷键沿用空写入器。
  // - tier：unit；复用现有 jsdom 文件，定向套件实测约 2.4s。
  it('restores annotation editing after a locked direct preview is unlocked', () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const view = render(
      <ConfirmDialogProvider>
        <ImageLightbox src={SRC} onClose={vi.fn()} annotationDisabled initialStrokes={[]} />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    expect(
      screen.queryByRole('button', { name: label('chat.media.annotate') }),
    ).toBeNull();

    view.rerender(
      <ConfirmDialogProvider>
        <ImageLightbox
          src={SRC}
          onClose={vi.fn()}
          annotationEdit={{ initialStrokes: [], onDraftChange, onSave }}
        />
      </ConfirmDialogProvider>,
    );
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    expect(onDraftChange).toHaveBeenCalledWith({
      strokes: [expect.objectContaining({ points: expect.any(Array) })],
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('uses the current draft writer for annotation shortcuts after unlock', () => {
    const lockedOnDraftChange = vi.fn();
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const view = render(
      <ConfirmDialogProvider>
        <ImageLightbox
          src={SRC}
          onClose={vi.fn()}
          annotationDisabled
          annotationEdit={{
            initialStrokes: [],
            onDraftChange: lockedOnDraftChange,
            onSave: vi.fn(),
          }}
        />
      </ConfirmDialogProvider>,
    );
    loadImage(lightboxImage());
    view.rerender(
      <ConfirmDialogProvider>
        <ImageLightbox
          src={SRC}
          onClose={vi.fn()}
          annotationEdit={{ initialStrokes: [], onDraftChange, onSave }}
        />
      </ConfirmDialogProvider>,
    );
    openAnnotate();
    drawStroke({ x: 10, y: 10 }, { x: 50, y: 50 });
    expect(onDraftChange).toHaveBeenCalledWith({
      strokes: [expect.objectContaining({ points: expect.any(Array) })],
    });
    pressKey({ key: 'z', ctrlKey: true });
    expect(onDraftChange).toHaveBeenLastCalledWith({ strokes: [] });
    expect(committedPaths('stroke')).toHaveLength(0);
    expect(lockedOnDraftChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

// #8356 r4436061975: selecting a persisted annotation from a mixed collection must
// load the unburned source and allow removing old strokes. Previous tests opened it directly.
it('keeps persisted strokes editable after switching collection items', () => {
  const burned = 'cindy-media://blobs/burned.png';
  render(<ChatSessionFileProvider value={{ sessionId: 'task', workingDir: '/repo', origin: { kind: 'local' } }}><AttachmentCollectionPreview
    items={[
      galleryImagePreviewItem({ src: burned, annotationSourceUrl: SRC, annotationStrokes: [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }] }] }, 'annotated'),
      galleryImagePreviewItem({ src: 'cindy-media://blobs/other.png' }, 'other'),
    ]}
    source="cindy-media://blobs/other.png" onClose={vi.fn()}
  /></ChatSessionFileProvider>);
  fireEvent.click(screen.getByRole('button', { name: label('attachmentPreview.previous') }));
  expect(lightboxImage().getAttribute('src')).toBe(SRC);
  loadImage(lightboxImage());
  openAnnotate();
  expect(committedPaths('stroke')).toHaveLength(1);
  pressKey({ key: 'z', ctrlKey: true });
  expect(committedPaths('stroke')).toHaveLength(0);
  expect(lightboxImage().getAttribute('src')).toBe(SRC);
});
