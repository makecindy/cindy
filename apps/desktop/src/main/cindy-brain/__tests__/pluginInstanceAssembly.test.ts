import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGhostProductionCallbacks } from './ghostProductionCallbacksFixture.js';
import { describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { ghostExternalLinkUrls } from '../../../shared/ghost.js';
import { findInstalledGhostByInstanceId, installedGhostStoragePart, resolveInstalledGhost } from '../../../shared/pluginIdentity.js';
import { PluginDownloadSlot } from '../downloadSlot.js';
import { GhostExternalLinkGate } from '../previewGate.js';
import { runGhostExternalLinkNavigation } from '../ghostExternalLinkNavigation.js';

const productionAssembly = createGhostProductionCallbacks<{
  pluginDownloads: PluginDownloadSlot;
  handleGhostExternalLinkNavigation: (...args: unknown[]) => void;
}>({
  functions: ['findAvailableGhost', 'findGhostForInstanceId', 'getGhostExternalLinkGate', 'handleGhostExternalLinkNavigation'],
  variables: ['pluginDownloads'],
  initialize: 'let externalLinkGateSingleton = null;',
});

function installed(namespace?: string | null, inPlace = false): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2, id: 'helper', name: 'Helper', version: '1.0.0', kind: 'chip', entry: 'main.js',
      node: { entry: 'node.js' }, network: {
        hosts: ['example.invalid'], secrets: [{ key: 'account', label: 'Account', url: 'https://example.invalid/control' }],
      },
    },
    dir: namespace && !inPlace ? '/plugins/_ns/' + namespace + '/helper' : '/plugins/helper',
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    ...(namespace === undefined ? { namespaceMigration: 'pending' } : { namespace }),
  } as InstalledGhost;
}

describe('production plugin instance assembly', () => {
  it.each(['S1', 'S2-off', 'S2-on', 'S2-coexist'])(
    'downloads and external navigation keep the selected instance in %s', async (stage) => {
      const selected = stage === 'S1' ? installed()
        : stage === 'S2-off' ? installed('acme', true) : installed('acme');
      const other = { ...installed(null), enabled: false };
      const ghosts = stage === 'S2-coexist' ? [other, selected] : [selected];
      const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-instance-assembly-'));
      const send = vi.fn();
      const openExternal = vi.fn(async () => {});
      const showMessageBox = vi.fn(async () => ({ response: 0 }));
      const host = { isDestroyed: () => false };
      const guest = { isDestroyed: () => false, isFocused: () => true, hostWebContents: host };
      const download = vi.fn(async (options) => {
        await fs.promises.writeFile(options.targetPath, 'ok');
        return { path: options.targetPath, size: 2, sha256: options.sha256, fromCache: false, durationMs: 1, resumedFromBytes: 0 };
      });
      const assembly = productionAssembly({
        availableGhosts: () => ghosts, resolveInstalledGhost, findInstalledGhostByInstanceId,
        PluginDownloadSlot, GhostExternalLinkGate, ghostExternalLinkUrls, runGhostExternalLinkNavigation,
        ownerScopedUserDataPath: (...parts: string[]) => path.join(tmp, ...parts),
        activeOwnerScopeKey: () => 'owner', getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
        anonymousDownloadRoots: new Map(), sendToGhostLogic: send, createDownloader: () => download,
        BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) }, dialog: { showMessageBox },
        shell: { openExternal }, t: (key: string) => key,
        log: { debug: vi.fn(), warn: vi.fn() },
      });
      const instanceId = installedGhostStoragePart(selected);
      try {
        expect(await assembly.pluginDownloads.handle(instanceId, {
          kind: 'start', id: 'artifact', url: 'https://example.invalid/file', bytes: 2,
          sha256: createHash('sha256').update('ok').digest('hex'),
        })).toMatchObject({ ok: true });
        expect(download).toHaveBeenCalledTimes(1);
        expect(send.mock.calls.every(([id]) => id === instanceId)).toBe(true);
        assembly.handleGhostExternalLinkNavigation('helper', 'https://example.invalid/control', host, guest, () => true, instanceId);
        await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.invalid/control'));
        expect(showMessageBox).not.toHaveBeenCalled();
        selected.enabled = false;
        expect(await assembly.pluginDownloads.handle(instanceId, {
          kind: 'start', id: 'denied', url: 'https://example.invalid/file', bytes: 2,
          sha256: 'a'.repeat(64),
        })).toMatchObject({ ok: false });
        expect(download).toHaveBeenCalledTimes(1);
      } finally {
        await assembly.pluginDownloads.stopAndWait();
        await fs.promises.rm(tmp, { recursive: true, force: true });
      }
    },
  );
});
