// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotErrorBoundary } from '../ScreenshotErrorBoundary';
import { Magnifier } from '../Magnifier';
import { bitmapToImageData, imageDataToBitmap, type RegionScreenshotOverlayBridge } from '../bridge';
import { RegionScreenshotOverlay } from '../RegionScreenshotOverlay';
import type { RegionScreenshotHit } from '../../../../shared/regionScreenshot';
import type { RegionCaptureFrame } from '../../../../shared/regionCapture';
import { ScrollCaptureOverlay } from '../ScrollCaptureOverlay';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { language: 'en' } }));
vi.mock('@/hooks/useTheme', () => ({ getInitialThemeVariant: () => ({ theme: 'default' }) }));
vi.mock('@/themes/theme-service', () => ({ themeService: { applyTheme: vi.fn() } }));
vi.mock('../ScreenshotToolbar', () => ({ TOOL_SHORTCUTS: {}, ScreenshotModeBar: () => null, ScreenshotStyleBar: () => null, ScreenshotToolbar: () => null }));
vi.mock('../LiveCapturePanel', () => ({ LiveCapturePanel: () => null }));
vi.mock('../ScreenshotEditorViewport', () => ({ ScreenshotEditorViewport: () => null }));

// 测试价值：生产 React 边界出错会释放浮层，放大镜坐标与屏幕像素一致。
// 纯几何测试没有组件/错误路径；最小输入为 render throw、2x 屏配 3x 定格图。
// tier: unit；仅此文件需要 DOM，和主进程窗口模拟分开。
describe('screenshot rendering recovery', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  // Production overlay regression: moving within the same window must not
  // reuse the old parent's chain or apply a delayed hit from another point.
  // Review regression (2026-10-28): a captured click-through front window must
  // not flash back while a corrected hit is pending. Previously this test
  // expected that flash. Overlapping captured windows + deferred replies, tier: unit.
  // Standalone file: 1.52s on XD-PC (2026-10-28).
  it('keeps point-specific hits current and selects the corrected target', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('ImageData', class {
      data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let begin!: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0];
    const replies: ((hit: RegionScreenshotHit) => void)[] = [];
    const bridge = {
      onBegin: (callback: typeof begin) => { begin = callback; return () => {}; },
      onEnd: () => () => {}, onClear: () => () => {},
      shellReady() {}, abandon() {}, painted() {}, focused() {}, selectionStarted() {},
      elementsAt: vi.fn(() => new Promise<RegionScreenshotHit>((resolve) => replies.push(resolve))),
    } as unknown as RegionScreenshotOverlayBridge;
    const { container } = render(<RegionScreenshotOverlay bridge={bridge} />);
    const root = container.firstElementChild!;
    const outer = { id: 0, rect: { x: 0, y: 0, width: 500, height: 400 } };
    const corrected = { id: 1, rect: { x: 20, y: 20, width: 300, height: 300 } };
    const front = { id: 2, rect: { x: 200, y: 100, width: 50, height: 40 } };
    await act(async () => begin({ token: 'one', locale: 'en', viewport: { width: 600, height: 500 }, safeArea: { x: 0, y: 0, width: 600, height: 500 }, scaleFactor: 1, frame: { width: 1, height: 1, data: new Uint8Array(4) }, windows: [front, outer, corrected], cursor: { x: 10, y: 10 }, lastRegion: null }));
    fireEvent.pointerMove(root, { clientX: 40, clientY: 40 });
    await act(async () => replies[0]({ window: outer, rects: [{ x: 0, y: 0, width: 200, height: 200 }] }));
    expect(screen.getByText('500 × 400')).toBeTruthy();
    expect(bridge.elementsAt).toHaveBeenLastCalledWith('one', 0, 40, 40);
    const content = { x: 25, y: 25, width: 250, height: 200 };
    // 2026-10-28 browser regression: default to the document, not its button.
    // The actual renderer must still let a wheel gesture reach finer elements.
    await act(async () => replies[1]({ window: corrected, rects: [{ x: 30, y: 30, width: 80, height: 60 }, content], preferredRect: content }));
    expect(screen.getByText('250 × 200')).toBeTruthy();
    fireEvent.wheel(root, { deltaY: 120 });
    expect(screen.getByText('80 × 60')).toBeTruthy();
    // Keep the default, not the old fine element, during a new point query.
    fireEvent.pointerMove(root, { clientX: 150, clientY: 150 });
    expect(screen.getByText('250 × 200')).toBeTruthy();
    await act(async () => replies[2]({ window: corrected, rects: [] }));
    expect(screen.getByText('250 × 200')).toBeTruthy();
    // An opaque pixel in the same front window must still win once confirmed.
    fireEvent.pointerMove(root, { clientX: 160, clientY: 150 });
    expect(screen.getByText('250 × 200')).toBeTruthy();
    await act(async () => replies[3]({ window: outer, rects: [] }));
    expect(screen.getByText('500 × 400')).toBeTruthy();
    fireEvent.pointerMove(root, { clientX: 180, clientY: 150 });
    await act(async () => replies[4]({ window: corrected, rects: [], preferredRect: content }));
    expect(screen.getByText('250 × 200')).toBeTruthy();
    // Leaving the corrected window stops retaining it even before a reply.
    fireEvent.pointerMove(root, { clientX: 450, clientY: 350 });
    expect(screen.getByText('500 × 400')).toBeTruthy();
    fireEvent.pointerMove(root, { clientX: 220, clientY: 120 });
    expect(screen.getByText('50 × 40')).toBeTruthy(); // a different front window wins immediately
    fireEvent.pointerMove(root, { clientX: 200, clientY: 150 });
    expect(screen.getByText('250 × 200')).toBeTruthy();
    await act(async () => replies[5]({ window: outer, rects: [] }));
    expect(screen.getByText('250 × 200')).toBeTruthy(); // stale opaque hit
    await act(async () => replies[6]({ window: corrected, rects: [] }));
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.pointerMove(root, { clientX: 450, clientY: 350 });
    expect(screen.getByText('250 × 200')).toBeTruthy();
    expect(bridge.elementsAt).toHaveBeenCalledTimes(7);
  });
  // PR #7661 discussion_r4398847280: a native null window must not flash the
  // captured window underneath an unknown occluder at each new pointer position.
  // Existing corrected-target coverage only used non-null windows. Production
  // overlay + deferred null/recovery replies is the minimal input; tier: unit.
  it('retains a confirmed unknown occluder while a new point is pending', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('ImageData', class {
      data = new Uint8ClampedArray(4);
      constructor(readonly width: number, readonly height: number) {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let begin!: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0];
    const replies: ((hit: RegionScreenshotHit) => void)[] = [];
    const bridge = {
      onBegin: (callback: typeof begin) => { begin = callback; return () => {}; },
      onEnd: () => () => {}, onClear: () => () => {},
      shellReady() {}, abandon() {}, painted() {}, focused() {}, selectionStarted() {},
      elementsAt: vi.fn(() => new Promise<RegionScreenshotHit>((resolve) => replies.push(resolve))),
    } as unknown as RegionScreenshotOverlayBridge;
    const outer = { id: 0, rect: { x: 0, y: 0, width: 500, height: 400 } };
    const front = { id: 1, rect: { x: 400, y: 100, width: 100, height: 100 } };
    const { container } = render(<RegionScreenshotOverlay bridge={bridge} />);
    const root = container.firstElementChild!;
    await act(async () => begin({ token: 'occluded', locale: 'en', viewport: { width: 600, height: 500 }, safeArea: { x: 0, y: 0, width: 600, height: 500 }, scaleFactor: 1, frame: { width: 1, height: 1, data: new Uint8Array(4) }, windows: [front, outer], cursor: { x: 50, y: 80 }, lastRegion: null }));
    await act(async () => replies[0]({ window: null, rects: [] }));
    expect(screen.getByText('600 × 500')).toBeTruthy();
    for (const x of [100, 200]) {
      fireEvent.pointerMove(root, { clientX: x, clientY: 80 });
      expect(screen.getByText('600 × 500')).toBeTruthy();
    }
    // An obsolete non-null hit cannot select the occluded window either.
    await act(async () => replies[1]({ window: outer, rects: [] }));
    expect(screen.getByText('600 × 500')).toBeTruthy();
    expect(bridge.elementsAt).toHaveBeenLastCalledWith('occluded', 0, 200, 80);
    await act(async () => replies[2]({ window: null, rects: [] }));
    fireEvent.pointerMove(root, { clientX: 250, clientY: 80 });
    expect(screen.getByText('600 × 500')).toBeTruthy();
    // A fresh hit restores the known window as soon as the occluder is left.
    await act(async () => replies[3]({ window: outer, rects: [] }));
    expect(screen.getByText('500 × 400')).toBeTruthy();
    fireEvent.pointerMove(root, { clientX: 300, clientY: 80 });
    await act(async () => replies[4]({ window: null, rects: [] }));
    fireEvent.pointerMove(root, { clientX: 450, clientY: 150 });
    expect(screen.getByText('100 × 100')).toBeTruthy(); // a different captured front ends retention
    await act(async () => replies[5]({ window: front, rects: [] }));
    expect(bridge.elementsAt).toHaveBeenCalledTimes(6);
  });
  // 2026-10-28 flicker: final-result assertions missed the whole-window frame
  // inserted during every pending query. Production overlay, two moves before a
  // deferred reply (unit); also cover old helpers without captured child regions.
  // Standalone file: 1.64s on XD-PC (2026-10-28).
  it.each([true, false])('keeps the default outline stable during pending queries (snapshot=%s)', async (snapshot) => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('ImageData', class {
      data = new Uint8ClampedArray(4);
      constructor(readonly width: number, readonly height: number) {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    let begin!: Parameters<RegionScreenshotOverlayBridge['onBegin']>[0];
    const replies: ((hit: RegionScreenshotHit) => void)[] = [];
    const bridge = {
      onBegin: (callback: typeof begin) => { begin = callback; return () => {}; },
      onEnd: () => () => {}, onClear: () => () => {},
      shellReady() {}, abandon() {}, painted() {}, focused() {}, selectionStarted() {},
      elementsAt: vi.fn(() => new Promise<RegionScreenshotHit>((resolve) => replies.push(resolve))),
    } as unknown as RegionScreenshotOverlayBridge;
    const content = { x: 0, y: 50, width: 500, height: 350 };
    const outer = { id: 0, rect: { x: 0, y: 0, width: 500, height: 400 }, ...(snapshot ? { snapRects: [content] } : {}) };
    const front = { id: 1, rect: { x: 400, y: 100, width: 100, height: 100 }, snapRects: [] };
    const { container } = render(<RegionScreenshotOverlay bridge={bridge} />);
    const root = container.firstElementChild!;
    const payload = { token: 'stable', locale: 'en', viewport: { width: 600, height: 500 }, safeArea: { x: 0, y: 0, width: 600, height: 500 }, scaleFactor: 1, frame: { width: 1, height: 1, data: new Uint8Array(4) }, windows: [front, outer], cursor: { x: 50, y: 80 }, lastRegion: null };
    await act(async () => begin(payload));
    if (snapshot) expect(screen.getByText('500 × 350')).toBeTruthy(); // before any native reply
    await act(async () => replies[0]({ window: outer, rects: [], preferredRect: content }));
    for (const x of [100, 200]) {
      fireEvent.pointerMove(root, { clientX: x, clientY: 80 });
      expect(screen.getByText('500 × 350')).toBeTruthy();
    }
    // A late result for x=100 must not change even the remembered default.
    await act(async () => replies[1]({ window: outer, rects: [], preferredRect: outer.rect }));
    fireEvent.pointerMove(root, { clientX: 250, clientY: 80 });
    expect(screen.getByText('500 × 350')).toBeTruthy();
    await act(async () => replies[2]({ window: outer, rects: [], preferredRect: outer.rect }));
    await act(async () => replies[3]({ window: outer, rects: [{ x: 230, y: 60, width: 80, height: 60 }], preferredRect: content }));
    expect(screen.getByText('500 × 350')).toBeTruthy();
    fireEvent.wheel(root, { deltaY: 120 });
    expect(screen.getByText('80 × 60')).toBeTruthy();
    fireEvent.pointerMove(root, { clientX: 250, clientY: 81 });
    await act(async () => replies[4]({ window: outer, rects: [], preferredRect: outer.rect }));
    expect(screen.getByText('500 × 350')).toBeTruthy(); // partial UIA does not erase known content
    fireEvent.pointerMove(root, { clientX: 250, clientY: 20 });
    expect(screen.getByText('500 × 400')).toBeTruthy(); // leave content immediately
    fireEvent.pointerMove(root, { clientX: 450, clientY: 150 });
    expect(screen.getByText('100 × 100')).toBeTruthy(); // top window occludes cached content
    fireEvent.pointerMove(root, { clientX: 250, clientY: 80 });
    expect(screen.getByText('500 × 350')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.pointerMove(root, { clientX: 550, clientY: 450 });
    expect(screen.getByText('500 × 350')).toBeTruthy();
    // A new capture cannot inherit a region or a late reply from this capture.
    await act(async () => begin({ ...payload, token: 'next', windows: [{ ...outer, snapRects: [] }] }));
    await act(async () => replies[5]({ window: outer, rects: [], preferredRect: content }));
    expect(screen.getByText('500 × 400')).toBeTruthy();
  });
  // 用户反馈点击自动滚动立刻提示已停止。已有渲染测试未覆盖开关与在途帧的竞态。
  // 最小输入：开启前发出的帧在开启成功后返回 false；下一帧的真实停止仍须显示。tier: unit。
  it('ignores a pre-start frame but reports a fresh automatic scrolling failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('ImageData', class {
      data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      putImageData: vi.fn(), drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const image = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
    let resolveFrame!: (frame: RegionCaptureFrame) => void;
    const liveFrame = vi.fn(() => new Promise<RegionCaptureFrame>(resolve => { resolveFrame = resolve; }));
    const bridge = {
      liveFrame, autoScroll: vi.fn(async () => true), holdCapture: vi.fn(async () => {}),
    } as unknown as RegionScreenshotOverlayBridge;
    render(<ScrollCaptureOverlay token="capture" bridge={bridge} onEdit={vi.fn()} begin={{
      mode: 'scroll', first: image, selection: { x: 10, y: 10, width: 64, height: 64 },
      scrollLayout: {
        viewport: { width: 800, height: 600 }, preview: { x: 100, y: 10, width: 64, height: 128 },
        actions: { x: 100, y: 150, width: 128, height: 32 }, auto: { x: 10, y: 90, width: 128, height: 32 },
      },
    }} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(liveFrame).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'regionScreenshot.live.autoScroll' })); });
    expect(screen.getByRole('button', { name: 'regionScreenshot.live.stopScroll' })).toBeTruthy();
    await act(async () => { resolveFrame({ image, autoScrolling: false, keys: null, cursor: null }); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'regionScreenshot.live.stopScroll' })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(200));
    await act(async () => { resolveFrame({ image, autoScrolling: false, keys: null, cursor: null }); });
    expect(screen.getByRole('alert').textContent).toBe('regionScreenshot.live.autoUnavailable');
    expect(screen.getByRole('button', { name: 'regionScreenshot.live.autoScroll' })).toBeTruthy();
  });
  // Unit: packed-pixel conversion must preserve alpha, immutable input and byte
  // views from IPC. Existing geometry/rendering tests do not inspect these bytes.
  it.each([0, 1])('round-trips screenshot pixels with byte offset %s', (offset) => {
    vi.stubGlobal('ImageData', class {
      data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    });
    const bytes = [9, 17, 33, 127, 100, 201, 255, 0];
    const data = new Uint8Array(new ArrayBuffer(bytes.length + offset), offset);
    data.set(bytes);
    const bitmap = { width: 2, height: 1, data };
    const image = bitmapToImageData(bitmap);
    expect(Array.from(image.data)).toEqual([33, 17, 9, 127, 255, 201, 100, 0]);
    expect(bitmapToImageData(bitmap, image)).toBe(image);
    expect(Array.from(data)).toEqual(bytes);
    expect(Array.from(imageDataToBitmap(image).data)).toEqual(bytes);
    expect(bitmapToImageData({ width: 1, height: 2, data }, image)).not.toBe(image);
  });
  it('releases the screen when a child crashes instead of showing the application crash page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fail = vi.fn();
    function Broken(): never {
      throw new Error('broken overlay');
    }
    const { container } = render(
      <ScreenshotErrorBoundary onFailure={fail}>
        <Broken />
      </ScreenshotErrorBoundary>,
    );
    expect(fail).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  });
  it.each([1.25, 2])(
    'shows physical screen coordinates at %sx independently of capture resolution',
    (scaleFactor) => {
      render(
        <Magnifier
          frame={null}
          frameSize={{ width: 300, height: 300 }}
          viewport={{ width: 100, height: 100 }}
          point={{ x: 20, y: 40 }}
          color={null}
          scaleFactor={scaleFactor}
        />,
      );
      expect(screen.getByText(`${20 * scaleFactor}, ${40 * scaleFactor}`)).toBeTruthy();
    },
  );
});
