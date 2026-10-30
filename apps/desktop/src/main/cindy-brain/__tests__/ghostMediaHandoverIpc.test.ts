import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { describe, expect, it, vi } from 'vitest';

import { type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart, isGhostInstanceId } from '../../../shared/pluginIdentity';
import { ghostMediaHandoverTargetTracker, resolveGhostMediaHandoverTarget } from '../ghostMediaHandoverTargetTracker';
import { parseGhostPanelMediaUrl, resolveGhostPanelMedia } from '../previewGate';

const createHandler = createGhostProductionCallbacks<{
  handler: (event: unknown, uri: unknown, purpose?: unknown, instanceId?: unknown, sourceToken?: unknown) => Promise<unknown>;
}>({ callbacks: { handler: ['ipcMain.handle', 'ghosts:resolve-panel-media'] } });

const hash = 'a'.repeat(64);
const uri = 'cindy-ghost://helper/preview/' + hash + '.png';

function harness() {
  const root = { manifest: { id: 'helper', version: '1.0.0' }, dir: '/plugins/helper', namespace: null, approval: { state: 'approved', revision: 'root-receipt' } } as InstalledGhost;
  const organization = { ...root, dir: '/plugins/_ns/acme/helper', namespace: 'acme', approval: { state: 'approved', revision: 'acme-receipt' } } as InstalledGhost;
  const installed = new Map([['helper', root], ['_ns__acme__helper', organization]]);
  const ledger = {
    ghostCanRead: vi.fn(async (_hash: string, instanceId: string) => instanceId === '_ns__acme__helper'),
    getBlobInfo: vi.fn(async () => ({ ext: '.png', mimeType: 'image/png' })),
  };
  const findAvailable = vi.fn(() => installed.size === 1 ? [...installed.values()][0] : null);
  const { handler } = createHandler({
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    isGhostInstanceId, resolveGhostMediaHandoverTarget, parseGhostPanelMediaUrl, installedGhostStoragePart, resolveGhostPanelMedia,
    findAvailableGhostForAuthorization: findAvailable,
    findGhostForInstanceId: (instanceId: string) => installed.get(instanceId) ?? null,
    ghostInstallMutationTargetFor: (instanceId: string) => installed.get(instanceId)?.approval.state === 'approved'
      ? (installed.get(instanceId)?.approval as { revision: string }).revision : null,
    ledger,
    blobStore: { blobUrl: () => 'cindy-media://blobs/image.png', resolveHashRef: () => ({ absPath: '/blobs/image.png' }) },
    fs: { promises: { stat: async () => ({ size: 42 }) } },
  });
  const token = ghostMediaHandoverTargetTracker.register({
    ghostId: 'helper', instanceId: '_ns__acme__helper',
    isCurrent: () => installed.get('_ns__acme__helper')?.approval.state === 'approved'
      && (installed.get('_ns__acme__helper')?.approval as { revision: string }).revision === 'acme-receipt',
  });
  return { handler, ledger, installed, token, findAvailable };
}

describe('Registered Ghost handover through the actual media IPC handler', () => {
  it('selects the token-bound instance, not a same-name root or URL declaration', async () => {
    const target = harness();
    try {
      await expect(target.handler({}, uri, 'attach', undefined, target.token)).resolves.toMatchObject({ kind: 'image' });
      expect(target.ledger.ghostCanRead).toHaveBeenCalledExactlyOnceWith(hash, '_ns__acme__helper');
      expect(target.findAvailable).not.toHaveBeenCalled();
    } finally { ghostMediaHandoverTargetTracker.revoke(target.token); }
  });

  it.each([
    ['attach', undefined, 'unknown-token'],
    ['menu', undefined, 'registered'],
    ['attach', 'helper', 'registered'],
    ['attach', undefined, ''],
  ])('rejects %s with instance %s and token %s without a legacy fallback', async (purpose, instanceId, token) => {
    const target = harness();
    try {
      await expect(target.handler({}, uri, purpose, instanceId, token === 'registered' ? target.token : token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(target.findAvailable).not.toHaveBeenCalled();
      expect(target.ledger.ghostCanRead).not.toHaveBeenCalled();
    } finally { ghostMediaHandoverTargetTracker.revoke(target.token); }
  });

  it.each(['token revoked', 'same-version receipt replaced'])('cancels when %s while the ledger lookup is pending', async (change) => {
    const target = harness();
    let release: (granted: boolean) => void = () => {};
    target.ledger.ghostCanRead.mockImplementation(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const pending = target.handler({}, uri, 'attach', undefined, target.token);
    if (change === 'token revoked') ghostMediaHandoverTargetTracker.revoke(target.token);
    else {
      const installed = target.installed.get('_ns__acme__helper')!;
      target.installed.set('_ns__acme__helper', { ...installed, approval: { state: 'approved', revision: 'replacement-receipt' } });
    }
    release(true);
    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    ghostMediaHandoverTargetTracker.revoke(target.token);
  });

  it('preserves an old root controller without instance or source token', async () => {
    const target = harness();
    try {
      target.installed.delete('_ns__acme__helper');
      target.ledger.ghostCanRead.mockResolvedValue(true);
      await expect(target.handler({}, uri)).resolves.toMatchObject({ kind: 'image' });
      expect(target.ledger.ghostCanRead).toHaveBeenCalledExactlyOnceWith(hash, 'helper');
    } finally { ghostMediaHandoverTargetTracker.revoke(target.token); }
  });
});
