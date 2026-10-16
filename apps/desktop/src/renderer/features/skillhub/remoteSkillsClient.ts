import {
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
} from '@cindy/device-link';
import { boundedPluginResponse } from '@/features/plugin/remotePluginManagementClient';
import type { RemoteSkillItem, RemoteSkillsSnapshot } from '../../../shared/remoteSkills';
import { isRemoteSkillMarketItem } from '../../../shared/remoteSkills';

const client = { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [] };
export async function remoteSkillsCapabilities(deviceId: string) {
  const manifest = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_MANIFEST_CHANNEL,
    [{ client }],
  )) as { collections?: Array<{ id: string; actions?: Array<{ id: string }> }> };
  if (!boundedPluginResponse(manifest)) throw new Error('INVALID_RESPONSE');
  const skills = manifest?.collections?.find((collection) => collection.id === 'skills');
  return {
    management: skills?.actions?.some((a) => a.id === 'management:snapshot') === true,
    catalog: skills?.actions?.some((a) => a.id === 'management:catalog') === true,
  };
}
export async function invokeRemoteSkills(
  deviceId: string,
  action: string,
  input?: Record<string, unknown>,
  item?: RemoteSkillItem,
) {
  const response = (await window.electronAPI.deviceLink.invoke(
    deviceId,
    REMOTE_RESOURCE_INVOKE_CHANNEL,
    [
      {
        client,
        collectionId: 'skills',
        actionId: `management:${action}`,
        ...(item ? { resourceRef: { collectionId: 'skills', kind: 'skill', id: item.id } } : {}),
        input: { ...input, ...(item ? { expectedRevision: item.revision } : {}) },
      },
    ],
  )) as { result?: unknown };
  if (!boundedPluginResponse(response)) throw new Error('INVALID_RESPONSE');
  return response?.result;
}
export function parseRemoteSkills(value: unknown): RemoteSkillsSnapshot {
  const snapshot = value as RemoteSkillsSnapshot | null;
  if (
    !boundedPluginResponse(value) ||
    snapshot?.version !== 1 ||
    !Array.isArray(snapshot.items) ||
    !Array.isArray(snapshot.market) ||
    typeof snapshot.marketUnavailable !== 'boolean' ||
    (snapshot.nextCursor !== null && typeof snapshot.nextCursor !== 'string') ||
    !snapshot.items.every(
      (i) =>
        typeof i.id === 'string' &&
        typeof i.revision === 'string' &&
        typeof i.name === 'string' &&
        typeof i.description === 'string' &&
        ['skill', 'command', 'agent'].includes(i.kind) &&
        ['global', 'project', 'user'].includes(i.scope) &&
        typeof i.enabled === 'boolean' &&
        typeof i.canUninstall === 'boolean' &&
        typeof i.managedByPlugin === 'boolean' &&
        typeof i.builtIn === 'boolean' &&
        (i.projectId === undefined || typeof i.projectId === 'string') &&
        (i.entryFile === undefined ||
          (typeof i.entryFile === 'string' &&
            !/[\\/]/.test(i.entryFile) &&
            !['.', '..'].includes(i.entryFile))) &&
        Array.isArray(i.engines) &&
        i.engines.every((e) => typeof e === 'string') &&
        (i.market === undefined ||
          (typeof i.market.name === 'string' &&
            (i.market.origin === undefined ||
              ['installed', 'published', 'learned', 'imported'].includes(i.market.origin)) &&
            (i.market.authorId === undefined ||
              (typeof i.market.authorId === 'string' && i.market.authorId.length <= 256)) &&
            (i.market.catalogScope === undefined ||
              ['market', 'team'].includes(i.market.catalogScope)))),
    ) ||
    !snapshot.market.every(isRemoteSkillMarketItem) ||
    (snapshot.projects !== undefined &&
      (!Array.isArray(snapshot.projects) ||
        !snapshot.projects.every(
          (project) =>
            project &&
            typeof project.id === 'string' &&
            typeof project.revision === 'string' &&
            typeof project.name === 'string',
        )))
  )
    throw new Error('INVALID_RESPONSE');
  // Older Hosts can report Claude's native `user` scope for a global Skill.
  return {
    ...snapshot,
    items: snapshot.items.map((item) =>
      (item as { scope: string }).scope === 'user' ? { ...item, scope: 'global' as const } : item,
    ),
  };
}
