import { describe, expect, it, vi } from 'vitest';

import { installWindowMaximizeStateBroadcast } from '../windowMaximizeState';

// 测试价值
// - 生产入口与可观察结果:installWindowMaximizeStateBroadcast 在窗口 maximize /
//   unmaximize 时向本窗口 webContents 推送 window-maximize-state-changed 与当前
//   isMaximized 布尔值;标题栏按钮据此刻画最大化/还原图标。
// - Bug/规则依据:engineering-conventions §3「main 侧业务逻辑默认带测试」;payload
//   取错(如固定 true)或销毁后继续推送都会让还原指示失真或报错。
// - 现有覆盖缺口:新增广播模块,此前无覆盖;fullscreen 同型广播的测试在
//   mainWindowFullscreenStartup.test.ts,本模块无对应文件。
// - 最小失败输入:窗口 emit maximize / unmaximize;窗口或 webContents 已销毁。
// - tier:unit(进程内 fake,无 Electron 运行时)。

type BroadcastWindow = Parameters<typeof installWindowMaximizeStateBroadcast>[0];

function createFakeWindow(initialMaximized = false) {
  const listeners = new Map<string, () => void>();
  const win = {
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => initialMaximized),
    maximizedValue: initialMaximized,
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return win;
    }),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
    emit(event: string) {
      listeners.get(event)?.();
    },
    setMaximized(value: boolean) {
      win.maximizedValue = value;
      win.isMaximized.mockReturnValue(value);
    },
  };
  return win as unknown as typeof win & BroadcastWindow;
}

describe('installWindowMaximizeStateBroadcast', () => {
  const CHANNEL = 'window-maximize-state-changed';

  it('pushes the live isMaximized state on maximize and unmaximize', () => {
    const win = createFakeWindow(false);
    installWindowMaximizeStateBroadcast(win);

    win.setMaximized(true);
    win.emit('maximize');
    expect(win.webContents.send).toHaveBeenLastCalledWith(CHANNEL, true);
    win.setMaximized(false);
    win.emit('unmaximize');
    expect(win.webContents.send).toHaveBeenLastCalledWith(CHANNEL, false);
  });

  it('does not publish once the window or its webContents is destroyed', () => {
    const win = createFakeWindow(true);
    installWindowMaximizeStateBroadcast(win);

    win.isDestroyed.mockReturnValue(true);
    win.emit('maximize');
    expect(win.webContents.send).not.toHaveBeenCalled();

    win.isDestroyed.mockReturnValue(false);
    win.webContents.isDestroyed.mockReturnValue(true);
    win.emit('maximize');
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
