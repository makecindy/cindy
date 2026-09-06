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
  sessionId = 'session-1',
  dataOwnerId = 'owner-1',
}: {
  runIds: string[];
  visible?: boolean;
  showBanner?: boolean;
  sessionId?: string;
  dataOwnerId?: string;
}) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => subscribeScheduleRunReadSync(refresh), []);
  useReadFailedScheduleRuns(
    runIds.filter((id) => !readIds.has(id)),
    visible,
  );
  return showBanner ? (
    <UnreadFailedScheduleBanner
      dataOwnerId={dataOwnerId}
      sessionId={sessionId}
      latestFailedRun={{ runId: runIds.at(-1)!, firedAt: runIds.length }}
    />
  ) : null;
}

beforeEach(() => {
  focused = true;
  visibility = 'visible';
  readIds.clear();
  localStorage.clear();
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

  it('marks the batch read without clicking close and keeps the notice after reopening', async () => {
    const view = render(<View runIds={['old-1', 'old-2']} />);
    expect(
      screen.getByRole('button', { name: 'chat.unreadFailedScheduleBanner.dismissTitle' }),
    ).toBeTruthy();
    await waitFor(() => expect(readIds).toEqual(new Set(['old-1', 'old-2'])));
    view.rerender(<View runIds={['old-2', 'old-1']} />);
    expect(markRunRead.mock.calls.map(([id]) => id)).toEqual(['old-1', 'old-2']);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    view.unmount();
    render(<View runIds={['old-1', 'old-2']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    expect(markRunRead).toHaveBeenCalledTimes(2);
  });

  it('keeps a closed notice hidden after remount, but shows a new failure', async () => {
    const view = render(<View runIds={['old']} />);
    await waitFor(() => expect(readIds.has('old')).toBe(true));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
    view.unmount();
    const reopened = render(<View runIds={['old']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
    reopened.rerender(<View runIds={['old', 'new']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    await waitFor(() => expect(readIds).toEqual(new Set(['old', 'new'])));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
  });

  it('does not carry dismissal into another task or owner', () => {
    const view = render(<View runIds={['old']} />);
    fireEvent.click(screen.getByRole('button'));
    view.rerender(<View runIds={['old']} sessionId="session-2" />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    view.rerender(<View runIds={['old']} dataOwnerId="owner-2" />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    view.rerender(<View runIds={['old']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
  });

  it('syncs dismissal from another window without changing read receipts', () => {
    focused = false;
    render(<View runIds={['old']} />);
    const key = 'scheduleFailureDismissal:["owner-1","session-1"]:[1,"old"]';
    localStorage.setItem(key, '1');
    fireEvent(window, new StorageEvent('storage', { key, storageArea: localStorage }));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
    expect(markRunRead).not.toHaveBeenCalled();
    localStorage.clear();
    fireEvent(window, new StorageEvent('storage', { key: null, storageArea: localStorage }));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
  });

  it('does not overwrite a newer dismissal when a stale window closes an older notice', () => {
    const older = render(<View runIds={['old']} />);
    const newer = render(<View runIds={['old', 'new']} />);
    fireEvent.click(newer.container.querySelector('button')!);
    fireEvent.click(older.container.querySelector('button')!);
    expect(localStorage.length).toBe(1);
    // 回收旧 key 后，收到清理事件的旧窗口仍保持关闭。
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: 'scheduleFailureDismissal:["owner-1","session-1"]:[1,"old"]',
        storageArea: localStorage,
      }),
    );
    expect(older.container.querySelector('button')).toBeNull();
    older.unmount();
    newer.unmount();
    render(<View runIds={['old', 'new']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
  });

  it('can close when preference storage fails, without clearing failed read receipts', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    markRunRead.mockRejectedValue(new Error('IPC unavailable'));
    const view = render(<View runIds={['old']} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
    expect(readIds.size).toBe(0);
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: 'scheduleFailureDismissal:["owner-1","session-1"]:[0,"older"]',
        storageArea: localStorage,
      }),
    );
    expect(screen.queryByTestId('unread-failed-schedule-banner')).toBeNull();
    view.rerender(<View runIds={['old', 'new']} />);
    expect(screen.queryByTestId('unread-failed-schedule-banner')).not.toBeNull();
    await act(async () => {});
    expect(readIds.size).toBe(0);
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
