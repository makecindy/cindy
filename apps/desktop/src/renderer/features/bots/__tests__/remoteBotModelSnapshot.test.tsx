// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore, useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { refreshRemoteDeviceSessions } from '@/features/device-link/refreshRemoteSessions';
import { makerApiFor } from '@/lib/makerTransport';
import { resolveComposerModelSelection } from '@/components/new-chat/composerModelSelection';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ deviceId: 'snapshot-host', botId: 'writer' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useRemoteBots', () => ({
  markRemoteBotRead: vi.fn(),
  useRemoteBots: () => [{ id: 'writer', deviceId: 'snapshot-host', deviceName: 'Host', name: 'Writer', sessionId: 'canonical', online: true }],
}));
// Keep the real entry, mirror, reconciliation, model projection and transport.
// The expensive transcript/editor tree is represented by its model/send consumer.
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ sessionIdProp }: { sessionIdProp: string }) => {
    const session = useRemoteProjectSessions().find((row) => row.id === sessionIdProp);
    if (!session) return <div>metadata-loading</div>;
    const selection = resolveComposerModelSelection({ current: {
      agentKind: 'codex', model: session.model, providerId: session.providerId ?? null,
      effort: session.effort, fastMode: session.fastMode,
    }, effective: session.runtimeEffective, pending: session.runtimePending });
    return <button onClick={() => void makerApiFor(session.id).send(session.id, 'next turn', {
      ...selection.display, effort: selection.display.effort ?? undefined,
      workingDir: '/remote/workspace',
    })}>{selection.display.model}</button>;
  },
}));
import { RemoteBotSessionView } from '../RemoteBotSessionView';

const astra = { id: 'canonical', source: 'bot', status: 'active', agentKind: 'codex',
  model: 'gpt-6-astra', providerId: 'openai', effort: 'medium', fastMode: false,
  workingDir: '/remote/workspace', title: 'Writer', createdAt: '2026-09-14T00:00:00Z',
  updatedAt: '2026-09-14T00:00:00Z' } as Session;
const fable = { ...astra, model: 'claude-fable-5-1', providerId: 'anthropic', effort: 'high' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function entry(detail: Promise<Session>) {
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'maker:remote-resources:get') return {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
      display: { title: 'Writer' }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'canonical' } }],
    };
    if (channel === 'local-db:sessions:get') return detail;
    if (channel === 'local-db:sessions:list') return [];
    return undefined;
  });
  return render(<RemoteBotSessionView />);
}
beforeEach(() => {
  remoteProjectsStore.clear();
  h.invoke.mockReset();
  window.electronAPI = { deviceLink: { invoke: h.invoke } } as unknown as Window['electronAPI'];
});
afterEach(() => { cleanup(); remoteProjectsStore.clear(); });

it('keeps Astra through reply completion and delayed ordinary-list refresh, then routes the next send to Astra', async () => {
  entry(Promise.resolve(astra));
  await screen.findByRole('button', { name: 'gpt-6-astra' });
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, { lastTurnEndedAt: Date.now() });
    for (let i = 0; i < 3; i++) await refreshRemoteDeviceSessions('snapshot-host', 'Host');
  });
  fireEvent.click(screen.getByRole('button', { name: 'gpt-6-astra' }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: astra.model, providerId: 'openai', effort: 'medium' }),
  ]));
  expect(h.invoke.mock.calls.some((call) => call[1] === 'maker:set-model')).toBe(false);
});

it('does not roll back an explicit model switch with a late companion-entry GET', async () => {
  const detail = deferred<Session>();
  remoteProjectsStore.mergeDeviceSessions('snapshot-host', 'Host', [fable]);
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, { ...astra });
    detail.resolve(fable);
  });
  await screen.findByRole('button', { name: 'gpt-6-astra' });
  await act(async () => remoteProjectsStore.applyPatch('snapshot-host', astra.id, fable));
  fireEvent.click(screen.getByRole('button', { name: fable.model }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: fable.model, providerId: 'anthropic', effort: 'high' }),
  ]));
});

it.each(['disconnect', 'remove', 'clear', 'delete', 'archive'] as const)(
  'does not revive a companion from a late GET after %s', async (event) => {
    const detail = deferred<Session>();
    remoteProjectsStore.mergeDeviceSessions('snapshot-host', 'Host', [astra]);
    entry(detail.promise);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
    await act(async () => {
      if (event === 'disconnect') remoteProjectsStore.markDeviceDisconnected('snapshot-host');
      if (event === 'remove') remoteProjectsStore.removeDevice('snapshot-host');
      if (event === 'clear') remoteProjectsStore.clear();
      if (event === 'delete' || event === 'archive') remoteProjectsStore.applyPatch('snapshot-host', astra.id, { status: event === 'delete' ? 'deleted' : 'archived' });
      detail.resolve(astra);
    });
    await screen.findByText('bots.sessionLoadFailedDescription');
    expect(screen.queryByRole('button', { name: astra.model })).toBeNull();
  },
);

it('invalidates an initial detail read even if clear happens before the first shard exists', () => {
  const current = remoteProjectsStore.captureSessionRead('unloaded-host', 'unloaded-session');
  remoteProjectsStore.clear();
  expect(current()).toBe(false);
});


it.each(['active', 'archived'] as const)('accepts the first companion detail across an unrelated %s list refresh', async (status) => {
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.nextSnapshotEpoch('snapshot-host', status);
    remoteProjectsStore.setDeviceSessions('snapshot-host', 'Host', [], status);
    detail.resolve(astra);
  });
  await screen.findByRole('button', { name: astra.model });
});

it.each([
  { deviceName: 'Host', mode: 'replace' },
  { deviceName: 'Renamed host', mode: 'replace' },
  { deviceName: 'Host', mode: 'merge' },
  { deviceName: 'Renamed host', mode: 'merge' },
] as const)('accepts authoritative detail when reconnect only restamps a cached companion: $mode / $deviceName', async ({ deviceName, mode }) => {
  remoteProjectsStore.hydrateFromCache([{ deviceId: 'snapshot-host', deviceName: 'Host', sessions: [fable] }]);
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    if (mode === 'merge') remoteProjectsStore.mergeDeviceSessions('snapshot-host', deviceName, []);
    else remoteProjectsStore.setDeviceSessions('snapshot-host', deviceName, []);
    detail.resolve(astra);
  });
  fireEvent.click(await screen.findByRole('button', { name: astra.model }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: astra.model, providerId: 'openai', effort: 'medium' }),
  ]));
  expect(screen.queryByRole('button', { name: fable.model })).toBeNull();
});

it.each(['replace', 'merge'].flatMap(mode => [
  { mode, event: 'tokens', patch: { totalTokenUsage: 1200 } },
  { mode, event: 'preview', patch: { preview: 'new preview' } },
  { mode, event: 'title', patch: { title: 'generated title' } },
  { mode, event: 'sent-at', patch: { userSendAt: 1789466400000 } },
  { mode, event: 'updated-at', patch: { updatedAt: '2026-09-16T04:00:00Z' } },
  { mode, event: 'cost', patch: { totalCostUsd: 2 } },
  { mode, event: 'money', patch: { totalMoney: { amount: 2, currency: 'USD', approximate: false, kind: 'actual-cost' } } },
  { mode, event: 'completion', patch: { lastTurnEndedAt: 1789466400000 } },
  { mode, event: 'rename', patch: {} },
  { mode, event: 'combined', patch: { totalTokenUsage: 1200, lastTurnEndedAt: 1789466400000 } },
]))('keeps Astra and newer activity across reconnect plus $event ($mode)', async ({ mode, event, patch }) => {
  remoteProjectsStore.hydrateFromCache([{ deviceId: 'snapshot-host', deviceName: 'Host', sessions: [fable] }]);
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    if (mode === 'merge') remoteProjectsStore.mergeDeviceSessions('snapshot-host', 'Host', []);
    else remoteProjectsStore.setDeviceSessions('snapshot-host', 'Host', []);
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, patch);
    if (event === 'rename' || event === 'combined') remoteProjectsStore.renameDevice('snapshot-host', 'Renamed host');
    detail.resolve(astra);
  });
  fireEvent.click(await screen.findByRole('button', { name: astra.model }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: astra.model, providerId: 'openai' }),
  ]));
  expect(remoteProjectsStore.getDeviceSessions('snapshot-host')[0]).toMatchObject({ ...patch, model: astra.model });
  if (event === 'rename' || event === 'combined') {
    expect(remoteProjectsStore.getDeviceSessions('snapshot-host')[0]?.deviceLinkDeviceName).toBe('Renamed host');
  }
});

it('merges only activity pushed after capture, including equal-value and cleared fields', async () => {
  remoteProjectsStore.mergeDeviceSessions('snapshot-host', 'Host', [{ ...astra, totalTokenUsage: 10, totalCostUsd: 1 }]);
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, { totalTokenUsage: 10, lastTurnEndedAt: null });
    detail.resolve({ ...astra, totalTokenUsage: 5, totalCostUsd: 3, lastTurnEndedAt: 1789466400000 });
  });
  await screen.findByRole('button', { name: astra.model });
  expect(remoteProjectsStore.getDeviceSessions('snapshot-host')[0]).toMatchObject({
    totalTokenUsage: 10, totalCostUsd: 3, lastTurnEndedAt: null,
  });
});

it.each(['deleted', 'archived'] as const)('rejects a first detail after an unknown-session %s patch', async (status) => {
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, { status });
    detail.resolve(astra);
  });
  await screen.findByText('bots.sessionLoadFailedDescription');
  expect(screen.queryByRole('button', { name: astra.model })).toBeNull();
});

it.each([
  { name: 'spend', patch: { totalMoney: { amount: 2, currency: 'USD', approximate: false, kind: 'actual-cost' }, totalCostUsd: 2 } },
  { name: 'tokens', patch: { totalTokenUsage: 1200 } },
  { name: 'preview', patch: { preview: 'first preview' } },
  { name: 'title', patch: { title: 'first title' } },
  { name: 'send registration', patch: { userSendAt: 1789466400000, updatedAt: '2026-09-16T04:00:00Z' } },
  { name: 'turn completion', patch: { lastTurnEndedAt: 1789466400000 } },
  { name: 'usage and turn completion', patch: { lastTurnEndedAt: 1789466400000, totalTokenUsage: 1200 } },
])('accepts the first companion detail across activity-only $name', async ({ patch }) => {
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, patch);
    detail.resolve(astra);
  });
  fireEvent.click(await screen.findByRole('button', { name: astra.model }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: astra.model, providerId: 'openai' }),
  ]));
  expect(screen.queryByText('bots.sessionLoadFailedDescription')).toBeNull();
});

it('preserves newer cumulative usage in an existing mirror instead of publishing a late GET', async () => {
  const detail = deferred<Session>();
  remoteProjectsStore.mergeDeviceSessions('snapshot-host', 'Host', [astra]);
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, { totalTokenUsage: 1200, totalCostUsd: 2, lastTurnEndedAt: 1789466400000 });
    detail.resolve(astra);
  });
  await screen.findByRole('button', { name: astra.model });
  expect(remoteProjectsStore.getDeviceSessions('snapshot-host')[0]).toMatchObject({ totalTokenUsage: 1200, totalCostUsd: 2, lastTurnEndedAt: 1789466400000 });
});

it.each([
  { model: astra.model, providerId: astra.providerId },
  { model: astra.model, providerId: astra.providerId, totalTokenUsage: 1200 },
  { model: astra.model, providerId: astra.providerId, lastTurnEndedAt: 1789466400000 },
])('rejects a stale first detail after a route push (including mixed usage) and retries with the new route: %j', async (patch) => {
  const detail = deferred<Session>();
  entry(detail.promise);
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'local-db:sessions:get', ['canonical']));
  await act(async () => {
    remoteProjectsStore.applyPatch('snapshot-host', astra.id, patch);
    detail.resolve(fable);
  });
  await screen.findByText('bots.sessionLoadFailedDescription');
  expect(remoteProjectsStore.getDeviceSessions('snapshot-host')).toEqual([]);
  h.invoke.mockImplementation(async (_device, channel) => {
    if (channel === 'maker:remote-resources:get') return {
      ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' },
      display: { title: 'Writer' }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'canonical' } }],
    };
    if (channel === 'local-db:sessions:get') return astra;
  });
  fireEvent.click(screen.getByRole('button', { name: 'bots.retry' }));
  fireEvent.click(await screen.findByRole('button', { name: astra.model }));
  await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('snapshot-host', 'maker:send', [
    astra.id, 'next turn', expect.objectContaining({ model: astra.model, providerId: 'openai' }),
  ]));
});

it('keeps a target detail valid across another session patch and another device disconnect', () => {
  const current = remoteProjectsStore.captureSessionRead('snapshot-host', 'canonical');
  remoteProjectsStore.applyPatch('snapshot-host', 'other-session', { model: fable.model });
  remoteProjectsStore.markDeviceDisconnected('other-host');
  expect(current()).toBe(true);
});

it.each(['disconnect', 'remove', 'all-disconnected'] as const)(
  'invalidates a detail before its first shard exists on %s', (event) => {
    const current = remoteProjectsStore.captureSessionRead('snapshot-host', 'canonical');
    if (event === 'disconnect') remoteProjectsStore.markDeviceDisconnected('snapshot-host');
    if (event === 'remove') remoteProjectsStore.removeDevice('snapshot-host');
    if (event === 'all-disconnected') remoteProjectsStore.markAllDisconnected();
    expect(current()).toBe(false);
  },
);
