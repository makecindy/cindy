import { describe, expect, it, vi } from 'vitest';
import { sessionSwipeReturnsToSource, pushSessionDrillDown, switchDrawerSessionInPlace } from '@/session/sessionDrawerNavigation';

describe('wide session drawer navigation', () => {
  it('switches the current route in place with only the target session identity', () => {
    const replaceParams = vi.fn();

    switchDrawerSessionInPlace(
      { replaceParams },
      {
        deviceId: 'device-b',
        deviceName: 'Desktop B',
        sessionId: 'session-b',
      },
    );

    expect(replaceParams).toHaveBeenCalledOnce();
    expect(replaceParams).toHaveBeenCalledWith({
      deviceId: 'device-b',
      deviceName: 'Desktop B',
      sessionId: 'session-b',
      sessionEntry: 'taskList',
    });
  });

  it('keeps companion history identity and the matched message when opening a search result', () => {
    const replaceParams = vi.fn();
    const target = {
      deviceId: 'device-b',
      deviceName: 'Desktop B',
      sessionId: 'old-chat',
      focusClientId: 'matched-message',
      resourceCollectionId: 'teammates',
      resourceKind: 'bot',
      resourceId: 'companion-b',
      resourceHistorySessionId: 'old-chat',
    };

    switchDrawerSessionInPlace({ replaceParams }, target);

    expect(replaceParams).toHaveBeenCalledWith({ ...target, sessionEntry: 'taskList' });
  });
});

it('preserves sidebar presentation while replacing every old conversation parameter', () => {
  const replaceParams = vi.fn();
  switchDrawerSessionInPlace({ replaceParams }, { deviceId: 'mac', deviceName: 'Mac', sessionId: 'next', taskListEntry: 'sidebar' });
  expect(replaceParams).toHaveBeenCalledExactlyOnceWith({ deviceId: 'mac', deviceName: 'Mac', sessionId: 'next', taskListEntry: 'sidebar', sessionEntry: 'taskList' });
});

// Unit, #11621: every task drill-down must keep its source in the stack, even
// when the destination already exists. The prior fix only marked message links.
it('pushes drill-down destinations with return ownership and preserves the message anchor', () => {
  const push = vi.fn();
  pushSessionDrillDown({ push }, {
    deviceId: 'pc', deviceName: 'Mac', sessionId: 'origin',
    focusClientId: 'message-1', focusRequestKey: 'request-1',
  });
  const [href, options] = push.mock.calls[0];
  expect(href.params).toEqual({
    deviceId: 'pc', deviceName: 'Mac', sessionId: 'origin',
    focusClientId: 'message-1', focusRequestKey: 'request-1', sessionEntry: 'drillDown',
  });
  expect(options.dangerouslySingular('sessions/[sessionId]', href.params)).toBeUndefined();
});

// Unit, #11621: resource cards and companion cards pushed unmarked task routes.
// Read the real predecessor, including for a retained background route, and
// verify that selecting another task from its drawer resets swipe ownership.
it.each(['sessions/[sessionId]', 'companions/groups/[groupId]', 'resources/[collectionId]/[resourceId]'])(
  'returns to an unmarked source %s and restores list swiping after list selection', name => {
    const state = { routes: [
      { key: 'home', name: 'devices/index' },
      { key: 'source', name },
      { key: 'child', name: 'sessions/[sessionId]' },
    ] };
    expect(sessionSwipeReturnsToSource(state, 'child')).toBe(true);
    const replaceParams = vi.fn();
    switchDrawerSessionInPlace({ replaceParams }, { deviceId: 'pc', deviceName: 'Mac', sessionId: 'other' });
    state.routes[2] = { ...state.routes[2], params: replaceParams.mock.calls[0][0] } as typeof state.routes[2];
    expect(sessionSwipeReturnsToSource(state, 'child')).toBe(false);
  },
);
it.each(['index', 'devices/index', 'devices/[deviceId]'])('opens the list after entering from %s', name => {
  const state = { routes: [{ key: 'home', name }, { key: 'task', name: 'sessions/[sessionId]' }] };
  expect(sessionSwipeReturnsToSource(state, 'task')).toBe(false);
  expect(sessionSwipeReturnsToSource(state, 'home')).toBe(false);
});

it('keeps legacy history normalization separate from selecting a task from the list', () => {
  const replaceParams = vi.fn();
  switchDrawerSessionInPlace({ replaceParams }, { deviceId: 'pc', deviceName: 'Mac', sessionId: 'history' }, false);
  expect(sessionSwipeReturnsToSource({ routes: [
    { key: 'source', name: 'sessions/[sessionId]' },
    { key: 'history', name: 'sessions/[sessionId]', params: replaceParams.mock.calls[0][0] },
  ] }, 'history')).toBe(true);
});
