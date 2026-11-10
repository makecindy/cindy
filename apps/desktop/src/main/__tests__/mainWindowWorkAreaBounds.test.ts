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
  fitReplacementStartupBounds,
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

  // #9572 复审：贴满工作区的窗口从显示器 A 直接拖到同尺寸的 B，中间没有更小的正常矩形。
  // 保存库看到最大化标记就不更新坐标，下次启动仍在 A 上创建。
  // 生产入口：manageWindowStatePreservingNormalBounds。现有用例只有一块屏。
  // 最小输入：A 上记下 1280×800，live 直接变成 B 上的贴满矩形。keeper 读到的矩形必须落在 B
  // 的工作区内，随后的 close 把它写进持久化结果，并仍标成最大化。Tier: unit。
  it('moves the saved restore rectangle onto the display the filled window was dragged to', () => {
    const displayA = {
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 19, width: 1536, height: 845 },
    };
    const displayB = {
      bounds: { x: 1920, y: 0, width: 1536, height: 864 },
      workArea: { x: 1920, y: 19, width: 1536, height: 845 },
    };
    const twoScreens: WorkAreaScreen = {
      getPrimaryDisplay: () => displayA,
      getDisplayMatching: (rect) => (rect.x >= 1920 ? displayB : displayA),
    };
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean } =
      {};
    const seen: Array<{ x: number; y: number }> = [];
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            const bounds = read();
            seen.push({ x: bounds.x, y: bounds.y });
            const normal = !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
            if (normal) Object.assign(saved, bounds);
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('resize', write);
          win.on?.('close', write);
        },
      },
      window.win,
      twoScreens,
      'win32',
    );

    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds({ x: 0, y: 19, width: 1536, height: 845 });
    window.emit('resize');
    // Dragged straight onto the other monitor while still filling its work area.
    window.setBounds({ x: 1920, y: 19, width: 1536, height: 845 });
    window.emit('move');
    window.emit('close');

    const onB = seen.filter((bounds) => bounds.x >= 1920 && bounds.x < 1920 + 1536);
    expect(onB.length).toBeGreaterThan(0);
    expect(saved).toMatchObject({ x: 2048, y: 41, width: 1280, height: 800, isMaximized: true });
  });

  // #9572 复审：目标屏更矮时，把 1280×800 钳到正好等于 1280×680 的工作区，再带着最大化标记保存，
  // 重启后还原目标又是整块工作区。生产入口同上。最小输入：记下 1280×800，live 变成矮屏的贴满矩形。
  // 保存的宽高必须至少有一边严格小于工作区。Tier: unit。
  it('keeps the restore rectangle strictly inside a shorter display', () => {
    const tall = {
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 19, width: 1536, height: 845 },
    };
    const short = {
      bounds: { x: 1920, y: 0, width: 1280, height: 720 },
      workArea: { x: 1920, y: 40, width: 1280, height: 680 },
    };
    const screens: WorkAreaScreen = {
      getPrimaryDisplay: () => tall,
      getDisplayMatching: (rect) => (rect.x >= 1920 ? short : tall),
    };
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean } =
      {};
    manageWindowStatePreservingNormalBounds(
      {
        // updateState reads the rectangle, then isMaximized(). A relocated size is
        // handed over as normal once and maximized on the following read, so the
        // stand-in reads twice, the same way a resize and the later close do.
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            const normal = !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
            if (normal) Object.assign(saved, read());
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('resize', write);
          win.on?.('close', () => {
            write();
            write();
          });
        },
      },
      window.win,
      screens,
      'win32',
    );

    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds(short.workArea);
    window.emit('move');
    window.emit('close');

    expect(saved.isMaximized).toBe(true);
    expect(saved.x).toBeGreaterThanOrEqual(short.workArea.x);
    expect(saved.y).toBeGreaterThanOrEqual(short.workArea.y);
    expect((saved.width ?? 0) < short.workArea.width || (saved.height ?? 0) < short.workArea.height).toBe(
      true,
    );
    expect(
      planWindowRestore(
        {
          x: saved.x ?? 0,
          y: saved.y ?? 0,
          width: saved.width ?? 0,
          height: saved.height ?? 0,
          isMaximized: true,
        },
        screens,
        { platform: 'win32' },
      ),
    ).toEqual({ restoreMaximized: true, replaceWithDefaultSize: false });
  });

  // #9572 复审：副屏断开后，屏外的保留矩形也会被 getDisplayMatching 配到幸存屏，于是被当成同一块屏
  // 而不重定位，下次启动的坐标还在已消失的屏幕上。最小输入：保留矩形完全在幸存屏左侧之外。Tier: unit。
  it('relocates a restore rectangle whose display has disconnected', () => {
    const surviving = {
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 19, width: 1536, height: 845 },
    };
    const onlyScreen: WorkAreaScreen = {
      getPrimaryDisplay: () => surviving,
      getDisplayMatching: () => surviving,
    };
    const window = createWindow({ x: -1800, y: 40, width: 1280, height: 800 });
    const saved: { x?: number; y?: number; width?: number; height?: number } = {};
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
              Object.assign(saved, read());
            }
          };
          win.on?.('resize', write);
          win.on?.('close', write);
        },
      },
      window.win,
      onlyScreen,
      'win32',
    );

    window.win.isSnapped = () => true;
    window.setBounds(surviving.workArea);
    window.emit('move');
    window.emit('close');

    expect(saved.x).toBeGreaterThanOrEqual(surviving.workArea.x);
    expect(saved.y).toBeGreaterThanOrEqual(surviving.workArea.y);
    expect((saved.x ?? 0) + (saved.width ?? 0)).toBeLessThanOrEqual(
      surviving.workArea.x + surviving.workArea.width,
    );
    expect((saved.y ?? 0) + (saved.height ?? 0)).toBeLessThanOrEqual(
      surviving.workArea.y + surviving.workArea.height,
    );
  });

  // #9572 复审：工作区高 640、记下的高 800。留 64px 空隙得到 576，但窗口最小高度是 600，
  // 下次启动会被抬回 600，按 576 算的 y 让底边落到任务栏下面。生产入口同上。
  // 最小输入：矮到刚能放下 600 的工作区。保存高度必须不低于 600，底边不超出工作区。Tier: unit。
  it('keeps the window minimum when a short display can still hold it', () => {
    const tall = {
      bounds: { x: 0, y: 0, width: 1536, height: 864 },
      workArea: { x: 0, y: 19, width: 1536, height: 845 },
    };
    const short = {
      bounds: { x: 1920, y: 0, width: 1280, height: 680 },
      workArea: { x: 1920, y: 40, width: 1280, height: 640 },
    };
    const screens: WorkAreaScreen = {
      getPrimaryDisplay: () => tall,
      getDisplayMatching: (rect) => (rect.x >= 1920 ? short : tall),
    };
    const window = createWindow({ x: 128, y: 41, width: 1280, height: 800 });
    const saved: { x?: number; y?: number; width?: number; height?: number } = {};
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
              Object.assign(saved, read());
            }
          };
          win.on?.('resize', write);
          win.on?.('close', () => {
            write();
            write();
          });
        },
      },
      window.win,
      screens,
      'win32',
    );

    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds(short.workArea);
    window.emit('move');
    window.emit('close');

    expect(saved.height).toBeGreaterThanOrEqual(600);
    expect(saved.height).toBeLessThan(short.workArea.height);
    expect((saved.y ?? 0) + (saved.height ?? 0)).toBeLessThanOrEqual(
      short.workArea.y + short.workArea.height,
    );
  });

  // #9572 复审：1279×679 落在 1280×680 里面，差 1px，早退会原样保留。贴满判断的容差是 2px，
  // 这条仍会被记成最大化，planWindowRestore 于是跳过替换。生产入口同上。
  // 最小输入：宽高都只比工作区少 1px。保存结果不能原样留下，也不能再被 2px 容差判成贴满。
  // Tier: unit。
  it('shrinks a restore rectangle that is only one pixel short of the work area', () => {
    const screen = {
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      workArea: { x: 0, y: 0, width: 1280, height: 680 },
    };
    const screens: WorkAreaScreen = {
      getPrimaryDisplay: () => screen,
      getDisplayMatching: () => screen,
    };
    const window = createWindow({ x: 0, y: 0, width: 1279, height: 679 });
    const saved: { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean } =
      {};
    manageWindowStatePreservingNormalBounds(
      {
        manage: (win) => {
          const read = win.getBounds.bind(win);
          const write = () => {
            const normal = !win.isMaximized() && !win.isMinimized() && !win.isFullScreen();
            if (normal) Object.assign(saved, read());
            saved.isMaximized = win.isMaximized();
          };
          win.on?.('resize', write);
          win.on?.('close', () => {
            write();
            write();
          });
        },
      },
      window.win,
      screens,
      'win32',
    );

    window.emit('resize');
    window.win.isSnapped = () => true;
    window.setBounds(screen.workArea);
    window.emit('move');
    window.emit('close');

    expect(saved).not.toMatchObject({ width: 1279, height: 679 });
    expect(
      boundsFillWorkArea(
        {
          x: saved.x ?? 0,
          y: saved.y ?? 0,
          width: saved.width ?? 0,
          height: saved.height ?? 0,
        },
        screen.workArea,
      ),
    ).toBe(false);
  });
});

describe('fitReplacementStartupBounds', () => {
  // #9572 复审：启动替换分支用默认 1280×800 加保存的 x/y 直接建窗口。工作区高 680 时底边落到
  // 任务栏下面，紧接着的保存把这个超尺寸矩形写成取消最大化的还原目标。
  // 生产入口：fitReplacementStartupBounds，bootstrap 只在 replaceWithDefaultSize 时调用。
  // 最小输入：1280×680 工作区、默认 1280×800。高度必须不低于 600 且小于 680，底边不超出。
  // Tier: unit。
  it('shrinks the default startup size onto a short work area without going under the minimum', () => {
    const workArea = { x: 0, y: 40, width: 1280, height: 680 };
    const fitted = fitReplacementStartupBounds(
      { x: 0, y: 40 },
      { width: 1280, height: 800 },
      workArea,
    );

    expect(fitted.height).toBeGreaterThanOrEqual(600);
    expect(fitted.height).toBeLessThan(workArea.height);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    expect(fitted.x).toBeGreaterThanOrEqual(workArea.x);
    expect(fitted.width).toBeLessThanOrEqual(workArea.width);
  });

  // #9572 复审：工作区正好等于默认尺寸时，原样创建就是贴满，取消最大化没有更小的尺寸可去。
  // 最小输入：1280×800 工作区、默认 1280×800。结果必须落在工作区内，且不能正好等于工作区。
  // Tier: unit。
  it('does not recreate the work area when the default size already equals it', () => {
    const workArea = { x: 100, y: 20, width: 1280, height: 800 };
    const fitted = fitReplacementStartupBounds(
      { x: 100, y: 20 },
      { width: 1280, height: 800 },
      workArea,
    );

    expect(fitted.x).toBeGreaterThanOrEqual(workArea.x);
    expect(fitted.y).toBeGreaterThanOrEqual(workArea.y);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(workArea.x + workArea.width);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(workArea.y + workArea.height);
    expect(fitted.width === workArea.width && fitted.height === workArea.height).toBe(false);
  });
});
