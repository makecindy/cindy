import { describe, expect, it, vi } from 'vitest';
import { projectHistoryView } from '../historyViewProjection.js';
import { isHistoryViewUnavailable, readHistoryWorkDetails, type HistoryMessageSource } from '../historyView.js';

function row(id: number, role: string, content: unknown): HistoryMessageSource {
  return { id: String(id), clientId: `c${id}`, role, content,
    createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString() };
}

describe('history reading projection', () => {
  it.each(['<tool_use_error>Permission denied</tool_use_error>', { isError: true, text: 'Failed' }])('keeps ordinary tool failures in the same recoverable activity range', (content) => {
    const rows = [row(0, 'user', 'Work'), row(1, 'thinking', 'reasoning'),
      { ...row(2, 'tool_use', { toolName: 'Read', input: {} }), toolUseId: 't' },
      { ...row(3, 'tool_result', content), toolUseId: 't' }];
    const visible = projectHistoryView(rows, true).flatMap((item) => item.type === 'messages' ? item.messages : []);
    expect(visible.map((item) => item.id)).toEqual(['0']);
    expect(projectHistoryView(rows, true)[1]).toMatchObject({ summary: { firstMessageId: '1', lastMessageId: '3' } });
  });
  it('reaches the preceding visible conversation without transmitting hundreds of hidden bodies', () => {
    const rows = [row(0, 'user', 'Inspect this problem')];
    for (let id = 1; id <= 600; id++) rows.push(row(id, 'thinking', 'detail '.repeat(1000)));
    rows.push(row(601, 'assistant', 'The result'));
    const projected = projectHistoryView(rows, false);
    expect(projected.map((item) => item.type)).toEqual(['messages', 'work', 'messages']);
    expect(projected[1]).toMatchObject({ summary: {
      firstMessageId: '1', lastMessageId: '600', messageCount: 600,
    } });
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(rows).length / 100);
    expect(rows[1].content).toBe('detail '.repeat(1000));
  });

  it('keeps delivery prose, interaction tools and reference-bearing results outside summaries', () => {
    const rows = [row(0, 'user', 'Work'), row(1, 'thinking', 'reasoning'),
      row(2, 'assistant', '# Deliverable\nA useful result'),
      { ...row(3, 'tool_use', { toolName: 'AskUserQuestion', input: {} }), toolUseId: 'ask' },
      { ...row(4, 'tool_use', { toolName: 'Read', input: {} }), toolUseId: 'media' },
      { ...row(5, 'tool_result', 'cindy-media://blobs/example.png'), toolUseId: 'media' },
      row(6, 'assistant', 'Done')];
    const projected = projectHistoryView(rows, false);
    const visible = projected.flatMap((item) => item.type === 'messages' ? item.messages : []);
    expect(visible.map((item) => item.id)).toEqual(['0', '2', '3', '4', '5', '6']);
  });

  it('keeps sealed history completed when a new active tail arrives before its user row', () => {
    const rows = [row(0, 'thinking', 'old'),
      { ...row(1, 'assistant', 'Done'), agentMeta: { turnCompleted: true } },
      row(2, 'thinking', 'new')];
    expect(projectHistoryView(rows, true).filter((item) => item.type === 'work')
      .map((item) => item.summary.isStreaming)).toEqual([false, true]);
  });
});

describe('automatic process detail reading', () => {
  it('automatically reads all pages without a user pagination action', async () => {
    const cursors: Array<string | null> = [];
    const received: string[] = [];
    await readHistoryWorkDetails({
      isCurrent: () => true,
      readPage: async (cursor) => {
        cursors.push(cursor);
        const index = cursor === null ? 1 : 2;
        return { version: 1, messages: [row(index, 'thinking', 'detail')],
          hasMore: index === 1, nextCursor: index === 1 ? '1' : null };
      },
      onPage: (rows) => received.push(...rows.map((item) => item.id)),
    });
    expect(cursors).toEqual([null, '1']);
    expect(received).toEqual(['1', '2']);
  });

  it('does not publish a late page after collapse or invalidation', async () => {
    let current = true;
    const received: unknown[] = [];
    await readHistoryWorkDetails({
      isCurrent: () => current,
      readPage: async () => {
        current = false;
        return { version: 1, messages: [row(1, 'thinking', 'late')], hasMore: false, nextCursor: null };
      },
      onPage: (rows) => received.push(rows),
    });
    expect(received).toEqual([]);
  });
});

import { HistoryViewController } from '../historyViewController.js';
import { renderHistoryView } from '../historyViewRender.js';
import type { HistoryViewPage } from '../historyView.js';
const ungroupedStructure = {
  placeholder: (summary: import('../historyView.js').HistoryWorkSummary) => ({ ...row(1, 'thinking', ''),
    clientId: summary.anchorClientId ?? summary.key.slice(5) }),
  children: () => undefined,
  sourceIds: () => [],
  rebuild: (item: unknown) => item,
};

describe('shared history view lifecycle', () => {
  it.each([true, false])('retains loaded history only when regrouping proves the same source start (%s)', async (overlap) => {
    const prefix = projectHistoryView([row(0, 'user', 'Earlier')], false);
    const rows = [row(1, 'assistant', 'Looking into it'), row(2, 'thinking', 'details'),
      row(3, 'assistant', 'Checking another part'), row(4, 'thinking', 'more')];
    const running = projectHistoryView(rows, true);
    const completed = projectHistoryView([...rows, row(5, 'assistant', 'Done')], false);
    expect(completed[0].key).not.toBe(running[0].key);
    const replacement = overlap ? completed : projectHistoryView([row(9, 'user', 'Replaced')], false);
    const read = vi.fn(async () => ({ version: 1 as const, items: running, hasMore: true, nextCursor: 'latest' }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    await view.refresh();
    read.mockResolvedValueOnce({ version: 1, items: prefix, hasMore: true, nextCursor: 'older' });
    await view.refresh(true);
    read.mockResolvedValueOnce({ version: 1, items: replacement, hasMore: true, nextCursor: 'new' });
    await view.refresh();
    expect(view.getSnapshot().items).toEqual(overlap ? [...prefix, ...completed] : replacement);
    expect(view.getSnapshot().nextCursor).toBe(overlap ? 'older' : 'new');
    expect(view.getSnapshot().hasMore).toBe(true);
  });

  it.each(['success', 'failure', 'blur', 'unavailable'])('reads again after an ACK over an in-flight %s without changing expansion', async (outcome) => {
    const page = { version: 1 as const, items: projectHistoryView([row(1, 'thinking', 'detail')], true), hasMore: false, nextCursor: null };
    let resolve!: (value: typeof page) => void;
    let reject!: (error: Error) => void;
    const read = vi.fn(() => Promise.resolve(page));
    const expanded = vi.fn(async () => undefined);
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [row(1, 'thinking', 'detail')], hasMore: false, nextCursor: null }), expanded });
    await view.refresh();
    const work = page.items.find(item => item.type === 'work')!;
    view.setExpanded(work.key, true);
    read.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const old = view.refresh();
    const ack = view.refresh(false, true);
    const repeated = view.refresh(false, true);
    if (outcome === 'blur') view.setActive(false);
    if (outcome === 'failure') reject(new Error('temporary timeout'));
    else if (outcome === 'unavailable') reject(new Error('[UNSUPPORTED_CAPABILITY] oversized'));
    else resolve(page);
    await Promise.all([old, ack, repeated]);
    expect(read).toHaveBeenCalledTimes(outcome === 'blur' || outcome === 'unavailable' ? 2 : 3);
    if (outcome === 'success' || outcome === 'failure') {
      expect(view.getSnapshot().expanded.has(work.key)).toBe(true);
      expect(view.getSnapshot().error).toBeNull();
      await new Promise(done => setTimeout(done, 0));
      expect(expanded).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ key: work.key })]));
    }
  });

  it.each(['reset', 'reset twice', 'reactivate'])('awaits the current read after %s, including a late failure', async (transition) => {
    for (const oldFailure of [false, true]) {
      const reads: Array<{ resolve(page: HistoryViewPage<HistoryMessageSource>): void; reject(error: Error): void }> = [];
      const page = { version: 1 as const, items: projectHistoryView([row(1, 'user', 'current')], false), hasMore: false, nextCursor: null };
      const view = new HistoryViewController<HistoryMessageSource>({
        page: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
        details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined,
      });
      const old = view.refresh();
      if (transition === 'reactivate') { view.setActive(false); view.setActive(true); }
      else view.reset();
      const intermediate = view.refresh();
      if (transition === 'reset twice') view.reset();
      let settled = false;
      const current = view.refresh().then(() => { settled = true; });
      const repeated = view.refresh();
      if (oldFailure) reads[0].reject(new Error('timeout'));
      else reads[0].resolve({ ...page, items: [] });
      await old;
      await new Promise((done) => setTimeout(done, 0));
      expect(reads).toHaveLength(2);
      expect(settled).toBe(false);
      expect(view.getSnapshot()).toMatchObject({ ready: false, error: null });
      reads[1].resolve(page);
      await Promise.all([intermediate, current, repeated]);
      expect(view.getSnapshot()).toMatchObject({ ready: true, items: page.items, error: null });
      expect(reads).toHaveLength(2);
    }
  });

  it('cancels a queued reset read on blur and exposes a subsequent current failure', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const read = vi.fn(() => new Promise<HistoryViewPage<HistoryMessageSource>>((done) => { resolve = done; }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    const old = view.refresh();
    view.reset();
    const queued = view.refresh();
    view.setActive(false);
    resolve({ version: 1, items: [], hasMore: false, nextCursor: null });
    await Promise.all([old, queued]);
    expect(read).toHaveBeenCalledTimes(1);
    const failure = new Error('timeout');
    read.mockRejectedValueOnce(failure);
    view.setActive(true);
    await view.refresh();
    expect(view.getSnapshot()).toMatchObject({ ready: false, loading: false, error: failure });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('preserves an opposite-direction request during a pending page (older=%s)', async (older) => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const page: HistoryViewPage<HistoryMessageSource> = { version: 1, items: projectHistoryView([row(2, 'user', 'current')], false), hasMore: true, nextCursor: '2' };
    const read = vi.fn(async (_before?: string) => page);
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    await view.refresh();
    read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const current = view.refresh(older);
    const queued = [view.refresh(!older), view.refresh(!older)];
    expect(read).toHaveBeenCalledTimes(2);
    resolve(page);
    await Promise.all([current, ...queued]);
    expect(read.mock.calls.map(([before]) => before)).toEqual([undefined, older ? '2' : undefined, older ? undefined : '2']);
  });

  it('cancels queued older intent when the view leaves before the current request settles', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const read = vi.fn(() => new Promise<HistoryViewPage<HistoryMessageSource>>((done) => { resolve = done; }));
    const view = new HistoryViewController({ page: read,
      details: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
    const current = view.refresh();
    const older = view.refresh(true);
    view.setActive(false);
    resolve({ version: 1, items: [], hasMore: true, nextCursor: '2' });
    await Promise.all([current, older]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('clears a ready projection on Host downgrade and rejects late detail results', async () => {
    const read = vi.fn(async () => ({ version: 1 as const, items: projectHistoryView([row(1, 'thinking', 'old')], true), hasMore: false, nextCursor: null }));
    let resolve!: (page: { version: 1; messages: HistoryMessageSource[]; hasMore: false; nextCursor: null }) => void;
    const view = new HistoryViewController({ page: read,
      details: () => new Promise<Parameters<typeof resolve>[0]>((done) => { resolve = done; }), expanded: async () => undefined });
    await view.refresh();
    view.setExpanded(view.getSnapshot().items[0].key, true);
    read.mockRejectedValueOnce(new Error('timeout'));
    await view.refresh();
    expect(view.getSnapshot().ready).toBe(true);
    read.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] old Host'));
    await view.refresh();
    resolve({ version: 1, messages: [row(1, 'thinking', 'late')], hasMore: false, nextCursor: null });
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot()).toMatchObject({ ready: false, items: [], hasMore: false, nextCursor: null });
    expect(view.getSnapshot().details.size).toBe(0);
    expect(view.getSnapshot().expanded.size).toBe(0);
  });

  it.each([false, true])('joins an expanded detail read through its latest revision (changed=%s)', async (changed) => {
    let rows = [row(1, 'thinking', 'old')];
    const replies: Array<(page: { version: 1; messages: HistoryMessageSource[]; hasMore: false; nextCursor: null }) => void> = [];
    const details = vi.fn(() => new Promise<Parameters<typeof replies[number]>[0]>(resolve => { replies.push(resolve); }));
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView(rows, true), hasMore: false, nextCursor: null }),
      details, expanded: async () => undefined,
    });
    await view.refresh();
    const group = view.getSnapshot().items[0];
    if (group.type !== 'work') throw new Error('Expected a work group');
    view.setExpanded(group.key, true);
    let completed = false;
    const joined = view.loadDetails(group.summary).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    expect(details).toHaveBeenCalledTimes(1);
    if (changed) {
      rows = [row(1, 'thinking', 'corrected'), row(2, 'thinking', 'appended')];
      await view.refresh();
      expect(details).toHaveBeenCalledTimes(1);
    }
    replies[0]({ version: 1, messages: [row(1, 'thinking', 'old')], hasMore: false, nextCursor: null });
    if (changed) {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(completed).toBe(false);
      expect(details).toHaveBeenCalledTimes(2);
      replies[1]({ version: 1, messages: rows, hasMore: false, nextCursor: null });
    }
    await joined;
    expect(view.getSnapshot().details.get(group.key)).toMatchObject({ complete: true, loading: false, messages: rows });
    const latest = view.getSnapshot().items[0];
    if (latest.type !== 'work') throw new Error('Expected the current work group');
    await view.loadDetails(latest.summary);
    expect(details).toHaveBeenCalledTimes(changed ? 2 : 1);
  });

  it('reloads an edited prefix when new rows arrive in the same revision', async () => {
    let rows = [row(1, 'thinking', 'old'), row(2, 'thinking', 'tail')];
    const cursors: Array<string | undefined> = [];
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null }),
      details: async (_summary, after) => {
        cursors.push(after);
        return { version: 1, messages: rows.filter((item) => !after || Number(item.id) > Number(after)), hasMore: false, nextCursor: null };
      },
      expanded: async () => undefined,
    });
    await view.refresh();
    const key = view.getSnapshot().items[0].key;
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    rows = [row(1, 'thinking', 'corrected'), rows[1], row(3, 'thinking', 'appended')];
    await view.refresh();
    await new Promise((done) => setTimeout(done, 0));
    expect(cursors).toEqual([undefined, undefined]);
    expect(view.getSnapshot().details.get(key)?.messages.map((item) => item.content))
      .toEqual(['corrected', 'tail', 'appended']);
    await view.refresh();
    expect(cursors).toHaveLength(2);
  });

  it('keeps an in-flight first read valid across repeated activation and releases collapsed intent', async () => {
    let resolve!: (page: HistoryViewPage<HistoryMessageSource>) => void;
    const intents: string[][] = [];
    const view = new HistoryViewController<HistoryMessageSource>({
      page: () => new Promise((done) => { resolve = done; }),
      details: async () => ({ version: 1, messages: [row(1, 'thinking', 'body')], hasMore: false, nextCursor: null }),
      expanded: async (refs) => { intents.push(refs.map((ref) => ref.key)); },
    });
    const pending = view.refresh();
    view.setActive(true);
    view.setActive(true);
    const items = projectHistoryView([row(1, 'thinking', 'body')], true);
    resolve({ version: 1, items, hasMore: false, nextCursor: null });
    await pending;
    expect(view.getSnapshot().ready).toBe(true);
    view.setExpanded(items[0].key, true);
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot().details.get(items[0].key)?.complete).toBe(true);
    view.setExpanded(items[0].key, false);
    await new Promise((done) => setTimeout(done, 0));
    expect(intents.at(-1)).toEqual([]);
  });

  it.each([false, true])('releases old detail interest when reset before a replacement page is ready (inactive=%s)', async (inactive) => {
    const items = projectHistoryView([row(1, 'thinking', 'body')], true);
    let first = true;
    const expanded = vi.fn(async () => undefined);
    const view = new HistoryViewController<HistoryMessageSource>({
      page: () => first ? (first = false, Promise.resolve({ version: 1, items, hasMore: false, nextCursor: null }))
        : new Promise(() => undefined),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded,
    });
    await view.refresh();
    view.setExpanded(items[0].key, true);
    await new Promise((done) => setTimeout(done, 0));
    expect(expanded).toHaveBeenLastCalledWith([items[0].type === 'work' ? items[0].summary : undefined]);
    if (inactive) view.setActive(false);
    view.reset();
    await new Promise((done) => setTimeout(done, 0));
    expect(view.getSnapshot().ready).toBe(false);
    expect(expanded).toHaveBeenLastCalledWith([]);
    view.setActive(false);
  });

  it.each(['live', 'mixed', 'preview', 'stored'])('matches persisted detail boundaries without changing reference identity: %s', async (mode) => {
    const persisted = [row(1, 'thinking', 'first'), row(2, 'thinking', 'last')];
    const references = persisted.map((message, index) => ({ ...message,
      id: mode === 'stored' ? message.clientId : mode === 'mixed' && index === 0
        ? message.id : `history-live:${message.clientId}` }));
    const items = projectHistoryView(references, true);
    if (items[0].type !== 'work') throw new Error('missing work');
    const summary = items[0].summary;
    if (mode === 'preview') summary.preview = { ...summary, key: 'preview' };
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items, hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: persisted, hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const key = mode === 'preview' ? 'preview' : summary.key;
    view.setExpanded(key, true);
    await new Promise(done => setTimeout(done, 0));
    const snapshot = view.getSnapshot();
    const detail = snapshot.details.get(key)!;
    // A refreshed subrange can temporarily reuse a wider cache. Both endpoints
    // must still clip correctly after the live rows acquire persistent IDs.
    snapshot.details.set(key, { ...detail, messages: [row(0, 'thinking', 'before'), ...persisted, row(3, 'thinking', 'after')] });
    const rendered = renderHistoryView({ view, snapshot, liveMessages: [], streaming: true,
      build: messages => messages.map(message => message.content), structure: ungroupedStructure });
    if (mode === 'stored') expect(rendered).not.toContain('first');
    else expect(rendered).toEqual(['first', 'last']);
    expect(view.getSnapshot().items).toEqual(items);
    expect([...snapshot.expanded]).toEqual([key]);
    view.setActive(false);
  });

  it('does not revive durable messages removed by rewind through the live overlay', async () => {
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([row(1, 'user', 'kept')], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const rendered = renderHistoryView({
      view, snapshot: view.getSnapshot(), liveMessages: [row(2, 'assistant', 'rewound')], streaming: false,
      build: (rows) => rows.map((item) => item.clientId), structure: ungroupedStructure,
      isLive: () => false,
    });
    expect(rendered).toEqual(['c1']);
  });

  it('preserves pending observation order without moving known history or other live rows', async () => {
    const known = row(1, 'assistant', 'history');
    const first = row(4, 'assistant', 'first pending');
    const second = row(2, 'assistant', 'second pending');
    const other = row(3, 'user', 'other live');
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([known], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const liveMessages = [known, second, other, first];
    const pendingHandoff = new Set(['removed', known.clientId, first.clientId, second.clientId]);
    const output = renderHistoryView({ view, snapshot: view.getSnapshot(), liveMessages, pendingHandoff,
      streaming: true, isLive: () => true, build: rows => [...rows], structure: ungroupedStructure });
    expect(output).toEqual([known, first, other, second]);
    expect(liveMessages).toEqual([known, second, other, first]);
    expect([...pendingHandoff]).toEqual(['removed', known.clientId, first.clientId, second.clientId]);
    view.setActive(false);
  });

  it('preserves current local user bubbles, source authority and store order despite clock skew', async () => {
    type Message = HistoryMessageSource & { isPendingPersist?: boolean; blockedByGhost?: boolean };
    const source = [row(1, 'user', 'kept'), row(10, 'assistant', 'answer'), row(11, 'user', 'persisted rewrite')];
    const view = new HistoryViewController<Message>({
      page: async () => ({ version: 1, items: projectHistoryView(source, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const blocked = { ...row(2, 'user', 'blocked'), blockedByGhost: true };
    const pending = { ...row(3, 'user', 'pending'), isPendingPersist: true };
    const render = (liveMessages: Message[]) => renderHistoryView<Message, unknown>({
      view, snapshot: view.getSnapshot(), liveMessages, streaming: false,
      isLive: () => false,
      isLocalUser: (message) => message.isPendingPersist === true || !!message.blockedByGhost,
      build: (rows) => rows.map((message) => message.content), structure: ungroupedStructure,
    });
    expect(render([source[0], blocked, source[1],
      { ...source[2], content: 'stale optimistic body', isPendingPersist: true }, pending,
      row(12, 'user', 'rewound durable user'), row(13, 'assistant', 'rewound answer')]))
      .toEqual(['kept', 'blocked', 'answer', 'persisted rewrite', 'pending']);
    // Clearing the existing store removes local bubbles; no renderer-owned cache revives them.
    expect(render(source)).toEqual(['kept', 'answer', 'persisted rewrite']);
  });

  it.each([false, true])('uses refreshed work details after collapse despite stale streaming rows (active=%s)', async (active) => {
    let thinking = { ...row(1, 'thinking', 'partial'), isStreaming: true };
    const prose = row(2, 'assistant', 'answer');
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([thinking, prose], active), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [thinking], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const key = view.getSnapshot().items[0].key;
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    const stale = thinking;
    view.setExpanded(key, false);
    thinking = { ...thinking, content: 'complete thinking', isStreaming: false };
    await view.refresh();
    view.setExpanded(key, true);
    await new Promise((done) => setTimeout(done, 0));
    const rendered = renderHistoryView({ view, snapshot: view.getSnapshot(),
      liveMessages: [stale, { ...prose, content: 'latest answer' }], streaming: active,
      isLive: () => true, build: (rows) => rows.map((item) => item.content), structure: ungroupedStructure });
    expect(rendered).toEqual(['complete thinking', 'latest answer']);
  });

  it('loads a collapsed work range for recovery without changing expansion state', async () => {
    const target = row(1, 'thinking', 'authoritative terminal');
    const details = vi.fn(async () => ({ version: 1 as const, messages: [target], hasMore: false, nextCursor: null }));
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([target], false), hasMore: false, nextCursor: null }),
      details,
      expanded: async () => undefined,
    });
    await view.refresh();
    const group = view.getSnapshot().items[0];
    if (group.type !== 'work') throw new Error('Expected a work group');

    await view.loadDetails(group.summary, { allowCollapsed: true });

    expect(details).toHaveBeenCalledOnce();
    expect(view.getSnapshot().expanded).toEqual(new Set());
    expect(view.getSnapshot().details.get(group.key)).toMatchObject({
      complete: true,
      messages: [target],
    });
  });
});


describe('locating folded history preserves display expansion', () => {
  it.each(['mounted', 'older-page', 'inactive', 'changed'])('reads only the target range without opening groups: %s', async (mode) => {
    const target = row(1, 'thinking', 'target');
    const items = projectHistoryView([target], false);
    let pages = 0;
    let finish!: (page: import('../historyView.js').HistoryDetailPage<HistoryMessageSource>) => void;
    const expanded = vi.fn(async (_summaries: readonly unknown[]) => undefined);
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: mode === 'older-page' && pages++ === 0 ? [] : items,
        hasMore: mode === 'older-page' && pages === 1, nextCursor: 'older' }),
      details: () => new Promise(resolve => { finish = resolve; }), expanded,
    });
    await view.refresh();
    const pending = view.locate(target.clientId, target.createdAt);
    await new Promise(done => setTimeout(done, 0));
    view.setExpanded(items[0].key, false); // a newly mounted folded group
    if (mode === 'inactive') view.setActive(false);
    if (mode === 'changed' && items[0].type === 'work') items[0].summary = { ...items[0].summary, revision: 'changed' };
    finish({ version: 1, messages: [target], hasMore: false, nextCursor: null });
    expect(await pending).toEqual(mode === 'inactive' || mode === 'changed' ? null : target);
    expect(view.getSnapshot().expanded.size).toBe(0);
    expect(expanded.mock.calls.every(([summaries]) => !summaries?.length)).toBe(true);
    if (mode === 'inactive' || mode === 'changed') expect(view.getSnapshot().details.size).toBe(0);
    else expect(view.getSnapshot().details.get(items[0].key)?.complete).toBe(true);
    view.setActive(false);
  });
  it('keeps a located full range visible to the builder while a running preview is subscribed', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, 'thinking', `detail-${i}`));
    const items = projectHistoryView(rows, true);
    if (items[0].type !== 'work') throw new Error('missing work');
    const summary = items[0].summary;
    summary.preview = { ...summary, key: 'preview', firstMessageId: rows[3].id };
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items, hasMore: false, nextCursor: null }),
      details: async (ref) => ({ version: 1, messages: ref.key === 'preview' ? rows.slice(3) : rows, hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    view.setExpanded('preview', true);
    await new Promise(done => setTimeout(done, 0));
    expect(await view.locate(rows[0].clientId, rows[0].createdAt)).toEqual(rows[0]);
    const rendered = renderHistoryView({ view, snapshot: view.getSnapshot(), liveMessages: [], streaming: true,
      build: messages => messages.map(message => message.clientId), structure: ungroupedStructure });
    expect(rendered).toContain(rows[0].clientId);
    expect([...view.getSnapshot().expanded]).toEqual(['preview']);
    view.setActive(false);
  });

  it('does not replace a located complete range with an in-flight partial expansion', async () => {
    const rows = [row(1, 'thinking', 'one'), row(2, 'thinking', 'two')];
    const items = projectHistoryView(rows, false);
    let read = 0;
    let finish!: (page: import('../historyView.js').HistoryDetailPage<HistoryMessageSource>) => void;
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items, hasMore: false, nextCursor: null }),
      details: () => ++read === 1 ? new Promise(resolve => { finish = resolve; })
        : Promise.resolve({ version: 1, messages: rows, hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    view.setExpanded(items[0].key, true);
    expect(await view.locate(rows[1].clientId, rows[1].createdAt)).toEqual(rows[1]);
    const observed: number[] = [];
    const stop = view.subscribe(() => observed.push(view.getSnapshot().details.get(items[0].key)?.messages.length ?? 0));
    finish({ version: 1, messages: [rows[0]], hasMore: true, nextCursor: rows[0].id });
    await new Promise(done => setTimeout(done, 0));
    expect(observed.every(count => count === 2)).toBe(true);
    stop(); view.setActive(false);
  });

  it.each([false, true])('only propagates errors from a current locate request (inactive=%s)', async (inactive) => {
    const target = row(1, 'thinking', 'target');
    let fail!: (error: Error) => void;
    const view = new HistoryViewController<HistoryMessageSource>({
      page: async () => ({ version: 1, items: projectHistoryView([target], false), hasMore: false, nextCursor: null }),
      details: () => new Promise((_, reject) => { fail = reject; }), expanded: async () => undefined,
    });
    await view.refresh();
    const request = view.locate(target.clientId, target.createdAt);
    if (inactive) view.setActive(false);
    fail(new Error('read failed'));
    if (inactive) expect(await request).toBeNull();
    else await expect(request).rejects.toThrow('read failed');
    view.setActive(false);
  });

});

it.each(['initial', 'older', 'refresh'])('uses existing raw fallback after a budget failure on %s', async (stage) => {
  let fail = stage === 'initial';
  const page = vi.fn(async () => {
    if (fail) throw new Error('[UNSUPPORTED_CAPABILITY] History view scan budget exceeded');
    return { version: 1 as const, items: projectHistoryView([row(1, 'user', 'hello')], false), hasMore: true, nextCursor: '1' };
  });
  const view = new HistoryViewController<HistoryMessageSource>({ page,
    details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined });
  await view.refresh();
  if (!fail) { fail = true; await view.refresh(stage === 'older'); }
  expect(view.getSnapshot().ready).toBe(false);
  expect(isHistoryViewUnavailable(view.getSnapshot().error)).toBe(true);
  expect(view.getSnapshot().items).toEqual([]);
  const calls = page.mock.calls.length;
  fail = false;
  await view.refresh();
  view.setActive(false); view.setActive(true);
  await view.refresh(true);
  expect(page).toHaveBeenCalledTimes(calls);
  view.reset(); await view.refresh();
  expect(view.getSnapshot().ready).toBe(true);
  view.setActive(false);
});
