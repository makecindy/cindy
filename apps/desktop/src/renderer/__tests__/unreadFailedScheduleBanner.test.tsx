// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnreadFailedScheduleBanner } from '@/components/chat/UnreadFailedScheduleBanner';
import { subscribeScheduleRunReadSync } from '@/features/scheduler/lib/scheduleRunReadSync';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

const readIds = new Set<string>();
const markRunRead = vi.fn<(id: string) => Promise<void>>();
let focused = true;
let visibility: DocumentVisibilityState = 'visible';

// 模拟已读 IPC 的权威存储和侧栏 read-sync 重查，使用真实组件与批量标记链路。
function View({ runIds, visible = true }: { runIds: string[]; visible?: boolean }) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => subscribeScheduleRunReadSync(refresh), []);
  return (
    <UnreadFailedScheduleBanner
      runIds={runIds.filter((id) => !readIds.has(id))}
      viewVisible={visible}
    />
  );
}

async function dwell(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  focused = true;
  visibility = 'visible';
  readIds.clear();
  markRunRead.mockReset().mockImplementation(async (id) => {
    readIds.add(id);
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { schedule: { markRunRead } } },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('historical failed schedule notice', () => {
  it('marks the visible batch read after dwelling, without a close button', async () => {
    const view = render(<View runIds={['old-1', 'old-2']} />);
    expect(screen.queryByRole('button')).toBeNull();
    await dwell(1_000);
    // 同内容的数组重建或排序不会阻止“看过”确认。
    view.rerender(<View runIds={['old-2', 'old-1']} />);
    await dwell(499);
    expect(markRunRead).not.toHaveBeenCalled();
    await dwell(1);
    expect(markRunRead.mock.calls.map(([id]) => id)).toEqual(['old-1', 'old-2']);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
  });

  it('does not read a mounted background window until it gains focus', async () => {
    focused = false;
    render(<View runIds={['old']} />);
    await dwell(5_000);
    expect(markRunRead).not.toHaveBeenCalled();
    focused = true;
    fireEvent(window, new Event('focus'));
    await dwell(1_500);
    expect(readIds.has('old')).toBe(true);
  });

  it.each(['blur', 'hidden-document', 'hidden-pane'] as const)(
    'restarts the dwell after %s instead of counting time out of view',
    async (kind) => {
      const view = render(<View runIds={['old']} />);
      await dwell(1_000);
      if (kind === 'blur') {
        focused = false;
        fireEvent(window, new Event('blur'));
      } else if (kind === 'hidden-document') {
        visibility = 'hidden';
        fireEvent(document, new Event('visibilitychange'));
      } else {
        view.rerender(<View runIds={['old']} visible={false} />);
      }
      await dwell(5_000);
      expect(markRunRead).not.toHaveBeenCalled();
      focused = true;
      visibility = 'visible';
      fireEvent(window, new Event('focus'));
      fireEvent(document, new Event('visibilitychange'));
      view.rerender(<View runIds={['old']} />);
      await dwell(1_499);
      expect(markRunRead).not.toHaveBeenCalled();
      await dwell(1);
      expect(readIds.has('old')).toBe(true);
    },
  );

  it('cancels on unmount and starts a fresh dwell for another task', async () => {
    const view = render(<View runIds={['task-a']} />);
    await dwell(1_000);
    view.unmount();
    render(<View runIds={['task-b']} />);
    await dwell(500);
    expect(markRunRead).not.toHaveBeenCalled();
    await dwell(1_000);
    expect(markRunRead.mock.calls).toEqual([['task-b']]);
  });

  it('gives a newly arrived failure its own dwell before acknowledging it', async () => {
    const view = render(<View runIds={['old']} />);
    await dwell(1_000);
    view.rerender(<View runIds={['old', 'new']} />);
    await dwell(500);
    expect(markRunRead).not.toHaveBeenCalled();
    await dwell(1_000);
    expect(readIds).toEqual(new Set(['old', 'new']));
  });

  it('keeps partial failures and later arrivals unread when an older write settles', async () => {
    let finishOld!: () => void;
    markRunRead.mockImplementation((id) => {
      if (id === 'old-ok') {
        return new Promise<void>((resolve) => {
          finishOld = () => {
            readIds.add(id);
            resolve();
          };
        });
      }
      return Promise.reject(new Error('IPC unavailable'));
    });
    const view = render(<View runIds={['old-ok', 'old-failed']} />);
    await dwell(1_500);
    view.rerender(<View runIds={['old-ok', 'old-failed', 'new']} />);
    await act(async () => finishOld());
    expect(markRunRead.mock.calls.map(([id]) => id)).toEqual(['old-failed', 'old-ok']);
    expect(readIds).toEqual(new Set(['old-ok']));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    // 新批次有自己的计时；旧请求完成不会顺带标记 new。
    await dwell(1_499);
    expect(markRunRead).not.toHaveBeenCalledWith('new');
    await dwell(1);
    expect(markRunRead).toHaveBeenCalledWith('new');
    const attempts = markRunRead.mock.calls.length;
    await dwell(10_000);
    expect(markRunRead).toHaveBeenCalledTimes(attempts);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    // 不对持续 IPC 失败循环重试；再次查看时可重新确认。
    markRunRead.mockImplementation(async (id) => {
      readIds.add(id);
    });
    focused = false;
    fireEvent(window, new Event('blur'));
    focused = true;
    fireEvent(window, new Event('focus'));
    await dwell(1_500);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
  });
});
