/**
 * workingDirIpc.test.ts(企微注册层)
 * ---------------------------------------------------------------------------
 * 业务体矩阵在 shared/__tests__/channelWorkingDirIpc.test.ts(双渠道同一套)。
 * 这里只锁企微自己的注册面:固定三个 channel、可信 sender 校验**先于一切
 * 业务依赖**、可信事件放行到业务体。channel 名刻意不做参数化。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createChannelWorkingDirIpcHandlers,
  type ChannelWorkingDirIpcDeps,
} from '../../shared/channelWorkingDirIpc';
import { registerWecomWorkingDirIpc, type IpcHandleSink } from '../workingDirIpc';

const STATE = { version: 1, workingDir: null, workingDirAvailable: true } as const;
const PICKED_STATE = { version: 1, workingDir: 'D:/picked', workingDirAvailable: true } as const;

function makeDeps(): ChannelWorkingDirIpcDeps {
  return {
    readSettings: vi.fn(async () => PICKED_STATE),
    normalizeSelectedDirectory: vi.fn(async () => 'D:/picked'),
    commitWorkingDir: vi.fn(async () => PICKED_STATE),
    resetWorkingDir: vi.fn(async () => STATE),
    showDirectoryPicker: vi.fn(async () => ({ canceled: false, filePaths: ['D:\\picked'] })),
    captureGeneration: vi.fn((): number | null => 7),
    warn: vi.fn(),
  };
}

describe('wecomBot working directory IPC 安全边界', () => {
  type Listener = (event: unknown) => unknown;
  const UNTRUSTED_EVENT = { sender: { id: 1 }, senderFrame: { url: 'https://evil.example' } };

  function registerWith(trusted: boolean) {
    const deps = makeDeps();
    const listeners = new Map<string, Listener>();
    const sink: IpcHandleSink = {
      handle: (channel, listener) => {
        listeners.set(channel, listener as Listener);
      },
    };
    registerWecomWorkingDirIpc({
      ipc: sink,
      handlers: createChannelWorkingDirIpcHandlers({
        updateFailedCode: 'WECOM_WORKING_DIR_UPDATE_FAILED',
        channelLabel: 'WeCom',
        deps,
      }),
      assertTrustedEvent: (event) => {
        if (!trusted) throw new Error('UNTRUSTED_RENDERER');
      },
    });
    return { deps, listeners };
  }

  it('registers exactly the three working-directory channels', () => {
    const { listeners } = registerWith(true);
    expect([...listeners.keys()].sort()).toEqual([
      'wecomBot:choose-working-directory',
      'wecomBot:get-channel-settings',
      'wecomBot:reset-working-directory',
    ]);
  });

  it('rejects untrusted senders before reading settings, opening the picker, or resetting', () => {
    const { deps, listeners } = registerWith(false);

    // 安全边界必须先于业务体: 任何一个业务 dep 都不允许被触碰。
    // (listener 同步抛出 — Electron handle 会把它变成 renderer 侧的 rejected
    // invocation, 这里按同步抛出断言。)
    expect(() => listeners.get('wecomBot:get-channel-settings')!(UNTRUSTED_EVENT)).toThrow(
      'UNTRUSTED_RENDERER',
    );
    expect(() => listeners.get('wecomBot:reset-working-directory')!(UNTRUSTED_EVENT)).toThrow(
      'UNTRUSTED_RENDERER',
    );
    expect(() => listeners.get('wecomBot:choose-working-directory')!(UNTRUSTED_EVENT)).toThrow(
      'UNTRUSTED_RENDERER',
    );

    expect(deps.readSettings).not.toHaveBeenCalled();
    expect(deps.showDirectoryPicker).not.toHaveBeenCalled();
    expect(deps.resetWorkingDir).not.toHaveBeenCalled();
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('passes trusted senders through to the business body', async () => {
    const { deps, listeners } = registerWith(true);

    await expect(listeners.get('wecomBot:get-channel-settings')!({ sender: 'wc' })).resolves.toBe(
      PICKED_STATE,
    );
    await expect(
      listeners.get('wecomBot:reset-working-directory')!({ sender: 'wc' }),
    ).resolves.toBe(STATE);
    await expect(
      listeners.get('wecomBot:choose-working-directory')!({ sender: 'wc' }),
    ).resolves.toMatchObject({ canceled: false });

    expect(deps.readSettings).toHaveBeenCalled();
    expect(deps.showDirectoryPicker).toHaveBeenCalledWith('wc');
    expect(deps.resetWorkingDir).toHaveBeenCalled();
  });
});
