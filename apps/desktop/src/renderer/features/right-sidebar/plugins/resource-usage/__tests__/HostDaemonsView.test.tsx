// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostDaemonsSnapshot, HostDaemonsUpdate } from '../../../../../../shared/hostDaemons';

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
  ConfirmDialog: ({ open }: { open?: boolean }) => (
    <span data-testid="confirm" data-open={String(open)} />
  ),
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

const ok = (name: string | null, extra: Partial<HostDaemonsSnapshot> = {}): HostDaemonsUpdate => ({
  ok: true,
  snapshot: snapshotWith(name, extra),
});
const FAILED: HostDaemonsUpdate = { ok: false, reason: 'internal', message: 'scan failed' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让已结算的 promise 和已排定的定时器都跑完（假时钟下不用 waitFor 的轮询）。 */
async function settle() {
  await act(async () => {
    vi.advanceTimersByTime(0);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}

let changedListener: ((update: HostDaemonsUpdate) => void) | null = null;
const offChanged = vi.fn();
const onChanged = vi.fn((listener: (update: HostDaemonsUpdate) => void) => {
  changedListener = listener;
  return offChanged;
});
const refresh = vi.fn<() => Promise<HostDaemonsUpdate>>(async () => ok(null));
const subscribe = vi.fn<() => Promise<HostDaemonsUpdate>>(async () => ok(null));
const unsubscribe = vi.fn(async () => undefined);

/** 模拟 main 推来一轮更新。 */
async function push(update: HostDaemonsUpdate) {
  await act(async () => {
    changedListener?.(update);
    await settle();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // 与真实桥接一致：退订后推送不再到达。
  offChanged.mockReset();
  offChanged.mockImplementation(() => {
    changedListener = null;
  });
  changedListener = null;
  offChanged.mockClear();
  onChanged.mockClear();
  refresh.mockReset();
  refresh.mockResolvedValue(ok(null));
  subscribe.mockReset();
  subscribe.mockResolvedValue(ok(null));
  unsubscribe.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hostDaemons: {
        subscribe,
        unsubscribe,
        onChanged,
        refresh,
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
  it('可见时订阅；清单只来自订阅的首轮回执和之后的推送，不自己读', async () => {
    const firstRound = deferred<HostDaemonsUpdate>();
    subscribe.mockImplementation(() => firstRound.promise);

    const { unmount } = render(<HostDaemonsView visible />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 第一轮还没做完：不先显示空清单。
    expect(screen.getByTestId('spinner')).toBeTruthy();

    await act(async () => {
      firstRound.resolve(ok('cindy-daily'));
      await settle();
    });
    expect(screen.getByText('cindy-daily')).toBeTruthy();

    // main 推来下一轮：原地替换，清单没有别的来源。
    await push(ok('cindy-nightly'));
    expect(screen.queryByText('cindy-daily')).toBeNull();
    expect(screen.getByText('cindy-nightly')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(offChanged).toHaveBeenCalledTimes(1);
  });

  it('不可见时不订阅', () => {
    render(<HostDaemonsView visible={false} />);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('循环停下后手动刷新能重新拉起一轮；在途期间按钮不可重复点', async () => {
    render(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('rightSidebar.hostDaemons.empty')).toBeTruthy();

    const round = deferred<HostDaemonsUpdate>();
    refresh.mockImplementation(() => round.promise);
    await act(async () => {
      screen.getByRole('button', { name: 'rightSidebar.hostDaemons.refresh' }).click();
      await settle();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // 新清单没到之前旧清单保留，按钮显示进行中且不可点。
    expect(screen.getByText('rightSidebar.hostDaemons.empty')).toBeTruthy();
    const busyButton = screen.getByRole('button', { name: 'rightSidebar.hostDaemons.scanning' });
    expect(busyButton.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      round.resolve(ok('cindy-daily'));
      await settle();
    });
    expect(screen.getByText('cindy-daily')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'rightSidebar.hostDaemons.refresh' })).toBeTruthy();
  });

  it('一轮更新失败时保留旧清单并提示；不自行重试', async () => {
    render(<HostDaemonsView visible />);
    await settle();

    refresh.mockResolvedValueOnce(FAILED);
    await act(async () => {
      screen.getByRole('button', { name: 'rightSidebar.hostDaemons.refresh' }).click();
      await settle();
    });
    expect(screen.getByText('rightSidebar.hostDaemons.empty')).toBeTruthy();
    expect(screen.getByText('rightSidebar.hostDaemons.refreshFailed')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await settle();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('订阅的第一轮就失败时显示失败态；刷新成功后进入清单', async () => {
    subscribe.mockResolvedValueOnce(FAILED);
    render(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('rightSidebar.hostDaemons.loadFailed')).toBeTruthy();

    refresh.mockResolvedValueOnce(ok('cindy-daily'));
    await act(async () => {
      screen.getByRole('button', { name: 'rightSidebar.hostDaemons.refresh' }).click();
      await settle();
    });
    expect(screen.getByText('cindy-daily')).toBeTruthy();
    expect(screen.queryByText('rightSidebar.hostDaemons.refreshFailed')).toBeNull();
  });

  it('不可见后退订；此后推送不再改变清单', async () => {
    subscribe.mockResolvedValue(ok('one'));
    const view = render(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('one')).toBeTruthy();

    view.rerender(<HostDaemonsView visible={false} />);
    await settle();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await push(ok('two'));
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.queryByText('two')).toBeNull();
  });

  it('重新可见时旧清单保留到新一轮到达', async () => {
    subscribe.mockResolvedValue(ok('one'));
    const view = render(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('one')).toBeTruthy();

    const round = deferred<HostDaemonsUpdate>();
    subscribe.mockImplementation(() => round.promise);
    view.rerender(<HostDaemonsView visible={false} />);
    await settle();
    view.rerender(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.queryByTestId('spinner')).toBeNull();

    await act(async () => {
      round.resolve(ok('two'));
      await settle();
    });
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('页脚如实说明有来源没读全', async () => {
    subscribe.mockResolvedValue(ok('one', { incomplete: true, pendingCount: 2 }));
    render(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByText('rightSidebar.hostDaemons.incomplete')).toBeTruthy();
    expect(screen.queryByText(/rightSidebar\.hostDaemons\.checking/)).toBeNull();
  });

  it('面板不可见时清掉待确认动作；重新可见不再弹出旧确认框', async () => {
    subscribe.mockResolvedValue(ok('one'));
    const view = render(<HostDaemonsView visible />);
    await settle();

    await act(async () => {
      screen.getByRole('button', { name: 'rightSidebar.hostDaemons.delete' }).click();
      await settle();
    });
    expect(screen.getByTestId('confirm').getAttribute('data-open')).toBe('true');

    view.rerender(<HostDaemonsView visible={false} />);
    await settle();
    expect(screen.getByTestId('confirm').getAttribute('data-open')).toBe('false');

    view.rerender(<HostDaemonsView visible />);
    await settle();
    expect(screen.getByTestId('confirm').getAttribute('data-open')).toBe('false');
  });
});
