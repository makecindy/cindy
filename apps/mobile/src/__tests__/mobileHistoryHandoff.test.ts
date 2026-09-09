import { describe, expect, it } from 'vitest';
import { HistoryViewController, HistoryViewHandoff, projectHistoryView } from '@cindy/maker-shared/message-window';
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
});
