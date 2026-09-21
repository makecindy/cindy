import { describe, expect, it, vi } from 'vitest';
import { HistoryViewController } from '../historyViewController.js';
import { projectHistoryView } from '../historyViewProjection.js';
import type { HistoryMessageSource, HistoryViewPage } from '../historyView.js';

const message: HistoryMessageSource = { id: '1', clientId: 'c1', role: 'assistant', content: 'Saved answer', createdAt: '2026-09-09T00:00:00Z' };
const page: HistoryViewPage<HistoryMessageSource> = { version: 1, items: projectHistoryView([message], false), hasMore: true, nextCursor: 'older' };

describe('offline history reading', () => {
  it('restores cached content without page, detail or interest requests and reconnects in place', async () => {
    const transport = { page: vi.fn(async () => page), details: vi.fn(), expanded: vi.fn(async () => undefined) };
    const view = new HistoryViewController<HistoryMessageSource>(transport);
    view.setNetworkAvailable(false);
    await view.restoreCachedView(async () => ({ ...view.getSnapshot(), ...page, ready: true }));
    const items = view.getSnapshot().items;
    view.setActive(false); view.setActive(true);
    view.setExpanded('missing', true);
    view.invalidate();
    await view.refresh(true);
    expect(await view.locate('c1', message.createdAt)).toEqual(message);
    expect(await view.locate('absent', message.createdAt)).toBeNull();
    expect(transport.page).not.toHaveBeenCalled();
    expect(transport.details).not.toHaveBeenCalled();
    expect(transport.expanded).not.toHaveBeenCalled();
    expect(view.getSnapshot().items).toBe(items);
    view.setNetworkAvailable(true);
    await view.refresh();
    expect(transport.page).toHaveBeenCalledTimes(1);
    expect(view.getSnapshot().items).toBe(items);
    view.setActive(false);
  });

  it('keeps a pending disk restore when the computer goes offline', async () => {
    const transport = { page: vi.fn(async () => page), details: vi.fn(), expanded: vi.fn(async () => undefined) };
    const view = new HistoryViewController<HistoryMessageSource>(transport);
    const cached = { ...view.getSnapshot(), ...page, ready: true };
    let finish!: (value: typeof cached) => void;
    const pending = view.restoreCachedView(() => new Promise((resolve) => { finish = resolve; }));
    view.setNetworkAvailable(false);
    finish(cached);
    await pending;
    expect(view.getSnapshot().items).toEqual(page.items);
    expect(view.getSnapshot().ready).toBe(true);
    expect(transport.page).not.toHaveBeenCalled();
  });

  it('ignores an in-flight online response after going offline', async () => {
    let finish!: (value: HistoryViewPage<HistoryMessageSource>) => void;
    const expanded = vi.fn(async () => undefined);
    const view = new HistoryViewController<HistoryMessageSource>({ page: () => new Promise((resolve) => { finish = resolve; }), details: vi.fn(), expanded });
    const pending = view.refresh();
    view.setNetworkAvailable(false);
    finish(page); await pending;
    expect(view.getSnapshot()).toMatchObject({ items: [], ready: false, loading: false });
    expect(expanded).not.toHaveBeenCalled();
  });
});
