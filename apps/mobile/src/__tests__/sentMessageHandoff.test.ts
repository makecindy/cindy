import { describe, expect, it } from 'vitest';
import { HistoryViewController, HistoryViewHandoff, projectHistoryView } from '@cindy/maker-shared/message-window';
import { appendOptimisticUserMessage, confirmedHistoryUserClientIds, projectOptimisticUserMessages, reconcileOptimisticUserMessages } from '../session/optimisticUserMessages';
import { buildMobileHistoryRenderItems } from '../session/mobileHistoryRender';
import { buildMobileMessageRenderItems } from '../session/messageRenderModel';
import { buildPendingSendItems, mergePendingSendItems } from '../session/pendingSendItems';
import { settleEnqueueResult, type QueueSettlingInput } from '../session/queueSettling';
import type { QueuedRemoteMessage, RemoteMessage } from '../session/types';

const none: ReadonlySet<string> = new Set();
const queued = {
  clientId: 'sent', text: 'hello',
  chatMessage: { clientId: 'sent', role: 'user', content: 'hello', createdAt: '2030-01-01T00:00:00Z' },
} as QueuedRemoteMessage;
const echo: RemoteMessage = {
  id: 'db-sent', clientId: 'sent', sessionId: 's', role: 'user', content: 'authoritative hello',
  createdAt: '2026-09-17T00:00:00Z', toolUseId: null, agentMeta: null,
};

const queueInput = (current: readonly QueuedRemoteMessage[] = [], overrides: Partial<QueueSettlingInput<QueuedRemoteMessage>> = {}): QueueSettlingInput<QueuedRemoteMessage> => ({
  previous: [queued], current, previousSteeringClientIds: none, currentSteeringClientIds: none,
  hiddenClientIds: none, locallyRemovedClientIds: none, ...overrides,
});

describe('sent message handoff', () => {
  it.each([false, true])('keeps exactly one user row across a stale history page (initially ready=%s)', async (ready) => {
    let history: RemoteMessage[] = [];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(history, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    if (ready) await view.refresh();
    const handoff = new HistoryViewHandoff<RemoteMessage>((row) => row.agentMeta?.isStreaming === true);
    let slots = appendOptimisticUserMessage([], [], queued, 's');
    const render = (raw: RemoteMessage[], active = none) => {
      const snapshot = view.getSnapshot();
      const state = handoff.reconcile(snapshot, raw);
      slots = reconcileOptimisticUserMessages(slots, raw, active, confirmedHistoryUserClientIds(snapshot, raw));
      const messages = projectOptimisticUserMessages(state.messages, slots);
      return snapshot.ready
        ? buildMobileHistoryRenderItems({ view, snapshot, messages, pendingHandoff: state.pending,
          localUserClientIds: new Set(slots.map((entry) => entry.message.clientId)), streaming: false, sessionId: 's' })
        : buildMobileMessageRenderItems(messages, { preserveSourceOrder: true });
    };
    expect(render([], new Set(['sent'])).map((item) => item.key)).toEqual(['message-sent']);
    expect(render([echo]).map((item) => item.key)).toEqual(['message-sent']);
    await view.refresh(); // A page requested before enqueue finishes after the push.
    const stale = render([echo]);
    expect(stale.map((item) => item.key)).toEqual(['message-sent']);
    expect(JSON.stringify(stale)).toContain('authoritative hello');
    expect(slots).toHaveLength(1);
    history = [echo];
    await view.refresh();
    expect(render([echo]).map((item) => item.key)).toEqual(['message-sent']);
    expect(slots).toHaveLength(0);
    // After ownership transfers, clear/rewind must not resurrect a local copy.
    history = [];
    await view.refresh();
    expect(render([])).toEqual([]);
    view.setActive(false);
  });

  it.each([false, true])('covers drain before the queued frame commits (reserved=%s)', (reserved) => {
    let slots = reserved ? appendOptimisticUserMessage([], [], queued, 's') : [];
    // React never observed pendingQueue=[queued]. Completion still owns the bubble.
    const settling = settleEnqueueResult([], queued, true, queueInput());
    slots = [...reconcileOptimisticUserMessages(slots, [], new Set(settling.map((item) => item.clientId)), none)];
    const pending = buildPendingSendItems({ queue: [], settling, outbox: [], hiddenClientIds: none,
      sendingClientIds: none, editingClientId: null, steeringClientIds: none, presentationByClientId: new Map() });
    const render = (raw: RemoteMessage[]) => mergePendingSendItems(
      buildMobileMessageRenderItems(projectOptimisticUserMessages(raw, slots), { preserveSourceOrder: true }),
      pending, new Set(slots.filter((entry) => !raw.some((row) => row.clientId === entry.message.clientId))
        .map((entry) => entry.message.clientId)),
    );
    expect(render([]).map((item) => item.key)).toEqual(['message-sent']);
    expect(render([echo]).map((item) => item.key)).toEqual(['message-sent']);
    expect(settleEnqueueResult(settling, queued, true, queueInput())).toBe(settling);
    expect(settleEnqueueResult(settling, queued, false, queueInput())).toEqual([]);
  });

  it('does not claim a settling item while it remains queued', () => {
    const settling: QueuedRemoteMessage[] = [];
    expect(settleEnqueueResult(settling, queued, true, queueInput([queued]))).toBe(settling);
  });

  it('retains a busy send through raw-to-history switching without duplicating the echo', async () => {
    let history: RemoteMessage[] = [];
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: projectHistoryView(history, false), hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    const handoff = new HistoryViewHandoff<RemoteMessage>(() => false);
    let settling = settleEnqueueResult([], queued, true, queueInput());
    const render = () => {
      const snapshot = view.getSnapshot();
      const state = handoff.reconcile(snapshot, [echo]);
      const confirmed = confirmedHistoryUserClientIds(snapshot, [echo]);
      settling = settling.filter((item) => !confirmed.has(item.clientId));
      const pending = buildPendingSendItems({ queue: [], settling, outbox: [],
        hiddenClientIds: new Set(state.messages.map((row) => row.clientId)), sendingClientIds: none,
        editingClientId: null, steeringClientIds: none, presentationByClientId: new Map() });
      const rendered = snapshot.ready
        ? buildMobileHistoryRenderItems({ view, snapshot, messages: state.messages, streaming: false, sessionId: 's' })
        : buildMobileMessageRenderItems(state.messages);
      return mergePendingSendItems(rendered, pending, none);
    };
    expect(render().map((item) => item.key)).toEqual(['message-sent']);
    expect(settling).toHaveLength(1);
    await view.refresh();
    expect(render().map((item) => item.key)).toEqual(['message-sent']);
    history = [echo];
    await view.refresh();
    expect(render().map((item) => item.key)).toEqual(['message-sent']);
    expect(settling).toEqual([]);
    view.setActive(false);
  });

  it('drops a reservation when the raw echo is deleted before history takes over', () => {
    let slots = appendOptimisticUserMessage([], [], queued, 's');
    slots = reconcileOptimisticUserMessages(slots, [echo], none, none);
    expect(slots[0].message).toBe(echo);
    expect(reconcileOptimisticUserMessages(slots, [], none, none)).toEqual([]);
  });

  it.each(['CHANNEL_NOT_ALLOWED', 'UNSUPPORTED_CAPABILITY', 'NETWORK_ERROR'])('uses raw ordering only for permanent history unavailability: %s', async (error) => {
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => { throw new Error(error); },
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => undefined,
    });
    await view.refresh();
    const raw = [{ ...echo, clientId: 'other-controller', id: 'other-controller' }, echo];
    const confirmed = confirmedHistoryUserClientIds(view.getSnapshot(), raw);
    const slots = reconcileOptimisticUserMessages(appendOptimisticUserMessage([], [], queued, 's'), raw, none, confirmed);
    if (error === 'NETWORK_ERROR') {
      expect(confirmed.size).toBe(0);
      expect(slots).toHaveLength(1);
    } else {
      expect(slots).toEqual([]);
      expect(projectOptimisticUserMessages(raw, slots)).toBe(raw);
      expect(confirmed.has('sent')).toBe(true);
    }
    view.setActive(false);
  });

  it('does not revive a remotely deleted middle item after enqueue acceptance', () => {
    const predecessor = { ...queued, clientId: 'before' };
    expect(settleEnqueueResult([], queued, true, queueInput([predecessor], {
      previous: [predecessor, queued],
    }))).toEqual([]);
    expect(settleEnqueueResult([], queued, true, queueInput([], {
      previous: [predecessor, queued],
    }))).toEqual([queued]);
    expect(settleEnqueueResult([], queued, true, queueInput([predecessor], {
      previous: [predecessor, queued], currentSteeringClientIds: new Set(['sent']),
    }))).toEqual([queued]);
  });

  it.each(['hiddenClientIds', 'locallyRemovedClientIds'] as const)('does not settle an already retired item (%s)', (field) => {
    expect(settleEnqueueResult([], queued, true, queueInput([], { [field]: new Set(['sent']) }))).toEqual([]);
  });
});
