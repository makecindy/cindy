import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  resolveRemoteText,
  type RemoteCollectionItem,
  type RemoteResource,
  type RemoteText,
  type RemoteActionInvokeResponse,
} from '@cindy/device-link';
import { validateNormalizedGhostManifest } from '../../../shared/ghost';
import type {
  PluginManagementReceipt,
  PluginManagementSnapshot,
  PluginManagementProjectState,
  PluginManagementProject,
} from '../../../shared/pluginManagement';
import type { PluginMarketDetail } from '../../../shared/pluginMarket';
import type { RemotePluginPreferenceSnapshot } from '../../../shared/pluginPreferences';

const pluginManagementClient = {
  protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
  primitives: ['status', 'markdown', 'action', 'form', 'list'],
};
/** Bound foreign Host declarations before any UI/manifest traversal. */
export function boundedPluginResponse(
  value: unknown,
  depth = 0,
  budget = { nodes: 50_000, chars: 8_000_000 },
): boolean {
  if (--budget.nodes < 0 || depth > 24) return false;
  if (typeof value === 'string') return (budget.chars -= value.length) >= 0;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(
    ([key, child]) =>
      !['__proto__', 'constructor', 'prototype'].includes(key) &&
      boundedPluginResponse(child, depth + 1, budget),
  );
}
export async function hasPluginManagement(deviceId: string): Promise<boolean> {
  const manifest = await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_MANIFEST_CHANNEL,
    [{ client: pluginManagementClient }],
  );
  if (!boundedPluginResponse(manifest)) return false;
  return !!(
    manifest as { collections?: Array<{ id: string; actions?: Array<{ id: string }> }> }
  ).collections?.some(
    (c) => c.id === 'plugins' && c.actions?.some((a) => a.id === 'management:snapshot'),
  );
}
export async function invokePluginManagement(
  deviceId: string,
  action: string,
  input: Record<string, unknown> = {},
  instance?: string,
): Promise<unknown> {
  const response = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_INVOKE_CHANNEL,
    [
      {
        client: pluginManagementClient,
        collectionId: 'plugins',
        actionId: `management:${action}`,
        input,
        ...(instance
          ? { resourceRef: { collectionId: 'plugins', kind: 'plugin', id: instance } }
          : {}),
      },
    ],
  )) as RemoteActionInvokeResponse;
  if (!boundedPluginResponse(response)) throw new Error('INVALID_RESPONSE');
  return response.result;
}
export function parsePluginManagementSnapshot(value: unknown): PluginManagementSnapshot {
  const data = value as PluginManagementSnapshot;
  if (
    !boundedPluginResponse(value) ||
    data?.version !== 1 ||
    !Array.isArray(data.ghosts) ||
    !Array.isArray(data.market?.items) ||
    !Array.isArray(data.market.customSourceNames) ||
    !Array.isArray(data.market.unavailableCustomSourceNames) ||
    (data.projects !== undefined &&
      (!Array.isArray(data.projects) ||
        !data.projects.every(
          (project) =>
            isPluginManagementProject(project),
        ) ||
        new Set(data.projects.map((project) => project.id)).size !== data.projects.length)) ||
    (data.projectBrowse !== undefined && data.projectBrowse !== true) ||
    (data.localShares !== undefined && data.localShares !== true) ||
    (data.uiCapabilityApproval !== undefined && data.uiCapabilityApproval !== true) ||
    !data.ghosts.every(
      (g) =>
        typeof g.instanceKey === 'string' &&
        typeof g.enabled === 'boolean' &&
        !!g.approval &&
        validateNormalizedGhostManifest(g.manifest).ok,
    ) ||
    !data.market.items.every(
      (i) =>
        typeof i.pluginId === 'string' &&
        typeof i.ghostId === 'string' &&
        typeof i.releaseId === 'string' &&
        typeof i.name === 'string',
    )
  )
    throw new Error('INVALID_RESPONSE');
  // Target-local icon keys cannot be resolved against this computer's market.
  return {
    ...data,
    market: {
      ...data.market,
      items: data.market.items.map((item) => {
        const safe = { ...item };
        delete safe.customIconKey;
        return safe;
      }),
    },
  };
}
function isPluginManagementProject(project: PluginManagementProject): boolean {
  return !!project && typeof project.id === 'string' && project.id.length > 0 &&
    project.id.length <= 256 && typeof project.name === 'string' &&
    (project.path === undefined || (typeof project.path === 'string' &&
      project.path.length > 0 && project.path.length <= 32768 && !project.path.includes('\0')));
}
export function parsePluginManagementProject(value: unknown): PluginManagementProject {
  if (!boundedPluginResponse(value) || !isPluginManagementProject(value as PluginManagementProject))
    throw new Error('INVALID_RESPONSE');
  return value as PluginManagementProject;
}
export function parsePluginManagementProjectState(
  value: unknown,
  projectId: string,
): PluginManagementProjectState {
  const state = value as PluginManagementProjectState;
  if (
    !boundedPluginResponse(value) ||
    state?.projectId !== projectId ||
    typeof state.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.revision) ||
    !Array.isArray(state.disabled) ||
    !state.disabled.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
  )
    throw new Error('INVALID_RESPONSE');
  return state;
}

export function parseRemotePluginPreferences(value: unknown): RemotePluginPreferenceSnapshot {
  const data = value as RemotePluginPreferenceSnapshot;
  if (
    !boundedPluginResponse(value) ||
    typeof data?.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision) ||
    (data.sidebarVisible !== undefined && typeof data.sidebarVisible !== 'boolean') ||
    (data.auxiliaryModelLabel !== undefined &&
      data.auxiliaryModelLabel !== null &&
      typeof data.auxiliaryModelLabel !== 'string')
  )
    throw new Error('INVALID_RESPONSE');
  if (
    data.tasks &&
    (typeof data.tasks.revision !== 'string' ||
      !data.tasks.config ||
      typeof data.tasks.config !== 'object' ||
      Array.isArray(data.tasks.config) ||
      !Array.isArray(data.tasks.permissionModes) ||
      !data.tasks.permissionModes.every((mode) => typeof mode === 'string') ||
      typeof data.tasks.defaultPermissionMode !== 'string')
  )
    throw new Error('INVALID_RESPONSE');
  return data;
}
export function parsePluginManagementDetail(value: unknown): PluginMarketDetail {
  const detail = value as PluginMarketDetail;
  if (
    !boundedPluginResponse(value) ||
    typeof detail?.pluginId !== 'string' ||
    !validateNormalizedGhostManifest(detail.manifest).ok
  )
    throw new Error('INVALID_RESPONSE');
  const safe = { ...detail };
  delete safe.customIconKey;
  return safe;
}
export function parsePluginManagementReceipt(
  value: unknown,
  operationId: string,
): PluginManagementReceipt {
  if (!boundedPluginResponse(value)) throw new Error('INVALID_RESPONSE');
  const receipt = value as PluginManagementReceipt;
  const permissions = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.every(
      (item) => item && typeof item.key === 'string' && typeof item.labelKey === 'string',
    );
  const facts = receipt?.consent?.facts;
  const validFacts =
    !facts ||
    (typeof facts.name === 'string' &&
      typeof facts.version === 'string' &&
      (facts.kind === 'install'
        ? permissions(facts.permissions)
        : facts.kind === 'update' &&
          permissions(facts.added) &&
          permissions(facts.removed) &&
          Number.isSafeInteger(facts.unchangedCount)));
  if (
    !validFacts ||
    receipt?.operationId !== operationId ||
    !['running', 'confirmation', 'succeeded', 'cancelled', 'failed'].includes(receipt.phase) ||
    (receipt.phase === 'confirmation' &&
      (!receipt.consent?.requestId ||
        !receipt.consent.facts ||
        !['install', 'update'].includes(receipt.consent.facts.kind)))
  )
    throw new Error('INVALID_RESPONSE');
  return receipt;
}

export interface LegacyManagedPlugin {
  id: string;
  name: string;
  description: string;
  iconDataUrl?: string;
  enabled?: boolean;
}
export interface LegacyManagedPluginDetail extends LegacyManagedPlugin {
  version?: string;
  tools?: Array<{ name: string; description: string }>;
  permissions?: Array<{ title: string; description: string }>;
  details?: Array<{ key: string; title: string; value: string }>;
}
function remotePluginText(value: unknown, locale?: string): string | undefined {
  if (typeof value === 'string') return value;
  const text = value as Exclude<RemoteText, string> | undefined;
  if (!text || typeof text.fallback !== 'string') return undefined;
  return text.translations &&
    Object.values(text.translations).every((entry) => typeof entry === 'string')
    ? resolveRemoteText(text, locale)
    : text.fallback;
}
function legacyPluginItem(item: RemoteCollectionItem, locale?: string): LegacyManagedPlugin | null {
  const name = remotePluginText(item?.display?.title, locale);
  if (
    item?.ref?.collectionId !== 'plugins' ||
    item.ref.kind !== 'plugin' ||
    typeof item.ref.id !== 'string' ||
    typeof item.revision !== 'string' ||
    name === undefined
  )
    return null;
  const status = remotePluginText(item.display.status?.label, locale);
  const actions = Array.isArray(item.actions) ? item.actions : [];
  const enabled = actions.some((action) => action?.id === 'disable')
    ? true
    : actions.some((action) => action?.id === 'enable')
      ? false
      : status === 'enabled'
        ? true
        : status === 'disabled'
          ? false
          : undefined;
  const icon = item.display.avatar;
  return {
    id: item.ref.id,
    name,
    description: remotePluginText(item.display.subtitle, locale) ?? '',
    ...(enabled !== undefined ? { enabled } : {}),
    ...(icon?.kind === 'asset' &&
    /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(icon.value)
      ? { iconDataUrl: icon.value }
      : {}),
  };
}
export async function readLegacyManagedPlugins(
  deviceId: string,
  locale?: string,
): Promise<LegacyManagedPlugin[]> {
  const response = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_LIST_CHANNEL,
    [{ collectionId: 'plugins', client: { ...pluginManagementClient, locale } }],
  )) as { items?: RemoteCollectionItem[] };
  if (!boundedPluginResponse(response) || !Array.isArray(response?.items))
    throw new Error('INVALID_RESPONSE');
  return response.items.flatMap((item) => {
    const plugin = legacyPluginItem(item, locale);
    return plugin ? [plugin] : [];
  });
}
async function readManagedPluginResource(
  deviceId: string,
  id: string,
  locale?: string,
): Promise<RemoteResource & { blocks: NonNullable<RemoteResource['blocks']> }> {
  const response = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_GET_CHANNEL,
    [
      {
        ref: { collectionId: 'plugins', kind: 'plugin', id },
        client: {
          ...pluginManagementClient,
          locale,
          primitives: [...pluginManagementClient.primitives, 'plugin-capabilities'],
        },
      },
    ],
  )) as RemoteResource;
  if (
    !boundedPluginResponse(response) ||
    response?.ref?.collectionId !== 'plugins' ||
    response.ref.kind !== 'plugin' ||
    response?.ref?.id !== id ||
    !Array.isArray(response.blocks)
  )
    throw new Error('INVALID_RESPONSE');
  return { ...response, blocks: response.blocks };
}
export async function readLegacyManagedPlugin(
  deviceId: string,
  id: string,
  locale?: string,
): Promise<LegacyManagedPluginDetail> {
  const response = await readManagedPluginResource(deviceId, id, locale);
  const plugin = legacyPluginItem(response, locale);
  if (!plugin) throw new Error('INVALID_RESPONSE');
  const capabilities = response.blocks.find(
    (block) => block?.id === 'capabilities' && block.primitive === 'plugin-capabilities',
  )?.data as Partial<LegacyManagedPluginDetail> | undefined;
  const description = response.blocks.find((block) => block?.id === 'about')?.fallbackMarkdown;
  const version = response.blocks.find((block) => block?.id === 'version')?.fallbackMarkdown;
  const tools = capabilities?.tools;
  const permissions = capabilities?.permissions;
  const details = capabilities?.details;
  return {
    ...plugin,
    description: typeof description === 'string' ? description : plugin.description,
    ...(typeof version === 'string' && version ? { version } : {}),
    ...(Array.isArray(tools) &&
    tools.every(
      (tool) =>
        tool &&
        typeof tool.name === 'string' &&
        (tool.description === undefined || typeof tool.description === 'string'),
    )
      ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })) }
      : {}),
    ...(Array.isArray(permissions) &&
    permissions.every(
      (permission) =>
        permission &&
        typeof permission.title === 'string' &&
        typeof permission.description === 'string',
    )
      ? { permissions: permissions.map(({ title, description }) => ({ title, description })) }
      : {}),
    ...(Array.isArray(details) &&
    details.every(
      (fact) =>
        fact &&
        typeof fact.key === 'string' &&
        typeof fact.title === 'string' &&
        typeof fact.value === 'string',
    )
      ? { details: details.map(({ key, title, value }) => ({ key, title, value })) }
      : {}),
  };
}
