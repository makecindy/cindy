import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeviceLinkError, FILE_PEER_CHANNEL, type DeviceLinkClient } from '@cindy/device-link';
import { ensureInvokeLinkReady, invokeWithClosedLinkRecovery } from '../linkRecovery';

// Run the production adapter with only its host dependencies injected, without
// importing Electron startup. The shared-client tests cover actual queue admission.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'remoteInvoke')!;
const compiled = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type PeerInvoke = (peer: string, channel: string, args: unknown[]) => Promise<unknown>;

function loadRemoteInvoke(overrides: Record<string, unknown>) {
  const dependencies = {
    DeviceLinkError, FILE_PEER_CHANNEL, ensureInvokeLinkReady, invokeWithClosedLinkRecovery,
    assertNotStandby: () => {},
    assertRemoteControlTargetEnabled: () => {},
    openLinkCloseEpochs: new Map<string, number>(),
    ensureOnlineForRequest: async () => {},
    isScopedPeer: () => false,
    tryPeerInvoke: async () => null,
    resolveRemoteInvokeTimeoutMs: () => undefined,
    openRemoteLink: vi.fn(),
    closeRemoteLink: vi.fn(),
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
    snapshotSubscriptions: () => [],
    closeRemoteLink: vi.fn(),
    ...overrides,
  };
  return new Function(...Object.keys(dependencies), backgroundCode + '; return remoteBackgroundInvoke;')(...Object.values(dependencies));
}

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
