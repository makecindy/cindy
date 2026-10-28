import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeviceLinkError, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, FILE_PEER_CHANNEL, type DeviceLinkClient } from '@cindy/device-link';
import { ensureInvokeLinkReady, invokeWithClosedLinkRecovery } from '../linkRecovery';
import { assertBackgroundLinkAccepted, assertSubscriptionLinkAccepted, hasControlSubscription, linkOpenCapabilities } from '../backgroundLink';

// Run the production adapter with only its host dependencies injected, without
// importing Electron startup. The shared-client tests cover actual queue admission.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'remoteInvoke')!;
const compiled = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadForegroundStateReader(
  foregroundInvokesInFlight: Map<string, { epoch: number; count: number }>,
  openLinkCloseEpochs: Map<string, number>,
) {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'hasForegroundInvokeInCurrentEpoch')!;
  const code = ts.transpileModule(node.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('foregroundInvokesInFlight', 'openLinkCloseEpochs', code + '; return hasForegroundInvokeInCurrentEpoch;')(
    foregroundInvokesInFlight, openLinkCloseEpochs,
  ) as (deviceId: string) => boolean;
}

type PeerInvoke = (peer: string, channel: string, args: unknown[]) => Promise<unknown>;

function loadRemoteInvoke(overrides: Record<string, unknown>) {
  const dependencies = {
    DeviceLinkError, FILE_PEER_CHANNEL, ensureInvokeLinkReady, invokeWithClosedLinkRecovery,
    assertNotStandby: () => {},
    assertRemoteControlTargetEnabled: () => {},
    openLinkCloseEpochs: new Map<string, number>(),
    foregroundInvokesInFlight: new Map<string, { epoch: number; count: number }>(),
    ensureOnlineForRequest: async () => {},
    isScopedPeer: () => false,
    tryPeerInvoke: async () => null,
    resolveRemoteInvokeTimeoutMs: () => undefined,
    openRemoteLink: vi.fn(),
    closeRemoteLink: vi.fn(),
    closeLegacyBackgroundLinkIfIdle: () => {},
    responsivenessTracker: null,
    ...overrides,
    client: { invoke: vi.fn(), needsLinkRecovery: () => false, ...(overrides.client as object) },
  };
  return new Function(...Object.keys(dependencies), compiled + '; return remoteInvoke;')(...Object.values(dependencies));
}

function loadBackgroundInvoke(overrides: Record<string, unknown>) {
  const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && ['remoteBackgroundInvoke', 'backgroundInvokeDevice'].includes(node.name?.text ?? ''));
  const backgroundCode = ts.transpileModule(declarations.map((node) => node.getText(source).replace(/^export /, '')).join(' '), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = {
    resolveRemoteAgentTargetWhenReady: async (id: string) => id,
    client: { isLinkReady: () => true },
    remoteInvoke: loadRemoteInvoke({}),
    openRemoteLink: vi.fn(),
    assertBackgroundLinkAccepted: () => {},
    parseSharedTaskPeer: () => null,
    snapshotSubscriptions: () => [],
    foregroundInvokesInFlight: new Map<string, { epoch: number; count: number }>(),
    hasForegroundInvokeInCurrentEpoch: () => false,
    hasForegroundLinkHoldInCurrentEpoch: () => false,
    hasControlSubscription,
    closeRemoteLink: vi.fn(),
    ...overrides,
  };
  return new Function(...Object.keys(dependencies), backgroundCode + '; return remoteBackgroundInvoke;')(...Object.values(dependencies));
}

function loadRemoteSubscribe(overrides: Record<string, unknown>) {
  const node = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'remoteSubscribe')!;
  const code = ts.transpileModule(node.getText(source).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = {
    sharedTaskTopics: (_peer: string, topics: string[]) => topics,
    assertNotStandby: () => {},
    assertRemoteControlTargetEnabled: () => {},
    assertRemoteControlTargetEnabledAfterReopen: () => {},
    openLinkCloseEpochs: new Map<string, number>(),
    foregroundInvokesInFlight: new Map<string, { epoch: number; count: number }>(),
    hasForegroundInvokeInCurrentEpoch: () => false,
    hasForegroundLinkHoldInCurrentEpoch: () => false,
    ensureOnlineForRequest: async () => {},
    snapshotSubscriptions: () => [{ deviceId: 'host', topics: ['sessions'] }],
    requiresSessionLink: () => true,
    openRemoteLink: vi.fn().mockResolvedValue({ capabilities: [] }),
    assertSubscriptionLinkAccepted,
    hasControlSubscription: (topics: string[]) => topics.some((topic) => topic.startsWith('session:')),
    parseSharedTaskPeer: () => null,
    closeRemoteLink: vi.fn(),
    closeLegacyBackgroundLinkIfIdle: () => {},
    responsivenessTracker: null,
    DL_SUBSCRIBE_CHANNEL: 'device-link:subscribe',
    deviceName: () => 'Controller',
    CONTROLLER_CAPABILITIES: [],
    client: { needsLinkRecovery: () => true, isLinkReady: () => false,
      invoke: vi.fn().mockResolvedValue({ ok: true, result: null }) },
    ...overrides,
  };
  return new Function(...Object.keys(dependencies), code + '; return remoteSubscribe;')(...Object.values(dependencies));
}

function loadLegacyBackgroundOpen(overrides: Record<string, unknown> = {}) {
  const names = new Set([
    'hasForegroundInvokeInCurrentEpoch', 'hasForegroundLinkHoldInCurrentEpoch',
    'hasOutboundControlSubscription', 'closeLegacyBackgroundLinkIfIdle',
    'retainForegroundLink', 'openRemoteLink',
  ]);
  const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
  const code = ts.transpileModule(declarations.map((node) => node.getText(source).replace(/^export /, '')).join(' '), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const openLinkCloseEpochs = new Map<string, number>();
  const legacyBackgroundLinksNeedingCleanup = new Map<string, number>();
  const foregroundInvokesInFlight = new Map<string, { epoch: number; count: number }>();
  const foregroundLinkHolds = new Map<string, { epoch: number; count: number }>();
  const explicitForegroundOpens = new Map<string, number>();
  const closeRemoteLink = vi.fn((id: string) => {
    legacyBackgroundLinksNeedingCleanup.delete(id);
    openLinkCloseEpochs.set(id, (openLinkCloseEpochs.get(id) ?? 0) + 1);
  });
  const dependencies = {
    openLinkCloseEpochs, legacyBackgroundLinksNeedingCleanup, explicitForegroundOpens,
    foregroundInvokesInFlight, foregroundLinkHolds, closeRemoteLink,
    snapshotSubscriptions: () => [], hasControlSubscription, linkOpenCapabilities,
    DeviceLinkError, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
    assertNotStandby: () => {}, assertRemoteControlTargetEnabled: () => {},
    ensureOnlineForRequest: async () => {},
    openLinkInFlight: new Map(),
    client: { openLink: vi.fn().mockResolvedValue({ capabilities: [] }) },
    CONTROLLER_CAPABILITIES: [], deviceName: () => 'Controller',
    app: { getVersion: () => 'test' },
    parseSharedTaskPeer: () => null,
    responsivenessTracker: null,
    revokedByRemote: new Set(),
    ...overrides,
  };
  const run = new Function(...Object.keys(dependencies), code + '; return { openRemoteLink, retainForegroundLink, closeLegacyBackgroundLinkIfIdle };')(
    ...Object.values(dependencies),
  );
  return { ...run, closeRemoteLink, openLinkCloseEpochs, foregroundInvokesInFlight,
    legacyBackgroundLinksNeedingCleanup, explicitForegroundOpens };
}

it('preserves an explicit legacy open before its first foreground invoke', async () => {
  const link = loadLegacyBackgroundOpen();
  await expect(link.openRemoteLink('host', { explicit: true })).resolves.toEqual({ capabilities: [] });
  link.closeLegacyBackgroundLinkIfIdle('host');
  expect(link.closeRemoteLink).not.toHaveBeenCalled();
  expect(link.explicitForegroundOpens.get('host')).toBe(0);
});

it('clears obsolete legacy cleanup when a capable peer reopens', async () => {
  const openLink = vi.fn()
    .mockResolvedValueOnce({ capabilities: [] })
    .mockResolvedValueOnce({ capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] });
  const link = loadLegacyBackgroundOpen({ client: { openLink } });
  const releaseViewer = link.retainForegroundLink('host');
  await link.openRemoteLink('host');
  expect(link.legacyBackgroundLinksNeedingCleanup.get('host')).toBe(0);
  await link.openRemoteLink('host');
  expect(link.legacyBackgroundLinksNeedingCleanup.has('host')).toBe(false);
  releaseViewer();
  expect(link.closeRemoteLink).not.toHaveBeenCalled();
});

it('cleans up an old peer background open after the foreground viewer releases its link', async () => {
  const { openRemoteLink, retainForegroundLink, closeRemoteLink } = loadLegacyBackgroundOpen();
  const releaseViewer = retainForegroundLink('host');
  await expect(openRemoteLink('host', { observed: false })).resolves.toEqual({ capabilities: [] });
  expect(closeRemoteLink).not.toHaveBeenCalled();
  releaseViewer();
  expect(closeRemoteLink).toHaveBeenCalledOnce();
  releaseViewer();
  expect(closeRemoteLink).toHaveBeenCalledOnce();
});

it('cleans up an old peer background open after the last foreground session leaves', async () => {
  let topics = ['sessions'];
  const { openRemoteLink, closeLegacyBackgroundLinkIfIdle, closeRemoteLink } = loadLegacyBackgroundOpen({
    snapshotSubscriptions: () => [{ deviceId: 'host', topics }],
    client: { openLink: vi.fn().mockImplementation(async () => {
      topics = ['sessions', 'session:active'];
      return { capabilities: [] };
    }) },
  });
  await expect(openRemoteLink('host', { observed: false })).resolves.toEqual({ capabilities: [] });
  expect(closeRemoteLink).not.toHaveBeenCalled();
  topics = ['sessions'];
  closeLegacyBackgroundLinkIfIdle('host');
  expect(closeRemoteLink).toHaveBeenCalledOnce();
});

it('cleans up an old peer background open when its only foreground invoke completes', async () => {
  const link = loadLegacyBackgroundOpen();
  const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
  const remoteInvoke = loadRemoteInvoke({
    openRemoteLink: link.openRemoteLink,
    openLinkCloseEpochs: link.openLinkCloseEpochs,
    foregroundInvokesInFlight: link.foregroundInvokesInFlight,
    closeLegacyBackgroundLinkIfIdle: link.closeLegacyBackgroundLinkIfIdle,
    client: { needsLinkRecovery: () => true, invoke },
  });
  await expect(remoteInvoke('host', 'file-browser:read', [])).resolves.toEqual({ ok: true, result: null });
  expect(invoke).toHaveBeenCalledOnce();
  expect(link.closeRemoteLink).toHaveBeenCalledOnce();
});

it('subscribes to a shared task even though its scoped accept omits background-link-v1', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
  const closeRemoteLink = vi.fn();
  const peer = 'shared-task-peer';
  const remoteSubscribe = loadRemoteSubscribe({
    parseSharedTaskPeer: (id: string) => id === peer ? { role: 'host' } : null,
    snapshotSubscriptions: () => [{ deviceId: peer, topics: ['session:shared'] }],
    closeRemoteLink,
    client: { needsLinkRecovery: () => true, isLinkReady: () => false, invoke },
  });
  await expect(remoteSubscribe(peer, ['session:shared'])).resolves.toEqual({ ok: true, result: null });
  expect(invoke).toHaveBeenCalledOnce();
  expect(closeRemoteLink).not.toHaveBeenCalled();
});

it('reads a shared task through its scoped link without requiring background-link-v1', async () => {
  const remoteInvoke = vi.fn().mockResolvedValue({ ok: true, result: null });
  const assertBackgroundLinkAccepted = vi.fn();
  const remoteBackgroundInvoke = loadBackgroundInvoke({
    client: { isLinkReady: () => false },
    parseSharedTaskPeer: () => ({ role: 'host' }),
    openRemoteLink: vi.fn().mockResolvedValue({ capabilities: ['shared-task-v2'] }),
    assertBackgroundLinkAccepted,
    remoteInvoke,
  });
  await expect(remoteBackgroundInvoke('shared-task-peer', 'task:read', [])).resolves.toEqual({ ok: true, result: null });
  expect(assertBackgroundLinkAccepted).not.toHaveBeenCalled();
  expect(remoteInvoke).toHaveBeenCalledOnce();
});

it('allows a foreground subscription to join an in-flight legacy background open', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, result: null });
  const closeRemoteLink = vi.fn();
  let topics = ['sessions'];
  const remoteSubscribe = loadRemoteSubscribe({
    snapshotSubscriptions: () => [{ deviceId: 'host', topics }],
    openRemoteLink: vi.fn().mockImplementation(async () => {
      topics = ['sessions', 'session:active'];
      return { capabilities: [] };
    }),
    closeRemoteLink,
    client: { needsLinkRecovery: () => true, isLinkReady: () => false, invoke },
  });
  await expect(remoteSubscribe('host', ['sessions', 'session:active'])).resolves.toEqual({ ok: true, result: null });
  expect(invoke).toHaveBeenCalledOnce();
  expect(closeRemoteLink).not.toHaveBeenCalled();
});

it('tracks a foreground invoke while it is pending without treating background reads as foreground', async () => {
  const foregroundInvokesInFlight = new Map<string, { epoch: number; count: number }>();
  let release!: () => void;
  const pendingReply = new Promise<{ ok: true; result: null }>((resolve) => {
    release = () => resolve({ ok: true, result: null });
  });
  const remoteInvoke = loadRemoteInvoke({
    foregroundInvokesInFlight,
    client: { invoke: vi.fn().mockReturnValueOnce(pendingReply).mockResolvedValue({ ok: true, result: null }) },
  });
  const foreground = remoteInvoke('host', 'remote-desktop', []);
  expect(foregroundInvokesInFlight.get('host')).toEqual({ epoch: 0, count: 1 });
  release();
  await foreground;
  expect(foregroundInvokesInFlight.has('host')).toBe(false);
  await remoteInvoke('host', 'provider-group:remote', [], { passiveLink: true });
  expect(foregroundInvokesInFlight.has('host')).toBe(false);
});

it('does not confuse queue priority with foreground link intent', async () => {
  const foregroundInvokesInFlight = new Map<string, { epoch: number; count: number }>();
  let finish!: () => void;
  const pending = new Promise<{ ok: true; result: null }>((resolve) => {
    finish = () => resolve({ ok: true, result: null });
  });
  const remoteInvoke = loadRemoteInvoke({
    foregroundInvokesInFlight,
    client: { invoke: vi.fn().mockReturnValue(pending) },
  });
  const request = remoteInvoke('host', 'maker:send', [], { background: true });
  expect(foregroundInvokesInFlight.get('host')).toEqual({ epoch: 0, count: 1 });
  finish();
  await request;
  expect(foregroundInvokesInFlight.has('host')).toBe(false);
});

it('closes a new unsupported background link despite an old-epoch foreground reply still pending', async () => {
  const foregroundInvokesInFlight = new Map<string, { epoch: number; count: number }>();
  const openLinkCloseEpochs = new Map<string, number>();
  const hasForegroundInvokeInCurrentEpoch = loadForegroundStateReader(foregroundInvokesInFlight, openLinkCloseEpochs);
  let finishOld!: () => void;
  let finishNew!: () => void;
  const oldReply = new Promise<{ ok: true; result: null }>((resolve) => {
    finishOld = () => resolve({ ok: true, result: null });
  });
  const newReply = new Promise<{ ok: true; result: null }>((resolve) => {
    finishNew = () => resolve({ ok: true, result: null });
  });
  const invoke = vi.fn().mockReturnValueOnce(oldReply).mockReturnValueOnce(newReply);
  const remoteInvoke = loadRemoteInvoke({
    foregroundInvokesInFlight, openLinkCloseEpochs, client: { invoke },
  });
  const oldForeground = remoteInvoke('host', 'remote-desktop', []);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(hasForegroundInvokeInCurrentEpoch('host')).toBe(true);

  // Explicit link close moves to a new epoch while the old invoke awaits its reply.
  openLinkCloseEpochs.set('host', 1);
  expect(hasForegroundInvokeInCurrentEpoch('host')).toBe(false);
  const closeRemoteLink = vi.fn(() => openLinkCloseEpochs.set('host', 2));
  const backgroundInvoke = loadBackgroundInvoke({
    client: { isLinkReady: () => false },
    foregroundInvokesInFlight, openLinkCloseEpochs, hasForegroundInvokeInCurrentEpoch,
    openRemoteLink: vi.fn().mockResolvedValue({ capabilities: [] }),
    assertBackgroundLinkAccepted, closeRemoteLink,
  });
  await expect(backgroundInvoke('host', 'usage:read', [])).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
  expect(closeRemoteLink).toHaveBeenCalledOnce();

  const newForeground = remoteInvoke('host', 'remote-desktop', []);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  finishOld();
  await oldForeground;
  expect(hasForegroundInvokeInCurrentEpoch('host')).toBe(true);
  finishNew();
  await newForeground;
  expect(hasForegroundInvokeInCurrentEpoch('host')).toBe(false);
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
    const remoteInvoke = loadRemoteInvoke({
      client: { invoke, needsLinkRecovery: () => stage === 'reliable link recovery' },
      openRemoteLink: pause,
      ensureOnlineForRequest: stage === 'online wait' ? pause : async () => {},
    });
    const remoteBackgroundInvoke = loadBackgroundInvoke({
      remoteInvoke,
      client: { isLinkReady: () => stage !== 'link opening' },
      openRemoteLink: pause,
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
