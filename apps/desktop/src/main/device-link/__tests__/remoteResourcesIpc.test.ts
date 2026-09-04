import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import { __testing } from '../remoteResourcesIpc.js';
import { RemoteResourceRegistryError } from '../remoteResourceRegistry.js';

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
