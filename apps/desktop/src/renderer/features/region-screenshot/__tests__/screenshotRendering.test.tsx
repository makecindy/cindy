// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotErrorBoundary } from '../ScreenshotErrorBoundary';
import { Magnifier } from '../Magnifier';
import { bitmapToImageData, imageDataToBitmap } from '../bridge';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// 测试价值：生产 React 边界出错会释放浮层，放大镜坐标与屏幕像素一致。
// 纯几何测试没有组件/错误路径；最小输入为 render throw、2x 屏配 3x 定格图。
// tier: unit；仅此文件需要 DOM，和主进程窗口模拟分开。
describe('screenshot rendering recovery', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
