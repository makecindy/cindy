// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostDaemonsSnapshot } from '../../../../../../shared/hostDaemons';

vi.mock('react-i18next', () => ({
  // 插值参数拼进返回值，让断言能区分「带了数量」与「裸 key」两种调用。
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0
        ? `${key}:${Object.values(opts).join(',')}`
        : key,
  }),
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { HostDaemonsView } from '../HostDaemonsView';

function snapshotWith(name: string | null, extra: Partial<HostDaemonsSnapshot> = {}) {
  const base: HostDaemonsSnapshot = {
    capturedAtMs: 1,
    supported: true,
    entries: [],
    unrelatedCount: 0,
    pendingCount: 0,
    incomplete: false,
    ...extra,
  };
  if (name === null) return base;
  return {
    ...base,
    entries: [
      {
        id: `scheduled-task:${name}`,
        name,
        kind: 'scheduled-task' as const,
        state: 'ready' as const,
        command: `cmd /c ${name}`,
        trigger: 'logon' as const,
        ownerTitle: '任务 A',
        ownerSessionId: 'session-a',
        lastRunAtMs: null,
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让已排定的定时器和已结算的 promise 都跑完（假时钟下不用 waitFor 的轮询）。 */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

let changedListener: (() => void) | null = null;
const offChanged = vi.fn();
const onChanged = vi.fn((listener: () => void) => {
  changedListener = listener;
  return offChanged;
});
const list = vi.fn(async () => snapshotWith(null));
const subscribe = vi.fn<() => Promise<void>>(async () => {});
const unsubscribe = vi.fn(async () => undefined);

/** 模拟 main 发来一条变化通知，并等合并窗口过去。 */
async function notify() {
  // 分两步：React 要等触发更新的那次 act 结束才提交渲染、排定合并定时器。
  await act(async () => {
    changedListener?.();
  });
  await act(async () => {
    vi.advanceTimersByTime(250);
    await settle();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // 与真实桥接一致：退订后通知不再到达。
  offChanged.mockReset();
  offChanged.mockImplementation(() => {
    changedListener = null;
  });
  changedListener = null;
  offChanged.mockClear();
  onChanged.mockClear();
  list.mockReset();
  list.mockResolvedValue(snapshotWith(null));
  subscribe.mockReset();
  subscribe.mockResolvedValue(undefined);
  unsubscribe.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hostDaemons: {
        list,
        subscribe,
        unsubscribe,
        onChanged,
        stop: vi.fn(async () => undefined),
        run: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HostDaemonsView 的读取节奏（工程规范 §8.2 / §8.6）', () => {
  it('可见时订阅；等第一轮推进做完才读清单，不先显示空清单', async () => {
    const firstRound = deferred<void>();
    subscribe.mockImplementation(() => firstRound.promise);
    list.mockResolvedValue(snapshotWith('cindy-daily'));

    const { unmount } = render(<HostDaemonsView visible />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 第一轮归属推进还没结束：此时读台账不是第一轮的结果，所以还不读。
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByTestId('spinner')).toBeTruthy();

    await act(async () => {
      firstRound.resolve();
      await settle();
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.getByText('cindy-daily')).toBeTruthy();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(offChanged).toHaveBeenCalledTimes(1);
  });

  it('不可见时不订阅、不读清单', () => {
    render(<HostDaemonsView visible={false} />);
    expect(subscribe).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('变化通知到达后重读一次；读取在途时来的通知只补读一次', async () => {
    const held = deferred<HostDaemonsSnapshot>();
    let calls = 0;
    list.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(snapshotWith('one'));
      if (calls === 2) return held.promise;
      return Promise.resolve(snapshotWith('two'));
    });

    render(<HostDaemonsView visible />);
    await act(settle);
    expect(screen.getByText('one')).toBeTruthy();

    await notify();
    expect(calls).toBe(2); // 第二次读取在途
    await notify();
    await notify();
    expect(calls).toBe(2); // 在途期间的两条通知不各自触发读取

    await act(async () => {
      held.resolve(snapshotWith('one'));
      await settle();
    });
    expect(calls).toBe(3); // 只补读一次
    expect(screen.getByText('two')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await settle();
    });
    expect(calls).toBe(3); // 没有新通知就不自己再读
  });

  it('重读失败时保留旧清单并提示，不自行重试', async () => {
    list.mockResolvedValueOnce(snapshotWith('one'));
    render(<HostDaemonsView visible />);
    await act(settle);
    expect(screen.getByText('one')).toBeTruthy();

    list.mockRejectedValueOnce(new Error('scan failed'));
    await notify();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('rightSidebar.hostDaemons.refreshFailed')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await settle();
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('不可见后退订；此后不再因通知读取', async () => {
    render(<HostDaemonsView visible />);
    await act(settle);
    expect(list).toHaveBeenCalledTimes(1);

    const view = render(<HostDaemonsView visible />);
    view.rerender(<HostDaemonsView visible={false} />);
    await act(settle);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await notify();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('页脚如实说明有来源没读全', async () => {
    list.mockResolvedValue(snapshotWith('one', { incomplete: true, pendingCount: 2 }));
    render(<HostDaemonsView visible />);
    await act(settle);
    expect(screen.getByText('rightSidebar.hostDaemons.incomplete')).toBeTruthy();
    expect(screen.queryByText(/rightSidebar\.hostDaemons\.checking/)).toBeNull();
  });
});
