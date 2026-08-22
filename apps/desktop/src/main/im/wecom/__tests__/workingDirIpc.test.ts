/**
 * workingDirIpc.test.ts
 * ---------------------------------------------------------------------------
 * wecomBot 工作目录 IPC 的 handler 级测试(依赖全注入, 不拉起 Electron)。
 * 关键路径: 主路径 / 取消 / 窗口失效 / 选择器异常 / **弹窗期间切号不落盘** /
 * **用户目录探测期间切号不落盘** / 写入与重置失败 —— 全部映射成统一 IPC
 * 错误码, 不把原始异常穿给 Renderer。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createWecomWorkingDirIpcHandlers,
  registerWecomWorkingDirIpc,
  type IpcHandleSink,
} from '../workingDirIpc';

const STATE = { version: 1, workingDir: null, workingDirAvailable: true } as const;
const PICKED_STATE = { version: 1, workingDir: 'D:/picked', workingDirAvailable: true } as const;
const NORMALIZED = 'D:/picked';
const ERROR_CODE = 'WECOM_WORKING_DIR_UPDATE_FAILED';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    readSettings: vi.fn(async () => PICKED_STATE),
    normalizeSelectedDirectory: vi.fn(async () => NORMALIZED),
    commitWorkingDir: vi.fn(async () => PICKED_STATE),
    resetWorkingDir: vi.fn(async () => STATE),
    showDirectoryPicker: vi.fn(async () => ({ canceled: false, filePaths: ['D:\\picked'] })),
    captureGeneration: vi.fn((): number | null => 7),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('wecomBot working directory IPC handlers', () => {
  it('saves the picked directory and returns the fresh state', async () => {
    const deps = makeDeps();
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory('wc')).resolves.toEqual({
      canceled: false,
      state: PICKED_STATE,
    });
    expect(deps.showDirectoryPicker).toHaveBeenCalledWith('wc');
    // 两段式: 先异步校验用户盘, 再(代次校验后)落盘本地配置。
    expect(deps.normalizeSelectedDirectory).toHaveBeenCalledWith('D:\\picked');
    expect(deps.commitWorkingDir).toHaveBeenCalledWith(NORMALIZED);
  });

  it('treats a cancelled picker as canceled, not an error, and keeps config', async () => {
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).resolves.toEqual({
      canceled: true,
      state: PICKED_STATE,
    });
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('rejects with the structured IPC error when the owner window is gone', async () => {
    const deps = makeDeps({ showDirectoryPicker: vi.fn(async () => null) });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('maps picker exceptions to the structured IPC error', async () => {
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(async () => {
        throw new Error('dialog exploded');
      }),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
    expect(deps.warn).toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('drops the pick when the IM account generation changes during the dialog', async () => {
    // 弹窗期间登出/换号: 代次推进 ⇒ 选中的路径属于上一个账号, 绝不落盘。
    const generations = [7, 8];
    const deps = makeDeps({
      captureGeneration: vi.fn(() => generations.shift() ?? null),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      'WeCom working directory pick crossed an account switch; dropped',
    );
  });

  it('drops the pick when the generation changes while probing the user directory', async () => {
    // 用户盘探测是异步的(网络盘可能秒级): 探测归来后必须重校验代次,
    // 不能沿用「弹窗后校验过一次」的同步假设 — 否则 A 账号选的路径会趁
    // 探测间隙写进 B 账号的 owner-scoped 配置。
    const generations = [7, 7, 8];
    const deps = makeDeps({
      captureGeneration: vi.fn(() => generations.shift() ?? null),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
    expect(deps.normalizeSelectedDirectory).toHaveBeenCalledTimes(1);
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      'WeCom working directory probe crossed an account switch; dropped',
    );
  });

  it('allows the write when the generation stays equal, including both null', async () => {
    const deps = makeDeps({ captureGeneration: vi.fn((): number | null => null) });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).resolves.toMatchObject({
      canceled: false,
    });
    expect(deps.commitWorkingDir).toHaveBeenCalledTimes(1);
  });

  it('maps validation failures to the structured IPC error without writing', async () => {
    const deps = makeDeps({
      normalizeSelectedDirectory: vi.fn(async () => {
        throw new Error('WECOM_WORKING_DIR_NOT_DIRECTORY');
      }),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('maps commit failures to the structured IPC error', async () => {
    const deps = makeDeps({
      commitWorkingDir: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({
      code: ERROR_CODE,
    });
  });

  it('returns the stored projection and maps reset failures', async () => {
    const deps = makeDeps();
    const handlers = createWecomWorkingDirIpcHandlers(deps);

    await expect(handlers.getChannelSettings()).resolves.toBe(PICKED_STATE);
    await expect(handlers.resetWorkingDirectory()).resolves.toBe(STATE);

    const failing = createWecomWorkingDirIpcHandlers(
      makeDeps({
        resetWorkingDir: vi.fn(async () => {
          throw new Error('EACCES');
        }),
      }),
    );
    await expect(failing.resetWorkingDirectory()).rejects.toThrow(
      /\[WECOM_WORKING_DIR_UPDATE_FAILED\]/,
    );
  });
});

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
      handlers: createWecomWorkingDirIpcHandlers(deps),
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
