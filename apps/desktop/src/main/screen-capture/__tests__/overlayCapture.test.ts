import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const cropped = { toPNG: vi.fn(() => Buffer.from([9, 9, 9])) };
  const frame = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 2560, height: 1440 })),
    crop: vi.fn(() => cropped),
    toDataURL: vi.fn(() => 'data:image/png;base64,ZnJhbWU='),
  };
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    options: Record<string, unknown>;
    destroyed = false;
    private listeners = new Map<string, Array<() => void>>();
    on(event: string, listener: () => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    removeListener(event: string, listener: () => void): this {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        list.filter((fn) => fn !== listener),
      );
      return this;
    }
    emit(event: string): void {
      for (const fn of this.listeners.get(event) ?? []) fn();
    }
    webContents = {
      id: 501,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    show = vi.fn();
    focus = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    cropped,
    frame,
    FakeBrowserWindow,
    getSources: vi.fn(async () => [{ display_id: '7', thumbnail: frame }]),
    getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: vi.fn(() => ({
      id: 7,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      size: { width: 1280, height: 720 },
      scaleFactor: 2,
    })),
    getAllDisplays: vi.fn((): unknown[] => [{ id: 7 }]),
    ipcListeners: new Map<string, (...args: unknown[]) => void>(),
  };
});

const FakeBrowserWindow = mocks.FakeBrowserWindow;

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeBrowserWindow,
  desktopCapturer: { getSources: mocks.getSources },
  screen: {
    getCursorScreenPoint: mocks.getCursorScreenPoint,
    getDisplayNearestPoint: mocks.getDisplayNearestPoint,
    getAllDisplays: mocks.getAllDisplays,
  },
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      mocks.ipcListeners.set(channel, listener);
    }),
    removeListener: vi.fn((channel: string) => {
      mocks.ipcListeners.delete(channel);
    }),
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { captureRegionViaOverlay } from '../overlayCapture.js';

const TEST_PALETTE = {
  scrim: 'rgba(0, 0, 0, 0.5)',
  selectionBorder: 'rgba(255, 255, 255, 0.8)',
  pillBg: '#262626',
  pillFg: '#fafafa',
};

function emitOverlayResult(senderId: number, result: unknown): void {
  const listener = mocks.ipcListeners.get('screen-capture:overlay-result');
  expect(listener).toBeDefined();
  listener?.({ sender: { id: senderId } }, result);
}

function emitOverlayReady(senderId: number): void {
  const listener = mocks.ipcListeners.get('screen-capture:overlay-ready');
  expect(listener).toBeDefined();
  listener?.({ sender: { id: senderId } });
}

function emitOverlayContentReady(senderId: number): void {
  const listener = mocks.ipcListeners.get('screen-capture:overlay-content-ready');
  expect(listener).toBeDefined();
  listener?.({ sender: { id: senderId } });
}

type FakeOverlay = InstanceType<typeof FakeBrowserWindow>;

async function flushLoad(): Promise<FakeOverlay> {
  // loadURL(data: URL) 的 promise 在微任务里 resolve; 冻结帧等 ready 信号,
  // show() 等冻结帧解码完成的 content-ready 信号。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const overlay = FakeBrowserWindow.instances.at(-1);
  expect(overlay).toBeDefined();
  return overlay as FakeOverlay;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeBrowserWindow.instances = [];
  mocks.ipcListeners.clear();
});

describe('captureRegionViaOverlay', () => {
  it('crops the frozen frame by scaleFactor and resolves PNG bytes on select', async () => {
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    const overlay = await flushLoad();
    // 冻结帧只在 ready 信号(组件已订阅)之后发送, 且只认覆盖层本体 sender。
    expect(overlay.webContents.send).not.toHaveBeenCalled();
    emitOverlayReady(999);
    expect(overlay.webContents.send).not.toHaveBeenCalled();
    emitOverlayReady(501);
    expect(overlay.webContents.send).toHaveBeenCalledWith(
      'screen-capture:overlay-init',
      expect.objectContaining({ imageDataUrl: 'data:image/png;base64,ZnJhbWU=' }),
    );
    // show() 等冻结帧 <img> 解码完成的 content-ready 信号(纯黑窗口不提前
    // 露出, review P2), 同样只认覆盖层本体 sender。
    expect(overlay.show).not.toHaveBeenCalled();
    emitOverlayContentReady(999);
    expect(overlay.show).not.toHaveBeenCalled();
    emitOverlayContentReady(501);
    expect(overlay.show).toHaveBeenCalled();
    expect(overlay.focus).toHaveBeenCalled();

    emitOverlayResult(501, { kind: 'select', rect: { x: 10, y: 20, width: 100, height: 50 } });
    const outcome = await pending;
    // DIP rect × scaleFactor(2) → 像素裁剪
    expect(mocks.frame.crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 200, height: 100 });
    expect(outcome).toEqual({ cancelled: false, data: Buffer.from([9, 9, 9]) });
    expect(overlay.destroyed).toBe(true);
  });

  it('resolves cancelled on cancel result and on near-zero selections', async () => {
    const first = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'cancel' });
    await expect(first).resolves.toEqual({ cancelled: true });

    const second = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'select', rect: { x: 1, y: 1, width: 2, height: 2 } });
    await expect(second).resolves.toEqual({ cancelled: true });
    expect(mocks.frame.crop).not.toHaveBeenCalled();
  });

  it('ignores results from foreign senders', async () => {
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    const overlay = await flushLoad();
    emitOverlayResult(999, { kind: 'select', rect: { x: 0, y: 0, width: 500, height: 500 } });
    expect(mocks.frame.crop).not.toHaveBeenCalled();
    // 覆盖层被关闭(用户 Alt-F4 等)→ 取消
    overlay.destroy();
    overlay.emit('closed');
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it('times out to cancelled when the user never finishes selecting', async () => {
    vi.useFakeTimers();
    try {
      const pending = captureRegionViaOverlay(1_000, 'drag to select', TEST_PALETTE);
      await vi.advanceTimersByTimeAsync(0); // flush load
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ cancelled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // Electron 不保证缩略图等于请求的 thumbnailSize: 裁剪按"实际帧/显示器 DIP"
  // 比例换算; 宽高比对不上说明帧不是这块屏, 拒绝(review P1)。
  it('maps selection by the actual frame-to-display ratio when thumbnail size differs', async () => {
    mocks.frame.getSize.mockReturnValueOnce({ width: 1920, height: 1080 });
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'select', rect: { x: 100, y: 40, width: 200, height: 100 } });
    await expect(pending).resolves.toMatchObject({ cancelled: false });
    // 1920/1280 = 1080/720 = 1.5
    expect(mocks.frame.crop).toHaveBeenCalledWith({ x: 150, y: 60, width: 300, height: 150 });
  });

  it('rejects frames whose aspect ratio cannot map to the display', async () => {
    mocks.frame.getSize.mockReturnValueOnce({ width: 2560, height: 1600 });
    await expect(captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE)).rejects.toThrow(
      'aspect ratio',
    );
  });

  it('throws when desktopCapturer yields no usable frame', async () => {
    mocks.getSources.mockResolvedValueOnce([]);
    await expect(captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE)).rejects.toThrow(
      'cannot match a capture source',
    );
  });

  // 帧源必须可靠对应覆盖层所在显示器: 多源且 display_id 无匹配(部分
  // Wayland 后端)时不猜 sources[0] —— 覆盖层在 A 屏展示/裁剪 B 屏内容会
  // 让用户不知情附上另一块屏幕(review P1)。单一源可安全使用。
  it('rejects unmatched multi-source displays but accepts a sole source without display_id', async () => {
    mocks.getSources.mockResolvedValueOnce([
      { display_id: '', thumbnail: mocks.frame },
      { display_id: '', thumbnail: mocks.frame },
    ]);
    await expect(captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE)).rejects.toThrow(
      'cannot match a capture source',
    );

    mocks.getSources.mockResolvedValueOnce([{ display_id: '', thumbnail: mocks.frame }]);
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'cancel' });
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  // 一次性覆盖层 renderer 崩溃必须立即收口: 不能让 captureInFlight 挡后续
  // 截图到总超时, 也不能让全屏冻结画面一直遮桌面(review P2)。
  it('rejects immediately when the overlay renderer crashes', async () => {
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    const overlay = await flushLoad();
    const goneListener = (overlay.webContents.on.mock.calls as unknown[][]).find(
      (c) => c[0] === 'render-process-gone',
    )?.[1] as ((event: unknown, details: { reason: string }) => void) | undefined;
    expect(goneListener).toBeDefined();
    goneListener?.({}, { reason: 'crashed' });
    await expect(pending).rejects.toThrow('overlay renderer gone');
    expect(overlay.destroyed).toBe(true);
  });

  // 唯一源兜底仅限"物理显示器也唯一": 多屏 Wayland/合并桌面后端可能只回
  // 一个空 display_id 的源(另一块屏或整张虚拟桌面), 不能当作光标所在屏
  // (review P1)。
  it('rejects a sole unmatched source when multiple physical displays exist', async () => {
    mocks.getSources.mockResolvedValueOnce([{ display_id: '', thumbnail: mocks.frame }]);
    mocks.getAllDisplays.mockReturnValueOnce([{ id: 7 }, { id: 8 }]);
    await expect(captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE)).rejects.toThrow(
      'cannot match a capture source',
    );
  });

  it('loads a self-contained data: URL with the dedicated minimal preload', async () => {
    const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    const overlay = await flushLoad();
    const url = String((overlay.loadURL.mock.calls as unknown[][])[0]?.[0]);
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url)).toContain('drag to select');
    // 主题配色透传进覆盖层样式(双模式, review P1)
    expect(decodeURIComponent(url)).toContain(TEST_PALETTE.scrim);
    expect(decodeURIComponent(url)).toContain(TEST_PALETTE.pillBg);
    expect(String(overlay.options.webPreferences && (overlay.options.webPreferences as { preload?: string }).preload)).toContain(
      'regionCaptureOverlayPreload.js',
    );
    emitOverlayResult(501, { kind: 'cancel' });
    await pending;
  });

  // IPC 不保留 TS 类型约束; 非法 payload 在 ipcMain.on 里抛异常会被 lifecycle
  // 视为 fatal 退出应用 —— 必须运行时校验并安全拒绝(review P1)。
  it('safely rejects malformed result payloads instead of throwing', async () => {
    for (const bad of [
      null,
      'select',
      { kind: 'select' },
      { kind: 'select', rect: null },
      { kind: 'select', rect: { x: Number.NaN, y: 0, width: 100, height: 100 } },
      { kind: 'select', rect: { x: 0, y: 0, width: Infinity, height: 100 } },
      { kind: 'select', rect: { x: '0', y: 0, width: 100, height: 100 } },
      { kind: 'unknown' },
    ]) {
      const pending = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
      await flushLoad();
      expect(() => emitOverlayResult(501, bad)).not.toThrow();
      await expect(pending).resolves.toEqual({ cancelled: true });
      expect(mocks.frame.crop).not.toHaveBeenCalled();
    }
  });

  it('clamps out-of-bounds selections and cancels fully out-of-frame ones', async () => {
    // 起点越过帧右缘 → 裁剪宽度非正 → 取消
    const outside = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'select', rect: { x: 5000, y: 0, width: 100, height: 100 } });
    await expect(outside).resolves.toEqual({ cancelled: true });
    expect(mocks.frame.crop).not.toHaveBeenCalled();

    // 尾部越界 → 夹到帧内
    const clamped = captureRegionViaOverlay(5_000, 'drag to select', TEST_PALETTE);
    await flushLoad();
    emitOverlayResult(501, { kind: 'select', rect: { x: 1200, y: 700, width: 200, height: 100 } });
    await expect(clamped).resolves.toMatchObject({ cancelled: false });
    expect(mocks.frame.crop).toHaveBeenCalledWith({ x: 2400, y: 1400, width: 160, height: 40 });
  });
});
