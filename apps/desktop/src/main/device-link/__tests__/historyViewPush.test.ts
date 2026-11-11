import { afterEach, describe, expect, it } from 'vitest';
import { isDeferredHistoryPush, deferredToolBoundary } from '../historyViewPush';
import * as subscriptions from '../subscriptions';
afterEach(() => subscriptions.__testing.reset());
describe('per-controller deferred history', () => {
  it('separates collapsed, expanded and legacy peers and refuses late intent after unsubscribe', () => {
    for (const peer of ['closed', 'open', 'old']) subscriptions.subscribe(peer, ['session:s']);
    for (const peer of ['closed', 'open']) subscriptions.prepareHistoryView(peer, 's')!.update(['w']);
    subscriptions.prepareHistoryView('open', 's')!.setExpanded(['w']);
    expect(subscriptions.projectsHistoryDetails('closed', 's')).toBe(true);
    expect(subscriptions.projectsHistoryDetails('open', 's')).toBe(false);
    expect(subscriptions.projectsHistoryDetails('old', 's')).toBe(false);
    subscriptions.unsubscribe('closed', ['session:s']);
    expect(subscriptions.prepareHistoryView('closed', 's')).toBeUndefined();
    expect(subscriptions.hasHistoryView('closed', 's')).toBe(false);
  });
  it.each(['disconnect', 'reopen', 'unsubscribe', 'revoke', 'clear-all'])('invalidates old reads and intents across %s, including re-subscription', (boundary) => {
    for (const peer of ['a', 'b']) subscriptions.subscribe(peer, ['sessions', 'session:s', 'session:other']);
    const old = subscriptions.prepareHistoryView('a', 's')!;
    const other = subscriptions.prepareHistoryView('b', 's')!;
    old.setExpanded(['w']);
    expect(subscriptions.hasHistoryView('a', 's')).toBe(false);
    expect(subscriptions.hasHistoryView('a', 's', true)).toBe(true);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(false);
    old.update(['w']);
    old.setExpanded(['w']);
    if (boundary === 'disconnect') subscriptions.clearController('a');
    if (boundary === 'reopen') subscriptions.clearHistoryViews('a');
    if (boundary === 'unsubscribe') subscriptions.unsubscribe('a', ['session:s']);
    if (boundary === 'revoke') subscriptions.forgetKnownController('a');
    if (boundary === 'clear-all') subscriptions.clearAll();
    subscriptions.subscribe('a', ['session:s']);
    old.update(['w']);
    old.setExpanded(['w']);
    expect(subscriptions.hasHistoryView('a', 's')).toBe(false);
    expect(subscriptions.hasHistoryView('a', 's', true)).toBe(false);
    const current = subscriptions.prepareHistoryView('a', 's')!;
    current.update(['new']);
    old.update(['old']);
    old.setExpanded(['new']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
    current.setExpanded(['new']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(false);
    other.update(['b-work']);
    other.setExpanded(['b-work']);
    expect(subscriptions.hasHistoryView('b', 's')).toBe(boundary !== 'clear-all');
    expect(subscriptions.projectsHistoryDetails('b', 's')).toBe(false);
  });
  it('tracks all streaming groups and replaces the accepted page keys', () => {
    subscriptions.subscribe('a', ['session:s']);
    subscriptions.subscribe('b', ['session:s']);
    const view = subscriptions.prepareHistoryView('a', 's')!;
    view.update(['first', 'second']);
    view.setExpanded(['second']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(false);
    expect(subscriptions.projectsHistoryDetails('b', 's')).toBe(false); // legacy
    view.setExpanded(['completed']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
    view.setExpanded(['second']);
    view.update(['third']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
    view.setExpanded(['third']);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(false);
    view.setExpanded([]);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
    view.setExpanded(['third']);
    view.update([]);
    expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
  });
  it('defers thinking/tool bodies but retains prose, interactions, errors and artifacts', () => {
    const push = (type: string, data: unknown) => ({ sessionId: 's', event: { type, data } });
    const names = () => 'Read';
    expect(isDeferredHistoryPush('maker:event', push('thinking', { stage: 'delta', text: 'large' }), names)).toBe(true);
    expect(isDeferredHistoryPush('maker:event', push('text', { text: 'answer' }), names)).toBe(false);
    expect(isDeferredHistoryPush('maker:event', push('tool_use', { toolName: 'AskUserQuestion' }), names)).toBe(false);
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: 'error', isError: true }), names)).toBe(false);
    const error = '<tool_use_error>Permission denied</tool_use_error>';
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: error }), names)).toBe(true);
    expect(isDeferredHistoryPush('local-db:messages:created', { sessionId: 's', message: { role: 'tool_result', toolUseId: 't', content: error } }, names)).toBe(true);
    expect(isDeferredHistoryPush('maker:event', push('tool_result_full', { toolUseId: 't', fullText: 'cindy-media://result.png' }), names)).toBe(false);
    const start = push('tool_use', { toolUseId: 't', toolName: 'Read', input: 'x'.repeat(100000) });
    expect(isDeferredHistoryPush('maker:event', start, names)).toBe(true);
    expect(deferredToolBoundary(start)).toEqual(push('tool_use', { toolUseId: 't', toolName: 'Read', input: null }));
    expect(JSON.stringify(start).length).toBeGreaterThan(100000);
  });
});

it('restores raw pushes only for the disabled view and rejects its late reads/intents', () => {
  for (const peer of ['a', 'b']) {
    subscriptions.subscribe(peer, ['session:s']);
    subscriptions.prepareHistoryView(peer, 's')!.update(['work']);
  }
  const old = subscriptions.prepareHistoryView('a', 's')!;
  old.disable();
  old.update(['work']);
  old.setExpanded(['work']);
  expect(subscriptions.hasHistoryView('a', 's')).toBe(false);
  expect(subscriptions.hasHistoryView('a', 's', true)).toBe(false);
  expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(false);
  expect(subscriptions.projectsHistoryDetails('b', 's')).toBe(true);
  subscriptions.prepareHistoryView('a', 's')!.update(['new']);
  old.disable();
  expect(subscriptions.projectsHistoryDetails('a', 's')).toBe(true);
});
