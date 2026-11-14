// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowControls } from '@/components/title-bar/WindowControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it('auxiliary close overrides do not require the main-window behavior bridge', () => {
  const close = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable:true, value:{platform:'win32'} });
  render(<WindowControls onClose={close} />);
  fireEvent.click(screen.getByRole('button', {name:'titleBar.close'}));
  expect(close).toHaveBeenCalledOnce();
});

function installWindowsApi(closeBehavior: 'quit' | 'tray' | null) {
  let closeBehaviorRequested: (() => void) | null = null;
  const getWindowsCloseBehavior = vi.fn(async () => closeBehavior);
  const setWindowsCloseBehavior = vi.fn(async (behavior: 'quit' | 'tray') => behavior);
  const onWindowsCloseBehaviorRequested = vi.fn((callback: () => void) => {
    closeBehaviorRequested = callback;
    return vi.fn();
  });
  const notifyWindowsCloseBehaviorPromptShown = vi.fn();
  const anySessionInTurn = vi.fn(async () => false);
  const windowClose = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      windowBehavior: {
        getWindowsCloseBehavior,
        setWindowsCloseBehavior,
        onWindowsCloseBehaviorRequested,
        notifyWindowsCloseBehaviorPromptShown,
      },
      anySessionInTurn,
      windowClose,
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
    } as unknown as Window['electronAPI'],
  });
  return {
    getWindowsCloseBehavior,
    setWindowsCloseBehavior,
    onWindowsCloseBehaviorRequested,
    notifyWindowsCloseBehaviorPromptShown,
    anySessionInTurn,
    windowClose,
    requestCloseBehavior: () => closeBehaviorRequested?.(),
  };
}

function installLinuxApi(closeBehavior: 'quit' | 'minimize' | null) {
  let closeBehaviorRequested: (() => void) | null = null;
  const getLinuxCloseBehavior = vi.fn(async () => closeBehavior);
  const setLinuxCloseBehavior = vi.fn(async (behavior: 'quit' | 'minimize') => behavior);
  const onLinuxCloseBehaviorRequested = vi.fn((callback: () => void) => {
    closeBehaviorRequested = callback;
    return vi.fn();
  });
  const notifyLinuxCloseBehaviorPromptShown = vi.fn();
  const anySessionInTurn = vi.fn(async () => false);
  const windowClose = vi.fn();
  const windowMinimize = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowBehavior: {
        getLinuxCloseBehavior,
        setLinuxCloseBehavior,
        onLinuxCloseBehaviorRequested,
        notifyLinuxCloseBehaviorPromptShown,
      },
      anySessionInTurn,
      windowClose,
      windowMinimize,
      windowMaximize: vi.fn(),
    } as unknown as Window['electronAPI'],
  });
  return {
    getLinuxCloseBehavior,
    setLinuxCloseBehavior,
    onLinuxCloseBehaviorRequested,
    notifyLinuxCloseBehaviorPromptShown,
    anySessionInTurn,
    windowClose,
    windowMinimize,
    requestCloseBehavior: () => closeBehaviorRequested?.(),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  delete (window as Partial<Window>).electronAPI;
});

describe.each(['win32', 'linux'] as const)('%s close prompt dismissal', (platform) => {
  it.each(['button', 'escape'] as const)('cancels via %s without saving or closing, and can reopen', async (method) => {
    const api = platform === 'win32' ? installWindowsApi(null) : installLinuxApi(null);
    render(<WindowControls />);
    act(() => api.requestCloseBehavior());
    await screen.findByRole('alertdialog');

    if (method === 'button') {
      fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    } else {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    }

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const setBehavior = 'setWindowsCloseBehavior' in api ? api.setWindowsCloseBehavior : api.setLinuxCloseBehavior;
    expect(setBehavior).not.toHaveBeenCalled();
    expect(api.windowClose).not.toHaveBeenCalled();
    expect(window.electronAPI.windowMinimize).not.toHaveBeenCalled();
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
    act(() => api.requestCloseBehavior());
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });

  it('keeps the prompt open while saving and permits dismissal after a failed save', async () => {
    const api = platform === 'win32' ? installWindowsApi(null) : installLinuxApi(null);
    let rejectSave!: (error: Error) => void;
    const setBehavior = 'setWindowsCloseBehavior' in api ? api.setWindowsCloseBehavior : api.setLinuxCloseBehavior;
    setBehavior.mockImplementation(() => new Promise<never>((_resolve, reject) => { rejectSave = reject; }));
    render(<WindowControls />);
    act(() => api.requestCloseBehavior());
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.quit' }));
    const dismiss = screen.getByRole('button', { name: 'common.dismiss' }) as HTMLButtonElement;
    expect(dismiss.disabled).toBe(true);
    fireEvent.click(dismiss);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => rejectSave(new Error('failed')));
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.windowClose).not.toHaveBeenCalled();
  });
});

describe('Windows close behavior', () => {
  it('uses the default minimize action when no override is provided', () => {
    installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));

    expect(window.electronAPI.windowMinimize).toHaveBeenCalledTimes(1);
  });

  it('uses a window-specific minimize action when provided', () => {
    installWindowsApi(null);
    const onMinimize = vi.fn();
    render(<WindowControls onMinimize={onMinimize} />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.minimize' }));

    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.windowMinimize).not.toHaveBeenCalled();
  });

  it('hides minimize when the current surface opts out', () => {
    installWindowsApi(null);
    render(<WindowControls showMinimize={false} />);

    expect(screen.queryByRole('button', { name: 'titleBar.minimize' })).toBeNull();
  });

  it('does not subscribe to main-window close requests from a secondary window', () => {
    window.history.replaceState({}, '', '/?secondaryWindow=1');
    const api = installWindowsApi(null);

    render(<WindowControls />);

    expect(api.onWindowsCloseBehaviorRequested).not.toHaveBeenCalled();
  });

  it('closes to the tray without showing the quit protection flow', async () => {
    const api = installWindowsApi('tray');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.getWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing quit protection flow when quit is selected', async () => {
    const api = installWindowsApi('quit');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.getWindowsCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).toHaveBeenCalledTimes(1);
  });

  it('uses the Cindy dialog for the first close and persists the safe tray choice', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.tray' }),
    );

    await waitFor(() => expect(api.setWindowsCloseBehavior).toHaveBeenCalledWith('tray'));
    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('opens the same dialog for a native Windows close request', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    act(() => api.requestCloseBehavior());

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledOnce());
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.quit' }),
    );

    await waitFor(() => expect(api.setWindowsCloseBehavior).toHaveBeenCalledWith('quit'));
    await waitFor(() => expect(api.anySessionInTurn).toHaveBeenCalledTimes(1));
    expect(api.windowClose).toHaveBeenCalledTimes(1);
  });

  it('acknowledges another native close request while the custom dialog is already visible', async () => {
    const api = installWindowsApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledOnce());

    act(() => api.requestCloseBehavior());

    expect(api.notifyWindowsCloseBehaviorPromptShown).toHaveBeenCalledTimes(2);
  });
});

describe('Linux close behavior', () => {
  it('minimizes immediately when the saved behavior is minimize', async () => {
    const api = installLinuxApi('minimize');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowMinimize).toHaveBeenCalledTimes(1));
    expect(api.getLinuxCloseBehavior).toHaveBeenCalledTimes(1);
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
    expect(api.windowClose).not.toHaveBeenCalled();
  });

  it('uses the Cindy dialog for the first close and persists the minimize choice', async () => {
    const api = installLinuxApi(null);
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    expect(screen.getByText('settings.windowBehavior.closePrompt.linuxDetail')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.windowBehavior.closeBehavior.minimize' }),
    );

    await waitFor(() => expect(api.setLinuxCloseBehavior).toHaveBeenCalledWith('minimize'));
    await waitFor(() => expect(api.windowMinimize).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).not.toHaveBeenCalled();
  });

  it('keeps the existing quit protection flow when quit is selected', async () => {
    const api = installLinuxApi('quit');
    render(<WindowControls />);

    fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));

    await waitFor(() => expect(api.windowClose).toHaveBeenCalledTimes(1));
    expect(api.anySessionInTurn).toHaveBeenCalledTimes(1);
    expect(api.windowMinimize).not.toHaveBeenCalled();
  });

  it('opens the same dialog for a native Linux close request', async () => {
    const api = installLinuxApi(null);
    render(<WindowControls />);

    act(() => api.requestCloseBehavior());

    expect(await screen.findByText('settings.windowBehavior.closePrompt.title')).toBeTruthy();
    await waitFor(() => expect(api.notifyLinuxCloseBehaviorPromptShown).toHaveBeenCalledOnce());
  });
});

// 测试价值
// - 生产入口与可观察结果:WindowControls 挂载时查询 getMaximizeState 并订阅
//   onMaximizeStateChange;标题栏最大化按钮的图标随窗口最大化状态在
//   lucide-square(最大化)与 lucide-copy(还原)间切换,桥缺失时回退最大化图标。
// - Bug/规则依据:用户可见缺口 —— 还原此前没有任何视觉入口(§3.2 结果差异:
//   最大化态下图标与点击语义不符)。
// - 现有覆盖缺口:本文件此前只覆盖关闭路径,最大化状态分支无覆盖。
// - 最小失败输入:挂载查询返回 true / 推送 false / electronAPI 缺两个新方法。
// - tier:unit(jsdom;断言渲染出的图标需要 DOM,与被测组件同文件)。

function installMaximizeApi(initialMaximized: boolean) {
  const sink: { push: ((value: boolean) => void) | null } = { push: null };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'win32',
      windowMinimize: vi.fn(),
      windowMaximize: vi.fn(),
      windowClose: vi.fn(),
      windowBehavior: { onWindowsCloseBehaviorRequested: () => () => {} },
      getMaximizeState: vi.fn(async () => initialMaximized),
      onMaximizeStateChange: vi.fn((callback: (value: boolean) => void) => {
        sink.push = callback;
        return () => {
          sink.push = null;
        };
      }),
    } as unknown as Window['electronAPI'],
  });
  return {
    pushMaximizeState: (value: boolean) => {
      act(() => sink.push?.(value));
    },
  };
}

describe('title-bar maximize⇄restore affordance', () => {
  it('starts from the queried state and follows push updates', async () => {
    const api = installMaximizeApi(true);
    render(<WindowControls />);
    const button = () => screen.getByRole('button', { name: 'titleBar.maximizeOrRestore' });

    await waitFor(() => expect(button().querySelector('.lucide-copy')).toBeTruthy());
    expect(button().querySelector('.lucide-square')).toBeNull();

    api.pushMaximizeState(false);
    await waitFor(() => expect(button().querySelector('.lucide-square')).toBeTruthy());
    expect(button().querySelector('.lucide-copy')).toBeNull();

    api.pushMaximizeState(true);
    await waitFor(() => expect(button().querySelector('.lucide-copy')).toBeTruthy());
  });

  it('falls back to the maximize icon when the bridge is missing', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        windowMinimize: vi.fn(),
        windowMaximize: vi.fn(),
        windowClose: vi.fn(),
        windowBehavior: { onWindowsCloseBehaviorRequested: () => () => {} },
      } as unknown as Window['electronAPI'],
    });
    render(<WindowControls />);
    const button = screen.getByRole('button', { name: 'titleBar.maximizeOrRestore' });

    expect(button.querySelector('.lucide-square')).toBeTruthy();
    expect(button.querySelector('.lucide-copy')).toBeNull();
  });
});
