import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcMainInvokeEvent, WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  managerCreate: vi.fn(() => ({ shellId: 'bash', shellDisplayName: 'Bash', pid: 123 })),
  getDefaultShellPref: vi.fn(() => 'bash' as const),
  context: null as null|{controllerDeviceId:string;sharedTask?:object},
  settings:{remoteControlEnabled:true,revokedControllers:[] as string[]},
  remoteInvoke:vi.fn(async (_request:unknown,authority:{assertCurrent():void})=>{authority.assertCurrent();return {version:1};}),
  remoteClose:vi.fn(),
  authChanged:()=>{},
  owner:'first-owner',
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
  app:{once:vi.fn()},
}));
vi.mock('@cindy/terminal-core',()=>({REMOTE_TERMINAL_CHANNEL:'terminal:remote-op',RemoteTerminalHost:class{invoke=mocks.remoteInvoke;close=mocks.remoteClose;}}));
vi.mock('../../authManager.js',()=>({getActiveAuthRealm:()=> 'global',getCurrentUserId:()=> 'membership',getCurrentDataOwnerId:()=>mocks.owner,onAuthStateChange:(callback:()=>void)=>{mocks.authChanged=callback;return ()=>{};}}));
vi.mock('../../device-link/invoke-context.js',()=>({getDeviceLinkInvokeContext:()=>mocks.context}));
vi.mock('../../device-link/settings-store.js',()=>({readDeviceLinkSettings:()=>mocks.settings}));
vi.mock('../../logger.js',()=>({createLogger:()=>({info(){},warn(){}})}));

vi.mock('../../terminal/ptyManager.js', () => ({
  PtyManager: class {
    create = mocks.managerCreate;
  },
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
import { registerRemoteTerminal } from '../../terminal/remote.js';

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

// Existing window terminal checks do not exercise the new remote boundary.
// Minimal failure: a guest or revoked controller reaches the PTY. Unit tier,
// production IPC handler and permission/error mapping, with the OS host mocked.
describe('remote terminal admission',()=>{
  it('requires a current same-account controller and closes on owner replacement',async()=>{
    mocks.ipcHandle.mockClear();mocks.remoteInvoke.mockClear();mocks.remoteClose.mockClear();
    mocks.context=null;mocks.settings={remoteControlEnabled:true,revokedControllers:[]};mocks.owner='first-owner';
    registerRemoteTerminal();
    const handler=mocks.ipcHandle.mock.calls.find(([channel])=>channel==='terminal:remote-op')![1] as InvokeHandler;
    const call=()=>handler({} as IpcMainInvokeEvent,{version:1,op:'capabilities'});
    await expect(call()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    mocks.context={controllerDeviceId:'guest',sharedTask:{}};
    await expect(call()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(mocks.remoteInvoke).not.toHaveBeenCalled();
    mocks.context={controllerDeviceId:'controller'};
    await expect(call()).resolves.toEqual({version:1});
    mocks.settings.revokedControllers=['controller'];
    await expect(call()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    mocks.owner='second-owner';mocks.authChanged();
    expect(mocks.remoteClose).toHaveBeenCalledOnce();
  });
});
