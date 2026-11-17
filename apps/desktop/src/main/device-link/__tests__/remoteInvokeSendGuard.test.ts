import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeviceLinkError, FILE_PEER_CHANNEL, parseProviderSharePeer, providerShareHostPeer, type DeviceLinkClient } from '@cindy/device-link';
import { ensureInvokeLinkReady, invokeWithClosedLinkRecovery } from '../linkRecovery';

// Run the production adapter with only its host dependencies injected, without
// importing Electron startup. The shared-client tests cover actual queue admission.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && ['remoteInvoke', 'remoteInvokeLive', 'remoteBackgroundInvoke',
    'backgroundInvokeDevice', 'backgroundInvokeDeviceLive'].includes(node.name?.text ?? ''));
const compiled = ts.transpileModule(declarations.map(node => node.getText(source).replace(/^export /, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type PeerInvoke = (peer: string, channel: string, args: unknown[]) => Promise<unknown>;

function loadAdapters(overrides: Record<string, unknown>) {
  const epochs = overrides.openLinkCloseEpochs as Map<string, number> ?? new Map<string, number>();
  const dependencies = {
    DeviceLinkError, FILE_PEER_CHANNEL, ensureInvokeLinkReady, invokeWithClosedLinkRecovery,
    parseProviderSharePeer,
    activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false,
    getRemoteLinkCloseEpoch: (id: string) => epochs.get(id) ?? 0,
    invokeProviderMetadataContinuity: (_target: string, _channel: string, _args: unknown[], read: () => unknown) => read(),
    resolveRemoteAgentTargetWhenReady: async (id: string) => id,
    assertBackgroundLinkAccepted: () => {}, snapshotSubscriptions: () => [],
    getReceivedShares: () => [], isCrossRegionProviderShareTarget: () => false,
    isProviderShareRefusal: () => false, noteProviderShareAccessFailure: vi.fn(),
    PROVIDER_SHARE_UNAVAILABLE_MESSAGE: 'unavailable',
    assertNotStandby: () => {},
    assertRemoteControlTargetEnabled: () => {},
    openLinkCloseEpochs: epochs,
    ensureOnlineForRequest: async () => {},
    isScopedPeer: () => false,
    tryPeerInvoke: async () => null,
    resolveRemoteInvokeTimeoutMs: () => undefined,
    openRemoteLink: vi.fn(),
    closeRemoteLink: vi.fn(),
    responsivenessTracker: null,
    ...overrides,
    client: { invoke: vi.fn(), isLinkReady: () => true, needsLinkRecovery: () => false, ...(overrides.client as object) },
  };
  return new Function(...Object.keys(dependencies), compiled + '; return { remoteInvoke, remoteBackgroundInvoke };')(...Object.values(dependencies));
}

const loadRemoteInvoke = (overrides: Record<string, unknown>) => loadAdapters(overrides).remoteInvoke;
const loadBackgroundInvoke = (overrides: Record<string, unknown>) => loadAdapters(overrides).remoteBackgroundInvoke;

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
      client: { needsLinkRecovery: () => false, invoke },
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
      needsLinkRecovery: () => false,
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

it.each(['ready', 'recover', 'cancel', 'close', 'disabled'])('handles relay recovery before sending new work: %s', async mode => {
  const epochs = new Map<string, number>();
  let current = true, enabled = true;
  const invoke = vi.fn(async () => ({ ok: true, result: null }));
  const reopen = vi.fn(async () => {
    if (mode === 'cancel') current = false;
    if (mode === 'close') epochs.set('host', 1);
    if (mode === 'disabled') enabled = false;
  });
  const remoteInvoke = loadRemoteInvoke({
    client: { invoke, needsLinkRecovery: () => mode !== 'ready' },
    openRemoteLink: reopen, openLinkCloseEpochs: epochs,
    assertRemoteControlTargetEnabled: () => { if (!enabled) throw new DeviceLinkError('REMOTE_DISABLED', 'disabled'); },
  });
  const pending = remoteInvoke('host', 'maker:send', [], { preSend: () => { if (!current) throw new Error('cancelled'); } });
  if (['ready', 'recover'].includes(mode)) {
    await expect(pending).resolves.toEqual({ ok: true, result: null });
    expect(invoke).toHaveBeenCalledOnce();
  } else {
    await expect(pending).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  }
  expect(reopen).toHaveBeenCalledTimes(mode === 'ready' ? 0 : 1);
});

it.each(['first-listing', 'recovery', 'unsubscribed', 'closed', 'closed and disabled'])('replays only a still-owned listing subscription: %s', async mode => {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'remoteSubscribe')!;
  const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let topics = ['sessions'];
  const epochs = new Map<string, number>();
  const invoke = vi.fn(async () => ({ ok: true, result: null }));
  const reopen = vi.fn(async () => {
    if (mode === 'unsubscribed') topics = [];
    if (mode.startsWith('closed')) epochs.set('host', 1);
  });
  // As in production: control turned off during the reopen tears the link down again and throws.
  const teardown = vi.fn();
  const deps = {
    DeviceLinkError, sharedTaskTopics: (_id: string, topics: string[]) => topics,
    assertNotStandby: () => {}, assertRemoteControlTargetEnabled: () => {},
    assertRemoteControlTargetEnabledAfterReopen: () => {
      if (mode !== 'closed and disabled') return;
      teardown();
      throw new DeviceLinkError('REMOTE_DISABLED', 'disabled');
    },
    client: { invoke, isLinkReady: () => false, needsLinkRecovery: () => mode !== 'first-listing' },
    snapshotSubscriptions: () => [{ deviceId: 'host', topics }],
    openLinkCloseEpochs: epochs, ensureOnlineForRequest: async () => {},
    requiresSessionLink: () => false, openRemoteLink: reopen,
    responsivenessTracker: null, DL_SUBSCRIBE_CHANNEL: 'device-link:subscribe',
    deviceName: () => 'test', CONTROLLER_CAPABILITIES: [],
  };
  const subscribe = new Function(...Object.keys(deps), code + '; return remoteSubscribe;')(...Object.values(deps));
  const pending = subscribe('host', ['sessions']);
  if (mode.startsWith('closed')) await expect(pending).rejects.toMatchObject({ code: 'LINK_NOT_OPEN' });
  else await expect(pending).resolves.toEqual({ ok: true, result: null });
  expect(invoke).toHaveBeenCalledTimes(['first-listing', 'recovery'].includes(mode) ? 1 : 0);
  expect(reopen).toHaveBeenCalledTimes(mode === 'first-listing' ? 0 : 1);
  // A subscription the user's close already superseded fails as closed and never tears the link down again.
  expect(teardown).not.toHaveBeenCalled();
});
