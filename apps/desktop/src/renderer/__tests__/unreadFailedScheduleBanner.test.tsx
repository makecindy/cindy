// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnreadFailedScheduleBanner } from '@/components/chat/UnreadFailedScheduleBanner';
import { useReadFailedScheduleRuns } from '@/features/scheduler/hooks/useReadFailedScheduleRuns';
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
function View({
  runIds,
  visible = true,
  showBanner = true,
}: {
  runIds: string[];
  visible?: boolean;
  showBanner?: boolean;
}) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => subscribeScheduleRunReadSync(refresh), []);
  useReadFailedScheduleRuns(
    runIds.filter((id) => !readIds.has(id)),
    visible,
  );
  return showBanner ? <UnreadFailedScheduleBanner /> : null;
}

beforeEach(() => {
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
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('historical failed schedule notice', () => {
  it('reads on opening even when running or specific errors replace the generic banner', async () => {
    render(<View runIds={['old']} showBanner={false} />);
    await waitFor(() => expect(readIds.has('old')).toBe(true));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
  });

  it('marks the batch read on opening and keeps the notice after reopening, without a button', async () => {
    const view = render(<View runIds={['old-1', 'old-2']} />);
    expect(screen.queryByRole('button')).toBeNull();
    await waitFor(() => expect(readIds).toEqual(new Set(['old-1', 'old-2'])));
    view.rerender(<View runIds={['old-2', 'old-1']} />);
    expect(markRunRead.mock.calls.map(([id]) => id)).toEqual(['old-1', 'old-2']);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    view.unmount();
    render(<View runIds={['old-1', 'old-2']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    expect(markRunRead).toHaveBeenCalledTimes(2);
  });

  it('does not read a mounted background window until it gains focus', async () => {
    focused = false;
    render(<View runIds={['old']} />);
    expect(markRunRead).not.toHaveBeenCalled();
    focused = true;
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(readIds.has('old')).toBe(true));
  });

  it.each(['hidden-document', 'hidden-pane'] as const)(
    'waits for actual viewing when mounted in a %s',
    async (kind) => {
      if (kind === 'hidden-document') visibility = 'hidden';
      const view = render(<View runIds={['old']} visible={kind !== 'hidden-pane'} />);
      expect(markRunRead).not.toHaveBeenCalled();
      visibility = 'visible';
      fireEvent(window, new Event('focus'));
      fireEvent(document, new Event('visibilitychange'));
      view.rerender(<View runIds={['old']} />);
      await waitFor(() => expect(readIds.has('old')).toBe(true));
    },
  );

  it('counts a quick opening as read without waiting for a dwell', async () => {
    const view = render(<View runIds={['task-a']} />);
    expect(markRunRead).toHaveBeenCalledWith('task-a');
    view.unmount();
    render(<View runIds={['task-b']} />);
    await waitFor(() => expect(readIds).toEqual(new Set(['task-a', 'task-b'])));
  });

  it('marks a new failure read when it arrives in the open task', async () => {
    const view = render(<View runIds={['old']} />);
    await waitFor(() => expect(readIds.has('old')).toBe(true));
    view.rerender(<View runIds={['old', 'new']} />);
    await waitFor(() => expect(readIds).toEqual(new Set(['old', 'new'])));
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
    focused = false;
    fireEvent(window, new Event('blur'));
    view.rerender(<View runIds={['old-ok', 'old-failed', 'new']} />);
    await act(async () => finishOld());
    expect(markRunRead.mock.calls.map(([id]) => id)).toEqual(['old-failed', 'old-ok']);
    expect(readIds).toEqual(new Set(['old-ok']));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    // 旧请求完成不会顺带标记后台到达的 new。
    expect(markRunRead).not.toHaveBeenCalledWith('new');
    focused = true;
    fireEvent(window, new Event('focus'));
    await act(async () => {});
    const attempts = markRunRead.mock.calls.length;
    view.rerender(<View runIds={['new', 'old-failed', 'old-ok']} />);
    expect(markRunRead).toHaveBeenCalledTimes(attempts);
    // 不对持续 IPC 失败循环重试；再次查看时可重新确认。
    markRunRead.mockImplementation(async (id) => {
      readIds.add(id);
    });
    focused = false;
    fireEvent(window, new Event('blur'));
    focused = true;
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(readIds).toEqual(new Set(['old-ok', 'old-failed', 'new'])));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
  });
});
