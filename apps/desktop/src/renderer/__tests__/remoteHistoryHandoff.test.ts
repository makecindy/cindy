import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HistoryViewController, HistoryViewHandoff, projectHistoryView, renderHistoryView, historyViewLeaves, nextHistoryCacheReceipt,
} from '@cindy/maker-shared/message-window';
import { buildMessageStreamRenderProjection, buildCachedRenderItems, buildRenderItems, groupWorkRuns, selectVisibleMessages, collectTurnFinalAssistantClientIds,
  findLastUserMessageClientId, planSessionBelongsToLatestUserTurn } from '../components/chat/MessageStream';
import { deriveNavRailEntries } from '../components/chat/messageNavRailModel';
import { collectAssistantTurnUsageDetails } from '../lib/userTurnUsage';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails';
import type { HistoryChatMessage } from '../lib/makerChatStore';
import type { VoiceCallRecord } from '@cindy/maker-core';
import { BOT_MESSAGE_TIME_GROUP_MS, collectBotMessageTimeGroups } from '../features/bots/botConversationTimeline';
import { confirmRemoteUsers, projectRemoteUsers, reserveRemoteUser } from '../lib/remoteUserHandoff';

const row = (clientId: string, isStreaming = false): HistoryChatMessage => ({
  id: clientId, clientId, role: clientId === 'user' ? 'user' : 'assistant',
  content: clientId === 'user' ? 'question' : 'visible answer', isStreaming,
  createdAt: clientId === 'user' ? '2026-09-08T00:00:01Z' : '2026-09-08T00:00:00Z',
});

// Regression: filtering the raw list in CCAgentSessionView did not cover the
// independently loaded history snapshot, so a saved seven-second empty call
// reappeared after reopening the task. Exercise the production render boundary.
it.each(['raw', 'render-cache', 'history', 'cache', 'older-page'] as const)(
  'omits empty/live call cards from %s without removing saved content or handoffs',
  async (source) => {
    const call = (
      id: string,
      turns: VoiceCallRecord['turns'] = [],
      handoffs: VoiceCallRecord['handoffs'] = [],
    ): HistoryChatMessage => ({
      ...row(id),
      content: '',
      systemCardType: 'voice-call',
      systemCardData: { record: {
        version: 1, callId: id, startedAt: 1000, endedAt: 8241, turns, handoffs,
      } satisfies VoiceCallRecord },
    });
    const turn = (text: string, failed = false): VoiceCallRecord['turns'] => [
      { id: 'turn', role: 'user', text, complete: true, failed, createdAt: 1100 },
    ];
    const rows = [
      call('empty'), call('whitespace', turn(' \n\t')),
      call('spoken', turn('你好')),
      call('failed', turn('请保留原句', true)),
      call('interrupted', [{ id: 'reply', role: 'assistant', text: '还没说完', complete: false, createdAt: 1200 }]),
      call('handoff', [], [{ id: 'task', inputId: 'request', text: '后台继续', state: 'accepted' }]),
      call('live', turn('这通电话还在继续')),
    ].map((message, index) => ({
      ...message,
      createdAt: new Date(Date.UTC(2026, 9, 20) + index * BOT_MESSAGE_TIME_GROUP_MS * 2).toISOString(),
    }));
    const saved = structuredClone(rows);
    const view = new HistoryViewController<HistoryChatMessage>({
      page: async (before) => ({
        version: 1,
        items: [{ type: 'messages', key: before ? 'older' : 'latest',
          messages: source === 'older-page' ? (before ? rows.slice(0, -1) : rows.slice(-1)) : rows }],
        hasMore: source === 'older-page' && !before,
        nextCursor: source === 'older-page' && !before ? 'older' : null,
      }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    try {
      if (source === 'cache') {
        view.setActive(false);
        await view.restoreCachedView(async () => ({ ...view.getSnapshot(), ready: true,
          items: [{ type: 'messages', key: 'cached', messages: rows }] }));
      } else if (source !== 'raw' && source !== 'render-cache') {
        await view.refresh();
        if (source === 'older-page') await view.refresh(true);
      }
      const render = (activeVoiceCallId: string | null) => {
        const renderOptions = { botSessionId: 'voice-owner', activeVoiceCallId };
        return buildMessageStreamRenderProjection({
          historyView: view, historySnapshot: view.getSnapshot(), historyLiveMessages: [],
          isSessionStreaming: false, generatedFilesItemCache: new Map(), renderOptions,
          buildRaw: () => (source === 'render-cache' ? buildCachedRenderItems : buildRenderItems)(
            rows, undefined, undefined, renderOptions,
          ),
        }).items.flatMap(item => item.type === 'message' ? [item.message] : []);
      };
      const visible = render('live');
      expect(visible.map(message => message.clientId)).toEqual(['spoken', 'failed', 'interrupted', 'handoff']);
      expect([...collectBotMessageTimeGroups(visible).keys()]).toEqual(['spoken', 'failed', 'interrupted', 'handoff']);
      // Ending a nonempty call reveals its existing card, without a new row.
      expect(render(null).map(message => message.clientId)).toEqual(['spoken', 'failed', 'interrupted', 'handoff', 'live']);
      expect(rows).toEqual(saved);
    } finally {
      view.setActive(false);
    }
  },
);

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
      staleTail: state.tail,
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
  it.each([false, true])('lets a newer empty page retire a receipt before the raw deletion push arrives (streamed=%s)', async (streamed) => {
    const { view, render, setSource } = fixture();
    const readReceipt = nextHistoryCacheReceipt();
    let received = { ...row('reply', streamed), cacheReceipt: nextHistoryCacheReceipt() };
    view.setActive(false);
    await view.restoreCachedView(async () => ({ ...view.getSnapshot(), ready: true, readReceipt }));
    expect(render([received]).text).toContain('visible answer');
    received = { ...received, isStreaming: false };
    setSource([]);
    view.setActive(true);
    await view.refresh();
    expect(render([received]).items).toEqual([]);
    view.setActive(false);
    expect(render([received]).items).toEqual([]);
    expect(render([received]).state.tail.size).toBe(0);
    expect(render([received]).state.pending.size).toBe(0);
  });

  // Unit: reproduce the list-receipt/history timestamp disagreement through the
  // Desktop renderer; the already received answer must never disappear on entry.
  it('keeps a received answer whose timestamp is earlier than the cached page tail', async () => {
    const { view, render, setSource } = fixture();
    const later = row('user');
    const readReceipt = nextHistoryCacheReceipt();
    const received = { ...row('reply'), cacheReceipt: nextHistoryCacheReceipt() };
    view.setActive(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([later], false), details: new Map(),
      expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null, readReceipt }));
    expect(render([received]).text).toContain('visible answer');
    setSource([received, later]);
    view.setActive(true);
    await view.refresh();
    const result = render([received]);
    expect(result.items.filter(item => item.type === 'message').map(item => item.message.clientId))
      .toEqual(['reply', 'user']);
    expect(result.state.tail.size).toBe(0);
    view.setActive(false);
  });

  // Same-ID body updates must survive cache restore and yield to a later Host read.
  it('renders a later list receipt instead of the old cached body', async () => {
    const { view, render, setSource } = fixture();
    const old = { ...row('reply'), content: 'old cached body' };
    const readReceipt = nextHistoryCacheReceipt();
    const received = { ...old, content: 'updated received body', cacheReceipt: nextHistoryCacheReceipt() };
    view.setActive(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([old], false), details: new Map(),
      expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null,
      readReceipt }));
    expect(render([received]).text).toContain('updated received body');
    expect(render([received]).text).not.toContain('old cached body');
    setSource([{ ...old, content: 'authoritative body' }]);
    view.setActive(true);
    await view.refresh();
    expect(render([received]).text).toContain('authoritative body');
    expect(render([received]).text).not.toContain('updated received body');
    view.setActive(false);
  });

  it.each([false, true])('places a late harness boundary before the reserved send (history ready=%s)', async (ready) => {
    const { view, render, setSource } = fixture();
    if (ready) await view.refresh();
    const previous = row('user');
    const sent = reserveRemoteUser({ ...row('sent'), role: 'user' as const, isPendingPersist: true }, [previous]);
    const boundary: HistoryChatMessage = { ...row('switch'), systemCardType: 'agent-switch',
      createdAt: '2026-09-08T00:00:02Z' };
    const raw = [previous, sent, boundary];
    const ids = () => render(raw).items.filter((item) => item.type === 'message').map((item) => item.message.clientId);
    // Local Desktop sends have no explicit reservation until their DB echo.
    const { localSendPrecedingClientIds: _reservation, ...localPending } = sent;
    expect(projectRemoteUsers([previous, localPending, boundary]).map((message) => message.clientId))
      .toEqual(['user', 'switch', 'sent']);
    expect(projectRemoteUsers(raw).map((message) => message.clientId)).toEqual(['user', 'switch', 'sent']);
    if (!ready) expect(ids()).toEqual(['user', 'switch', 'sent']);
    setSource([previous, boundary]);
    await view.refresh();
    expect(ids()).toEqual(['user', 'switch', 'sent']);
    raw[1] = { ...sent, id: 'db-sent', isPendingPersist: undefined };
    expect(ids()).toEqual(['user', 'switch', 'sent']);
    setSource([previous, boundary, raw[1]]);
    await view.refresh();
    expect(ids()).toEqual(['user', 'switch', 'sent']);
    view.setActive(false);
  });

  it('does not pull a later harness switch across a reply into an earlier send', () => {
    const previous = row('user');
    const sent = reserveRemoteUser({ ...row('sent'), role: 'user' as const }, [previous]);
    const reply = row('reply');
    const boundary = { ...row('switch'), systemCardType: 'agent-switch' as const };
    const next = reserveRemoteUser({ ...row('next'), role: 'user' as const }, [previous, sent, reply]);
    expect(projectRemoteUsers([previous, sent, reply, next, boundary]).map((message) => message.clientId))
      .toEqual(['user', 'sent', 'reply', 'switch', 'next']);
  });

  it.each([false, true])('keeps consecutive switches with their sends without a reply (next echoed=%s)', (echoed) => {
    const previous = row('user');
    const firstSwitch = { ...row('switch-first'), systemCardType: 'agent-switch' as const };
    const secondSwitch = { ...row('switch-next'), systemCardType: 'agent-switch' as const };
    // The first DB echo has arrived, but history has not retired its reservation.
    const first = reserveRemoteUser({ ...row('first'), role: 'user' as const }, [previous]);
    const next = reserveRemoteUser({ ...row('next'), role: 'user' as const,
      isPendingPersist: !echoed }, [previous, firstSwitch, first]);
    const raw = [previous, firstSwitch, first, secondSwitch, next];
    const expected = ['user', 'switch-first', 'first', 'switch-next', 'next'];
    expect(projectRemoteUsers(raw).map((message) => message.clientId)).toEqual(expected);
    expect(projectRemoteUsers(raw, new Set(['user', 'switch-first'])).map((message) => message.clientId)).toEqual(expected);
    const confirmedIds = new Set(expected);
    expect(projectRemoteUsers(confirmRemoteUsers(raw, confirmedIds), confirmedIds).map((message) => message.clientId)).toEqual(expected);
  });

  it('shows a list-pushed reply after a restored snapshot until the page read covers it', async () => {
    const { view, render, setSource } = fixture();
    const reply = { ...row('reply'), content: 'prefetched reply', createdAt: '2026-09-08T00:00:09Z' };
    const pendingUser = { ...row('typing'), role: 'user' as const, content: 'local draft send',
      isPendingPersist: true, createdAt: '2026-09-08T00:00:10Z' };
    view.setActive(false);
    await view.restoreCachedView(async () => ({ items: projectHistoryView([row('user')], false), details: new Map(),
      expanded: new Set(), nextCursor: null, hasMore: false, loading: false, ready: true, error: null }));
    const restored = render([row('user'), reply, pendingUser]);
    expect(restored.state.tail).toEqual(new Set(['reply', 'typing']));
    expect(restored.text).toContain('prefetched reply');
    expect(restored.text.split('local draft send')).toHaveLength(2);
    setSource([row('user'), reply]);
    view.setActive(true);
    await view.refresh();
    const fresh = render([row('user'), reply]);
    expect(fresh.state.tail.size).toBe(0);
    expect(fresh.text.split('prefetched reply')).toHaveLength(2);
    view.setActive(false);
  });

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
    expect(source).toContain('const metadataMessages = metadataProjection(displayMessages)');
    expect(source).toContain('findFirstUserMessageClientId(metadataMessages,');
    expect(source).toContain('collectAssistantTurnUsageDetails(metadataMessages,');
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

// Unit: exercise the projection used by MessageStream, including the lazy raw
// fallback. Existing handoff cases call renderHistoryView below that boundary.
it.each([false, true])('builds the displayed source and retains tool results (ready=%s)', async ready => {
  const historyRows: HistoryChatMessage[] = [row('user'),
    { ...row('call'), role: 'tool_use', toolName: 'Read', toolUseId: 'tool', toolInput: {} },
    { ...row('result'), role: 'tool_result', toolUseId: 'tool', content: 'Tool output' },
    { ...row('cached'), content: 'Cached answer' }];
  const view = new HistoryViewController<HistoryChatMessage>({
    page: async () => ({ version: 1, items: [{ type: 'messages', key: 'page', messages: historyRows }], hasMore: false, nextCursor: null }),
    details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
    expanded: async () => undefined,
  });
  if (ready) await view.refresh();
  const buildRaw = vi.fn(() => buildRenderItems([{ ...row('raw'), content: 'Raw answer' }]));
  const result = buildMessageStreamRenderProjection({
    historyView: view, historySnapshot: view.getSnapshot(), historyLiveMessages: [],
    isSessionStreaming: false, generatedFilesItemCache: new Map(), buildRaw,
  });
  expect(result.items.filter(item => item.type === 'message').map(item => item.message.content))
    .toContain(ready ? 'Cached answer' : 'Raw answer');
  expect(JSON.stringify(result.items)).not.toContain(ready ? 'Raw answer' : 'Cached answer');
  expect(buildRaw).toHaveBeenCalledTimes(ready ? 0 : 1);
  if (ready) {
    const work = result.items.find(item => item.type === 'work_group');
    const tool = work?.type === 'work_group' ? work.children.find(item => item.type === 'tool_segment') : undefined;
    expect(tool?.type === 'tool_segment' && tool.resultMap.get('call')).toBe('Tool output');
  } else {
    expect(result.singleResultMap).toBe(buildRaw.mock.results[0].value.singleResultMap);
  }
  view.setActive(false);
});
