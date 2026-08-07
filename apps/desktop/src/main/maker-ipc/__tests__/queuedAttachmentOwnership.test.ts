import { describe, expect, it, vi } from 'vitest';

import { QueuedAttachmentOwnershipRegistry } from '../queuedAttachmentOwnership';

describe('QueuedAttachmentOwnershipRegistry', () => {
  it('defers discard during persistence and transfers ownership to the durable row', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.discardClient('session-1', 'client-1');
    expect(cleanup).not.toHaveBeenCalled();

    registry.releaseClient('session-1', 'client-1');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs a deferred discard when persistence fails', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.discardClient('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable owner after persistence fails without a discard', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });
    expect(cleanup).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans a non-retryable owner when persistence fails', async () => {
    const cleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', cleanup);
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: false,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('holds remote cleanup until the queue crosses a durable boundary', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    expect(ownerId).toBeTruthy();
    expect(remoteCleanup).not.toHaveBeenCalled();
    await registry.markDurable('session-1', 'client-1', ownerId!);

    expect(remoteCleanup).toHaveBeenCalledTimes(1);
    expect(localCleanup).not.toHaveBeenCalled();
    await registry.markDurable('session-1', 'client-1', ownerId!);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);

    registry.releaseClient('session-1', 'client-1');
    expect(localCleanup).not.toHaveBeenCalled();
  });

  it('cleans both local and remote ownership on explicit discard', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });

    await registry.discardClient('session-1', 'client-1');

    expect(localCleanup).toHaveBeenCalledTimes(1);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);
  });

  it('retains both ownership callbacks for a retryable persistence failure', async () => {
    const localCleanup = vi.fn(async () => {});
    const remoteCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const ownerId = registry.register('session-1', 'client-1', localCleanup, {
      cleanupAfterDurable: remoteCleanup,
    });
    registry.activateCurrentOwner('session-1', 'client-1', ownerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', {
      retainForRetry: true,
    });
    expect(localCleanup).not.toHaveBeenCalled();
    expect(remoteCleanup).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(localCleanup).toHaveBeenCalledTimes(1);
    expect(remoteCleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans superseded owners while preserving the accepted replacement', async () => {
    const oldLocal = vi.fn(async () => {});
    const oldRemote = vi.fn(async () => {});
    const newLocal = vi.fn(async () => {});
    const newRemote = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const oldOwnerId = registry.register('session-1', 'client-1', oldLocal, {
      cleanupAfterDurable: oldRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', oldOwnerId!);
    const newOwnerId = registry.register('session-1', 'client-1', newLocal, {
      cleanupAfterDurable: newRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', newOwnerId!);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', { retainForRetry: true });

    expect(oldLocal).toHaveBeenCalledTimes(1);
    expect(oldRemote).toHaveBeenCalledTimes(1);
    expect(newLocal).not.toHaveBeenCalled();
    expect(newRemote).not.toHaveBeenCalled();

    await registry.discardClient('session-1', 'client-1');
    expect(newLocal).toHaveBeenCalledTimes(1);
    expect(newRemote).toHaveBeenCalledTimes(1);
  });

  it('settles the persisted replacement atomically and cleans the old owner', async () => {
    const oldLocal = vi.fn(async () => {});
    const oldRemote = vi.fn(async () => {});
    const newLocal = vi.fn(async () => {});
    const newRemote = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const oldOwnerId = registry.register('session-1', 'client-1', oldLocal, {
      cleanupAfterDurable: oldRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', oldOwnerId!);
    const newOwnerId = registry.register('session-1', 'client-1', newLocal, {
      cleanupAfterDurable: newRemote,
    });
    registry.activateCurrentOwner('session-1', 'client-1', newOwnerId!);

    await registry.settleDurable('session-1', 'client-1');

    expect(oldLocal).toHaveBeenCalledTimes(1);
    expect(oldRemote).toHaveBeenCalledTimes(1);
    expect(newLocal).not.toHaveBeenCalled();
    expect(newRemote).toHaveBeenCalledTimes(1);
    expect(registry.getCurrentOwnerId('session-1', 'client-1')).toBeNull();
  });

  it('does not clean a duplicate materialisation that was never accepted', async () => {
    const acceptedCleanup = vi.fn(async () => {});
    const duplicateCleanup = vi.fn(async () => {});
    const registry = new QueuedAttachmentOwnershipRegistry();
    const acceptedOwnerId = registry.register('session-1', 'client-1', acceptedCleanup);
    registry.activateCurrentOwner('session-1', 'client-1', acceptedOwnerId!);
    registry.register('session-1', 'client-1', duplicateCleanup);

    registry.markPersistenceStarted('session-1', 'client-1');
    await registry.markPersistenceFailed('session-1', 'client-1', { retainForRetry: true });

    expect(duplicateCleanup).toHaveBeenCalledTimes(1);
    expect(acceptedCleanup).not.toHaveBeenCalled();
    await registry.discardClient('session-1', 'client-1');
    expect(acceptedCleanup).toHaveBeenCalledTimes(1);
  });
});
