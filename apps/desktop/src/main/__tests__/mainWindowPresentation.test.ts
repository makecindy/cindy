/**
 * 测试价值
 * - 生产入口与可观察结果：presentMainWindow（托盘「打开 Cindy」、托盘激活、second-instance、
 *   activate 共用的 focusMainWindow 实现）；结果是合成器把主窗口重新显示给用户。
 * - Bug／规则依据：#6240，Ubuntu 24.04 GNOME Wayland 下托盘无法恢复已最小化的主窗口。
 * - 现有覆盖缺口：linuxTrayLifecycle.test.ts 只验证点击会调用 showWindow，不验证窗口能否回到屏幕。
 * - 最小失败输入：原生 Wayland 下 Electron 发起 minimize()，或合成器（Dock）最小化而 Electron
 *   不知情；旧实现只调用 show()/restore()/focus()，窗口仍留在最小化状态。
 * - tier：unit。按 GNOME 46 实测语义建模合成器，进程内完成，不需要真实桌面。
 * - 实测耗时：本机单独运行约 2 秒（pnpm --dir apps/desktop exec vitest run <本文件>）。
 */
import { describe, expect, it } from 'vitest';

import { isLinuxNativeWayland, presentMainWindow } from '../mainWindowPresentation';

type Backend = 'wayland' | 'x11';

/**
 * Compositor-visible state and Electron's own view, diverging the way they
 * do on GNOME 46 + Electron 42 (#6240):
 * - Wayland has no unminimize request: restore() only clears Electron's flag.
 * - A fresh map (hide + show) is placed and shown by the compositor.
 * - A compositor-side minimize is invisible to Electron on Wayland.
 */
function fakeWindow(backend: Backend) {
  const state = { mapped: true, compositorMinimized: false, electronMinimized: false, focused: true };
  const win = {
    isVisible: () => state.mapped && !state.electronMinimized,
    isMinimized: () => state.electronMinimized,
    isFocused: () => state.focused,
    show: () => {
      if (!state.mapped) {
        state.mapped = true;
        // A new map: Electron re-applies its own minimized state if still set.
        state.compositorMinimized = state.electronMinimized;
      } else if (backend === 'x11') {
        state.compositorMinimized = false;
        state.electronMinimized = false;
      }
    },
    hide: () => {
      state.mapped = false;
      state.focused = false;
    },
    restore: () => {
      state.electronMinimized = false;
      if (backend === 'x11') state.compositorMinimized = false;
    },
    focus: () => {
      // Without an activation token the compositor ignores focus on Wayland.
      if (backend === 'x11' && state.mapped && !state.compositorMinimized) state.focused = true;
    },
    minimizeFromApp: () => {
      state.electronMinimized = true;
      state.compositorMinimized = true;
      state.focused = false;
    },
    minimizeFromCompositor: () => {
      state.compositorMinimized = true;
      state.focused = false;
      if (backend === 'x11') state.electronMinimized = true;
    },
    onScreen: () => state.mapped && !state.compositorMinimized,
  };
  return win;
}

describe('presentMainWindow', () => {
  it.each([
    ['title-bar minimize', 'minimizeFromApp'],
    ['Dock / shortcut minimize', 'minimizeFromCompositor'],
  ] as const)('brings the window back on native Wayland after %s', (_label, minimize) => {
    const win = fakeWindow('wayland');
    win[minimize]();
    expect(win.onScreen()).toBe(false);

    presentMainWindow(win, { nativeWayland: true });

    expect(win.onScreen()).toBe(true);
    expect(win.isMinimized()).toBe(false);
  });

  it('does not re-map a window the user already has in front on Wayland', () => {
    const win = fakeWindow('wayland');
    let remapped = false;
    const hide = win.hide;
    win.hide = () => {
      remapped = true;
      hide();
    };

    presentMainWindow(win, { nativeWayland: true });

    expect(remapped).toBe(false);
    expect(win.onScreen()).toBe(true);
  });

  it('restores in place without re-mapping on X11', () => {
    const win = fakeWindow('x11');
    win.minimizeFromApp();
    win.hide = () => {
      throw new Error('X11 restore must not re-map the window');
    };

    presentMainWindow(win, { nativeWayland: false });

    expect(win.onScreen()).toBe(true);
    expect(win.isFocused()).toBe(true);
  });
});

describe('isLinuxNativeWayland', () => {
  it.each([
    ['linux', 'wayland', true],
    ['linux', 'x11', false],
    ['linux', '', false],
    ['darwin', 'wayland', false],
  ] as const)('%s with ozone-platform=%j -> %s', (platform, ozone, expected) => {
    expect(isLinuxNativeWayland(platform, ozone)).toBe(expected);
  });
});
