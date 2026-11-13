// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionActivityInvalidation } from '@/session/useSessionActivityInvalidation';
import { useSessionMessageHistoryRead } from '@/session/useSessionMessageHistoryRead';
import { resolveSessionMessageEmptyState, type MessageHistoryRead } from '@/session/sessionEmptyState';
import zhMessages from '@/i18n/locales/zh-CN/message.json';

// #6527: exercise the production hook through React mount and dependency updates.
// AST callback tests bypassed effects and stale closures; a signature change with
// attention already true is the smallest missed input. Unit/jsdom is separate
// from the Node sync tests because only these cases need React DOM and effects.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
const initialIdentity = JSON.stringify(['d1', 's1', 1]);
const reconnectIdentity = JSON.stringify(['d1', 's1', 2]);
type ActivityProps = Pick<Parameters<typeof useSessionActivityInvalidation>[0],
  'liveActivitySig' | 'liveAttention' | 'sessionSubscriptionIdentity' | 'load'>
  & Pick<Parameters<typeof useSessionMessageHistoryRead>[0], 'deviceId' | 'sessionId' | 'notificationResponse'>;

function mountActivity(ready = true, notificationResponse: string | null = null) {
  const gate = { current: 1 };
  const loadGenerations: number[] = [];
  const load = vi.fn(async () => { loadGenerations.push(gate.current); });
  let props: ActivityProps = {
    deviceId: 'd1', sessionId: 's1', notificationResponse,
    liveActivitySig: 'completed|1|old result', liveAttention: true,
    sessionSubscriptionIdentity: initialIdentity, load,
  };
  let state!: {
    historyRead: MessageHistoryRead | null;
    readAck: string | null;
    metadata: string | null;
    setHistoryRead: (read: MessageHistoryRead | null) => void;
    emptyState: ReturnType<typeof resolveSessionMessageEmptyState>;
  };
  function presentation(historyRead: MessageHistoryRead | null, status: 'online' | 'stopped' = 'online') {
    return resolveSessionMessageEmptyState({
      loading: false, showSyncingShell: false, messageCount: 0,
      subscriptionIdentity: props.sessionSubscriptionIdentity,
      historyRead, historySnapshot: { ready, items: [] },
      status, targetAvailable: true, remoteUnavailableReason: null,
      historyNotCachedMessage: zhMessages.renderer.historyNotCached,
    });
  }
  function Harness({ value }: { value: ActivityProps }) {
    const [historyRead, setHistoryRead] = useSessionMessageHistoryRead({
      ...value, subscriptionIdentity: value.sessionSubscriptionIdentity,
    });
    const [readAck, setReadAck] = useState<string | null>('read');
    const [metadata, setMetadata] = useState<string | null>('metadata');
    useSessionActivityInvalidation({
      ...value, readAckGateGenRef: gate, setReadAckSyncedKey: setReadAck,
      setSessionMetadataSyncedKey: setMetadata, setMessageHistoryRead: setHistoryRead,
    });
    state = { historyRead, readAck, metadata, setHistoryRead, emptyState: presentation(historyRead) };
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const rerender = (next: Partial<ActivityProps> = {}) => {
    props = { ...props, ...next };
    act(() => root.render(createElement(Harness, { value: props })));
  };
  cleanups.push(() => act(() => root.unmount()));
  rerender();
  return { gate, load, loadGenerations, rerender, get state() { return state; },
    offline: () => presentation(state.historyRead, 'stopped'),
  };
}

describe('useSessionActivityInvalidation', () => {
  // #6527 notification review, unit/jsdom: activity-only cases never changed the
  // visit. A new notification plus a ready empty cache must stay unknown before
  // a successful read, including on the first mount and after reconnect.
  it.each(['cold-open', 'new-visit'])('invalidates cached empty history for a notification %s', (entry) => {
    const h = mountActivity(true, entry === 'cold-open' ? 'notification-1' : null);
    if (entry === 'new-visit') {
      expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
      h.rerender({ notificationResponse: 'notification-1' });
    }
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    expect(h.offline()).toEqual({ syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步' });
    h.rerender({ sessionSubscriptionIdentity: reconnectIdentity });
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    act(() => h.state.setHistoryRead({ key: reconnectIdentity, synced: true }));
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
    h.rerender({ notificationResponse: 'notification-2' });
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    h.rerender({ deviceId: 'd2', sessionId: 's2', notificationResponse: null,
      sessionSubscriptionIdentity: JSON.stringify(['d2', 's2', 1]) });
    expect(h.offline()).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it('keeps the existing empty result on mount and unrelated renders', () => {
    const h = mountActivity();
    h.rerender();
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
    expect(h.state.readAck).toBe('read');
    expect(h.state.metadata).toBe('metadata');
    expect(h.gate.current).toBe(1);
    expect(h.load).not.toHaveBeenCalled();
  });

  it.each([false, true])('invalidates empty history on signature changes (ready cache=%s)', (ready) => {
    const h = mountActivity(ready);
    h.rerender({ liveActivitySig: 'completed|1|new result' });
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    expect(h.offline()).toEqual({ syncingWhileEmpty: false, emptyMessage: '历史消息尚未缓存，连接电脑后同步' });
    expect(h.state.readAck).toBeNull();
    expect(h.state.metadata).toBeNull();
    expect(h.loadGenerations).toEqual([2]);
    act(() => h.state.setHistoryRead({ key: initialIdentity, synced: true }));
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });

  it('does not invalidate when activity changes without attention', () => {
    const h = mountActivity();
    h.rerender({ liveActivitySig: 'completed|0|acknowledged', liveAttention: false });
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
    expect(h.gate.current).toBe(1);
    expect(h.load).not.toHaveBeenCalled();
  });

  it('retains invalidation on reconnect and uses the latest load and identity for later activity', () => {
    const h = mountActivity();
    h.rerender({ liveActivitySig: 'completed|1|new result' });
    const newLoadGenerations: number[] = [];
    const newLoad = vi.fn(async () => { newLoadGenerations.push(h.gate.current); });
    h.rerender({ sessionSubscriptionIdentity: reconnectIdentity, load: newLoad });
    expect(h.state.historyRead).toEqual({ key: initialIdentity, synced: false });
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: true, emptyMessage: undefined });
    expect(newLoad).not.toHaveBeenCalled();
    h.rerender({ liveActivitySig: 'completed|1|newer result' });
    expect(h.state.historyRead).toEqual({ key: reconnectIdentity, synced: false });
    expect(h.load).toHaveBeenCalledOnce();
    expect(newLoadGenerations).toEqual([3]);
    act(() => h.state.setHistoryRead({ key: reconnectIdentity, synced: true }));
    expect(h.state.emptyState).toEqual({ syncingWhileEmpty: false, emptyMessage: undefined });
  });
});
