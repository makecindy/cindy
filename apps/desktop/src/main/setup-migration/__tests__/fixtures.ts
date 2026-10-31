import type { SetupSnapshot, SetupSnapshotPlugin } from '@cindy/device-link';

import type { GhostPermissionItem } from '../../../shared/ghost.js';
import type { GhostInstallConsentFacts } from '../../../shared/ghostInstallConsent.js';
import type { SetupPlanInputs } from '../plan.js';

export function snapshot(overrides: Partial<SetupSnapshot> = {}): SetupSnapshot {
  return {
    version: 1,
    createdAt: 1,
    platform: 'darwin',
    settings: [],
    rendererPrefs: null,
    plugins: [],
    marketSources: [],
    skills: [],
    mcpServers: [],
    providers: [],
    builtinTools: [],
    access: { remoteControlEnabled: false, remoteDesktopEnabled: false, keepAwake: false },
    hints: { builtinKeys: [], imChannels: [], sshHostCount: 0 },
    sshHosts: [],
    transfer: 0,
    unavailable: [],
    ...overrides,
  };
}

export function plugin(overrides: Partial<SetupSnapshotPlugin> & Pick<SetupSnapshotPlugin, 'ghostId'>): SetupSnapshotPlugin {
  return {
    name: overrides.ghostId,
    version: '1.0.0',
    namespace: null,
    pluginId: `plg_${overrides.ghostId}`,
    source: 'market',
    marketName: null,
    enabled: true,
    setupReady: null,
    ...overrides,
  };
}

export function installFacts(ghostId: string, host = 'api'): GhostInstallConsentFacts {
  const item: GhostPermissionItem = {
    key: `network:${host}`,
    kind: 'network',
    labelKey: 'networkHost',
    labelArgs: { host: `${host}.example.com` },
  };
  return { kind: 'install', ghostId, name: ghostId, version: '1.0.0', permissions: [item] };
}

export function planInputs(overrides: Partial<SetupPlanInputs> = {}): SetupPlanInputs {
  return {
    planId: 'plan-1',
    now: 10,
    platform: 'darwin',
    source: { deviceId: 'dev-old', name: 'Mac mini' },
    snapshot: snapshot(),
    ghosts: [],
    catalog: new Map(),
    marketNames: new Set(),
    localSkills: new Map(),
    settings: [],
    mcpIds: new Set(),
    providerIds: new Set(),
    builtinTools: new Map(),
    access: { remoteControlEnabled: false, keepAwake: false },
    builtinKeys: new Set(),
    sshHostIds: new Set(),
    ...overrides,
  };
}
