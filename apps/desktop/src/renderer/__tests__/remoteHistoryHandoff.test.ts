import { describe, expect, it } from 'vitest';
import {
  HistoryViewController, HistoryViewHandoff, projectHistoryView, renderHistoryView,
} from '@cindy/maker-shared/message-window';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { HistoryChatMessage } from '../lib/makerChatStore';

const row = (clientId: string, isStreaming = false): HistoryChatMessage => ({
  id: clientId, clientId, role: clientId === 'user' ? 'user' : 'assistant',
  content: clientId === 'user' ? 'question' : 'visible answer', isStreaming,
  createdAt: clientId === 'user' ? '2026-09-08T00:00:01Z' : '2026-09-08T00:00:00Z',
});

function fixture() {
  let source = [row('user')];
  const view = new HistoryViewController<HistoryChatMessage>({
    page: async () => ({ version: 1, items: projectHistoryView(source, false), hasMore: false, nextCursor: null }),
    details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
    expanded: async () => undefined,
  });
  const handoff = new HistoryViewHandoff<HistoryChatMessage>((message) => message.isStreaming === true);
  const render = (raw: HistoryChatMessage[]) => {
    const snapshot = view.getSnapshot();
    const state = handoff.reconcile(snapshot, raw);
    const build = (rows: readonly HistoryChatMessage[]) => groupWorkRuns(buildRenderItems([...rows]).items, false);
    const items = snapshot.ready ? renderHistoryView({
      view, snapshot, liveMessages: raw, streaming: false,
      isLive: (message) => message.isStreaming === true,
      pendingHandoff: state.pending,
      isLocalUser: (message) => message.role === 'user' && (message.isPendingPersist === true || !!message.blockedByGhost),
      build,
      structure: {
        placeholder: () => { throw new Error('This fixture contains prose only'); },
        children: () => undefined,
        sourceIds: () => [],
        rebuild: (item) => item,
      },
    }) : build(raw);
    return { state, text: JSON.stringify(items), items };
  };
  return { view, handoff, render, setSource: (rows: HistoryChatMessage[]) => { source = rows; } };
}

describe('desktop remote history uses the shared live-to-history handoff', () => {
  it('keeps finalized prose through the first stale page and takes over once by clientId', async () => {
    const { view, render, setSource } = fixture();
    expect(render([row('answer', true)]).text).toContain('visible answer');
    expect(render([row('answer')]).text).toContain('visible answer');
    await view.refresh();
    // The provisional timestamp is older than the history tail; it still belongs
    // to this displayed stream, unlike an arbitrary durable cache row.
    expect(render([row('answer')]).text).toContain('visible answer');
    expect(render([{ ...row('answer'), id: 'persisted-id', rowid: 42 }]).text).toContain('visible answer');
    await view.refresh();
    expect(render([row('answer')]).text).toContain('visible answer');
    setSource([row('user'), { ...row('answer'), id: 'persisted-id', content: 'authoritative answer' }]);
    await view.refresh();
    const final = render([row('answer')]);
    expect(final.state.pending.size).toBe(0);
    expect(final.text).not.toContain('visible answer');
    expect(final.items.filter((item) => item.type === 'message' && item.message.clientId === 'answer')).toHaveLength(1);
    expect(final.text).toContain('authoritative answer');
    view.setActive(false);
  });

  it('retains local pending user bubbles while the assistant awaits history', async () => {
    const { view, render } = fixture();
    await view.refresh();
    render([row('answer', true)]);
    const pending: HistoryChatMessage = { ...row('pending'), role: 'user', content: 'queued follow-up', isPendingPersist: true };
    const final = render([row('answer'), pending]);
    expect(final.text).toContain('visible answer');
    expect(final.text).toContain('queued follow-up');
    expect(final.items.filter((item) => item.type === 'message').map((item) => item.message.clientId)).toEqual(['user', 'answer', 'pending']);
    view.setActive(false);
  });

  it('does not resurrect finalized raw rows after removal, reset or a source switch', async () => {
    const { view, render } = fixture();
    await view.refresh();
    expect(render([row('old')]).text).not.toContain('visible answer');
    render([row('answer', true)]);
    render([]);
    expect(render([row('answer')]).text).not.toContain('visible answer');
    render([row('answer', true)]);
    view.reset();
    render([row('answer')]);
    await view.refresh();
    expect(render([row('answer')]).text).not.toContain('visible answer');
    const replacement = fixture();
    await replacement.view.refresh();
    expect(replacement.render([row('answer')]).text).not.toContain('visible answer');
    replacement.view.setActive(false);
    view.setActive(false);
  });
});
