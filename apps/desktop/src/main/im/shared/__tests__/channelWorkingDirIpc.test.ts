/**
 * channelWorkingDirIpc.test.ts
 * ---------------------------------------------------------------------------
 * 工作目录 IPC 共享工厂的 handler 级测试(依赖全注入, 不拉起 Electron),
 * 个人微信与企业微信两组参数各跑一遍同一矩阵:
 *   - 主路径 / 取消 / 窗口失效 / 选择器异常;
 *   - **generation 三处校验**: 选择器返回后、异步探测返回后(commit 前)、
 *     本地 commit 返回后 —— 前两处不得 commit, 第三处不得把已落盘状态
 *     返回给 Renderer(切号期间报错代替);
 *   - 校验失败 / 落盘失败 / 重置失败全部映射成渠道 UPDATE_FAILED 错误码;
 *   - **日志脱敏**: warn 上下文只含 errorCode, 不含原始 error.message 与
 *     用户所选绝对路径。
 * 固定 channel 注册与可信 sender 校验的测试在各渠道自己的 workingDirIpc.test。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createChannelWorkingDirIpcHandlers,
  type ChannelWorkingDirIpcDeps,
} from '../channelWorkingDirIpc';

const STATE = { version: 1, workingDir: null, workingDirAvailable: true } as const;
const PICKED_STATE = { version: 1, workingDir: 'D:/picked', workingDirAvailable: true } as const;
const NORMALIZED = 'D:/picked';
const RAW_PICKED = 'D:\\picked';

function makeDeps(overrides: Partial<ChannelWorkingDirIpcDeps> = {}): ChannelWorkingDirIpcDeps {
  return {
    readSettings: vi.fn(async () => PICKED_STATE),
    normalizeSelectedDirectory: vi.fn(async () => NORMALIZED),
    commitWorkingDir: vi.fn(async () => PICKED_STATE),
    resetWorkingDir: vi.fn(async () => STATE),
    showDirectoryPicker: vi.fn(async () => ({ canceled: false, filePaths: [RAW_PICKED] })),
    captureGeneration: vi.fn((): number | null => 7),
    warn: vi.fn(),
    ...overrides,
  };
}

const CHANNELS = [
  { code: 'WECOM_WORKING_DIR_UPDATE_FAILED', label: 'WeCom' },
  { code: 'WECHAT_WORKING_DIR_UPDATE_FAILED', label: 'personal WeChat' },
] as const;

describe.each(CHANNELS)('channelWorkingDirIpc handlers ($label)', ({ code, label }) => {
  function makeHandlers(deps: ChannelWorkingDirIpcDeps) {
    return createChannelWorkingDirIpcHandlers({ updateFailedCode: code, channelLabel: label, deps });
  }

  it('saves the picked directory via the two-phase flow and returns the fresh state', async () => {
    const deps = makeDeps();
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory('wc')).resolves.toEqual({
      canceled: false,
      state: PICKED_STATE,
    });
    expect(deps.showDirectoryPicker).toHaveBeenCalledWith('wc');
    expect(deps.normalizeSelectedDirectory).toHaveBeenCalledWith(RAW_PICKED);
    expect(deps.commitWorkingDir).toHaveBeenCalledWith(NORMALIZED);
  });

  it('treats a cancelled picker as canceled, not an error, and keeps config', async () => {
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).resolves.toEqual({
      canceled: true,
      state: PICKED_STATE,
    });
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('rejects with the structured IPC error when the owner window is gone', async () => {
    const deps = makeDeps({ showDirectoryPicker: vi.fn(async () => null) });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('maps picker exceptions to the structured IPC error', async () => {
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(async () => {
        throw new Error('dialog exploded');
      }),
    });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.warn).toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('drops the pick when the account generation changes during the dialog', async () => {
    const generations = [7, 8];
    const deps = makeDeps({ captureGeneration: vi.fn(() => generations.shift() ?? null) });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory pick crossed an account switch; dropped`,
    );
  });

  it('drops the pick when the generation changes while probing the user directory', async () => {
    const generations = [7, 7, 8];
    const deps = makeDeps({ captureGeneration: vi.fn(() => generations.shift() ?? null) });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.normalizeSelectedDirectory).toHaveBeenCalledTimes(1);
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory probe crossed an account switch; dropped`,
    );
  });

  it('rejects instead of returning the state when the generation changes during commit', async () => {
    // commit 期间切号: 落盘可能已发生, 但该状态属于上一个账号的语境 —
    // 报错让界面重新读取, 不把跨账号路径返回给 Renderer。
    const generations = [7, 7, 7, 8];
    const deps = makeDeps({ captureGeneration: vi.fn(() => generations.shift() ?? null) });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.commitWorkingDir).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory commit crossed an account switch; dropped`,
    );
  });

  it('allows the write when a non-null generation stays equal', async () => {
    const deps = makeDeps();
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).resolves.toMatchObject({ canceled: false });
    expect(deps.commitWorkingDir).toHaveBeenCalledTimes(1);
  });

  it('rejects every operation at the entry when the generation is null (no active account boundary)', async () => {
    // null→null 不构成「稳定账号」: 换号窗口期间配置归属未定义, 一律拒绝,
    // 且不得触碰任何业务依赖(读配置/弹选择器/重置/提交)。
    const deps = makeDeps({ captureGeneration: vi.fn((): number | null => null) });
    const handlers = makeHandlers(deps);

    await expect(handlers.getChannelSettings()).rejects.toMatchObject({ code });
    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    await expect(handlers.resetWorkingDir()).rejects.toMatchObject({ code });
    expect(deps.readSettings).not.toHaveBeenCalled();
    expect(deps.showDirectoryPicker).not.toHaveBeenCalled();
    expect(deps.resetWorkingDir).not.toHaveBeenCalled();
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('rejects when the generation falls back to null mid-flight (number → null)', async () => {
    // 弹窗/探测/提交期间 stopImConnection 关闭账号边界 → generation 回落 null:
    // 与变成另一个数字一样, 都算切号。
    const generations: Array<number | null> = [7, null];
    const deps = makeDeps({
      captureGeneration: vi.fn((): number | null => {
        const next = generations.shift();
        return next === undefined ? 7 : next;
      }),
    });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.normalizeSelectedDirectory).not.toHaveBeenCalled();
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory pick crossed an account switch; dropped`,
    );
  });

  it('rejects a settings read that falls back to null mid-flight', async () => {
    let resolveRead!: (state: typeof PICKED_STATE) => void;
    const generations: Array<number | null> = [7];
    const deps = makeDeps({
      readSettings: vi.fn(
        () => new Promise<typeof PICKED_STATE>((resolve) => { resolveRead = resolve; }),
      ),
      captureGeneration: vi.fn((): number | null => generations.shift() ?? null),
    });
    const handlers = makeHandlers(deps);

    const pending = handlers.getChannelSettings();
    await Promise.resolve();
    resolveRead(PICKED_STATE);
    await expect(pending).rejects.toMatchObject({ code });
  });

  it('maps validation failures to the structured IPC error without writing', async () => {
    const deps = makeDeps({
      normalizeSelectedDirectory: vi.fn(async () => {
        throw Object.assign(new Error('WECHAT_WORKING_DIR_NOT_DIRECTORY'), {
          code: 'WECHAT_WORKING_DIR_NOT_DIRECTORY',
        });
      }),
    });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
    expect(deps.commitWorkingDir).not.toHaveBeenCalled();
  });

  it('maps commit failures to the structured IPC error', async () => {
    const deps = makeDeps({
      commitWorkingDir: vi.fn(async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory 'D:/picked'"), {
          code: 'ENOENT',
        });
      }),
    });
    const handlers = makeHandlers(deps);

    await expect(handlers.chooseWorkingDirectory({})).rejects.toMatchObject({ code });
  });

  it('returns the stored projection and maps reset failures', async () => {
    const deps = makeDeps();
    const handlers = makeHandlers(deps);

    await expect(handlers.getChannelSettings()).resolves.toBe(PICKED_STATE);
    await expect(handlers.resetWorkingDir()).resolves.toBe(STATE);

    const failing = makeHandlers(
      makeDeps({
        resetWorkingDir: vi.fn(async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }),
      }),
    );
    await expect(failing.resetWorkingDir()).rejects.toThrow(`[${code}]`);
  });

  it('returns settings normally when the generation stays stable across a slow read', async () => {
    let resolveRead!: (state: typeof PICKED_STATE) => void;
    const deps = makeDeps({
      readSettings: vi.fn(
        () => new Promise<typeof PICKED_STATE>((resolve) => { resolveRead = resolve; }),
      ),
    });
    const handlers = makeHandlers(deps);

    const pending = handlers.getChannelSettings();
    resolveRead(PICKED_STATE);
    await expect(pending).resolves.toBe(PICKED_STATE);
  });

  it('drops a slow settings read that crosses an account switch', async () => {
    // A 账号的目录在慢速网络盘上: 读取挂起期间切到 B — A 的绝对路径不得
    // 返回给当前 Renderer(Main 侧守卫, renderer 无法可靠拦截)。
    const OLD_ACCOUNT_STATE = {
      version: 1,
      workingDir: 'D:/owner-a/project',
      workingDirAvailable: true,
    } as const;
    let resolveRead!: (state: typeof PICKED_STATE) => void;
    let generation = 7;
    const deps = makeDeps({
      readSettings: vi.fn(
        () => new Promise<typeof PICKED_STATE>((resolve) => { resolveRead = resolve; }),
      ),
      captureGeneration: vi.fn(() => generation),
    });
    const handlers = makeHandlers(deps);

    const pending = handlers.getChannelSettings();
    generation = 8;
    resolveRead(OLD_ACCOUNT_STATE as unknown as typeof PICKED_STATE);
    await expect(pending).rejects.toMatchObject({ code });
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory settings read crossed an account switch; dropped`,
    );
  });

  it('drops the post-cancel settings read when it crosses an account switch', async () => {
    let resolveRead!: (state: typeof PICKED_STATE) => void;
    let generation = 7;
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      readSettings: vi.fn(
        () => new Promise<typeof PICKED_STATE>((resolve) => { resolveRead = resolve; }),
      ),
      captureGeneration: vi.fn(() => generation),
    });
    const handlers = makeHandlers(deps);

    const pending = handlers.chooseWorkingDirectory({});
    // 等 handler 走过取消分支、真正发起 readSettings 后再切号。
    await Promise.resolve();
    await Promise.resolve();
    generation = 8;
    resolveRead(PICKED_STATE);
    await expect(pending).rejects.toMatchObject({ code });
  });

  it('rejects a cancel that crossed an account switch before any settings read', async () => {
    // A 打开选择器 → 切到 B → 取消: A 发起的 IPC 不得把 B 的配置带回去 —
    // pick 复检先于取消判断, 且不得发起 readSettings。
    let resolvePicker!: (result: { canceled: boolean; filePaths: string[] }) => void;
    let generation = 7;
    const deps = makeDeps({
      showDirectoryPicker: vi.fn(
        () => new Promise<{ canceled: boolean; filePaths: string[] }>((resolve) => {
          resolvePicker = resolve;
        }),
      ),
      captureGeneration: vi.fn(() => generation),
    });
    const handlers = makeHandlers(deps);

    const pending = handlers.chooseWorkingDirectory({});
    await Promise.resolve();
    await Promise.resolve();
    generation = 8;
    resolvePicker({ canceled: true, filePaths: [] });
    await expect(pending).rejects.toMatchObject({ code });
    expect(deps.readSettings).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      `${label} working directory pick crossed an account switch; dropped`,
    );
  });

  it('never logs the picked absolute path or raw error messages', async () => {
    // 脱敏纪律: 原生 fs 错误的 message 含完整用户目录, warn 上下文只允许
    // errorCode 一个字段。
    const scenarios: Array<Partial<ChannelWorkingDirIpcDeps>> = [
      {
        showDirectoryPicker: vi.fn(async () => {
          throw new Error(`dialog exploded near ${RAW_PICKED}`);
        }),
      },
      {
        normalizeSelectedDirectory: vi.fn(async () => {
          throw Object.assign(new Error(`ENOENT: no such file or directory '${RAW_PICKED}'`), {
            code: 'ENOENT',
          });
        }),
      },
      {
        commitWorkingDir: vi.fn(async () => {
          throw Object.assign(new Error(`EACCES: permission denied '${RAW_PICKED}'`), {
            code: 'EACCES',
          });
        }),
      },
    ];
    for (const override of scenarios) {
      const deps = makeDeps(override);
      const handlers = makeHandlers(deps);
      await handlers.chooseWorkingDirectory({}).catch(() => undefined);
      expect(deps.warn).toHaveBeenCalled();
      for (const call of vi.mocked(deps.warn).mock.calls) {
        const context = call[1] ?? {};
        expect(Object.keys(context)).toEqual(['errorCode']);
        expect(JSON.stringify(context)).not.toContain(RAW_PICKED);
        expect(JSON.stringify(call[0])).not.toContain(RAW_PICKED);
      }
    }
  });
});
