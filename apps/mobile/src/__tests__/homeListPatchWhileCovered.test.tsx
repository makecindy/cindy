// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteSessionStoreSubscriptionGate, remoteSessionStore, useRemoteSessions, useRemoteSessionTitles } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => remoteSessionStore.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  remoteSessionStore.clear();
  vi.restoreAllMocks();
});

function row(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id, userId: 'owner', title: id, status: 'active', workingDir: '/repo', workspaceKind: 'project',
    model: 'model', agentKind: 'codex', effort: '', permissionMode: 'default', fastMode: false,
    userSendAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...patch,
  };
}

function Titles() {
  return useRemoteSessions().map((session) => session.title).join(',');
}

// Home keeps its `sessions` subscription while a task page covers it. Pushes that land in that
// window must be on screen as soon as Home is visible again, without a fresh list pull.
it('shows list patches received while Home was covered as soon as Home returns', () => {
  remoteSessionStore.setDeviceSessions('mac', 'Mac', [row('a'), row('b')]);
  root = createRoot(container);
  const render = (enabled: boolean) => act(() => root!.render(
    createElement(RemoteSessionStoreSubscriptionGate, { enabled, children: createElement(Titles) }),
  ));
  render(true);
  expect(container.textContent).toBe('a,b');

  render(false);
  act(() => {
    remoteSessionStore.applyRemotePush('mac', 'local-db:sessions:patched', { sessionId: 'a', patch: { title: 'renamed' } });
    remoteSessionStore.applyRemotePush('mac', 'local-db:sessions:patched', { sessionId: 'b', patch: { status: 'archived' } });
  });
  // Covered Home does not re-render for each push.
  expect(container.textContent).toBe('a,b');

  render(true);
  expect(container.textContent).toBe('renamed');
});

it('freezes linked titles while covered and catches up on resume without a list pull', () => {
  remoteSessionStore.setDeviceSessions('mac', 'Mac', [row('a'), row('b')]);
  const ids = ['a'];
  const renders = vi.fn();
  function Link() {
    renders();
    return useRemoteSessionTitles(ids)?.a ?? 'missing';
  }
  root = createRoot(container);
  const render = (enabled: boolean) => act(() => root!.render(
    createElement(RemoteSessionStoreSubscriptionGate, { enabled, children: createElement(Link) }),
  ));
  render(true);
  expect(container.textContent).toBe('a');
  render(false);
  renders.mockClear();
  act(() => remoteSessionStore.applySessionPatch('mac', 'a', { title: 'renamed' }));
  expect(renders).not.toHaveBeenCalled();
  expect(container.textContent).toBe('a');
  render(true);
  expect(container.textContent).toBe('renamed');
  let cancelPreview!: () => void;
  act(() => { cancelPreview = remoteSessionStore.beginSessionListRemovalPreview('a'); });
  expect(container.textContent).toBe('missing');
  act(() => cancelPreview());
  expect(container.textContent).toBe('renamed');
});
