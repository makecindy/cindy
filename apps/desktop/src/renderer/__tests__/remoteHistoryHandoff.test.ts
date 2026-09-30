import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HistoryViewController, HistoryViewHandoff, projectHistoryView, renderHistoryView, historyViewLeaves,
} from '@cindy/maker-shared/message-window';
import { buildRenderItems, groupWorkRuns, selectVisibleMessages, collectTurnFinalAssistantClientIds,
  findLastUserMessageClientId, planSessionBelongsToLatestUserTurn } from '../components/chat/MessageStream';
import { deriveNavRailEntries } from '../components/chat/messageNavRailModel';
import { collectAssistantTurnUsageDetails } from '../lib/userTurnUsage';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import type { HistoryChatMessage } from '../lib/makerChatStore';
import { confirmRemoteUsers, projectRemoteUsers, reserveRemoteUser } from '../lib/remoteUserHandoff';

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
    const historyIds = new Set(historyViewLeaves(snapshot.items).flatMap((item) =>
      item.type === 'messages' ? item.messages.map((row) => row.clientId) : []));
    for (const detail of snapshot.details.values()) for (const row of detail.messages) historyIds.add(row.clientId);
    raw = projectRemoteUsers(raw, historyIds);
    const state = handoff.reconcile(snapshot, raw);
    const build = (rows: readonly HistoryChatMessage[]) => groupWorkRuns(buildRenderItems([...rows]).items, false);
    const items = snapshot.ready ? renderHistoryView({
      view, snapshot, liveMessages: raw, streaming: false,
      isLive: (message) => message.isStreaming === true,
      pendingHandoff: state.pending,
      isLocalUser: (message) => message.role === 'user' && (message.isPendingPersist === true || !!message.blockedByGhost || !!message.localSendPrecedingClientIds),
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
  it('keeps the live tail after history when the last send reservation retires', async () => {
    const { view, render, setSource } = fixture();
    await view.refresh();
    const sent = reserveRemoteUser({ ...row('sent'), role: 'user' as const }, [row('user')]);
    const reply = { ...row('reply', true), content: 'current answer',
      turnUsageDetails: buildTurnUsageDetails({ inputTokens: 3, outputTokens: 1 })! };
    const raw = [row('user'), reply, sent];
    render(raw); // Observe the live reply before the Host owns either row.
    const { localSendPrecedingClientIds: _reservation, ...hostUser } = sent;
    setSource([row('user'), hostUser]);
    await view.refresh();
    const historyIds = new Set(['user', 'sent']);
    const confirmed = confirmRemoteUsers(raw, historyIds);
    expect(confirmed.every((message) => !message.localSendPrecedingClientIds)).toBe(true);
    const display = projectRemoteUsers(confirmed, historyIds);
    expect(display.map((message) => message.clientId)).toEqual(['user', 'sent', 'reply']);
    expect(render(confirmed).items.filter((item) => item.type === 'message')
      .map((item) => item.message.clientId)).toEqual(['user', 'sent', 'reply']);
    const visible = selectVisibleMessages(display);
    const finals = collectTurnFinalAssistantClientIds(visible);
    expect(finals).toEqual(new Set(['reply']));
    expect(findLastUserMessageClientId(visible)).toBe('sent');
    expect(planSessionBelongsToLatestUserTurn(display, ['reply'])).toBe(true);
    expect(deriveNavRailEntries(visible).at(-1)?.answerExcerpt).toBe('current answer');
    expect(collectAssistantTurnUsageDetails(display, finals).get('reply')?.totalTokens).toBe(4);
    const second = reserveRemoteUser({ ...row('second'), role: 'user' as const }, display);
    const secondReply = row('second-reply', true);
    expect(projectRemoteUsers([...confirmed, secondReply, second], historyIds)
      .map((message) => message.clientId)).toEqual(['user', 'sent', 'reply', 'second', 'second-reply']);
    // Empty history (including the legacy path) provides no ordering evidence.
    expect(projectRemoteUsers(confirmed)).toEqual(confirmed);
    setSource([]);
    await view.refresh();
    expect(render(confirmed).items.filter((item) => item.type === 'message' && item.message.clientId === 'sent')).toEqual([]);
    view.setActive(false);
  });

  it('keeps turn actions, navigation, plans and usage aligned through skewed consecutive sends', () => {
    const oldAnswer = { ...row('old-answer'), content: 'old answer',
      turnUsageDetails: buildTurnUsageDetails({ inputTokens: 100, outputTokens: 1 })! };
    const history = [row('user'), oldAnswer];
    const sent = reserveRemoteUser({ ...row('sent'), role: 'user' as const }, history);
    const internal = { ...row('internal'), parentToolUseId: 'toolu_subagent',
      turnUsageDetails: buildTurnUsageDetails({ inputTokens: 5, outputTokens: 2 })! };
    const reply = { ...row('reply'), content: 'current answer',
      turnUsageDetails: buildTurnUsageDetails({ inputTokens: 3, outputTokens: 1 })! };
    const second = reserveRemoteUser({ ...row('second'), role: 'user' as const }, [...history, sent, internal, reply]);
    const secondReply = { ...row('second-reply'), content: 'second answer' };
    const display = projectRemoteUsers([...history, internal, reply, secondReply, second, sent]);
    const visible = selectVisibleMessages(display);
    expect(visible.map((message) => message.clientId)).toEqual(['user', 'old-answer', 'sent', 'reply', 'second', 'second-reply']);
    const finals = collectTurnFinalAssistantClientIds(visible);
    expect(finals).toEqual(new Set(['old-answer', 'reply', 'second-reply']));
    expect(findLastUserMessageClientId(visible)).toBe('second');
    expect(planSessionBelongsToLatestUserTurn(display, ['second-reply'])).toBe(true);
    expect(planSessionBelongsToLatestUserTurn(display, ['reply'])).toBe(false);
    expect(deriveNavRailEntries(visible).map((entry) => entry.answerExcerpt)).toEqual(['old answer', 'current answer', 'second answer']);
    expect(collectAssistantTurnUsageDetails(display, finals).get('reply')?.totalTokens).toBe(11);
    // Pin the component's inputs too: pure helpers alone cannot catch a raw-order caller.
    const source = readFileSync(new URL('../components/chat/MessageStream.tsx', import.meta.url), 'utf8');
    expect(source).toContain('selectVisibleMessages(displayMessages)');
    expect(source).toContain('planSessionBelongsToLatestUserTurn(displayMessages,');
    expect(source).toContain('findFirstUserMessageClientId(displayMessages,');
    expect(source).toContain('collectAssistantTurnUsageDetails(displayMessages,');
  });

  it.each([{ predecessors: [] as string[] }, { predecessors: ['removed'] }, { predecessors: ['user'] }])('anchors a send after late history with $predecessors', async ({ predecessors }) => {
    const { view, render, setSource } = fixture();
    const sent = reserveRemoteUser({ ...row('sent'), role: 'user' as const }, predecessors.map((id) => row(id)));
    const reply = { ...row('reply', true), content: 'first reply' };
    expect(render([reply, sent]).items.filter((item) => item.type === 'message').map((item) => item.message.clientId)).toEqual(['sent', 'reply']);
    const late = { ...row('late'), role: 'user' as const, content: 'newer historical question' };
    setSource([row('user'), late]);
    await view.refresh();
    expect(render([reply, row('user'), late, sent]).items.filter((item) => item.type === 'message').map((item) => item.message.clientId)).toEqual(['user', 'late', 'sent', 'reply']);
    const second = reserveRemoteUser({ ...row('second'), role: 'user' as const }, [sent, reply]);
    const secondReply = { ...row('second-reply', true), content: 'second reply' };
    expect(render([reply, secondReply, row('user'), late, second, sent]).items.filter((item) => item.type === 'message').map((item) => item.message.clientId)).toEqual(['user', 'late', 'sent', 'reply', 'second', 'second-reply']);
    view.setActive(false);
  });

  it.each([false, true])('keeps a sent user through DB echo and stale history, ready=%s', async (ready) => {
    const { view, render, setSource } = fixture();
    if (ready) await view.refresh();
    const pending = reserveRemoteUser({ ...row('sent'), role: 'user' as const, content: 'sent text', isPendingPersist: true }, [row('user')]);
    expect(render([row('user'), pending]).text).toContain('sent text');
    const echo = { ...pending, isPendingPersist: undefined, id: 'db-sent' };
    await view.refresh();
    expect(render([row('user'), echo]).items.filter((item) => item.type === 'message' && item.message.clientId === 'sent')).toHaveLength(1);
    const authoritative = { ...row('sent'), role: 'user' as const, content: 'authoritative sent' };
    setSource([row('user'), authoritative]);
    await view.refresh();
    const confirmed = confirmRemoteUsers([echo], new Set(['sent']));
    expect(confirmed[0].localSendPrecedingClientIds).toBeUndefined();
    expect(render(confirmed).text).toContain('authoritative sent');
    setSource([]);
    await view.refresh();
    expect(render(confirmed).text).not.toContain('sent text');
    expect(render([]).items).toEqual([]);
    view.setActive(false);
  });

  it.each(['2000-01-01', '2040-01-01'])('keeps user before its reply regardless of controller clock %s', async (createdAt) => {
    const { view, render } = fixture();
    await view.refresh();
    const pending = reserveRemoteUser({ ...row('sent'), role: 'user' as const, createdAt }, [row('user')]);
    const answer = row('answer', true);
    // Raw store may have sorted the host reply ahead of the controller's user row.
    const result = render([row('user'), answer, pending]);
    expect(result.items.filter((item) => item.type === 'message').map((item) => item.message.clientId)).toEqual(['user', 'sent', 'answer']);
    const second = reserveRemoteUser({ ...row('second'), role: 'user' as const }, [row('user'), pending, answer]);
    expect(projectRemoteUsers([row('user'), second, answer, pending]).map((item) => item.clientId)).toEqual(['user', 'sent', 'answer', 'second']);
    view.setActive(false);
  });

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
