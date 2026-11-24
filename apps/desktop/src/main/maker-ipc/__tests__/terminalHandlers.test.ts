import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcMainInvokeEvent, WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  managerCreate: vi.fn(() => ({ shellId: 'bash', shellDisplayName: 'Bash', pid: 123 })),
  getDefaultShellPref: vi.fn(() => 'bash' as const),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
}));

vi.mock('../../terminal/terminalService.desktop.js', () => ({
  getDesktopHostTerminalService: () => ({ bindUi: vi.fn(), manager: { create: mocks.managerCreate } }),
}));

vi.mock('../../terminal/shellResolver.js', () => ({
  probeAvailableShells: vi.fn(() => []),
}));

vi.mock('../../terminal/terminalPrefsStore.js', () => ({
  getDefaultShellPref: mocks.getDefaultShellPref,
  setDefaultShellPref: vi.fn(),
}));

import { TERMINAL_INVOKE } from '../channels';
import { registerTerminalHandlers } from '../terminal-handlers';

type InvokeHandler = (event: IpcMainInvokeEvent, params: unknown) => unknown;

function createHandler(): InvokeHandler {
  const call = mocks.ipcHandle.mock.calls.find(([channel]) => channel === TERMINAL_INVOKE.CREATE);
  if (!call) throw new Error('terminal:create handler was not registered');
  return call[1] as InvokeHandler;
}

function invokeCreate(params: Record<string, unknown>): unknown {
  const sender = { isDestroyed: () => false } as unknown as WebContents;
  return createHandler()({ sender } as IpcMainInvokeEvent, params);
}

describe('terminal CREATE shell preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTerminalHandlers();
  });

  it('resolves an omitted shellPref from the persisted main-process default', () => {
    invokeCreate({ id: 'terminal-1', cwd: '/tmp' });

    expect(mocks.getDefaultShellPref).toHaveBeenCalledOnce();
    expect(mocks.managerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'terminal-1', shellPref: 'bash' }),
    );
  });

  it.each(['auto', 'zsh', null] as const)(
    'preserves an explicit shellPref (%s) without reading the global default',
    (shellPref) => {
      invokeCreate({ id: 'terminal-explicit', cwd: '/tmp', shellPref });

      expect(mocks.getDefaultShellPref).not.toHaveBeenCalled();
      expect(mocks.managerCreate).toHaveBeenCalledWith(
        expect.objectContaining({ shellPref }),
      );
    },
  );

  it('rejects an invalid explicit shellPref before spawning', () => {
    expect(() =>
      invokeCreate({ id: 'terminal-invalid', cwd: '/tmp', shellPref: 'not-a-shell' }),
    ).toThrow(/invalid shellPref/);
    expect(mocks.getDefaultShellPref).not.toHaveBeenCalled();
    expect(mocks.managerCreate).not.toHaveBeenCalled();
  });
});

// 依据：#12409 群聊终端须从本机主目录开始，不能依赖空 cwd 回退（renderer 拿不到 process.env）。
// 缺口：此前没有任何 IPC 向 renderer 暴露主目录。最小失败输入：未注册该 channel。tier: unit。
describe('terminal GET_HOME_DIR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTerminalHandlers();
  });

  it('returns the local user home directory from main', async () => {
    const { homedir } = await import('node:os');
    const call = mocks.ipcHandle.mock.calls.find(([channel]) => channel === TERMINAL_INVOKE.GET_HOME_DIR);
    expect(call).toBeDefined();
    expect((call![1] as () => string)()).toBe(homedir());
  });
});
