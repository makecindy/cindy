// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotErrorBoundary } from '../ScreenshotErrorBoundary';
import { Magnifier } from '../Magnifier';
import { bitmapToImageData, imageDataToBitmap } from '../bridge';
import type { RegionScreenshotOverlayBridge } from '../bridge';
import type { RegionCaptureFrame } from '../../../../shared/regionCapture';
import { ScrollCaptureOverlay } from '../ScrollCaptureOverlay';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
