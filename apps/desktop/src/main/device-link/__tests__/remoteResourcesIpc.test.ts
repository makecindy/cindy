import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  context: null as null | { controllerDeviceId: string; channel: string },
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, raw: unknown) => Promise<unknown>) => h.handlers.set(channel, handler) } }));
vi.mock('../invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => h.context }));

import { __testing, registerRemoteResourcesIpc } from '../remoteResourcesIpc.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../remoteResourceRegistry.js';

describe('remote resources IPC error boundary', () => {
  it('preserves stable registry errors needed by clients', () => {
    expect(() => __testing.rethrowRegistryError(
      new RemoteResourceRegistryError('NOT_FOUND', 'unknown collection'),
    )).toThrow('unknown collection');
  });

  it('does not expose provider internals to a remote controller', () => {
    expect(() => __testing.rethrowRegistryError(
      new Error('SQLITE_ERROR at /Users/private/db.sqlite'),
    )).toThrow('remote resource provider failed');
    expect(() => __testing.rethrowRegistryError(
      new RemoteResourceRegistryError('INTERNAL', 'provider leaked /secret/path'),
    )).toThrow('remote resource provider failed');
  });
});


describe('remote resources IPC authentication', () => {
  beforeEach(() => { h.context = null; h.handlers.clear(); registerRemoteResourcesIpc(); });
  const request = { client: { protocolVersion: 1, primitives: ['session-link'] }, collectionId: 'teammates' };
  it('rejects renderer calls and a context captured for another channel', async () => {
    const list = h.handlers.get('maker:remote-resources:list')!;
    await expect(list({}, request)).rejects.toThrow('only available through device-link');
    h.context = { controllerDeviceId: 'phone', channel: 'maker:remote-resources:get' };
    await expect(list({}, request)).rejects.toThrow('only available through device-link');
  });
  it('passes a validated request with the authenticated controller identity', async () => {
    h.context = { controllerDeviceId: 'phone', channel: 'maker:remote-resources:list' };
    const list = vi.spyOn(remoteResourceRegistry, 'list').mockResolvedValue({ collectionId: 'teammates', revision: '1', items: [] });
    try {
      await h.handlers.get('maker:remote-resources:list')!({}, request);
      expect(list).toHaveBeenCalledWith({ controllerDeviceId: 'phone' }, request);
    } finally { list.mockRestore(); }
  });
});
