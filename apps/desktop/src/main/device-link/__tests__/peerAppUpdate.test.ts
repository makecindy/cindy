/**
 * 测试价值
 * - 生产入口与可观察结果：createPeerAppUpdateHandler(...).handle(dispatch 拦截后的远程/本机应用更新入口)。
 *   覆盖 status 只读查询（含 dev/不支持构建、busy fail-closed、短缓存）与 install 触发（锁定 expectedVersion、
 *   先回包后延迟调内置 apply、账号切换在 beforeRelaunch/beforeSpawn 拦截、后台失败错误码经 status 回传）。
 * - Bug/规则依据：2026-11-26 用户确认的 Agent-Net 卡片更新功能；必须复用 updateService 既有状态机，
 *   并在账号切换或版本漂移时拒绝误装；macOS 本地已 ready 时不能在 RPC 回包前直接退出进程。
 * - 现有覆盖缺口：updateService.test.ts 只覆盖本机调用，未覆盖 peer 协议参数校验、延迟回包、并发幂等与失败回传。
 * - 最小失败输入：无效版本号、expectedVersion 不匹配、安装中途切换账号、isBusy 抛错、后台 download_failed。
 * - tier：unit（进程内 fake ports 与 fake timers，无网络或磁盘 I/O）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPeerAppUpdateHandler,
  PEER_APP_UPDATE_APPLY_DELAY_MS,
  type PeerAppUpdateApplyResult,
  type PeerAppUpdateCheckResult,
  type PeerAppUpdatePorts,
} from '../peerAppUpdate.js';

function setup(overrides: Partial<PeerAppUpdatePorts> = {}) {
  let nowMs = 1_000_000;
  let ownerCurrent = true;
  let checkResult: PeerAppUpdateCheckResult = {
    status: 'available',
    currentVersion: '0.1.143',
    targetVersion: '0.1.145',
  };
  let busyResult: Promise<boolean> | (() => Promise<boolean>) = async () => false;
  let applyImpl: PeerAppUpdatePorts['apply'] = async (options) => {
    const ok = await options.beforeRelaunch();
    if (!ok) return { status: 'failed', reason: 'cancelled', errorCode: 'relaunch_cancelled' };
    if (options.beforeSpawn && !options.beforeSpawn()) {
      return { status: 'failed', reason: 'cancelled', errorCode: 'relaunch_cancelled' };
    }
    return { status: 'relaunching', targetVersion: options.expectedVersion };
  };

  const check = vi.fn(async () => checkResult);
  const apply = vi.fn((options: Parameters<PeerAppUpdatePorts['apply']>[0]) => applyImpl(options));
  const isBusy = vi.fn(() => (typeof busyResult === 'function' ? busyResult() : busyResult));

  const ports: PeerAppUpdatePorts = {
    platform: 'darwin',
    appVersion: () => checkResult.currentVersion,
    check,
    apply,
    isBusy,
    captureScope: () => () => ownerCurrent,
    now: () => nowMs,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };

  const handler = createPeerAppUpdateHandler(ports);
  return {
    handler,
    check,
    apply,
    isBusy,
    advanceNow: (ms: number) => { nowMs += ms; },
    setCheck: (next: PeerAppUpdateCheckResult) => { checkResult = next; },
    setBusy: (fn: () => Promise<boolean>) => { busyResult = fn; },
    setOwnerCurrent: (current: boolean) => { ownerCurrent = current; },
    setApply: (fn: PeerAppUpdatePorts['apply']) => { applyImpl = fn; },
  };
}

describe('createPeerAppUpdateHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports available updates with fail-closed busy status and short-caches repeated status reads', async () => {
    const ctx = setup();
    ctx.setBusy(async () => { throw new Error('probe failed'); });

    const first = await ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac');
    expect(first).toEqual({
      version: 1,
      state: 'available',
      currentVersion: '0.1.143',
      targetVersion: '0.1.145',
      busy: true,
      platform: 'darwin',
    });

    const second = await ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac');
    expect(second).toMatchObject({ state: 'available', targetVersion: '0.1.145', busy: true });
    expect(ctx.check).toHaveBeenCalledTimes(1);

    ctx.advanceNow(31_000);
    await ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac');
    expect(ctx.check).toHaveBeenCalledTimes(2);
    ctx.handler.dispose();
  });

  it('reports unsupported for dev or blocked builds and rejects install', async () => {
    const ctx = setup();
    ctx.setCheck({ status: 'unsupported', currentVersion: '0.0.0', reason: 'dev' });

    await expect(ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac')).resolves.toMatchObject({
      state: 'unsupported',
      currentVersion: '0.0.0',
    });
    await expect(
      ctx.handler.handle({ action: 'install', expectedVersion: '0.1.145' }, 'ctrl-1', 'Studio Mac'),
    ).rejects.toThrow('[PEER_APP_UPDATE_UNSUPPORTED]');
    expect(ctx.apply).not.toHaveBeenCalled();
    ctx.handler.dispose();
  });

  it('rejects malformed requests and version drift before touching the built-in updater', async () => {
    const ctx = setup();
    await expect(ctx.handler.handle({ action: 'install', expectedVersion: 'not-a-version' }, 'ctrl-1', 'Studio Mac'))
      .rejects.toThrow('[PEER_APP_UPDATE_INVALID]');
    await expect(ctx.handler.handle({ action: 'install', expectedVersion: '0.1.144' }, 'ctrl-1', 'Studio Mac'))
      .rejects.toThrow('[PEER_APP_UPDATE_VERSION_CHANGED]');
    expect(ctx.apply).not.toHaveBeenCalled();
    ctx.handler.dispose();
  });

  it('acknowledges install before applying, stays idempotent for same version, and delegates to apply', async () => {
    const ctx = setup();
    const accepted = await ctx.handler.handle(
      { action: 'install', expectedVersion: '0.1.145' },
      'ctrl-1',
      'Studio Mac',
    );
    expect(accepted).toEqual({
      version: 1,
      accepted: true,
      state: 'downloading',
      targetVersion: '0.1.145',
    });
    // Reply leaves before built-in apply starts.
    expect(ctx.apply).not.toHaveBeenCalled();

    // Same version while active is idempotent; different version is busy.
    await expect(ctx.handler.handle({ action: 'install', expectedVersion: '0.1.145' }, 'ctrl-1', 'Studio Mac'))
      .resolves.toEqual(accepted);
    await expect(ctx.handler.handle({ action: 'install', expectedVersion: '0.1.146' }, 'ctrl-1', 'Studio Mac'))
      .rejects.toThrow('[PEER_APP_UPDATE_BUSY]');

    await vi.advanceTimersByTimeAsync(PEER_APP_UPDATE_APPLY_DELAY_MS);
    expect(ctx.apply).toHaveBeenCalledTimes(1);
    expect(ctx.apply.mock.calls[0]?.[0]?.expectedVersion).toBe('0.1.145');
    await expect(ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac')).resolves.toMatchObject({
      state: 'relaunching',
      targetVersion: '0.1.145',
    });
    ctx.handler.dispose();
  });

  it('cancels relaunch if account scope changes before spawn and reports failure code via status', async () => {
    const ctx = setup();
    ctx.setApply(async (options): Promise<PeerAppUpdateApplyResult> => {
      ctx.setOwnerCurrent(false);
      const proceed = await options.beforeRelaunch();
      expect(proceed).toBe(false);
      return { status: 'failed', reason: 'cancelled', errorCode: 'relaunch_cancelled' };
    });

    await ctx.handler.handle({ action: 'install', expectedVersion: '0.1.145' }, 'ctrl-1', 'Studio Mac');
    await vi.advanceTimersByTimeAsync(PEER_APP_UPDATE_APPLY_DELAY_MS);

    await expect(ctx.handler.handle({ action: 'status' }, 'ctrl-1', 'Studio Mac')).resolves.toMatchObject({
      state: 'available',
      targetVersion: '0.1.145',
      lastErrorCode: 'relaunch_cancelled',
    });
    ctx.handler.dispose();
  });

  it('coalesces concurrent install requests across awaited check so apply runs once without false failure', async () => {
    const resolvers: Array<(v: PeerAppUpdateCheckResult) => void> = [];
    const ctx = setup({
      check: vi.fn(() => new Promise<PeerAppUpdateCheckResult>((resolve) => { resolvers.push(resolve); })),
    });
    const first = ctx.handler.handle({ action: 'install', expectedVersion: '0.1.145' }, 'ctrl-1', 'Mac A');
    const second = ctx.handler.handle({ action: 'install', expectedVersion: '0.1.145' }, 'ctrl-2', 'Mac B');
    for (const resolve of resolvers) {
      resolve({ status: 'available', currentVersion: '0.1.143', targetVersion: '0.1.145' });
    }
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ version: 1, accepted: true, state: 'downloading', targetVersion: '0.1.145' });
    expect(r2).toEqual(r1);

    await vi.advanceTimersByTimeAsync(PEER_APP_UPDATE_APPLY_DELAY_MS);
    expect(ctx.apply).toHaveBeenCalledTimes(1);
    ctx.handler.dispose();
  });
});
