import { describe, expect, it, vi } from 'vitest';
import { HistoryViewController } from '../historyViewController.js';
import type { HistoryMessageSource, HistoryViewPage } from '../historyView.js';

const page: HistoryViewPage<HistoryMessageSource> = {
  version: 1, items: [], hasMore: true, nextCursor: 'older',
};

function fixture() {
  const transport = { page: vi.fn(async () => page), details: vi.fn(), expanded: vi.fn(async () => undefined) };
  const view = new HistoryViewController(transport);
  return { view, transport };
}

describe('history pagination feedback', () => {
  it('keeps initial and repeated background reads silent, including a queued older page', async () => {
    const { view, transport } = fixture();
    const feedback: boolean[] = [];
    view.subscribe(() => feedback.push(view.isLoadingOlder()));
    await view.refresh();
    for (let index = 0; index < 3; index++) await view.refresh();
    expect(feedback.every((loading) => !loading)).toBe(true);

    let finish!: (value: typeof page) => void;
    transport.page.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const refresh = view.refresh();
    const older = view.refresh(true);
    expect(view.getSnapshot().loading).toBe(true);
    expect(view.isLoadingOlder()).toBe(false);
    finish(page);
    await refresh; await older;
    expect(feedback.slice(-4)).toEqual([false, false, true, false]);
    expect(transport.page).toHaveBeenLastCalledWith('older');
  });

  it.each(['failure', 'offline', 'blur', 'reset'] as const)('clears pagination feedback after %s', async (end) => {
    const { view, transport } = fixture();
    await view.refresh();
    let finish!: (value: typeof page) => void;
    let fail!: (error: Error) => void;
    transport.page.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const older = view.refresh(true);
    expect(view.isLoadingOlder()).toBe(true);
    if (end === 'failure') fail(new Error('unavailable'));
    else {
      if (end === 'offline') view.setNetworkAvailable(false);
      if (end === 'blur') view.setActive(false);
      if (end === 'reset') view.reset();
      expect(view.isLoadingOlder()).toBe(false);
      finish(page);
    }
    await older;
    expect(view.isLoadingOlder()).toBe(false);
  });
});
