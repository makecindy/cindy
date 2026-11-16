import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_COLLECTION, REMOTE_RESOURCE_CHANGED_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';

vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));

import { __resetGhostCardStoreForTest, ensureRemoteCard, getGhostCardEntry, retainRemoteCardSession } from '../ghostCardStore';
import { __resetGhostCardActionsForTest, dispatchGhostCardAction, routeForPicker } from '../ghostCardActions';

// Production entries: MessageStream calls ensureRemoteCard for a remote task's card results, and
// every card click goes through dispatchGhostCardAction. A remote card must be read from and acted
// on through its own computer, never this one; an older host must be asked only once.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const route = { agentKind: 'cc' as const, providerId: 'anthropic', model: 'm', effort: 'low', fastMode: false };

function stubApi() {
  let push: (payload: { deviceId: string; channel: string; payload: unknown }, stamp?: unknown) => void = () => {};
  const api = {
    ghosts: {
      getRemoteCard: vi.fn(async (_device: string, _session: string, callId: string) => ({
        card: { ghostId: 'cindy-github', html: `<p>${callId}</p>`, height: 120, revision: `rev-${callId}`, externalLinks: false },
      })),
      dispatchCardAction: vi.fn(async () => ({ ok: true })),
    },
    deviceLink: {
      onRemotePush: vi.fn((cb: typeof push) => { push = cb; return () => {}; }),
      listDevices: vi.fn(async () => ({ devices: [{ deviceId: 'controller', isSelf: true }, { deviceId: 'host', isSelf: false }] })),
      invoke: vi.fn(async (_device: string, _channel: string, args: unknown[]) => {
        const request = args[0] as { collectionId: string; actionId: string };
        if (request.collectionId === PLUGIN_COLLECTION && request.actionId === 'open-interaction') return { effects: [], result: { pageId: 'page-1' } };
        if (request.collectionId === PLUGIN_COLLECTION && request.actionId === 'poll') return { effects: [], result: { events: [], confirms: [], notifications: [] } };
        return { effects: [] };
      }),
    },
  };
  vi.stubGlobal('window', { electronAPI: api });
  return { api, push: (...args: Parameters<typeof push>) => push(...args) };
}

describe('remote plugin cards', () => {
  beforeEach(() => {
    __resetGhostCardStoreForTest();
    __resetGhostCardActionsForTest();
  });

  it('reads cards through the task computer, follows its change notices and asks an older host once', async () => {
    const { api, push } = stubApi();
    retainRemoteCardSession('host', 'session');
    ensureRemoteCard('host', 'session', 'call');
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledWith('host', 'session', 'call');
    expect(getGhostCardEntry('call')).toMatchObject({ status: 'ready', html: '<p>call</p>', remote: { deviceId: 'host', sessionId: 'session', revision: 'rev-call' } });

    // A click's result card and a changed card are read again; other computers' notices are ignored.
    const notice = (deviceId: string, callId: string) => push({ deviceId, channel: REMOTE_RESOURCE_CHANGED_CHANNEL,
      payload: { collectionId: 'plugin-results', resourceRefs: [{ collectionId: 'plugin-results', kind: 'card', id: JSON.stringify(['session', callId]) }] } });
    notice('host', 'call::spk1');
    notice('other', 'call');
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(2);
    expect(getGhostCardEntry('call::spk1')).toMatchObject({ status: 'ready', remote: { deviceId: 'host' } });

    // A card read before it was stored there keeps the tool row, then appears with its notice.
    api.ghosts.getRemoteCard.mockResolvedValueOnce({ card: null, failed: true } as never);
    ensureRemoteCard('host', 'session', 'late');
    await flush();
    expect(getGhostCardEntry('late')).toEqual({ status: 'missing' });
    notice('host', 'late');
    await flush();
    expect(getGhostCardEntry('late')).toMatchObject({ status: 'ready', html: '<p>late</p>' });

    api.ghosts.getRemoteCard.mockResolvedValueOnce({ card: null, unsupported: true } as never);
    ensureRemoteCard('old-host', 'session', 'a');
    await flush();
    ensureRemoteCard('old-host', 'session', 'b');
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(5);
    expect(getGhostCardEntry('a')).toEqual({ status: 'missing' });
    expect(getGhostCardEntry('b')).toEqual({ status: 'missing' });
  });

  // Regression #10734, unit: public store + actual change notification.
  // Existing coverage completed every read before a notice; minimal failing timing is a notice
  // during the first in-flight read. Leaving both task/preview views must stop shared-link IO.
  it('coalesces notices during reads and stops IO after the last view leaves', async () => {
    const { api, push } = stubApi();
    const releaseTask = retainRemoteCardSession('host', 'session');
    const releasePreview = retainRemoteCardSession('host', 'session');
    let resolve!: (value: never) => void;
    api.ghosts.getRemoteCard.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    ensureRemoteCard('host', 'session', 'call');
    const notice = (callId = 'call') => push({ deviceId: 'host', channel: REMOTE_RESOURCE_CHANGED_CHANNEL,
      payload: { collectionId: 'plugin-results', resourceRefs: [{ collectionId: 'plugin-results', kind: 'card', id: JSON.stringify(['session', callId]) }] } });
    notice();
    notice();
    resolve({ card: { ghostId: 'cindy-github', html: '<p>old</p>', height: 120, revision: 'old', externalLinks: false } } as never);
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(2);
    expect(getGhostCardEntry('call')).toMatchObject({ html: '<p>call</p>', remote: { revision: 'rev-call' } });
    releaseTask();
    notice();
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(3);
    releasePreview();
    notice();
    notice('call::sphidden');
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(3);
    retainRemoteCardSession('host', 'session');
    await flush();
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(4);
  });

  it('sends remote clicks to the task computer with its card version and translated model choices', async () => {
    const { api } = stubApi();
    ensureRemoteCard('host', 'session', 'call');
    await flush();

    // This computer's own model is "another computer" for the host, and the host's model is local there.
    expect(await dispatchGhostCardAction('call', 'pick', { modelSelection: route })).toEqual({ ok: true });
    expect(await dispatchGhostCardAction('call', 'pick', { modelSelection: { ...route, agentDeviceId: 'host' } })).toEqual({ ok: true });
    const actions = api.deviceLink.invoke.mock.calls.filter(([, channel, args]) =>
      channel === REMOTE_RESOURCE_INVOKE_CHANNEL && (args[0] as { collectionId: string }).collectionId === 'plugin-results');
    expect(actions.map(([device, , args]) => [device, (args[0] as { actionId: string; input: unknown }).input])).toEqual([
      ['host', { revision: 'rev-call', pageId: 'page-1', modelSelection: { ...route, agentDeviceId: 'controller' } }],
      ['host', { revision: 'rev-call', pageId: 'page-1', modelSelection: route }],
    ]);
    // One interaction page serves both clicks; nothing went to this computer's own plugins.
    expect(api.deviceLink.invoke.mock.calls.filter(([, , args]) => (args[0] as { actionId: string }).actionId === 'open-interaction')).toHaveLength(1);
    expect(api.ghosts.dispatchCardAction).not.toHaveBeenCalled();
    expect(routeForPicker(route, { deviceId: 'host' })).toEqual({ ...route, agentDeviceId: 'host' });
    expect(routeForPicker({ ...route, agentDeviceId: 'controller' }, { deviceId: 'host' })).toEqual(route);

    // A refused click shows the host's current card and opens a fresh page next time.
    api.deviceLink.invoke.mockRejectedValueOnce(new Error('INVALID_PARAMS'));
    expect(await dispatchGhostCardAction('call', 'merge')).toEqual({ ok: false });
    expect(api.ghosts.getRemoteCard).toHaveBeenCalledTimes(2);
    await dispatchGhostCardAction('call', 'merge');
    expect(api.deviceLink.invoke.mock.calls.filter(([, , args]) => (args[0] as { actionId: string }).actionId === 'open-interaction')).toHaveLength(2);
  });

  it('keeps local cards on this computer', async () => {
    const { api } = stubApi();
    expect(await dispatchGhostCardAction('local-call', 'merge', { prompt: 'now' })).toEqual({ ok: true });
    expect(api.ghosts.dispatchCardAction).toHaveBeenCalledWith('local-call', 'merge', 'now');
    expect(api.deviceLink.invoke).not.toHaveBeenCalled();
  });
});
