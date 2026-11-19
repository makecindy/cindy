import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeviceLinkError, FILE_PEER_CHANNEL, ProviderShareScopeChangedError, parseProviderSharePeer, providerShareHostPeer, type DeviceLinkClient } from '@cindy/device-link';
import { ServerApiError } from '../../serverApiClient';
import { ensureInvokeLinkReady, invokeWithClosedLinkRecovery } from '../linkRecovery';
import { RemoteAgentRunClient, remoteAgentInvoker } from '../../remote-agent/controller/runClient';
import type { RemoteAgentPoller } from '../../remote-agent/controller/poller';
import { isTemporaryProviderMetadataFailure } from '../providerMetadataContinuity';
import { isShareAvailabilityRead, projectShareAvailabilityRead } from '../providerShareAvailabilityModels';

vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://example.invalid' }));

// Run the production adapter with only its host dependencies injected, without
// importing Electron startup. The shared-client tests cover actual queue admission.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && ['remoteInvoke', 'remoteInvokeLive', 'remoteBackgroundInvoke',
    'backgroundInvokeDevice', 'backgroundInvokeDeviceLive', 'closeRemoteLink', 'onRemoteLinkClosed'].includes(node.name?.text ?? ''));
const compiled = ts.transpileModule(declarations.map(node => node.getText(source).replace(/^export /, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type PeerInvoke = (peer: string, channel: string, args: unknown[]) => Promise<unknown>;

function loadAdapters(overrides: Record<string, unknown>) {
  const epochs = overrides.openLinkCloseEpochs as Map<string, number> ?? new Map<string, number>();
  const dependencies = {
    DeviceLinkError, ServerApiError, FILE_PEER_CHANNEL, ensureInvokeLinkReady, invokeWithClosedLinkRecovery,
    parseProviderSharePeer, providerShareHostPeer,
    parseProviderShareAgentDeviceId: (id: string) => id.startsWith('share:') ? id.slice(6) : null,
    findReceivedShareForExecution: () => null,
    activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false,
    getRemoteLinkCloseEpoch: (id: string) => epochs.get(id) ?? 0,
    invokeProviderMetadataContinuity: (_target: string, _channel: string, _args: unknown[], read: () => unknown) => read(),
    resolveRemoteAgentTargetWhenReady: async (id: string) => id,
    assertBackgroundLinkAccepted: () => {}, snapshotSubscriptions: () => [],
    getReceivedShares: () => [], isCrossRegionProviderShareTarget: () => false,
    providerShareAccessEpoch: () => 0, isTemporaryProviderMetadataFailure, isShareAvailabilityRead, projectShareAvailabilityRead,
    isProviderShareRefusal: () => false, noteProviderShareAccessFailure: vi.fn(),
    PROVIDER_SHARE_UNAVAILABLE_MESSAGE: 'unavailable',
    assertNotStandby: () => {},
    assertRemoteControlTargetEnabled: () => {},
    openLinkCloseEpochs: epochs,
    remoteLinkCloseListeners: new Map<string, Set<() => void>>(),
    openLinkInFlight: new Map(),
    invalidateProviderMetadataContinuity: () => {}, stopFilePeers: () => {}, invalidatePluginOauth: () => {},
    transportTimeoutReopen: { cancel() {} }, cancelSubscriptionReplay: () => {},
    ensureOnlineForRequest: async () => {},
    isScopedPeer: () => false,
    tryPeerInvoke: async () => null,
    resolveRemoteInvokeTimeoutMs: () => undefined,
    openRemoteLink: vi.fn(),
    responsivenessTracker: null,
    ...overrides,
    client: { invoke: vi.fn(), closeLink: vi.fn(), isLinkReady: () => true, needsLinkRecovery: () => false, ...(overrides.client as object) },
  };
  return new Function(...Object.keys(dependencies), compiled + '; return { remoteInvoke, remoteBackgroundInvoke, closeRemoteLink, onRemoteLinkClosed };')(...Object.values(dependencies));
}

const loadRemoteInvoke = (overrides: Record<string, unknown>) => loadAdapters(overrides).remoteInvoke;
const loadBackgroundInvoke = (overrides: Record<string, unknown>) => loadAdapters(overrides).remoteBackgroundInvoke;

// Unit regression #11345: a shared target rechecks ownership after its RPC result.
// The real RunClient + background adapter must cancel an unsent input, but retain
// an accepted result after Stop/signal. Earlier queue tests missed this post-RPC
// adapter boundary. Only client admission and its acknowledgement are deferred.
it.each(['signal', 'stop'] as const)('preserves shared input delivery across %s at the dispatch boundary', async cancel => {
  for (const phase of ['queued', 'sent'] as const) {
    const callId = randomUUID();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const delivered: string[] = [];
    const remoteBackgroundInvoke = loadBackgroundInvoke({ client: {
      invoke: vi.fn<DeviceLinkClient['invoke']>(async (_peer, payload, _timeout, options) => {
        const request = payload.args![0] as { callId: string };
        if (request.callId === callId && phase === 'queued') { reached(); await held; }
        options?.preSend?.();
        options?.beforeDispatch?.();
        delivered.push(request.callId);
        if (request.callId === callId && phase === 'sent') { reached(); await held; }
        client.onData(Buffer.from(JSON.stringify({ t: 'result', callId: request.callId, ok: true, value: 'accepted' }) + '\n'), false);
        return { ok: true, result: {} };
      }),
    } });
    const invoke = remoteAgentInvoker(providerShareHostPeer('share', 'host'), remoteBackgroundInvoke);
    const client = new RemoteAgentRunClient(randomUUID(), { invoke, unregister() {} } as unknown as RemoteAgentPoller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {}, onRequest: async () => ({ type: 'callback', value: null }),
    }, randomUUID);
    const abort = new AbortController();
    const result = client.callWithId(callId, 'send', ['hello'], abort.signal);
    const observed = result.then(value => ({ value }), error => ({ error }));
    await waiting;
    if (cancel === 'signal') abort.abort();
    else await client.callWithId(randomUUID(), 'abort', []);
    release();
    if (phase === 'queued') expect(await observed).toMatchObject({ error: { name: 'AbortError' } });
    else expect(await observed).toEqual({ value: 'accepted' });
    expect(delivered.filter(id => id === callId)).toHaveLength(phase === 'sent' ? 1 : 0);
    client.abandon('fixture-complete');
  }
});

// PR #10895 / unit: real closeRemoteLink must wake a hung startup after changing
// its epoch, without notifying other peers or retaining disposed subscriptions.
it('notifies only the explicitly closed peer after invalidating pending startup', () => {
  const epochs = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const closeLink = vi.fn();
  const { closeRemoteLink, onRemoteLinkClosed } = loadAdapters({ openLinkCloseEpochs: epochs,
    remoteLinkCloseListeners: listeners, client: { closeLink } });
  const observedEpochs: Array<number | undefined> = [];
  const cancel = vi.fn(() => { observedEpochs.push(epochs.get('owner')); });
  const off = onRemoteLinkClosed('owner', cancel);
  closeRemoteLink('unrelated');
  expect(cancel).not.toHaveBeenCalled();
  closeRemoteLink('owner');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(observedEpochs).toEqual([1]);
  expect(closeLink).toHaveBeenLastCalledWith('owner', 'user');
  off();
  expect(listeners.size).toBe(0);
  closeRemoteLink('owner');
  expect(cancel).toHaveBeenCalledTimes(1);
});

// #10826, unit: the production background adapter must recover the model directory
// when presence says online but the owner's data link fails. The availability tests
// cover projection only and mock this adapter; they cannot catch this routing gap.
const sharePeer = providerShareHostPeer('share', 'host');
const receivedShare = { shareId: 'share', hostDeviceId: 'host', status: 'active', hostOnline: true, standbyOnline: true };
const standbyCatalog = { providers: [{ id: 'shared', agents: ['codex'], routing: {}, source: 'user',
  models: { codex: [{ id: 'model', name: 'Model', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high', supportsFastMode: true }] } }] };
it.each(['result', 'throw', 'cross-region'])(
  'reads the authorized standby catalog after an online owner transport failure (%s)', async mode => {
    const failure = new DeviceLinkError('DEVICE_OFFLINE', 'unreachable');
    const invoke = vi.fn(async () => {
      if (mode !== 'result') throw failure;
      return { ok: false, error: { code: failure.code, message: failure.message } };
    });
    const read = vi.fn(async () => standbyCatalog);
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      getReceivedShares: () => [receivedShare], readShareAvailabilityCatalog: read,
      client: { invoke }, crossRegionInvoke: invoke, isCrossRegionProviderShareTarget: () => mode === 'cross-region',
    });
    await expect(remoteBackgroundInvoke(sharePeer, 'maker:provider:list', [])).resolves.toEqual({ ok: true, result: standbyCatalog });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledExactlyOnceWith('share');
  },
);

it.each(['maker:get-capabilities', 'maker:list-available-agents'])(
  'keeps the picker usable after its companion read fails (%s)', async channel => {
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      getReceivedShares: () => [receivedShare], readShareAvailabilityCatalog: async () => standbyCatalog,
      client: { invoke: vi.fn(async () => { throw new DeviceLinkError('DEVICE_OFFLINE', 'unreachable'); }) },
    });
    const result = await remoteBackgroundInvoke(sharePeer, channel, channel === 'maker:get-capabilities' ? ['codex'] : []);
    if (channel === 'maker:list-available-agents') expect(result).toEqual({ ok: true, result: ['codex'] });
    else {
      expect(result).toMatchObject({ ok: true, result: {
        availableModels: [{ id: 'model', displayName: 'Model', efforts: ['high'], defaultEffort: 'high' }],
        permissionModes: [], hasFastMode: false,
      } });
      expect(result.result).not.toHaveProperty('supportsSessionAgentSwitch');
      expect(result.result).not.toHaveProperty('binaryReady');
      expect(result.result.availableModels[0].supportsFastMode).toBe(false);
    }
  },
);

it.each(['direct success', 'denied', 'unsupported standby', 'other channel', 'live probe', 'invalid agent', 'both fail'])(
  'preserves the direct outcome without manufacturing a catalog (%s)', async mode => {
    const result = mode === 'direct success' ? { ok: true, result: { providers: [] } }
      : { ok: false, error: { code: mode === 'denied' ? 'FORBIDDEN' : 'DEVICE_OFFLINE', message: 'unavailable' } };
    const read = vi.fn(async () => { throw new ServerApiError('NETWORK_ERROR', 0, 'standby unavailable'); });
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      getReceivedShares: () => [{ ...receivedShare, standbyOnline: mode === 'unsupported standby' ? undefined : true }],
      readShareAvailabilityCatalog: read, client: { invoke: vi.fn(async () => result) },
    });
    await expect(remoteBackgroundInvoke(sharePeer,
      mode === 'other channel' ? 'maker:agent:status' : mode === 'invalid agent' ? 'maker:get-capabilities' : 'maker:provider:list',
      mode === 'invalid agent' ? ['unknown'] : [], mode === 'live probe' ? { liveProviderMetadata: true } : undefined))
      .resolves.toEqual(result);
    expect(read).toHaveBeenCalledTimes(mode === 'both fail' ? 1 : 0);
  },
);

// PR #10895 review: unlike the existing transport-failure case, a terminal HTTPS
// catalog failure must reach the caller and only a real denial retires the share.
// Unit, production remoteBackgroundInvoke: minimal input is an unreachable owner
// followed by a rejected catalog, including the offline-owner shortcut.
it.each(['result', 'throw', 'offline'])(
  'preserves terminal standby errors and retires only denied access (%s)', async mode => {
    for (const [failure, denied] of [
      [new ServerApiError('UNAUTHORIZED', 401, 'unauthorized'), true],
      [new ServerApiError('HTTP_403', 403, 'forbidden'), true],
      [Object.assign(new Error('[PERMISSION_DENIED] Provider share request rejected'), { code: 'PERMISSION_DENIED' }), true],
      [new ServerApiError('NOT_FOUND', 404, 'no standby policy'), false],
      [new ProviderShareScopeChangedError(), false],
      [new Error('Invalid shared catalog'), false],
    ] as const) {
      const note = vi.fn();
      const read = vi.fn(async () => { throw failure; });
      const invoke = vi.fn(async () => {
        if (mode === 'throw') throw new DeviceLinkError('DEVICE_OFFLINE', 'unreachable');
        return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'unreachable' } };
      });
      const remoteBackgroundInvoke = loadBackgroundInvoke({
        getReceivedShares: () => [{ ...receivedShare, hostOnline: mode !== 'offline' }],
        readShareAvailabilityCatalog: read, noteProviderShareAccessFailure: note, client: { invoke },
      });
      await expect(remoteBackgroundInvoke(sharePeer, 'maker:provider:list', [])).rejects.toBe(failure);
      expect(read).toHaveBeenCalledExactlyOnceWith('share');
      expect(note.mock.calls).toEqual(denied ? [['share']] : []);
      expect(invoke).toHaveBeenCalledTimes(mode === 'offline' ? 0 : 1);
    }
  },
);

it.each(['account', 'late denial', 'permission', 'closed', 'cancelled', 'disabled'])(
  'rejects a late standby catalog after %s changes', async change => {
    let changed = false;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn(async () => {
      await waiting;
      if (change === 'late denial') throw new ServerApiError('HTTP_403', 403, 'forbidden');
      return standbyCatalog;
    });
    const note = vi.fn();
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      getReceivedShares: () => [receivedShare], readShareAvailabilityCatalog: read,
      client: { invoke: vi.fn(async () => { throw new DeviceLinkError('DEVICE_OFFLINE', 'unreachable'); }) },
      activeOwnerScopeKey: () => changed && (change === 'account' || change === 'late denial') ? 'other' : 'owner',
      noteProviderShareAccessFailure: note,
      providerShareAccessEpoch: () => Number(changed && change === 'permission'),
      getRemoteLinkCloseEpoch: () => Number(changed && change === 'closed'),
      assertRemoteControlTargetEnabled: () => { if (changed && change === 'disabled') throw new Error('disabled'); },
    });
    const pending = remoteBackgroundInvoke(sharePeer, 'maker:provider:list', [], {
      preSend: () => { if (changed && change === 'cancelled') throw new Error('cancelled'); },
    }).then((result: unknown) => result, (error: unknown) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    changed = true;
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(note).not.toHaveBeenCalled();
  },
);

// Unit: compile all production adapters together, not just the former public body.
// Minimal regression: a live recovery probe must reach RPC exactly once and bypass metadata snapshots.
it.each(['host', providerShareHostPeer('share', 'host')])('sends a live recovery probe to %s without recursion or cached metadata', async target => {
  const invoke = vi.fn(async () => ({ ok: true, result: { providers: [] } }));
  const metadata = vi.fn(() => { throw new Error('live probe used metadata snapshot'); });
  const { remoteBackgroundInvoke } = loadAdapters({ client: { invoke }, invokeProviderMetadataContinuity: metadata });
  await expect(remoteBackgroundInvoke(target, 'maker:provider:list', [], { liveProviderMetadata: true }))
    .resolves.toMatchObject({ ok: true, result: { providers: [] } });
  expect(invoke).toHaveBeenCalledTimes(1); expect(metadata).not.toHaveBeenCalled();
});

it.each(['target resolution', 'link opening', 'online wait', 'reliable link recovery'])(
  'does not send an old account’s background request after account changes during %s', async (stage) => {
    let current = true;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reached = vi.fn();
    const pause = async () => { reached(); await waiting; };
    const invoke = vi.fn<DeviceLinkClient['invoke']>(async (_peer, _payload, _timeout, options) => {
      options?.preSend?.();
      return { ok: true, result: null };
    });
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      client: { invoke, isLinkReady: () => stage !== 'link opening', needsLinkRecovery: () => stage === 'reliable link recovery' },
      openRemoteLink: pause,
      ensureOnlineForRequest: stage === 'online wait' ? pause : async () => {},
      resolveRemoteAgentTargetWhenReady: async (id: string) => {
        if (stage === 'target resolution') await pause();
        return id;
      },
    });
    const changed = new Error('account changed');
    const pending = remoteBackgroundInvoke('host', 'provider-group:remote', [{ action: 'usage-part' }], {
      preSend: () => { if (!current) throw changed; },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(reached).toHaveBeenCalledTimes(1));
    current = false;
    release();
    expect(await pending).toBe(changed);
    expect(invoke).not.toHaveBeenCalled();
  },
);

it.each(['caller cancelled', 'target disabled', 'link closed', 'still valid'])(
  'revalidates %s after the client queue and never reopens an explicitly closed link', async (change) => {
    let enabled = true;
    let current = true;
    const epochs = new Map<string, number>();
    const send = vi.fn();
    const reopen = vi.fn();
    let dispatch!: () => void;
    const invoke = vi.fn<DeviceLinkClient['invoke']>((_peer, _payload, _timeout, options) => new Promise((resolve, reject) => {
      dispatch = () => {
        try { options?.preSend?.(); send(); resolve({ ok: true, result: null }); }
        catch (error) { reject(error); }
      };
    }));
    const remoteInvoke = loadRemoteInvoke({
      assertRemoteControlTargetEnabled: () => { if (!enabled) throw new DeviceLinkError('REMOTE_DISABLED', 'disabled'); },
      openLinkCloseEpochs: epochs,
      client: { invoke },
      openRemoteLink: reopen,
    });
    const cancelled = new Error('caller cancelled');
    const pending = remoteInvoke('host', 'maker:send', [], {
      preSend: () => { if (!current) throw cancelled; },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    if (change === 'caller cancelled') current = false;
    if (change === 'target disabled') enabled = false;
    if (change === 'link closed') epochs.set('host', 1);
    dispatch();
    const result = await pending;
    if (change === 'caller cancelled') expect(result).toBe(cancelled);
    if (change === 'target disabled') expect(result).toMatchObject({ code: 'REMOTE_DISABLED' });
    if (change === 'link closed') expect(result).toMatchObject({ code: 'LINK_NOT_OPEN' });
    if (change === 'still valid') expect(result).toEqual({ ok: true, result: null });
    expect(send).toHaveBeenCalledTimes(change === 'still valid' ? 1 : 0);
    expect(reopen).not.toHaveBeenCalled();
  },
);

it.each([false, true])('never reopens a link for late file cleanup (ready=%s)', async (ready) => {
  const online = vi.fn();
  const reopen = vi.fn();
  const invoke = vi.fn().mockRejectedValue(new DeviceLinkError('LINK_NOT_OPEN', 'closed'));
  const remoteInvoke = loadRemoteInvoke({
    ensureOnlineForRequest: online,
    client: { isLinkReady: () => ready, invoke },
    openRemoteLink: reopen,
  });
  await expect(remoteInvoke('host', FILE_PEER_CHANNEL, [{ action: 'close', connection: 'old' }]))
    .rejects.toMatchObject({ code: 'LINK_NOT_OPEN' });
  expect(invoke).toHaveBeenCalledTimes(ready ? 1 : 0);
  expect(online).not.toHaveBeenCalled();
  expect(reopen).not.toHaveBeenCalled();
});

// The direct connection keeps this invoke and calls it later from timers (idle close),
// where `void invoke(...).catch(() => {})` only absorbs rejections. A synchronous throw
// there escaped as an uncaughtException and shut the app down.
it('rejects instead of throwing when a stored direct-connection invoke outlives its caller', async () => {
  let current = true;
  let stored!: PeerInvoke;
  const remoteInvoke = loadRemoteInvoke({
    client: {
      invoke: vi.fn<DeviceLinkClient['invoke']>(async (_peer, _payload, _timeout, options) => {
        options?.preSend?.();
        return { ok: true, result: null };
      }),
    },
    tryPeerInvoke: async (_device: string, _channel: string, _args: unknown[], invoke: PeerInvoke) => {
      stored = invoke;
      return null;
    },
  });
  const stopped = new Error('DESKTOP_STOPPED');
  await remoteInvoke('host', 'remote-desktop', [], {
    preSend: () => { if (!current) throw stopped; },
  });
  current = false;
  let closing: Promise<unknown> | undefined;
  expect(() => { closing = stored('host', 'file-peer', [{ action: 'close' }]); }).not.toThrow();
  await expect(closing).rejects.toBe(stopped);
});
