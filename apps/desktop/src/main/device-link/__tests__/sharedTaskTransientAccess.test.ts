import { sharedTaskGuestPeer } from '@cindy/device-link';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_OAUTH_CHANNEL, PROTOCOL_VERSION, SHARED_TASK_CAPABILITY, type SharedTaskDetail } from '@cindy/device-link';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/cindy-test/app', getPath: () => '/tmp/cindy-test', getVersion: () => 'test' },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => ({ remoteControlEnabled: true, revokedControllers: [] }),
}));

import { __testing, runInvoke, wireInboundDispatch } from '../dispatch';
import { __testing as registry } from '../invoke-registry';
import { SharedTaskHost } from '../sharedTaskHost';
import { setSharedTaskDispatchHost } from '../sharedTaskDispatch';
import type { SharedTaskJournalEntry } from '../../localDb/sharedTasks';
import * as pluginOauthRuntime from '../../plugin-oauth/runtime';
import * as mediaFetch from '../mediaFetch';
import * as sessions from '../../localDb/ipc/sessions';

const peer = sharedTaskGuestPeer('sharedTask', 'member', 'phone');
const read = { channel: 'local-db:messages:list', args: ['task'] };
const subscribe = { channel: 'device-link:subscribe', args: [{ topics: ['session:task'] }] };
let detail: SharedTaskDetail;
let host: SharedTaskHost;
const api = { create: vi.fn(), list: vi.fn(), get: vi.fn(), invite: vi.fn(), join: vi.fn(), remove: vi.fn(), leave: vi.fn(), close: vi.fn() };

function client() {
  return {
    getStatus: vi.fn(() => 'online'), getConnectionEpoch: vi.fn(() => 1), getPeerLinkGeneration: vi.fn(() => 1),
    getReliableSendQueueDepth: vi.fn(() => 0), canSendPush: vi.fn(() => true), sendPush: vi.fn(),
    sendInvokeResult: vi.fn(), sendLinkAccept: vi.fn(), closeLink: vi.fn(), onFrame: vi.fn(),
  };
}

beforeEach(async () => {
  __testing.reset();
  registry.reset();
  for (const fn of Object.values(api)) fn.mockReset();
  detail = {
    sharedTaskId: 'sharedTask', sessionId: 'task', ownerAccountId: 'owner', hostDeviceId: 'desktop',
    revision: 1, status: 'active', title: 'Task',
    guests: [{ memberId: 'member', accountId: 'guest', deviceIds: ['phone'], version: 1 }], memberLabels: [],
  };
  api.get.mockImplementation(async () => structuredClone(detail));
  let entry: SharedTaskJournalEntry | undefined;
  host = new SharedTaskHost({
    api, ownerAccountId: 'owner', hostDeviceId: 'desktop', isCurrent: () => true,
    readSession: async (id) => ({ id, title: 'Task', status: 'active' }), revoke: vi.fn(), changed: vi.fn(),
    journal: {
      latest: async () => entry ? [entry] : [],
      recordAuthority: async (snapshot) => {
        entry = { sharedTaskId: 'sharedTask', sessionId: 'task', terminal: snapshot.status === 'closed', snapshot };
        return true;
      },
      close: async () => { entry = { sharedTaskId: 'sharedTask', sessionId: 'task', terminal: true, snapshot: null }; },
    },
  });
  setSharedTaskDispatchHost(host);
  await host.refresh('sharedTask');
});
afterEach(() => {
  __testing.reset(); registry.reset(); setSharedTaskDispatchHost(null);
});

describe('shared task temporary authority fences preserve membership', () => {
  it('routes guest text previews through task authorization and fences revoked reads', async () => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'shared-text-')));
    const file = path.join(dir, 'report.md');
    const localReader = vi.fn(() => ({ success: true, data: 'unscoped' }));
    registry.register('text-file:read-preview', localReader);
    const snapshot = vi.spyOn(sessions, 'getSessionFsSnapshot').mockResolvedValue({
      workingDir: dir, remoteHostId: null, permissionMode: 'default', planModeEnabled: false,
    });
    const resolve = vi.spyOn(mediaFetch, 'resolveAuthorizedMedia').mockResolvedValue({ absPath: file, mimeType: undefined, uploadExtHint: undefined, maxBytes: null });
    const request = { channel: 'text-file:read-preview', args: [{ filePath: file }] };
    try {
      await writeFile(file, '# 历史附件');
      await expect(runInvoke(peer, request)).resolves.toMatchObject({ ok: true, result: { success: true, data: '# 历史附件' } });
      expect(snapshot).toHaveBeenCalledWith('task');
      expect(resolve).toHaveBeenCalledWith({ url: expect.stringContaining('xdt-file:') }, 10 * 1024 * 1024);
      expect(localReader).not.toHaveBeenCalled();
      await writeFile(file, '\u0000'.repeat(400_000));
      await expect(runInvoke(peer, request)).resolves.toMatchObject({ ok: true, result: { success: false, reason: 'oversize', limitMb: 10 } });
      resolve.mockRejectedValueOnce(Object.assign(new Error('too large'), { code: 'OVERSIZE', size: 11 * 1024 * 1024 }));
      await expect(runInvoke(peer, request)).resolves.toMatchObject({ ok: true, result: { success: false, reason: 'oversize', size: 11 * 1024 * 1024, limitMb: 10 } });
      resolve.mockRejectedValueOnce(new Error('[PERMISSION_DENIED] Outside shared task'));
      await expect(runInvoke(peer, request)).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('PERMISSION_DENIED') } });
      resolve.mockImplementationOnce(async () => {
        detail = { ...detail, revision: 2, guests: [] };
        await host.refresh('sharedTask');
        return { absPath: file, mimeType: undefined, uploadExtHint: undefined, maxBytes: null };
      });
      await expect(runInvoke(peer, request)).resolves.toMatchObject({ ok: false, error: { code: 'ACCESS_REVOKED' } });
      expect(localReader).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore(); snapshot.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps plugin authorization owner-only without blocking guest task history', async () => {
    const request = { op: 'hello' };
    const reply = { accepted: true };
    const authorize = vi.spyOn(pluginOauthRuntime, 'requestPluginOauth').mockResolvedValue(reply);
    try {
      expect(host.capturePeer(peer)?.isCurrent()).toBe(true);
      for (const args of [[request], ['task', request]]) {
        await expect(runInvoke(peer, { channel: PLUGIN_OAUTH_CHANNEL, args })).resolves.toMatchObject({
          ok: false, error: { code: 'IPC_ERROR', message: expect.stringContaining('PERMISSION_DENIED') },
        });
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(host.peerStatus(peer)).toBe('available');
      registry.register(read.channel, () => []);
      await expect(runInvoke(peer, read)).resolves.toEqual({ ok: true, result: [] });
      await expect(runInvoke('owner-phone', { channel: PLUGIN_OAUTH_CHANNEL, args: [request] }))
        .resolves.toEqual({ ok: true, result: reply });
      expect(authorize).toHaveBeenCalledExactlyOnceWith('owner-phone', request);
    } finally {
      authorize.mockRestore();
    }
  });

  it.each(['suspended', 'revoked'] as const)('gates admission, subscription, link-open and final send while %s', async (state) => {
    let rejectRemove!: (error: Error) => void;
    let removal: Promise<void> | undefined;
    if (state === 'suspended') {
      api.remove.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectRemove = reject; }));
      removal = host.remove('sharedTask', 'member');
      await vi.waitFor(() => expect(rejectRemove).toBeTypeOf('function'));
    } else {
      detail = { ...detail, revision: 2, guests: [] };
      await host.refresh('sharedTask');
    }
    const code = state === 'suspended' ? 'NOT_CONNECTED' : 'ACCESS_REVOKED';
    expect(host.peerStatus(peer)).toBe(state === 'suspended' ? 'unavailable' : 'revoked');
    expect(host.capturePeer(peer)).toBeNull();
    expect(__testing.handleSubscriptionFrame(peer, subscribe)).toMatchObject({ ok: false, error: { code } });
    const transport = client();
    __testing.setActiveClient(transport as never);
    __testing.handleLinkOpen(transport as never, peer, 'open', {
      controllerName: 'Guest', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', capabilities: [SHARED_TASK_CAPABILITY],
    }, 0, true);
    expect(transport.closeLink).toHaveBeenCalledWith(peer, state === 'suspended' ? 'transport-timeout' : 'revoked', 'inbound');
    expect(transport.sendLinkAccept).not.toHaveBeenCalled();
    __testing.sendInvokeResultSafe(transport as never, peer, 'late', { ok: true, result: 'private data' }, read.channel, read.args);
    expect(transport.sendInvokeResult).toHaveBeenLastCalledWith(peer, 'late', expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) }));
    const handler = vi.fn(() => []);
    registry.register(read.channel, handler);
    wireInboundDispatch(transport as never);
    transport.onFrame.mock.calls[0][0]({ v: PROTOCOL_VERSION, kind: 'invoke', src: peer, id: 'new', payload: read });
    await vi.waitFor(() => expect(transport.sendInvokeResult).toHaveBeenCalledWith(peer, 'new', expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) })));
    expect(handler).not.toHaveBeenCalled();
    if (removal) {
      const failed = expect(removal).rejects.toThrow('offline');
      rejectRemove(new Error('offline'));
      await failed;
      expect(host.peerStatus(peer)).toBe('available');
      expect(__testing.handleSubscriptionFrame(peer, subscribe).ok).toBe(true);
      expect((await runInvoke(peer, read)).ok).toBe(true);
    }
  });

  it.each(['device-added', 'member-removed'] as const)('fences an in-flight read after %s without confusing stale capture with revocation', async (change) => {
    let finish!: (value: unknown) => void;
    registry.register(read.channel, () => new Promise((resolve) => { finish = resolve; }));
    const result = runInvoke(peer, read);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    detail = { ...detail, revision: 2, guests: change === 'device-added'
      ? [{ ...detail.guests[0], version: 2, deviceIds: ['phone', 'second-phone'] }] : [] };
    await host.refresh('sharedTask');
    finish([{ content: 'private data' }]);
    expect(await result).toMatchObject({ ok: false, error: { code: change === 'device-added' ? 'NOT_CONNECTED' : 'ACCESS_REVOKED' } });
    if (change === 'device-added') {
      expect(host.capturePeer(peer)?.isCurrent()).toBe(true);
      registry.register(read.channel, () => []);
      expect((await runInvoke(peer, read)).ok).toBe(true);
    }
  });

  it('denies an out-of-scope request without revoking an otherwise valid member', async () => {
    expect(await runInvoke(peer, { ...read, args: ['another-task'] }))
      .toMatchObject({ ok: false, error: { code: 'IPC_ERROR', message: expect.stringContaining('PERMISSION_DENIED') } });
    expect(host.peerStatus(peer)).toBe('available');
    expect(__testing.handleSubscriptionFrame(peer, subscribe).ok).toBe(true);
  });

  it('treats unrestored or replaced host authority as unavailable rather than revoked', async () => {
    expect(host.peerStatus(sharedTaskGuestPeer('unknown', 'member', 'phone'))).toBe('unavailable');
    setSharedTaskDispatchHost(null);
    expect(await runInvoke(peer, read)).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
  });
});
