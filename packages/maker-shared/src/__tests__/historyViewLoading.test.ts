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

describe('history read coverage', () => {
  // A latest page can advance beyond the cached tail while the phone is away.
  // The old overlap-only tests never exercised this gap (2026-10-25 shrink).
  // Equal timestamps still have distinct rowid order; time equality is not a boundary.
  it.each(['join', 'same-time', 'failure', 'blur', 'repeated-cursor'] as const)('keeps the cached reading window until a disconnected refresh settles (%s)', async (outcome) => {
    const makePage = (ids: number[], hasMore = true): HistoryViewPage<HistoryMessageSource> => ({
      version: 1, items: ids.map(id => ({ type: 'messages', key: String(id), messages: [{
        id: String(id), clientId: String(id), role: 'user', content: String(id),
        createdAt: new Date(1700000000000 + (outcome === 'same-time' ? 0 : id * 1000)).toISOString(),
      }] })), hasMore, nextCursor: hasMore ? String(ids[0]) : null,
    });
    let finish!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    let fail!: (error: Error) => void;
    const read = vi.fn().mockResolvedValueOnce(makePage([1, 2, 3], false))
      .mockResolvedValueOnce(makePage([7, 8]))
      .mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const view = new HistoryViewController<HistoryMessageSource>({ page: read, details: vi.fn(), expanded: vi.fn(async () => undefined) });
    await view.refresh();
    const visible: string[][] = [];
    view.subscribe(() => visible.push(view.getSnapshot().items.map(item => item.key)));
    const pending = view.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3), { interval: 1 });
    expect(view.getSnapshot().items.map(item => item.key)).toEqual(['1', '2', '3']);
    if (outcome === 'blur') view.setActive(false);
    if (outcome === 'failure') fail(new Error('temporary read failure'));
    else finish(outcome === 'repeated-cursor' ? makePage([7, 8]) : makePage([3, 4, 5, 6]));
    await pending;
    expect(view.getSnapshot().items.map(item => item.key)).toEqual(outcome === 'join' || outcome === 'same-time'
      ? ['1', '2', '3', '4', '5', '6', '7', '8'] : ['1', '2', '3']);
    expect(visible.every(items => items[0] === '1')).toBe(true);
    expect(view.getSnapshot().hasMore).toBe(false);
    if (outcome === 'failure' || outcome === 'repeated-cursor') expect(view.getSnapshot().error).toBeTruthy();
  });
  // Desktop's push-driven repair asks these two questions to avoid a second page read
  // per notice; an older-page read must not count as covering a latest-page notice.
  it('reports when the latest page was last read and whether a latest read is in flight', async () => {
    const { view, transport } = fixture();
    expect(view.latestReadStartedAt()).toBe(0);
    expect(view.isReadingLatest()).toBe(false);
    let finish!: (value: typeof page) => void;
    transport.page.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const before = Date.now();
    const latest = view.refresh();
    expect(view.isReadingLatest()).toBe(true);
    expect(view.latestReadStartedAt()).toBeGreaterThanOrEqual(before);
    finish(page);
    await latest;
    expect(view.isReadingLatest()).toBe(false);
    const startedAt = view.latestReadStartedAt();
    transport.page.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const older = view.refresh(true);
    expect(view.isReadingLatest()).toBe(false);
    expect(view.latestReadStartedAt()).toBe(startedAt);
    finish(page);
    await older;
  });

  it('stamps a latest read as certified only after it was applied', async () => {
    const { view, transport } = fixture();
    expect(view.latestReadOkStartedAt()).toBe(0);
    transport.page.mockRejectedValueOnce(new Error('link hiccup'));
    await view.refresh();
    expect(view.latestReadStartedAt()).toBeGreaterThan(0);
    expect(view.latestReadOkStartedAt()).toBe(0);
    await view.refresh();
    expect(view.latestReadOkStartedAt()).toBe(view.latestReadStartedAt());
  });
});

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
