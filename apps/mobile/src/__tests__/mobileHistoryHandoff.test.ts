import { describe, expect, it, vi } from 'vitest';
import { HistoryViewController, HistoryViewHandoff, projectHistoryView, nextHistoryCacheReceipt } from '@cindy/maker-shared/message-window';
import { buildMobileHistoryRenderItems } from '../session/mobileHistoryRender';
import type { RemoteMessage } from '../session/types';

const row = (id: string, streaming = false): RemoteMessage => ({
  id, clientId: id, sessionId: 's', role: id === 'user' ? 'user' : 'assistant',
  content: id === 'user' ? 'question' : 'visible answer', toolUseId: null,
  createdAt: id === 'user' ? '2026-09-08T00:00:00Z' : '2026-09-08T00:00:01Z',
  agentMeta: streaming ? { isStreaming: true } : null,
});

const createHandoff = () => new HistoryViewHandoff<RemoteMessage>((row) => row.agentMeta?.isStreaming === true);

describe('mobile history handoff', () => {
  // Regression: an updated list body has the same ID/time as the cached page. The
  // old tail-only rule hid it. Unit: real handoff + renderer, no network or timers.
  it('shows a newer received body in place until a page read after that push takes over', async () => {
    const old = { ...row('answer'), content: 'old answer' };
    const received = { ...old, content: 'updated answer', cacheReceipt: { run: 'cached', order: 2 } };
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView([old], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    view.setActive(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([old], false),
      details: new Map(), expanded: new Set(), nextCursor: null, hasMore: false,
      loading: false, ready: true, error: null, readReceipt: { run: 'cached', order: 1 } }));
    const handoff = createHandoff();
    const render = (snapshot = view.getSnapshot(), currentHandoff = handoff) => {
      const state = currentHandoff.reconcile(snapshot, [received]);
      return buildMobileHistoryRenderItems({ view, snapshot, messages: state.messages,
        pendingHandoff: state.pending, staleTail: state.tail, streaming: false, sessionId: 's',
      }).filter(item => item.type === 'message').map(item => item.message.body);
    };
    expect(render()).toEqual(['updated answer']);
    // An in-flight page captured before the push must not roll it back either.
    expect(render({ ...view.getSnapshot(), stale: false })).toEqual(['updated answer']);
    // A new receipt can also arrive while the very first page is in flight.
    expect(render({ ...view.getSnapshot(), items: [], stale: false }, createHandoff())).toEqual(['updated answer']);
    // A newer authoritative read is allowed to replace it, even with shorter text.
    expect(render({ ...view.getSnapshot(), stale: false, readReceipt: { run: 'cached', order: 3 } })).toEqual(['old answer']);
    expect(handoff.reconcile(view.getSnapshot(), []).tail.size).toBe(0);
  });

  // A clock correction must not make an old receipt beat every future Host read,
  // including receipts restored from a previous app run.
  it.each([false, true])('retires old receipts after a clock rollback (previous run=%s)', async (previousRun) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(50_000);
    const cachedRead = previousRun ? { run: 'previous-run', order: 1 } : nextHistoryCacheReceipt();
    const receipt = previousRun ? { run: 'previous-run', order: 999_999 } : nextHistoryCacheReceipt();
    const old = { ...row('answer'), content: 'cached body', cacheReceipt: receipt };
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView([{ ...row('answer'), content: 'host body' }], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined,
    });
    const handoff = createHandoff();
    const render = () => {
      const snapshot = view.getSnapshot();
      const state = handoff.reconcile(snapshot, [old]);
      return buildMobileHistoryRenderItems({ view, snapshot, messages: state.messages, staleTail: state.tail,
        pendingHandoff: state.pending, streaming: false, sessionId: 's' }).filter(item => item.type === 'message').map(item => item.message.body);
    };
    try {
      view.setActive(false);
      await view.restoreCachedView(async () => ({ items: projectHistoryView([{ ...row('answer'), content: 'older body' }], false),
        details: new Map(), expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null, readReceipt: cachedRead }));
      expect(render()).toEqual(['cached body']);
      clock.mockReturnValue(100);
      view.setActive(true);
      await view.refresh();
      expect(render()).toEqual(['host body']);
      view.setActive(false);
      expect(render()).toEqual(['host body']); // Leaving the page must not revive the retired receipt.
    } finally { view.setActive(false); clock.mockRestore(); }
  });

  // Unit: separately saved raw (run A) and authoritative page (run B), restored
  // offline in run C. Only an actual C push may supersede B; A cannot be ordered after B.
  it.each([false, true])('does not guess the order of two old runs (current push=%s)', async (currentPush) => {
    const raw = { ...row('answer'), content: 'raw body',
      cacheReceipt: currentPush ? nextHistoryCacheReceipt() : { run: 'run-A', order: 999_999 } };
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => { throw new Error('offline'); },
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }), expanded: async () => undefined,
    });
    view.setNetworkAvailable(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([{ ...row('answer'), content: 'authoritative B' }], false),
      details: new Map(), expanded: new Set(), nextCursor: null, hasMore: false,
      loading: false, ready: true, error: null, readReceipt: { run: 'run-B', order: 1 } }));
    const snapshot = view.getSnapshot();
    const state = createHandoff().reconcile(snapshot, [raw]);
    expect(buildMobileHistoryRenderItems({ view, snapshot, messages: state.messages, staleTail: state.tail,
      pendingHandoff: state.pending, streaming: false, sessionId: 's' })
      .filter(item => item.type === 'message').map(item => item.message.body))
      .toEqual([currentPush ? 'raw body' : 'authoritative B']);
    view.setActive(false);
  });

  it('keeps the live tail below completed text when recovery history has not caught up to that tail', async () => {
    const first = { ...row('A'), content: 'first paragraph' };
    let live = { ...row('B', true), content: 'second paragraph', createdAt: first.createdAt };
    let history = [row('user'), first];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(history, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    const handoff = createHandoff();
    const render = () => {
      const state = handoff.reconcile(view.getSnapshot(), [first, live]);
      return buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(),
        messages: state.messages, pendingHandoff: state.pending, streaming: true, sessionId: 's',
      }).filter(item => item.type === 'message').map(item => item.message);
    };
    await view.refresh();
    expect(render().map(item => item.source.clientId)).toEqual(['user', 'A', 'B']);
    // A recovery page knows A's host timestamp, but B only exists in the live store.
    // B still has the older provisional timestamp it received before the disconnect.
    history = [row('user'), { ...first, createdAt: '2026-09-08T00:00:02Z', rowid: 42 }];
    view.setActive(false);
    view.setActive(true);
    await view.refresh();
    const recovered = render();
    expect(recovered.map(item => item.source.clientId)).toEqual(['user', 'A', 'B']);
    expect(recovered[2]).toMatchObject({ body: 'second paragraph', isStreaming: true });
    expect(recovered[2].source.createdAt).toBe(first.createdAt);
    live = { ...live, content: 'second paragraph continues' };
    expect(render().map(item => item.body)).toEqual(['question', 'first paragraph', 'second paragraph continues']);
    live = { ...live, agentMeta: null };
    expect(render()[2].isStreaming).not.toBe(true);
    history = [...history, { ...live, createdAt: '2026-09-08T00:00:03Z', rowid: 43 }];
    await view.refresh();
    expect(render().map(item => item.source.clientId)).toEqual(['user', 'A', 'B']);
    expect(handoff.reconcile(view.getSnapshot(), [first, live]).pending.size).toBe(0);
    view.setActive(false);
  });

  it('keeps multiple displayed pending paragraphs in order while persistence overtakes history', async () => {
    const first = row('A');
    const second = { ...row('B', true), createdAt: first.createdAt };
    const third = { ...row('C', true), createdAt: first.createdAt };
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView([row('user'), first], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    const handoff = createHandoff();
    const render = (raw: RemoteMessage[]) => {
      const state = handoff.reconcile(view.getSnapshot(), raw);
      return buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(),
        messages: state.messages, pendingHandoff: state.pending, streaming: true, sessionId: 's',
      }).filter(item => item.type === 'message').map(item => item.message.source.clientId);
    };
    await view.refresh();
    expect(render([first, second])).toEqual(['user', 'A', 'B']);
    const finalized = { ...second, agentMeta: null };
    expect(render([first, finalized, third])).toEqual(['user', 'A', 'B', 'C']);
    // The raw store has received B's durable timestamp and re-sorted its rows.
    // History has neither B nor C yet; both still belong to the displayed live tail.
    const persisted = { ...finalized, createdAt: '2026-09-08T00:00:02Z', rowid: 42 };
    expect(render([first, third, persisted])).toEqual(['user', 'A', 'B', 'C']);
    view.setActive(false);
  });
  it.each([true, false])('keeps text order when history timestamps arrive before live persistence (handoff=%s)', async (useHandoff) => {
    const message = (id: string, second: number, streaming = false): RemoteMessage => ({
      ...row(id, streaming), content: id,
      createdAt: new Date(Date.UTC(2026, 8, 8, 0, 0, second)).toISOString(),
    });
    let history = [message('A', 0)];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(history, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const handoff = createHandoff();
    const provisional = message('B', 0, true);
    const render = (raw: RemoteMessage[]) => {
      const state = useHandoff ? handoff.reconcile(view.getSnapshot(), raw)
        : { messages: raw, pending: new Set<string>() };
      return buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(),
        messages: state.messages, pendingHandoff: state.pending, streaming: true, sessionId: 's',
      }).filter(item => item.type === 'message').map(item => item.message.source);
    };
    expect(render([message('A', 0), provisional]).map(item => item.clientId)).toEqual(['A', 'B']);
    history = [message('A', 1), { ...message('B', 2), content: 'older history text', rowid: 42 }];
    await view.refresh();
    const during = render([message('A', 1), provisional]);
    expect(during.map(item => item.clientId)).toEqual(['A', 'B']);
    expect(during[1]).toMatchObject({ content: 'B', createdAt: history[1].createdAt, rowid: 42 });
    expect(provisional.createdAt).toBe(message('B', 0).createdAt);
    expect(history[1].content).toBe('older history text');
    expect(render([message('A', 1), message('B', 2)]).map(item => item.clientId)).toEqual(['A', 'B']);
    view.setActive(false);
  });
  it('retains text finalized before the first history page arrives, including an older provisional time anchor', async () => {
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView([row('user')], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    const handoff = createHandoff();
    const live = { ...row('answer', true), createdAt: '2026-09-07T23:59:59Z' };
    handoff.reconcile(view.getSnapshot(), [live]);
    const final = { ...live, agentMeta: null };
    handoff.reconcile(view.getSnapshot(), [final]);
    await view.refresh();
    const state = handoff.reconcile(view.getSnapshot(), [final]);
    const output = buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(), messages: state.messages,
      pendingHandoff: state.pending, streaming: false, sessionId: 's' });
    expect(JSON.stringify(output)).toContain('visible answer');
    expect(state.pending.has('answer')).toBe(true);
    view.setActive(false);
  });

  it('keeps a displayed answer through finalization, persistence and a stale page until history takes over once', async () => {
    let source = [row('user')];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(source, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const handoff = createHandoff();
    const render = (raw: RemoteMessage[]) => {
      const state = handoff.reconcile(view.getSnapshot(), raw);
      const output = buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(),
        messages: state.messages, pendingHandoff: state.pending, streaming: false, sessionId: 's' });
      return { state, output: JSON.stringify(output) };
    };
    expect(render([row('answer', true)]).output).toContain('visible answer');
    // done/tool boundary clears streaming, but persistence/history have not arrived.
    expect(render([row('answer')]).output).toContain('visible answer');
    // A durable push replaces the raw object before the separate history page.
    expect(render([{ ...row('answer'), id: 'db-id', rowid: 42 }]).output).toContain('visible answer');
    await view.refresh();
    expect(render([row('answer')]).output).toContain('visible answer');
    source = [row('user'), { ...row('answer'), content: 'authoritative answer' }];
    await view.refresh();
    const final = render([row('answer')]);
    expect(final.state.pending.size).toBe(0);
    expect(final.state.messages.filter(x => x.clientId === 'answer')).toHaveLength(1);
    expect(final.output).toContain('authoritative answer');
    expect(final.output).not.toContain('visible answer');
    view.setActive(false);
  });

  it('never promotes old durable cache rows and cancels a handoff removed by delete or rewind', async () => {
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView([row('user')], false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const handoff = createHandoff();
    expect(handoff.reconcile(view.getSnapshot(), [row('old')]).messages.map(x => x.clientId)).toEqual(['user']);
    handoff.reconcile(view.getSnapshot(), [row('answer', true)]);
    expect(handoff.reconcile(view.getSnapshot(), []).pending.size).toBe(0);
    expect(handoff.reconcile(view.getSnapshot(), [row('answer')]).messages.map(x => x.clientId)).toEqual(['user']);
    handoff.reconcile(view.getSnapshot(), [row('answer', true)]);
    view.reset();
    handoff.reconcile(view.getSnapshot(), []);
    await view.refresh();
    expect(handoff.reconcile(view.getSnapshot(), [row('answer')]).pending.size).toBe(0);
    expect(createHandoff().reconcile(view.getSnapshot(), [row('answer')]).pending.size).toBe(0);
    view.setActive(false);
  });

  it('shows rows received after a stale cached snapshot until the fresh page covers them', async () => {
    const at = (id: string, role: RemoteMessage['role'], second: number, content = id): RemoteMessage => ({
      id, clientId: id, sessionId: 's', role, content, toolUseId: null,
      createdAt: `2026-09-08T00:00:${String(second).padStart(2, '0')}Z`, agentMeta: null,
    });
    const cached = [at('q1', 'user', 0), at('a1', 'assistant', 1)];
    const later = [at('q2', 'user', 5, 'asked on the computer'), at('a2', 'assistant', 6, 'prefetched reply')];
    const local = at('mobile-system-pwd', 'system', 7);
    let release!: () => void;
    const view = new HistoryViewController<RemoteMessage>({
      page: () => new Promise((resolve) => {
        release = () => resolve({ version: 1, items: projectHistoryView([...cached, ...later], false), hasMore: false, nextCursor: null });
      }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    view.setActive(false);
    await view.restoreCachedView(async () => ({
      items: projectHistoryView(cached, false), details: new Map(), expanded: new Set(),
      nextCursor: null, hasMore: false, loading: false, ready: true, error: null,
    }));
    const handoff = createHandoff();
    const render = () => {
      const state = handoff.reconcile(view.getSnapshot(), [...cached, ...later, local]);
      return buildMobileHistoryRenderItems({ view, snapshot: view.getSnapshot(), messages: state.messages,
        pendingHandoff: state.pending, staleTail: state.tail, streaming: false, sessionId: 's',
      }).filter(item => item.type === 'message').map(item => item.message.source.clientId);
    };
    expect(view.getSnapshot().stale).toBe(true);
    expect(render()).toEqual(['q1', 'a1', 'q2', 'a2']);
    view.setActive(true);
    expect(render()).toEqual(['q1', 'a1', 'q2', 'a2']);
    release();
    await view.refresh();
    expect(view.getSnapshot().stale).toBe(false);
    expect(handoff.reconcile(view.getSnapshot(), [...cached, ...later]).tail.size).toBe(0);
    expect(render()).toEqual(['q1', 'a1', 'q2', 'a2']);
    view.setActive(false);
    expect(view.getSnapshot().stale).toBe(true);
  });

  it('keeps a shown tail row when a page read before it arrived replaces the stale snapshot', async () => {
    const at = (id: string, second: number): RemoteMessage => ({
      id, clientId: id, sessionId: 's', role: 'assistant', content: id, toolUseId: null,
      createdAt: `2026-09-08T00:00:0${second}Z`, agentMeta: null,
    });
    let pageRows = [at('a1', 1)];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(pageRows, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    view.setActive(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([at('a1', 1)], false), details: new Map(),
      expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null }));
    const handoff = createHandoff();
    const reply = at('reply', 5);
    expect(handoff.reconcile(view.getSnapshot(), [at('a1', 1), reply]).tail).toEqual(new Set(['reply']));
    // The Host read its latest page before the reply was saved.
    view.setActive(true);
    await view.refresh();
    expect(view.getSnapshot().stale).toBe(false);
    const fresh = handoff.reconcile(view.getSnapshot(), [at('a1', 1), reply]);
    expect(fresh.messages.map((row) => row.clientId)).toEqual(['a1', 'reply']);
    // Covered by history: leaves the tail. Removed from the raw store: not revived.
    pageRows = [at('a1', 1), reply];
    await view.refresh(false, true);
    expect(handoff.reconcile(view.getSnapshot(), [at('a1', 1), reply]).tail.size).toBe(0);
    expect(handoff.reconcile(view.getSnapshot(), [at('a1', 1)]).messages.map((row) => row.clientId)).toEqual(['a1', 'reply']);
    view.setActive(false);
  });
});
