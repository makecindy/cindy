/**
 * 测试价值
 * - 生产入口与可观察结果：shouldTreatPersistedBoundsAsMaximized /
 *   normalBoundsForPersistence / manageWindowStatePreservingNormalBounds。启动是否把已存的
 *   伪最大化当成真正最大化；保存时是否仍写上一次正常还原尺寸，同时把贴满工作区记成最大化。
 * - Bug／规则依据：issue #9461。Windows Snap 把「贴满工作区但 IsZoomed=false」写进
 *   window-state.json 后，最大化按钮无可见变化，任务栏自动隐藏失效。展开 BrowserWindow
 *   会丢掉原型上的 isMaximized，移动或保存时抛错；只保留旧尺寸、不写最大化标记，则下次
 *   启动缩回贴满之前的小窗口。
 * - 现有覆盖缺口：mainWindowMaximizeRecovery 只处理显示器抖动导致的取消最大化，
 *   不识别工作区矩形。已有用例把窗口方法定义成对象自身属性，且没有「保存后再读启动状态」。
 * - 最小失败输入：isMaximized=false 且 x/y/width/height 与 workArea 相差 ≤2px；或方法只在
 *   原型上、保存时 isMaximized() 仍为 false。
 * - tier：unit。纯函数，不启 Electron。
 */
import { describe, expect, it } from 'vitest';

import {
  boundsFillWorkArea,
  manageWindowStatePreservingNormalBounds,
  normalBoundsForPersistence,
  planWindowRestore,
  shouldTreatPersistedBoundsAsMaximized,
  type PersistableWindow,
  type WorkAreaScreen,
} from '../mainWindowWorkAreaBounds';

const workArea = { x: 0, y: 19, width: 1536, height: 845 };
const display = {
  bounds: { x: 0, y: 0, width: 1536, height: 864 },
  workArea,
};
const screenApi: WorkAreaScreen = {
  getPrimaryDisplay: () => display,
  getDisplayMatching: () => display,
};

describe('shouldTreatPersistedBoundsAsMaximized', () => {
  it('treats a non-maximized work-area rectangle as maximized on Windows', () => {
    // issue #9461: width/height match the work area, isMaximized is false.
    expect(
      shouldTreatPersistedBoundsAsMaximized(
        { x: 2, y: 19, width: 1537, height: 846, isMaximized: false },
        screenApi,
        'win32',
      ),
    ).toBe(true);
  });

  it('leaves a normal window, an already maximized window, and other platforms alone', () => {
    const cases = [
      {
        state: { x: 128, y: 41, width: 1280, height: 800, isMaximized: false },
        platform: 'win32' as const,
        expected: false,
      },
      {
        state: { x: 0, y: 19, width: 1536, height: 845, isMaximized: true },
        platform: 'win32' as const,
        expected: false,
      },
      {
        state: { x: 0, y: 19, width: 1536, height: 845, isFullScreen: true },
        platform: 'win32' as const,
        expected: false,
      },
      {
        state: { x: 0, y: 19, width: 1536, height: 845, isMaximized: false },
        platform: 'darwin' as const,
        expected: false,
      },
    ];
    for (const { state, platform, expected } of cases) {
      expect(shouldTreatPersistedBoundsAsMaximized(state, screenApi, platform)).toBe(expected);
    }
  });
});

describe('normalBoundsForPersistence', () => {
  const previous = { x: 128, y: 41, width: 1280, height: 800 };

  it('keeps the previous restore size while the window fills the work area', () => {
    const win = {
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isSnapped: () => true,
      getBounds: () => ({ x: 0, y: 19, width: 1536, height: 845 }),
    };
    expect(normalBoundsForPersistence(win, previous, screenApi, 'win32')).toEqual(previous);
  });

  it('keeps the previous size when bounds fill the work area even if isSnapped is false', () => {
    const win = {
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isSnapped: () => false,
      getBounds: () => ({ x: 0, y: 19, width: 1536, height: 846 }),
    };
    expect(normalBoundsForPersistence(win, previous, screenApi, 'win32')).toEqual(previous);
  });

  it('returns null for a normal, maximized, or non-Windows window', () => {
    expect(
      normalBoundsForPersistence(
        {
          isMaximized: () => false,
          isMinimized: () => false,
          isFullScreen: () => false,
          getBounds: () => previous,
        },
        previous,
        screenApi,
        'win32',
      ),
    ).toBeNull();
    expect(
      normalBoundsForPersistence(
        {
          isMaximized: () => true,
          isMinimized: () => false,
          isFullScreen: () => false,
          isSnapped: () => true,
          getBounds: () => ({ x: 0, y: 19, width: 1536, height: 845 }),
        },
        previous,
        screenApi,
        'win32',
      ),
    ).toBeNull();
    expect(
      normalBoundsForPersistence(
        {
          isMaximized: () => false,
          isMinimized: () => false,
          isFullScreen: () => false,
          isSnapped: () => true,
          getBounds: () => ({ x: 0, y: 19, width: 1536, height: 845 }),
        },
        previous,
        screenApi,
        'darwin',
      ),
    ).toBeNull();
  });

  it('does not invent a restore size when nothing normal was seen yet', () => {
    const current = { x: 0, y: 19, width: 1536, height: 845 };
    expect(
      normalBoundsForPersistence(
        {
          isMaximized: () => false,
          isMinimized: () => false,
          isFullScreen: () => false,
          isSnapped: () => true,
          getBounds: () => current,
        },
        null,
        screenApi,
        'win32',
      ),
    ).toEqual(current);
    expect(boundsFillWorkArea({ x: 0, y: 19, width: 1400, height: 845 }, workArea)).toBe(false);
  });

  it('leaves a half-screen snap at its own size instead of marking it maximized', () => {
    const half = { x: 0, y: 19, width: 768, height: 845 };
    const win = {
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isSnapped: () => true,
      getBounds: () => half,
    };
    expect(normalBoundsForPersistence(win, previous, screenApi, 'win32')).toBeNull();
  });
});

describe('manageWindowStatePreservingNormalBounds', () => {
  function createWindow(initial: { x: number; y: number; width: number; height: number }) {
    let bounds = { ...initial };
    const listeners = new Map<string, Array<() => void>>();
    const win: PersistableWindow & { on(event: string, listener: () => void): void } = {
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isSnapped: () => false,
      getBounds: () => bounds,
      on: (event, listener) => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      },
    };
    return {
      win,
      setBounds: (next: typeof bounds) => {
        bounds = next;
      },
      emit: (event: string) => {
        for (const listener of listeners.get(event) ?? []) listener();
      },
    };
  }

  it('gives the keeper the last normal size while snapped without replacing getBounds', () => {
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const liveGetBounds = window.win.getBounds;
    const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
    manageWindowStatePreservingNormalBounds(
      {
        // electron-window-state binds getBounds once, then calls the bound function.
        manage: (win) => {
          const read = win.getBounds.bind(win);
          win.on?.('resize', () => seen.push(read()));
          win.on?.('close', () => seen.push(read()));
        },
      },
      window.win,
      screenApi,
      'win32',
    );

    window.win.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    window.emit('resize');
    window.emit('close');
    expect(seen).toEqual([
      { x: 128, y: 41, width: 1280, height: 800 },
      { x: 128, y: 41, width: 1280, height: 800 },
    ]);
    // The real window is never patched, so other callers keep the live rectangle.
    expect(window.win.getBounds).toBe(liveGetBounds);
    expect(window.win.getBounds()).toEqual({ x: 0, y: 19, width: 1536, height: 845 });
  });

  it('remembers a later normal size after the user restores and resizes', () => {
    const window = createWindow({ x: 0, y: 19, width: 1536, height: 845 });
    window.win.isSnapped = () => true;
    const seen: Array<{ width: number }> = [];
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          win.on?.('resize', () => seen.push(read()));
        },
      },
      window.win,
      screenApi,
      'win32',
    );

    window.win.isSnapped = () => false;
    window.setBounds({ x: 40, y: 40, width: 1100, height: 720 });
    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    window.emit('resize');
    expect(seen.map((bounds) => bounds.width)).toEqual([1100, 1100]);
  });

  it('forwards prototype methods instead of spreading them off the window', () => {
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const proto = {
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      isSnapped: () => false,
    };
    const bare = Object.create(proto) as PersistableWindow & {
      getBounds(): { x: number; y: number; width: number; height: number };
      on(event: string, listener: () => void): void;
    };
    bare.getBounds = window.win.getBounds;
    bare.on = window.win.on;
    window.win = bare;
    expect(Object.hasOwn(window.win, 'isMaximized')).toBe(false);

    const managed: PersistableWindow[] = [];
    manageWindowStatePreservingNormalBounds(
      { manage: (win) => managed.push(win) },
      window.win,
      screenApi,
      'win32',
    );

    proto.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    expect(() => managed[0]?.isMaximized()).not.toThrow();
    expect(managed[0]?.isMaximized()).toBe(true);
    expect(managed[0]?.getBounds()).toEqual({ x: 128, y: 41, width: 1280, height: 800 });
    expect(window.win.getBounds()).toEqual({ x: 0, y: 19, width: 1536, height: 845 });
  });

  it('persists maximize intent with the old size, then restores maximized on relaunch', () => {
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      isMaximized?: boolean;
    } = {};
    manageWindowStatePreservingNormalBounds(
      {
        // Same write electron-window-state does: normal bounds only while isNormal,
        // and isMaximized from the object handed to manage().
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            const bounds = read();
            const normal = !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
            if (normal) Object.assign(saved, bounds);
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('resize', write);
          win.on?.('close', write);
        },
      },
      window.win,
      screenApi,
      'win32',
    );

    // Created at the last normal size. The first resize records it before the user snaps.
    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    window.emit('resize');
    window.emit('close');

    expect(saved).toMatchObject({
      x: 128,
      y: 41,
      width: 1280,
      height: 800,
      isMaximized: true,
    });
    expect(window.win.isMaximized()).toBe(false);
    // The saved normal rectangle no longer fills the work area, so only the
    // maximize flag (not the old rectangle heuristic) brings it back maximized.
    expect(
      shouldTreatPersistedBoundsAsMaximized(
        {
          x: saved.x ?? 0,
          y: saved.y ?? 0,
          width: saved.width ?? 0,
          height: saved.height ?? 0,
          isMaximized: false,
        },
        screenApi,
        'win32',
      ),
    ).toBe(false);

    const relaunch = planWindowRestore(
      {
        x: saved.x ?? 0,
        y: saved.y ?? 0,
        width: saved.width ?? 0,
        height: saved.height ?? 0,
        isMaximized: saved.isMaximized,
      },
      screenApi,
      { platform: 'win32' },
    );
    expect(relaunch).toEqual({ restoreMaximized: true, replaceWithDefaultSize: false });
  });

  it('keeps the maximize intent when a filled window is minimized and then quit', () => {
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: { width?: number; isMaximized?: boolean } = {};
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            const normal = !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
            if (normal) saved.width = read().width;
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('resize', write);
          win.on?.('close', write);
        },
      },
      window.win,
      screenApi,
      'win32',
    );

    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    window.emit('resize');
    // Minimizing reports the pre-snap rectangle. Without a remembered intent the
    // close below would persist that small size with isMaximized false.
    window.win.isMinimized = () => true;
    window.setBounds({ x: 128, y: 41, width: 1280, height: 800 });
    window.emit('close');

    expect(saved).toEqual({ width: 1280, isMaximized: true });
    expect(
      planWindowRestore(
        { x: 128, y: 41, width: 1280, height: 800, isMaximized: saved.isMaximized },
        screenApi,
        { platform: 'win32' },
      ).restoreMaximized,
    ).toBe(true);
  });

  it('does not mark a normal window maximized just because it was minimized', () => {
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: { width?: number; isMaximized?: boolean } = {};
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
              saved.width = read().width;
            }
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('close', write);
        },
      },
      window.win,
      screenApi,
      'win32',
    );

    window.win.isMinimized = () => true;
    window.emit('close');
    expect(saved).toEqual({ isMaximized: false });
  });
});
