/**
 * Source side of new-computer setup: builds the non-secret configuration snapshot another
 * computer of the same account asked for (docs/product-rules/new-device-setup-migration.md).
 *
 * Reads only; never writes this computer's state. Every section is collected independently,
 * so one unreadable store marks that section unavailable instead of failing the snapshot.
 * Credentials are reported as presence-only hints and never read into the snapshot.
 */
import {
  SETUP_SNAPSHOT_MAX_BYTES,
  SETUP_SNAPSHOT_LIMITS,
  SETUP_SNAPSHOT_VERSION,
  SETUP_TRANSFER_VERSION,
  isPortableGitUrl,
  serializedSetupSnapshotBytes,
  type SetupSnapshot,
  type SetupSnapshotAccess,
  type SetupSnapshotBuiltinTool,
  type SetupSnapshotHints,
  type SetupSnapshotMarketSource,
  type SetupSnapshotMcpServer,
  type SetupSnapshotPlugin,
  type SetupSnapshotProvider,
  type SetupSnapshotProviderAuth,
  type SetupSnapshotSection,
  type SetupSnapshotSettingsGroup,
  type SetupSnapshotSkill,
  type SetupSnapshotSshHost,
} from '@cindy/device-link';

import type { SetupSettingsGroup } from './settingsGroups.js';

/** One installed plugin instance on the source computer. */
export interface SourceGhostFact {
  ghostId: string;
  name: string;
  version: string;
  namespace: string | null | undefined;
  instanceKey: string;
  enabled: boolean;
  builtin: boolean;
}

/** An installed entry from the marketplace view (server or custom market). */
export interface SourceMarketFact {
  pluginId: string;
  ghostId: string;
  namespace?: string | null;
  installed: boolean;
  sourceType: 'server' | 'git-market' | 'local-market';
  sourceMarketName: string | null;
  defaultInstall: boolean;
}

export interface SourceMarketSourceFact {
  name: string;
  source: { type: 'git'; url: string; ref?: string; sparsePaths: string[] } | { type: 'local'; path: string };
}

export interface SourceMcpFact {
  id: string;
  name: string;
  transport: 'http' | 'sse';
  url: string;
  headers: Record<string, string>;
  hasToken: boolean;
}

export interface SourceProviderFact {
  id: string;
  name: string;
  auth?: { method: string; native?: unknown } | null;
  runtimes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SetupSnapshotSourceDeps {
  platform: string;
  now(): number;
  settingsGroups: readonly SetupSettingsGroup[];
  readRendererPrefs(): Promise<Record<string, string> | null>;
  readPlugins(): Promise<{ ghosts: SourceGhostFact[]; market: SourceMarketFact[] }>;
  /** `true` when the plugin's accounts/keys are set up here; null when unknown. */
  pluginSetupReady(instanceKey: string): boolean | null;
  readMarketSources(): Promise<SourceMarketSourceFact[]>;
  readSkills(): Promise<SetupSnapshotSkill[]>;
  readMcpServers(): Promise<SourceMcpFact[]>;
  readProviders(): Promise<SourceProviderFact[]>;
  /** False for providers owned by an organization, BYOK or managed local runtimes. */
  isUserProvider(id: string): boolean;
  readBuiltinToolOverrides(): Promise<SetupSnapshotBuiltinTool[]>;
  readAccess(): SetupSnapshotAccess;
  readHints(): Promise<SetupSnapshotHints>;
  /** Servers Cindy shows here: how to reach them and the trusted host key, nothing else. */
  readSshHosts(): Promise<SetupSnapshotSshHost[]>;
}

export async function collectSetupSnapshot(deps: SetupSnapshotSourceDeps): Promise<SetupSnapshot> {
  const unavailable = new Set<SetupSnapshotSection>();
  const guard = async <T>(section: SetupSnapshotSection, fallback: T, read: () => Promise<T> | T): Promise<T> => {
    try {
      return await read();
    } catch {
      unavailable.add(section);
      return fallback;
    }
  };

  const settings = await guard('settings', [] as SetupSnapshotSettingsGroup[], () =>
    collectSettings(deps.settingsGroups, deps.platform, () => unavailable.add('settings')),
  );
  const rendererPrefs = await guard('rendererPrefs', null as Record<string, string> | null, () =>
    deps.readRendererPrefs(),
  );
  if (rendererPrefs === null) unavailable.add('rendererPrefs');
  const plugins = await guard('plugins', [] as SetupSnapshotPlugin[], async () =>
    projectPlugins(await deps.readPlugins(), deps.pluginSetupReady),
  );
  const marketSources = await guard('plugins', [] as SetupSnapshotMarketSource[], async () =>
    projectMarketSources(await deps.readMarketSources()),
  );
  const skills = await guard('skills', [] as SetupSnapshotSkill[], () => deps.readSkills());
  const mcpServers = await guard('mcpServers', [] as SetupSnapshotMcpServer[], async () =>
    (await deps.readMcpServers())
      .slice(0, SETUP_SNAPSHOT_LIMITS.mcpServers)
      .flatMap((server) => projectMcpServer(server) ?? []),
  );
  const providers = await guard('providers', [] as SetupSnapshotProvider[], async () =>
    (await deps.readProviders())
      .filter((config) => deps.isUserProvider(config.id))
      .slice(0, SETUP_SNAPSHOT_LIMITS.providers)
      .map(projectProvider),
  );
  const builtinTools = await guard('builtinTools', [] as SetupSnapshotBuiltinTool[], () =>
    deps.readBuiltinToolOverrides(),
  );
  const access = await guard(
    'access',
    { remoteControlEnabled: false, remoteDesktopEnabled: false, keepAwake: false } as SetupSnapshotAccess,
    () => deps.readAccess(),
  );
  const hints = await guard('hints', { builtinKeys: [], imChannels: [], sshHostCount: 0 } as SetupSnapshotHints, () =>
    deps.readHints(),
  );
  const sshHosts = await guard('sshHosts', [] as SetupSnapshotSshHost[], () => deps.readSshHosts());

  const snapshot: SetupSnapshot = {
    version: SETUP_SNAPSHOT_VERSION,
    createdAt: deps.now(),
    platform: deps.platform,
    settings,
    rendererPrefs,
    plugins,
    marketSources,
    skills: skills.slice(0, SETUP_SNAPSHOT_LIMITS.skills),
    mcpServers,
    providers,
    builtinTools: builtinTools.slice(0, SETUP_SNAPSHOT_LIMITS.builtinTools),
    access,
    hints,
    sshHosts: sshHosts.slice(0, SETUP_SNAPSHOT_LIMITS.sshHosts),
    transfer: SETUP_TRANSFER_VERSION,
    unavailable: [],
  };
  return fitSetupSnapshotBudget(snapshot, unavailable);
}

async function collectSettings(
  groups: readonly SetupSettingsGroup[],
  platform: string,
  markPartial: () => void,
): Promise<SetupSnapshotSettingsGroup[]> {
  const out: SetupSnapshotSettingsGroup[] = [];
  for (const group of groups) {
    if (group.platforms && !group.platforms.includes(platform as NodeJS.Platform)) continue;
    try {
      const values = group.settings.readCustomized();
      if (Object.keys(values).length === 0) continue;
      if (Buffer.byteLength(JSON.stringify(values), 'utf8') > SETUP_SNAPSHOT_LIMITS.settingsGroupBytes) {
        markPartial();
        continue;
      }
      out.push({ id: group.id, values });
    } catch {
      markPartial();
    }
  }
  return out;
}

export function projectPlugins(
  facts: { ghosts: SourceGhostFact[]; market: SourceMarketFact[] },
  setupReady: (instanceKey: string) => boolean | null,
): SetupSnapshotPlugin[] {
  const installedMarket = facts.market.filter((item) => item.installed);
  const out: SetupSnapshotPlugin[] = [];
  for (const ghost of facts.ghosts) {
    if (out.length >= SETUP_SNAPSHOT_LIMITS.plugins) break;
    const namespace = ghost.namespace ?? null;
    const sameId = installedMarket.filter((item) => item.ghostId === ghost.ghostId);
    const market =
      sameId.find((item) => item.namespace !== undefined && (item.namespace ?? null) === namespace) ??
      (sameId.length === 1 && sameId[0].namespace === undefined ? sameId[0] : undefined);
    let ready: boolean | null = null;
    try {
      ready = setupReady(ghost.instanceKey);
    } catch {
      ready = null;
    }
    const base = {
      ghostId: ghost.ghostId,
      name: ghost.name,
      version: ghost.version,
      namespace,
      enabled: ghost.enabled,
      setupReady: ready,
    };
    if (ghost.builtin) {
      out.push({ ...base, pluginId: null, source: 'builtin', marketName: null });
    } else if (!market) {
      out.push({ ...base, pluginId: null, source: 'manual', marketName: null });
    } else if (market.sourceType === 'server') {
      out.push({
        ...base,
        pluginId: market.pluginId,
        source: market.defaultInstall ? 'default-install' : 'market',
        marketName: null,
      });
    } else if (market.sourceType === 'git-market') {
      out.push({ ...base, pluginId: market.pluginId, source: 'custom-market', marketName: market.sourceMarketName });
    } else {
      // A local-folder market only exists on that computer.
      out.push({ ...base, pluginId: null, source: 'manual', marketName: market.sourceMarketName });
    }
  }
  return out;
}

export function projectMarketSources(sources: SourceMarketSourceFact[]): SetupSnapshotMarketSource[] {
  return sources
    .flatMap((entry) =>
      entry.source.type === 'git' && isPortableGitUrl(entry.source.url)
        ? [
            {
              name: entry.name,
              url: entry.source.url,
              ref: entry.source.ref ?? null,
              sparsePaths: [...entry.source.sparsePaths],
            },
          ]
        : [],
    )
    .slice(0, SETUP_SNAPSHOT_LIMITS.pluginSources);
}

/**
 * Besides the stored token, request headers (`Authorization`, `x-api-key`…) and the URL's user
 * and query parts can carry credentials, so none of them leave this computer. A server that
 * had any of them is marked as needing its credentials entered again on the other computer.
 */
function projectMcpServer(server: SourceMcpFact): SetupSnapshotMcpServer | null {
  try {
    new URL(server.url);
  } catch {
    return null;
  }
  const url = withoutUrlSecrets(server.url);
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: url.value,
    headers: {},
    hasToken: server.hasToken || url.removed || Object.keys(server.headers).length > 0,
  };
}

/**
 * The user, password, query and fragment parts of a URL can carry credentials
 * (`?api_key=…`). Absolute URLs lose all of them; a relative request path loses everything
 * from its query on.
 */
function withoutUrlSecrets(value: string): { value: string; removed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    const cut = value.search(/[?#]/);
    return cut === -1 ? { value, removed: false } : { value: value.slice(0, cut), removed: true };
  }
  if (!(parsed.username || parsed.password || parsed.search || parsed.hash)) return { value, removed: false };
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return { value: parsed.toString(), removed: true };
}

export function providerAuthKind(config: SourceProviderFact): SetupSnapshotProviderAuth {
  const method = config.auth?.method;
  if (method === 'none') return 'none';
  if (method === 'oauth') return config.auth?.native ? 'native' : 'oauth';
  return 'apiKey';
}

/** Address fields of a custom provider; any of them may carry credentials in its URL. */
const PROVIDER_RUNTIME_URL_KEYS = ['baseUrl', 'modelsUrl', 'requestPath'] as const;
const PROVIDER_ROUTE_URL_KEYS = ['baseUrl', 'requestPath'] as const;
const PROVIDER_OAUTH_URL_KEYS = ['deviceAuthorizationUrl', 'tokenUrl', 'authorizeUrl', 'modelsDiscoveryUrl'] as const;

function projectProvider(config: SourceProviderFact): SetupSnapshotProvider {
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let urlSecretsRemoved = false;
  const clean = (target: unknown, keys: readonly string[]) => {
    if (!target || typeof target !== 'object') return;
    const record = target as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] !== 'string') continue;
      const url = withoutUrlSecrets(record[key] as string);
      record[key] = url.value;
      urlSecretsRemoved ||= url.removed;
    }
  };
  for (const runtime of Object.values((copy.runtimes as Record<string, unknown> | undefined) ?? {})) {
    if (!runtime || typeof runtime !== 'object') continue;
    const record = runtime as Record<string, unknown>;
    // Runtime headers are credential material kept in the secret store; never export them.
    delete record.headers;
    delete record.headersState;
    clean(record, PROVIDER_RUNTIME_URL_KEYS);
    if (Array.isArray(record.models)) {
      for (const model of record.models) clean((model as Record<string, unknown> | null)?.route, PROVIDER_ROUTE_URL_KEYS);
    }
  }
  clean((copy.auth as Record<string, unknown> | undefined)?.oauth, PROVIDER_OAUTH_URL_KEYS);
  return {
    id: config.id,
    name: config.name,
    auth: providerAuthKind(config),
    config: copy,
    // The addresses arrive without those parts; the user enters them again on that computer.
    ...(urlSecretsRemoved ? { urlSecretsRemoved: true } : {}),
  };
}

/** Drops whole optional sections (marked unavailable) until the reply fits one relay frame. */
export function fitSetupSnapshotBudget(
  snapshot: SetupSnapshot,
  unavailable: Set<SetupSnapshotSection>,
  maxBytes = SETUP_SNAPSHOT_MAX_BYTES,
): SetupSnapshot {
  const next: SetupSnapshot = { ...snapshot };
  const finish = () => ({ ...next, unavailable: [...unavailable] });
  const droppable: Array<[SetupSnapshotSection, () => void]> = [
    ['rendererPrefs', () => (next.rendererPrefs = null)],
    ['providers', () => (next.providers = [])],
    ['settings', () => (next.settings = [])],
    ['skills', () => (next.skills = [])],
    ['sshHosts', () => (next.sshHosts = [])],
  ];
  for (const [section, drop] of droppable) {
    if (serializedSetupSnapshotBytes(finish()) <= maxBytes) return finish();
    drop();
    unavailable.add(section);
  }
  if (serializedSetupSnapshotBytes(finish()) > maxBytes) throw new Error('SETUP_SNAPSHOT_TOO_LARGE');
  return finish();
}
