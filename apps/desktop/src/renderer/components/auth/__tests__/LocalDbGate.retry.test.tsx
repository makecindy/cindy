// @vitest-environment jsdom
/**
 * LocalDbGate.retry.test.tsx
 * ---------------------------------------------------------------------------
 * gate decision 失败的有限重试链路(睡醒白屏修复的防御层):
 * transient 失败(如跨睡眠 db RPC 假超时)重试 2 次后成功 → 正常放行;
 * 持续失败耗尽重试 → 才落 fatal 阻断渲染。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => loggerMock,
}));

const authState = vi.hoisted(() => ({
  current: {
    user: { id: 'user-1' },
    dataOwnerId: 'user-1',
    mode: 'cloud',
    logout: vi.fn().mockResolvedValue(undefined),
    exitLocalMode: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

import { LocalDbGate } from '../LocalDbGate';

type ElectronApiStub = {
  localDb: {
    // #7146: keep recovery fixtures checked against the renderer IPC contract.
    ensureReady: ReturnType<typeof vi.fn<ElectronAPI['localDb']['ensureReady']>>;
  };
  appReadyForBot: ReturnType<typeof vi.fn>;
  getUpdateStatus: ReturnType<typeof vi.fn>;
  onUpdateStatus: ReturnType<typeof vi.fn>;
};

function stubElectronApi(): ElectronApiStub {
  const api: ElectronApiStub = {
    localDb: {
      ensureReady: vi.fn<ElectronAPI['localDb']['ensureReady']>().mockResolvedValue({ ready: true }),
    },
    appReadyForBot: vi.fn().mockResolvedValue(undefined),
    // fatal 分支挂载 LocalDbFatalScreen → useUpdateStatus 需要这两个 API。
    getUpdateStatus: vi.fn().mockResolvedValue({ status: 'idle' }),
    onUpdateStatus: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function gateTree() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<LocalDbGate />}>
          <Route index element={<div data-testid="main-content" />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderGate() {
  return render(gateTree());
}

/** 让 pending 的 microtask 链跑完(fake timers 下 await Promise 需要显式 flush)。 */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceRetryDelay(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await flushAsync();
}

describe('LocalDbGate 有限重试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    authState.current.user = { id: 'user-1' };
    authState.current.dataOwnerId = 'user-1';
    authState.current.mode = 'cloud';
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('决策一次成功 → 直接放行主内容', async () => {
    stubElectronApi();
    renderGate();
    await flushAsync();
    expect(screen.getByTestId('main-content')).toBeTruthy();
  });

  // #7135 / unit: mount the real gate + fatal screen, retry a failed lease for
  // the original account, and verify admission rather than only callback calls.
  it('reopens the original account after a lease failure instead of installing an available update', async () => {
    const api = stubElectronApi();
    api.getUpdateStatus.mockResolvedValue({ status: 'ready' });
    api.localDb.ensureReady.mockResolvedValueOnce({
      ready: false,
      error: { code: 'DB_SCHEMA_LOCKED', message: 'fixture lock requires recovery' },
    });
    renderGate();
    await flushAsync();
    expect(screen.queryByTestId('main-content')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'localDbFatal.schemaLease.retry' }));
    await flushAsync();
    expect(screen.getByTestId('main-content')).toBeTruthy();
    expect(api.localDb.ensureReady).toHaveBeenNthCalledWith(2, 'user-1');
  });

  it('transient 失败 2 次后成功 → 重试后放行,不落 fatal', async () => {
    const api = stubElectronApi();
    api.localDb.ensureReady
      .mockRejectedValueOnce(new Error('db worker RPC timeout: op="queryOne" (sleep)'))
      .mockRejectedValueOnce(new Error('db worker RPC timeout: op="queryOne" (sleep)'))
      .mockResolvedValue({ ready: true });

    renderGate();
    await flushAsync();
    expect(screen.queryByTestId('main-content')).toBeNull(); // 第 1 次失败,等待重试

    await advanceRetryDelay(); // 第 2 次(重试 1)仍失败
    expect(screen.queryByTestId('main-content')).toBeNull();

    await advanceRetryDelay(); // 第 3 次(重试 2)成功
    expect(screen.getByTestId('main-content')).toBeTruthy();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying (1/2)'),
      expect.anything(),
    );
  });

  it('重试等待期 user 变化 → 新决策重置重试额度,不继承已消耗计数', async () => {
    const api = stubElectronApi();
    // 4 次 ensureReady:决策#1 失败(消耗 1 次额度)→ user 变化重置 → 决策#2/#3 失败
    // (若额度未重置,第 3 次失败时计数已达上限,会提前 fatal)→ 决策#4 成功
    api.localDb.ensureReady
      .mockRejectedValueOnce(new Error('transient #1'))
      .mockRejectedValueOnce(new Error('transient #2'))
      .mockRejectedValueOnce(new Error('transient #3'))
      .mockResolvedValue({ ready: true });

    const view = renderGate();
    await flushAsync(); // 决策#1 失败,count=1,等待重试

    // 重试等待期切换账号 → 触发全新决策
    authState.current.user = { id: 'user-2' };
    authState.current.dataOwnerId = 'user-2';
    await act(async () => {
      view.rerender(gateTree());
    });
    await flushAsync(); // 决策#2 失败;额度已重置,count=1

    await advanceRetryDelay(); // 决策#3 失败,count=2,仍有重试
    await advanceRetryDelay(); // 决策#4 成功

    expect(api.localDb.ensureReady).toHaveBeenCalledTimes(4);
    expect(loggerMock.error).not.toHaveBeenCalled(); // 未提前 fatal
    view.unmount();
  });

  it('持续失败耗尽重试 → 落 fatal:阻断主内容,渲染全屏恢复界面', async () => {
    const api = stubElectronApi();
    api.localDb.ensureReady.mockRejectedValue(
      new Error('db worker RPC timeout: op="queryOne"'),
    );

    renderGate();
    await flushAsync();
    await advanceRetryDelay();
    await advanceRetryDelay();
    await flushAsync();

    expect(screen.queryByTestId('main-content')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      'local-db gate decision failed after retries',
      expect.anything(),
    );
    // 恰好尝试 3 次(1 次原始 + 2 次重试),没有无限重试
    expect(api.localDb.ensureReady).toHaveBeenCalledTimes(3);
  });
});
