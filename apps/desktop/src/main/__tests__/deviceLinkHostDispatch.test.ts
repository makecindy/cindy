/**
 * deviceLinkHostDispatch.test.ts —— device-link「被控端 dispatch 决策」端到端集成(Tier 2)。
 * ---------------------------------------------------------------------------
 * 把过去要真机验证的**被控端那一半**变成 CI 可跑:驱动**真实** runInvoke(dispatch.ts),
 * 串起真实双层门禁(remoteControlEnabled + allowlist)+ **真实 workingDir guard**
 * (`checkRemoteWorkingDir` 跑真实异步 fs 探测)
 * + dispatchLocalInvoke 路由到本机 handler + set-* 回流 + throwIpcError `[CODE]` 透传。
 *
 * 真实 vs 忠实替身的边界(诚实声明):
 *   - 真实:runInvoke 全部决策逻辑、guard 的 fs 存在性判定、
 *     allowlist、dispatchLocalInvoke 的 handler 查找与合成 event 调用、错误编码。
 *   - 替身:被控端业务 handler(maker:create-session / set-model / send 等)用忠实假实现
 *     (会拉起真 agent / 真 maker-host,不确定且无法在 node 跑)——这里只验证**dispatch 把请求
 *     正确门禁、收敛、路由到 handler**,handler 内部业务由各自单测覆盖。
 *
 * 直击 Bug 1(远程浏览的新目录建会话):fresh 真实目录 → 放行到 handler;不存在路径 → 拒。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks(hoist 前置)──────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  settings: { remoteControlEnabled: true, revokedControllers: [] as string[] },
  customProviderBilling: {
    showSdkCostForCustomProviders: true,
    isCustomized: true,
    defaultShowSdkCostForCustomProviders: false,
  },
  // ⚠️ 绝不能回落 process.cwd():TEMP 是 Windows 独有变量,macOS 上回落 cwd 曾让
  // auth-adapters 的 codex-home 骨架(含真实凭证硬链)生成进仓库 apps/desktop/ 下
  // (2026-07-03 事故)。统一走系统临时目录:macOS TMPDIR / Windows TEMP / 其余 /tmp。
  userDataDir: process.env.TMPDIR ?? process.env.TEMP ?? '/tmp',
}));

// electron:仅占位(dispatch 引 app、invoke-registry 引 ipcMain;runInvoke 不实际用)。
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => h.userDataDir,
    getVersion: () => '1.0.0-test',
    isPackaged: false,
  },
  // power-blocker.ts 模块级单例引用 powerSaveBlocker,需占位避免 vitest 报 mock 未定义
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  // notificationService.ts 在 dev 模式加载通知图标；测试只需要一个空图占位。
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
// 被控开关:由 h.settings 控制(双层门禁第一道)。
vi.mock('../device-link/settings-store', () => ({
  readDeviceLinkSettings: () => h.settings,
}));
vi.mock('../maker-host/custom-provider-billing-settings-store', () => ({
  customProviderBillingWire: () => h.customProviderBilling,
}));
import {
  runInvoke,
  setRemoteWorkingDirGuard,
  setRemoteSettingsPersist,
  __testing as dispatchTesting,
} from '../device-link/dispatch';
import { checkRemoteWorkingDir } from '../device-link/remote-workdir-guard';
import { __testing as registry } from '../device-link/invoke-registry';
import type { InvokeResultPayload } from '@cindy/device-link';

const SRC = 'controller-device';
const TMP_DIR = os.tmpdir(); // 真实存在的目录(模拟"浏览到/新建的远程目录")
let managedWorktreeTestRoot = '';
let managedWorktreeDir = '';

beforeAll(() => {
  managedWorktreeTestRoot = mkdtempSync(path.join(os.tmpdir(), 'device-link-worktree-'));
  managedWorktreeDir = path.join(managedWorktreeTestRoot, '.cindy-worktrees', 'auto-test');
  mkdirSync(managedWorktreeDir, { recursive: true });

  // 接入与生产相同的结构化 guard。
  // 此集成测试在纯 Node 中运行，显式注入真实异步 stat；utilityProcess 的
  // 并发、超时与回收由 workdir-probe-host 专属测试覆盖。
  setRemoteWorkingDirGuard((dir) => checkRemoteWorkingDir(dir, { stat }));
});

afterAll(() => {
  rmSync(managedWorktreeTestRoot, { recursive: true, force: true });
});

let persistSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  registry.reset();
  h.settings.remoteControlEnabled = true;
  h.settings.revokedControllers = [];
  persistSpy = vi.fn();
  setRemoteSettingsPersist(persistSpy);
});

afterEach(() => {
  dispatchTesting.reset();
  setRemoteSettingsPersist(null);
  vi.clearAllMocks();
});

/** 注册一个记录调用的本机 handler(模拟被控端业务 handler,不跑真 agent)。 */
function registerHandler(channel: string, impl: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn((_event: unknown, ...args: unknown[]) => impl(...args));
  registry.register(channel, fn as never);
  return fn;
}

describe('device-link host dispatch (runInvoke) — real gate + async fs guard + routing', () => {
  it('Bug1:create-session 的 workingDir 是真实存在的新目录 → 放行到 handler', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 's-new' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ workingDir: TMP_DIR, workspaceKind: 'project' }],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ sessionId: 's-new' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('create-session 的 workingDir 是刚创建的 Cindy 托管 worktree → 放行到 handler', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 's-worktree' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ id: 's-worktree', workingDir: managedWorktreeDir, workspaceKind: 'project' }],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ sessionId: 's-worktree' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('Bug1:create-session 的 workingDir 不存在 → 结构化拒绝,不落到 handler', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 'should-not-happen' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ workingDir: '/definitely/not/a/real/dir/xyz123' }],
    })) as Extract<InvokeResultPayload, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('IPC_ERROR');
    expect(res.error.message).toContain('REMOTE_WORKDIR_NOT_FOUND');
    expect(handler).not.toHaveBeenCalled();
  });

  it('create-session 的历史 recent 路径当前不存在 → 拒绝', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 's2' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ workingDir: '/seeded/recent/proj' }],
    })) as Extract<InvokeResultPayload, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('REMOTE_WORKDIR_NOT_FOUND');
    expect(handler).not.toHaveBeenCalled();
  });

  it('create-session 的历史 session 路径当前不存在 → 拒绝', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 's3' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ workingDir: '/existing/session/dir' }],
    })) as Extract<InvokeResultPayload, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain('REMOTE_WORKDIR_NOT_FOUND');
    expect(handler).not.toHaveBeenCalled();
  });

  it('create-session 的 workingDir 是文件(存在但非目录)→ 拒', async () => {
    const handler = registerHandler('maker:create-session', () => ({ sessionId: 'nope' }));
    const res = (await runInvoke(SRC, {
      channel: 'maker:create-session',
      args: [{ workingDir: __filename }], // 真实文件,非目录
    })) as Extract<InvokeResultPayload, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('IPC_ERROR');
    expect(res.error.message).toContain('REMOTE_WORKDIR_NOT_DIRECTORY');
    expect(handler).not.toHaveBeenCalled();
  });

  // 远程 worktree:worktree:create 的 baseRepo 与 create-session 的 workingDir 同口径收敛
  // (决定在被控端哪个仓库下跑 git worktree add)。
  it('worktree:create 的 baseRepo 是真实存在目录 → 放行到 handler', async () => {
    const handler = registerHandler('worktree:create', () => ({ ok: true }));
    const res = (await runInvoke(SRC, {
      channel: 'worktree:create',
      args: [{ sessionId: 's-wt', baseRepo: TMP_DIR, name: 'auto-x1', sourceBranch: 'main' }],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('worktree:create 的 baseRepo 不存在 → 结构化拒绝,不落到 handler', async () => {
    const handler = registerHandler('worktree:create', () => ({ ok: true }));
    const res = (await runInvoke(SRC, {
      channel: 'worktree:create',
      args: [{ sessionId: 's-wt', baseRepo: '/definitely/not/a/real/repo/xyz123', name: 'auto-x1', sourceBranch: 'main' }],
    })) as Extract<InvokeResultPayload, { ok: false }>;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('IPC_ERROR');
    expect(res.error.message).toContain('REMOTE_WORKDIR_NOT_FOUND');
    expect(handler).not.toHaveBeenCalled();
  });

  it('双层门禁第一道:remoteControlEnabled=false → REMOTE_DISABLED(不查 allowlist/guard)', async () => {
    h.settings.remoteControlEnabled = false;
    const handler = registerHandler('maker:list-active', () => []);
    const res = (await runInvoke(SRC, { channel: 'maker:list-active', args: [] })) as Extract<
      InvokeResultPayload,
      { ok: false }
    >;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('REMOTE_DISABLED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('逐设备黑名单:src 已撤销访问权限 → ACCESS_REVOKED(不查 allowlist/guard、不落 handler)', async () => {
    h.settings.revokedControllers = [SRC];
    const handler = registerHandler('maker:list-active', () => []);
    const res = (await runInvoke(SRC, { channel: 'maker:list-active', args: [] })) as Extract<
      InvokeResultPayload,
      { ok: false }
    >;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('ACCESS_REVOKED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('双层门禁第二道:channel 不在 allowlist → CHANNEL_NOT_ALLOWED', async () => {
    const handler = registerHandler('maker:evil-not-allowed', () => 'pwned');
    const res = (await runInvoke(SRC, { channel: 'maker:evil-not-allowed', args: [] })) as Extract<
      InvokeResultPayload,
      { ok: false }
    >;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('CHANNEL_NOT_ALLOWED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('set-* 成功后回流持久化(args[1] 作为字段值,以被控端为准)', async () => {
    registerHandler('maker:set-model', () => undefined);
    const res = (await runInvoke(SRC, {
      channel: 'maker:set-model',
      args: ['sess-1', 'claude-opus-4-8'],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    expect(persistSpy).toHaveBeenCalledWith('sess-1', { model: 'claude-opus-4-8' });
  });

  it('set-extra-dirs 回流持久化 handler 实际应用的子集(剔除被拒目录,非原始请求值)', async () => {
    // 模拟被控端校验:请求 3 个目录,/rejected 在被控端被拒 → handler 返回 validation.valid 子集
    registerHandler('maker:set-extra-dirs', (_sessionId: unknown, dirs: unknown) =>
      (dirs as string[]).filter((d) => d !== '/rejected'),
    );
    const res = (await runInvoke(SRC, {
      channel: 'maker:set-extra-dirs',
      args: ['sess-1', ['/ok/a', '/rejected', '/ok/b']],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    // 持久化的是 handler 返回的生效子集,不含被拒的 /rejected(否则被控端 DB 会存进会话从未接受的目录)
    expect(persistSpy).toHaveBeenCalledWith('sess-1', { extraDirs: ['/ok/a', '/ok/b'] });
  });

  it('set-extra-dirs handler no-op(返回 undefined)→ 不持久化', async () => {
    // session 不在 / capability 不支持 → handler 返回 undefined,不应把请求目录写进 DB
    registerHandler('maker:set-extra-dirs', () => undefined);
    const res = (await runInvoke(SRC, {
      channel: 'maker:set-extra-dirs',
      args: ['sess-1', ['/some/dir']],
    })) as Extract<InvokeResultPayload, { ok: true }>;
    expect(res.ok).toBe(true);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('非 set-* channel 不触发回流', async () => {
    registerHandler('maker:list-active', () => []);
    await runInvoke(SRC, { channel: 'maker:list-active', args: [] });
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('被控端 handler 抛 throwIpcError → invoke-result 透传 [CODE] message(控制端可解码)', async () => {
    registerHandler('maker:send', () => {
      throw new Error('[BUSY] turn already in progress');
    });
    const res = (await runInvoke(SRC, { channel: 'maker:send', args: ['s', 'hi'] })) as Extract<
      InvokeResultPayload,
      { ok: false }
    >;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('IPC_ERROR');
    expect(res.error.message).toContain('[BUSY]');
  });

  it('allowlist 内但无本机 handler → dispatchLocalInvoke 抛 NOT_FOUND → IPC_ERROR 透传', async () => {
    // 不注册 handler。maker:list-active 在 allowlist 内、门禁过、guard 不管它 → 进 dispatchLocalInvoke。
    const res = (await runInvoke(SRC, { channel: 'maker:list-active', args: [] })) as Extract<
      InvokeResultPayload,
      { ok: false }
    >;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('IPC_ERROR');
    expect(res.error.message).toContain('[NOT_FOUND]');
  });

  it('custom provider billing GET 走只读 device-link 投影,不经过 trusted-renderer IPC handler', async () => {
    const handler = registerHandler('maker:custom-provider-billing:get', () => {
      throw new Error('synthetic event must not reach renderer-only handler');
    });
    const res = (await runInvoke(SRC, {
      channel: 'maker:custom-provider-billing:get',
      args: [],
    })) as Extract<InvokeResultPayload, { ok: true }>;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual(h.customProviderBilling);
    expect(handler).not.toHaveBeenCalled();
  });
});
