// @vitest-environment jsdom
//
// EnvCheckContext 启动检查时序回归。
//
// 背景(2026-07):热更 zip 与 agent 二进制共用 main 侧单槽(maxConcurrent=1)
// FIFO 下载调度器,物理串行。splash 进度条必须跟随"当前真正在下载的那一段",
// 段切换无动画归零;终态(update_done / download_failed / manifest_failed / failed)
// 不被乱序尾包刷掉;热更下载失败要留在 splash 弹重试而不是被 'passed' 冲掉。
// 本文件用可控的 electronAPI mock 逐事件重放各时序场景。

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => false }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => false }));

import { EnvCheckProvider, useEnvCheck } from '../EnvCheckContext';

/* ── 可控 electronAPI mock ── */

interface Deferred<T> {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

type BinaryPayload = Record<string, unknown>;
type UpdatePayload = Record<string, unknown>;

let binaryCb: (p: BinaryPayload) => void = () => {};
let updateCb: (p: UpdatePayload) => void = () => {};
let envCheckCalls: Array<Deferred<unknown>> = [];
let appUpdateCalls: Array<Deferred<unknown>> = [];

beforeEach(() => {
  binaryCb = () => {};
  updateCb = () => {};
  envCheckCalls = [];
  appUpdateCalls = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onBinaryDownloadProgress: (cb: (p: BinaryPayload) => void) => {
      binaryCb = cb;
      return () => {};
    },
    onAppUpdateProgress: (cb: (p: UpdatePayload) => void) => {
      updateCb = cb;
      return () => {};
    },
    checkEnvironment: () =>
      new Promise((resolve, reject) => {
        envCheckCalls.push({ resolve, reject });
      }),
    checkAppUpdate: () =>
      new Promise((resolve, reject) => {
        appUpdateCalls.push({ resolve, reject });
      }),
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EnvCheckProvider>{children}</EnvCheckProvider>
);

/**
 * 挂载 provider 并手动发起一轮完整 checkEnvironment。
 *
 * 注意:vitest 下 import.meta.env.DEV === true,mount 时的 auto-check effect 走
 * dev 短路径,只消费 envCheckCalls[0](本文件永不 resolve 它,让它悬着)。
 * 手动调用产生 appUpdateCalls[0](Phase 1)与 envCheckCalls[1](Phase 2)。
 */
async function mountAndKick() {
  const view = renderHook(() => useEnvCheck(), { wrapper });
  await waitFor(() => expect(envCheckCalls.length).toBe(1));
  await act(async () => {
    void view.result.current.checkEnvironment();
  });
  await waitFor(() => expect(envCheckCalls.length).toBe(2));
  expect(appUpdateCalls.length).toBe(1);
  return view;
}

const flush = () => act(async () => {});

describe('EnvCheckContext dev 短路径的 ripgrep fail-fast (#1956)', () => {
  // vitest 下 import.meta.env.DEV === true,mount 的 auto-check 走 dev 短路径,
  // 只消费 envCheckCalls[0]。
  it('dev:ripgrep failed 进 failed 态,不被 dev 的无条件放行吞掉', async () => {
    const view = renderHook(() => useEnvCheck(), { wrapper });
    await waitFor(() => expect(envCheckCalls.length).toBe(1));

    await act(async () => {
      envCheckCalls[0].resolve({
        allPassed: false,
        ripgrep: { status: 'failed', error: 'Bundled ripgrep not found' },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe('failed'));
  });

  it('dev:claude/codex 缺失维持既有放行(只有 ripgrep 失败才拦)', async () => {
    const view = renderHook(() => useEnvCheck(), { wrapper });
    await waitFor(() => expect(envCheckCalls.length).toBe(1));

    await act(async () => {
      envCheckCalls[0].resolve({
        allPassed: false,
        claudeCode: { status: 'failed', error: 'no claude binary' },
      });
    });

    await waitFor(() => expect(view.result.current.status).toBe('passed'));
  });
});

describe('EnvCheckContext 启动下载进度时序', () => {
  it('热更先下(常态):Phase 2 在途期间热更进度直接驱动 splash,二进制接管时归零', async () => {
    const { result } = await mountAndKick();
    expect(result.current.status).toBe('checking');
    const reset0 = result.current.resetSignal;

    // 热更段:二进制在队列里排队(无事件),热更进度必须可见 —— 本次修复的核心。
    act(() => updateCb({ progress: 30, received: 30 * 1024 * 1024, total: 100 * 1024 * 1024 }));
    expect(result.current.status).toBe('updating');
    expect(result.current.downloadProgress).toBe(30);

    act(() => updateCb({ progress: 100, received: 100 * 1024 * 1024, total: 100 * 1024 * 1024 }));
    expect(result.current.downloadProgress).toBe(100);
    expect(result.current.resetSignal).toBe(reset0); // 同段内不归零

    // 热更下完,Phase 1 resolve(等待 relaunch);renderer 仍在等 Phase 2。
    appUpdateCalls[0].resolve({ hasUpdate: true, action: 'relaunch', version: '9.9.9' });
    await flush();

    // 二进制段接管:进度条无动画归零 + 状态切 downloading。
    act(() => binaryCb({ progress: 5, step: 1, totalSteps: 2 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(5);
    expect(result.current.step).toBe(1);
    expect(result.current.resetSignal).toBe(reset0 + 1);

    // 热更段被延迟送达的尾包:二进制段活跃期间必须丢弃,不得把进度拉回 100。
    act(() => updateCb({ progress: 100, received: 100, total: 100 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(5);

    act(() => binaryCb({ progress: 100, step: 1, totalSteps: 2 }));

    // Phase 2 通过 → Phase 1 已 resolve → 直接进入 update_done(重启提示)。
    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    await waitFor(() => expect(result.current.status).toBe('update_done'));
    expect(result.current.updateVersion).toBe('9.9.9');
  });

  it('二进制先下:Phase 2 结束后热更接管,二进制乱序尾包被丢弃', async () => {
    const { result } = await mountAndKick();
    const reset0 = result.current.resetSignal;

    // 二进制段先行。
    act(() => binaryCb({ progress: 40 }));
    expect(result.current.status).toBe('downloading');
    expect(result.current.downloadProgress).toBe(40);
    expect(result.current.resetSignal).toBe(reset0); // 首段无需归零

    act(() => binaryCb({ progress: 100 }));

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });

    // Phase 2 已返回:二进制尾包(跨通道乱序)必须丢弃。
    act(() => binaryCb({ progress: 77 }));
    expect(result.current.downloadProgress).toBe(100);

    // 热更段接管:归零 + updating。
    act(() => updateCb({ progress: 10, received: 10, total: 100 }));
    expect(result.current.status).toBe('updating');
    expect(result.current.downloadProgress).toBe(10);
    expect(result.current.resetSignal).toBe(reset0 + 1);

    appUpdateCalls[0].resolve({ hasUpdate: true, action: 'relaunch', version: '9.9.9' });
    await waitFor(() => expect(result.current.status).toBe('update_done'));
  });

  it('D 场景 reset payload:归零一次,不重复 bump', async () => {
    const { result } = await mountAndKick();
    const reset0 = result.current.resetSignal;

    act(() => binaryCb({ progress: 100, step: 1, totalSteps: 2 }));
    act(() => binaryCb({ progress: 0, step: 2, totalSteps: 2, reset: true }));
    expect(result.current.resetSignal).toBe(reset0 + 1);
    expect(result.current.downloadProgress).toBe(0);
    expect(result.current.step).toBe(2);
  });

  it('二进制检查失败是终态:后台热更进度事件不得刷回 updating(防 splash 卡死)', async () => {
    const { result } = await mountAndKick();

    act(() => binaryCb({ failed: true, error: 'NETWORK' }));
    expect(result.current.status).toBe('failed');

    // 热更包仍在后台下载,它的进度不能顶掉重试提示 ——
    // checkEnvironment 在 Phase 2 失败时已 return,没有人再消费 updatePromise。
    act(() => updateCb({ progress: 50, received: 50, total: 100 }));
    expect(result.current.status).toBe('failed');

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: false });
    });
    expect(result.current.status).toBe('failed');
  });

  it('热更下载失败:reply error 落地为 download_failed,不被 passed 冲掉', async () => {
    const { result } = await mountAndKick();

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });

    act(() => updateCb({ progress: 20, received: 20, total: 100 }));
    expect(result.current.status).toBe('updating');

    // failed 事件先到 → download_failed;随后 reply 到达,旧实现在这里无条件
    // setStatus('passed') 把重试弹窗冲掉(race 回归点)。
    act(() => updateCb({ failed: true, error: 'NETWORK' }));
    expect(result.current.status).toBe('download_failed');

    appUpdateCalls[0].resolve({ hasUpdate: true, action: 'none', error: 'download_failed' });
    await flush();
    await waitFor(() => expect(result.current.status).toBe('download_failed'));
  });

  it('manifest 拉取失败:放行进 app(离线用户不能被锁在 splash)', async () => {
    const { result } = await mountAndKick();

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    appUpdateCalls[0].resolve({ hasUpdate: false, action: 'none', error: 'manifest_failed' });
    await waitFor(() => expect(result.current.status).toBe('passed'));
  });

  it('update_done 终态不被热更进度尾包刷掉(既有保护回归)', async () => {
    const { result } = await mountAndKick();

    await act(async () => {
      envCheckCalls[1].resolve({ allPassed: true });
    });
    appUpdateCalls[0].resolve({ hasUpdate: true, action: 'relaunch', version: '9.9.9' });
    await waitFor(() => expect(result.current.status).toBe('update_done'));

    act(() => updateCb({ progress: 100, received: 100, total: 100 }));
    expect(result.current.status).toBe('update_done');
  });
});
