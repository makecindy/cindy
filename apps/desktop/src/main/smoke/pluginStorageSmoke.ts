import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { CLIENT_ENDPOINT_KEYS, type ClientEndpointMap } from '@cindy/maker-shared/client-endpoints';
import type { VisiblePluginSummary } from '@cindy/plugin-protocol';

import { commitActiveAppSession, dataOwnerStorageKey } from '../appSessionState.js';
import { getGhostManager } from '../cindy-brain/index.js';
import { resetClientEndpointsForTest } from '../clientEndpointsService.js';
import type { PluginMarketApi } from '../plugin-market/api.js';
import { ghostManifestDigest, PluginMarketLedger } from '../plugin-market/ledger.js';
import { PluginMarketService } from '../plugin-market/service.js';
import { MarketSourceStore } from '../plugin-market/sources/store.js';
import { validateGhostManifest } from '../../shared/ghost.js';

const GHOST_ID = 'cindy-smoke-storage';
const PLUGIN_ID = `c${'f'.repeat(24)}`;

export interface PluginStorageSmokeResult {
  initialSignedOutCount: number;
  ownerGhostFound: boolean;
  ownerGhostDir: string | null;
  ledgerInstalledAfterEmptySnapshot: boolean;
  optOutAfterEmptySnapshot: boolean;
  recoveryPromptedForCorruptedLedger: boolean;
  ledgerStayedRemovedBeforeRecoveryDecision: boolean;
  optOutStayedBeforeRecoveryDecision: boolean;
}

function endpointFixture(): ClientEndpointMap {
  const endpoints = Object.fromEntries(
    CLIENT_ENDPOINT_KEYS.map((key) => [key, '']),
  ) as ClientEndpointMap;
  endpoints.pluginApiBaseUrl = 'https://plugin-smoke.invalid';
  return endpoints;
}

function pluginSummary(): VisiblePluginSummary {
  return {
    id: PLUGIN_ID,
    ghostId: GHOST_ID,
    name: 'Plugin storage smoke',
    description: 'Packaged smoke fixture',
    author: 'Cindy',
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    currentRelease: {
      id: 'release-smoke-1',
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      publishedAt: '2026-08-09T00:00:00.000Z',
      icon: null,
    },
  };
}

/**
 * Packaged-process black-box fixture for the plugin storage startup boundary.
 * This function is called only by the explicit `--smoke-plugin-storage` path.
 */
export async function runPluginStorageSmoke(ownerId: string): Promise<PluginStorageSmokeResult> {
  const manager = getGhostManager();
  const initialSignedOutCount = manager.list().length;
  const ownerRoot = path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId));
  const ghostDir = path.join(ownerRoot, 'cindy-brain', GHOST_ID);
  const marketDir = path.join(ownerRoot, 'plugin-market');
  const ledgerPath = path.join(marketDir, 'ledger.v1.json');
  fs.mkdirSync(ghostDir, { recursive: true });
  fs.mkdirSync(marketDir, { recursive: true });
  const rawManifest = {
    schemaVersion: 2,
    id: GHOST_ID,
    name: 'Plugin storage smoke',
    description: 'Packaged smoke fixture',
    author: 'Cindy',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['notify'],
  };
  const validatedManifest = validateGhostManifest(rawManifest);
  if (!validatedManifest.ok) throw new Error('plugin storage smoke manifest is invalid');
  fs.writeFileSync(path.join(ghostDir, 'ghost.json'), `${JSON.stringify(rawManifest)}\n`);
  fs.writeFileSync(path.join(ghostDir, 'main.js'), '// packaged plugin storage smoke\n');

  const ledger = new PluginMarketLedger(ledgerPath);
  ledger.upsertInstallation({
    pluginId: PLUGIN_ID,
    ghostId: GHOST_ID,
    releaseId: 'release-smoke-1',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    scope: 'public',
    organizationId: null,
    source: 'market',
    installed: true,
    updatedAt: '2026-08-09T00:00:00.000Z',
    manifestDigest: ghostManifestDigest(validatedManifest.manifest),
  });

  commitActiveAppSession('cloud', ownerId);
  const ownerGhost = manager.list().find((ghost) => ghost.manifest.id === GHOST_ID) ?? null;

  // A passive snapshot must not translate temporary absence into an uninstall.
  const hiddenGhostDir = path.join(ownerRoot, 'cindy-brain', `.${GHOST_ID}-hidden`);
  fs.renameSync(ghostDir, hiddenGhostDir);
  resetClientEndpointsForTest(endpointFixture());
  const api = {
    listAll: async () => ({ plugins: [pluginSummary()], removals: [] }),
  } as unknown as PluginMarketApi;
  const service = new PluginMarketService(
    api,
    ledger,
    new MarketSourceStore(path.join(marketDir, 'sources.v1.json')),
  );
  await service.snapshot();
  const recordAfterEmptySnapshot = ledger.installationForGhost(GHOST_ID);
  const optOutAfterEmptySnapshot = ledger.isDefaultInstallSuppressed(ownerId, PLUGIN_ID);

  // Recreate the 0.1.38 ledger corruption without going through an explicit
  // uninstall (which now records a removal receipt). Discovery may offer an
  // owner-scoped recovery, but it must remain passive until the user decides.
  fs.renameSync(hiddenGhostDir, ghostDir);
  ledger.markRemoved(GHOST_ID, ownerId);
  await service.snapshot();
  const recoveryStatus = service.recoveryStatus();
  const recordBeforeDecision = ledger.installationForGhost(GHOST_ID);

  return {
    initialSignedOutCount,
    ownerGhostFound: ownerGhost !== null,
    ownerGhostDir: ownerGhost?.dir ?? null,
    ledgerInstalledAfterEmptySnapshot: recordAfterEmptySnapshot?.installed === true,
    optOutAfterEmptySnapshot,
    recoveryPromptedForCorruptedLedger:
      recoveryStatus.state === 'pending' &&
      recoveryStatus.proposal?.candidates.some((candidate) => candidate.ghostId === GHOST_ID) ===
        true,
    ledgerStayedRemovedBeforeRecoveryDecision: recordBeforeDecision?.installed === false,
    optOutStayedBeforeRecoveryDecision: ledger.isDefaultInstallSuppressed(ownerId, PLUGIN_ID),
  };
}
