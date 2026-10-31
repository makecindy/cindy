/**
 * Target side of new-computer setup: compares another computer's snapshot with this
 * computer and decides, per item, whether it will be copied, is already the same, keeps
 * this computer's own value, or cannot be copied (docs/product-rules/new-device-setup-migration.md).
 *
 * Pure: every local fact is passed in, so the same rules are unit-tested without Electron.
 * Nothing here installs or writes anything.
 */
import {
  isLoopbackProviderUrl,
} from '@cindy/model-providers';
import {
  SETUP_TRANSFER_BUILTIN_KEY_IDS,
  SETUP_TRANSFER_VERSION,
  type SetupSnapshot,
  type SetupSnapshotPlugin,
  type SetupSnapshotProvider,
} from '@cindy/device-link';

import type { GhostInstallConsentFacts } from '../../shared/ghostInstallConsent.js';
import type {
  SetupMigrationAccessItem,
  SetupMigrationBuiltinToolItem,
  SetupMigrationChecklistItem,
  SetupMigrationMcpItem,
  SetupMigrationPlan,
  SetupMigrationPluginItem,
  SetupMigrationProviderItem,
  SetupMigrationRendererPrefsItem,
  SetupMigrationSecretRef,
  SetupMigrationSecretsItem,
  SetupMigrationSettingsItem,
  SetupMigrationSkillItem,
  SetupMigrationSshHostItem,
} from '../../shared/setupMigration.js';
import { SETUP_MIGRATION_SECRETS_KEY, isPortableRendererPrefKey } from '../../shared/setupMigration.js';

/** Built-in tools whose switch only works after local OS permissions; handled by the checklist. */
export const SETUP_LOCAL_PERMISSION_TOOL_IDS: ReadonlySet<string> = new Set(['computer', 'android']);

export interface TargetGhostFact {
  ghostId: string;
  namespace: string | null | undefined;
  instanceKey: string;
  enabled: boolean;
  builtin: boolean;
}

/** What this computer's marketplace offers for one source plugin, read before planning. */
export interface TargetCatalogFact {
  pluginId: string;
  releaseId: string;
  version: string;
  /** Permissions this computer would confirm; null when they cannot be computed yet. */
  consent: GhostInstallConsentFacts | null;
}

export interface TargetSettingsFact {
  id: string;
  platforms?: readonly string[];
  /** Values the user already changed on this computer. */
  customized: Record<string, unknown>;
}

export interface SetupPlanInputs {
  planId: string;
  now: number;
  platform: string;
  source: { deviceId: string; name: string };
  snapshot: SetupSnapshot;
  ghosts: TargetGhostFact[];
  /** Keyed by the source plugin's market id. Missing = not offered here. */
  catalog: ReadonlyMap<string, TargetCatalogFact>;
  /** Custom markets already added on this computer, by market name. */
  marketNames: ReadonlySet<string>;
  /** Global skills already installed here, by name, with their on/off state. */
  localSkills: ReadonlyMap<string, { enabled: boolean }>;
  settings: TargetSettingsFact[];
  mcpIds: ReadonlySet<string>;
  providerIds: ReadonlySet<string>;
  /** Effective built-in tool switches here, and whether the user set them. */
  builtinTools: ReadonlyMap<string, { enabled: boolean; userSet: boolean }>;
  access: { remoteControlEnabled: boolean; keepAwake: boolean };
  /** Built-in keys already saved here; those are never replaced. */
  builtinKeys: ReadonlySet<string>;
  /** SSH aliases this computer already has (Cindy's file and the user's own config). */
  sshHostIds: ReadonlySet<string>;
}

export function pluginItemKey(plugin: Pick<SetupSnapshotPlugin, 'ghostId' | 'namespace'>): string {
  return `plugin:${plugin.namespace ?? '_root'}:${plugin.ghostId}`;
}

function findTargetGhost(
  ghosts: TargetGhostFact[],
  plugin: Pick<SetupSnapshotPlugin, 'ghostId' | 'namespace'>,
): TargetGhostFact | undefined {
  const sameId = ghosts.filter((ghost) => ghost.ghostId === plugin.ghostId);
  return (
    sameId.find((ghost) => ghost.namespace !== undefined && (ghost.namespace ?? null) === plugin.namespace) ??
    // A legacy pending install has no confirmed namespace yet; one same-id install is the same plugin.
    (sameId.length === 1 && sameId[0].namespace === undefined ? sameId[0] : undefined)
  );
}

export function buildSetupPlan(input: SetupPlanInputs): SetupMigrationPlan {
  const { snapshot } = input;
  const checklist: SetupMigrationChecklistItem[] = [];
  const addChecklist = (item: SetupMigrationChecklistItem) => {
    if (!checklist.some((existing) => existing.id === item.id)) checklist.push(item);
  };
  const sourceMarkets = new Map(snapshot.marketSources.map((source) => [source.name, source]));

  const plugins: SetupMigrationPluginItem[] = [];
  for (const plugin of snapshot.plugins) {
    const key = pluginItemKey(plugin);
    const local = findTargetGhost(input.ghosts, plugin);
    const base = {
      key,
      ghostId: plugin.ghostId,
      name: plugin.name,
      version: plugin.version,
      namespace: plugin.namespace,
      pluginId: plugin.pluginId,
      source: plugin.source,
      marketName: plugin.marketName,
      enabledOnSource: plugin.enabled,
      consent: null,
    };
    if (local) {
      // Already here: only an on/off difference is worth copying.
      plugins.push({ ...base, state: local.enabled === plugin.enabled ? 'present' : 'ready' });
      continue;
    }
    if (plugin.source === 'builtin') continue;
    if (plugin.source === 'manual') {
      plugins.push({ ...base, state: 'unavailable', reason: 'local-only' });
      addChecklist({ id: `plugin-manual:${key}`, kind: 'plugin-manual', label: plugin.name, ref: plugin.ghostId });
      continue;
    }
    if (plugin.source === 'custom-market') {
      const market = plugin.marketName;
      if (!market || (!input.marketNames.has(market) && !sourceMarkets.has(market))) {
        plugins.push({ ...base, state: 'unavailable', reason: 'source-not-added' });
        addChecklist({ id: `market-source:${market ?? plugin.ghostId}`, kind: 'market-source', label: market ?? plugin.name });
        continue;
      }
      const catalog = plugin.pluginId ? input.catalog.get(plugin.pluginId) : undefined;
      // A market added during apply is read then; its permissions are confirmed one by one.
      plugins.push({ ...base, state: 'ready', consent: catalog?.consent ?? null });
      continue;
    }
    const catalog = plugin.pluginId ? input.catalog.get(plugin.pluginId) : undefined;
    if (!catalog) {
      plugins.push({ ...base, state: 'unavailable', reason: 'not-in-catalog' });
      continue;
    }
    plugins.push({ ...base, state: 'ready', consent: catalog.consent, version: catalog.version });
  }

  const skills: SetupMigrationSkillItem[] = snapshot.skills.map((skill) => {
    const base = {
      key: `skill:${skill.name}`,
      name: skill.name,
      version: skill.version,
      catalogScope: skill.catalogScope,
      enabledOnSource: skill.enabled,
    };
    const local = input.localSkills.get(skill.name);
    // Already here: only an on/off difference is worth copying, as for plugins.
    if (local) return { ...base, state: local.enabled === skill.enabled ? ('present' as const) : ('ready' as const) };
    if (skill.origin !== 'installed' && skill.origin !== 'published') {
      addChecklist({ id: `skill-manual:${skill.name}`, kind: 'skill-manual', label: skill.name, ref: skill.name });
      return { ...base, state: 'unavailable' as const, reason: 'local-only' as const };
    }
    return { ...base, state: 'ready' as const };
  });

  const settings: SetupMigrationSettingsItem[] = [];
  for (const group of snapshot.settings) {
    const target = input.settings.find((candidate) => candidate.id === group.id);
    if (!target) continue;
    if (target.platforms && !target.platforms.includes(input.platform)) continue;
    const { apply, kept } = splitSettingsValues(group.values, target.customized);
    const changeCount = Object.keys(apply).length;
    const keptCount = kept.length;
    settings.push({
      key: `settings:${group.id}`,
      id: group.id,
      changeCount,
      keptCount,
      state: changeCount > 0 ? 'ready' : keptCount > 0 ? 'kept' : 'present',
    });
  }

  let rendererPrefs: SetupMigrationRendererPrefsItem | null = null;
  if (snapshot.rendererPrefs) {
    const values = Object.fromEntries(
      Object.entries(snapshot.rendererPrefs).filter(([key]) => isPortableRendererPrefKey(key)),
    );
    rendererPrefs = {
      key: 'renderer-prefs',
      values,
      state: Object.keys(values).length > 0 ? 'ready' : 'present',
    };
  }

  const providers: SetupMigrationProviderItem[] = snapshot.providers.map((provider) => {
    const key = `provider:${provider.id}`;
    if (input.providerIds.has(provider.id)) return { key, provider, state: 'present' as const };
    if (isLocalProvider(provider)) {
      addChecklist({ id: `local-model:${provider.id}`, kind: 'local-model', label: provider.name, ref: provider.id });
      return { key, provider, state: 'unavailable' as const, reason: 'local-only' as const };
    }
    if (provider.urlSecretsRemoved) {
      addChecklist({ id: `provider-connection:${provider.id}`, kind: 'provider-connection', label: provider.name, ref: provider.id });
    }
    if (provider.auth === 'apiKey') {
      addChecklist({ id: `provider-key:${provider.id}`, kind: 'provider-key', label: provider.name, ref: provider.id });
    } else if (provider.auth === 'oauth' || provider.auth === 'native') {
      addChecklist({ id: `provider-sign-in:${provider.id}`, kind: 'provider-sign-in', label: provider.name, ref: provider.id });
    }
    return { key, provider, state: 'ready' as const };
  });

  const mcpServers: SetupMigrationMcpItem[] = snapshot.mcpServers.map((server) => {
    const key = `mcp:${server.id}`;
    if (input.mcpIds.has(server.id)) return { key, server, state: 'present' as const };
    if (server.hasToken) {
      addChecklist({ id: `mcp-token:${server.id}`, kind: 'mcp-token', label: server.name, ref: server.id });
    }
    return { key, server, state: 'ready' as const };
  });

  const builtinTools: SetupMigrationBuiltinToolItem[] = [];
  for (const tool of snapshot.builtinTools) {
    if (SETUP_LOCAL_PERMISSION_TOOL_IDS.has(tool.id)) {
      if (tool.enabled) {
        addChecklist({
          id: tool.id === 'computer' ? 'computer-use' : `builtin-tool:${tool.id}`,
          kind: 'computer-use',
          label: tool.id,
          ref: tool.id,
        });
      }
      continue;
    }
    const local = input.builtinTools.get(tool.id);
    if (!local) continue;
    const state =
      local.enabled === tool.enabled ? 'present' : local.userSet ? 'kept' : 'ready';
    builtinTools.push({ key: `builtin-tool:${tool.id}`, id: tool.id, enabled: tool.enabled, state });
  }

  const access: SetupMigrationAccessItem[] = [];
  if (snapshot.access.remoteControlEnabled) {
    access.push({
      key: 'access:remote-control',
      id: 'remote-control',
      state: input.access.remoteControlEnabled ? 'present' : 'ready',
    });
  }
  if (snapshot.access.keepAwake) {
    access.push({
      key: 'access:keep-awake',
      id: 'keep-awake',
      state: input.access.keepAwake ? 'present' : 'ready',
    });
  }
  if (snapshot.access.remoteDesktopEnabled) {
    addChecklist({ id: 'remote-desktop', kind: 'remote-desktop', label: '' });
  }

  for (const id of snapshot.hints.builtinKeys) {
    if (input.builtinKeys.has(id)) continue;
    addChecklist({ id: `builtin-key:${id}`, kind: 'builtin-key', label: id, ref: id });
  }
  for (const channel of snapshot.hints.imChannels) {
    addChecklist({ id: `im-channel:${channel}`, kind: 'im-channel', label: channel, ref: channel });
  }

  const transferable = snapshot.transfer >= SETUP_TRANSFER_VERSION;
  const sshHosts: SetupMigrationSshHostItem[] = transferable
    ? snapshot.sshHosts.map((host) => ({
        key: `ssh:${host.id}`,
        id: host.id,
        displayName: host.displayName,
        hostname: host.hostname,
        port: host.port,
        user: host.user,
        state: input.sshHostIds.has(host.id) ? ('present' as const) : ('ready' as const),
      }))
    : [];
  // Older computers only report how many servers they have.
  if (!transferable && snapshot.hints.sshHostCount > 0) {
    addChecklist({ id: 'ssh', kind: 'ssh', label: String(snapshot.hints.sshHostCount) });
  }

  return {
    planId: input.planId,
    source: { ...input.source, platform: snapshot.platform },
    createdAt: input.now,
    plugins,
    skills,
    settings,
    rendererPrefs,
    providers,
    mcpServers,
    builtinTools,
    access,
    secrets: transferable ? secretsItem(input, { plugins, providers, mcpServers }) : null,
    sshHosts,
    checklist,
    unavailable: [...snapshot.unavailable],
  };
}

/**
 * Keys the other computer may copy: API-key connections and MCP with credentials that will be
 * created here, built-in keys this computer lacks, and plugins that had keys set up there. OAuth
 * sign-ins are never listed; they stay on the checklist.
 */
function secretsItem(
  input: SetupPlanInputs,
  items: {
    plugins: SetupMigrationPluginItem[];
    providers: SetupMigrationProviderItem[];
    mcpServers: SetupMigrationMcpItem[];
  },
): SetupMigrationSecretsItem | null {
  const refs: SetupMigrationSecretRef[] = [
    ...items.providers
      .filter((item) => item.state === 'ready' && (item.provider.auth === 'apiKey' || item.provider.urlSecretsRemoved))
      .map((item) => ({ kind: 'provider' as const, ref: item.provider.id, name: item.provider.name })),
    ...items.mcpServers
      .filter((item) => item.state === 'ready' && item.server.hasToken)
      .map((item) => ({ kind: 'mcp' as const, ref: item.server.id, name: item.server.name })),
    ...input.snapshot.hints.builtinKeys
      .filter((id) => SETUP_TRANSFER_BUILTIN_KEY_IDS.includes(id) && !input.builtinKeys.has(id))
      .map((id) => ({ kind: 'builtin' as const, ref: id, name: id })),
    ...items.plugins
      .filter((item) => item.state !== 'unavailable')
      .filter((item) =>
        input.snapshot.plugins.some(
          (plugin) => plugin.ghostId === item.ghostId && plugin.namespace === item.namespace && plugin.setupReady === true,
        ),
      )
      .map((item) => ({ kind: 'plugin' as const, ref: item.key, name: item.name })),
  ];
  return refs.length > 0 ? { key: SETUP_MIGRATION_SECRETS_KEY, state: 'ready', items: refs } : null;
}

/**
 * Values to copy are the other computer's changes that this computer has not changed itself.
 * Values the user already changed here are kept, even when they differ.
 */
export function splitSettingsValues(
  source: Record<string, unknown>,
  targetCustomized: Record<string, unknown>,
): { apply: Record<string, unknown>; kept: string[] } {
  const apply: Record<string, unknown> = {};
  const kept: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(targetCustomized, key)) {
      if (stable(targetCustomized[key]) !== stable(value)) kept.push(key);
      continue;
    }
    apply[key] = value;
  }
  return { apply, kept };
}

export function isLocalProvider(provider: SetupSnapshotProvider): boolean {
  const runtimes = provider.config.runtimes;
  if (!runtimes || typeof runtimes !== 'object') return false;
  return Object.values(runtimes as Record<string, unknown>).some((runtime) => {
    const baseUrl = runtime && typeof runtime === 'object' ? (runtime as { baseUrl?: unknown }).baseUrl : undefined;
    return isLoopbackProviderUrl(baseUrl);
  });
}

function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
