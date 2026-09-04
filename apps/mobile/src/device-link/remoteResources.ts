import {
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  resolveRemoteText,
  type RemoteActionInvokeResponse,
  type RemoteCollectionDescriptor,
  type RemoteCollectionItem,
  type RemoteCollectionListResponse,
  type RemoteResourceAvatar,
  type RemoteResourceDisplay,
  type RemoteResourceLink,
  type RemoteResourceClientDescriptor,
  type RemoteResource,
  type RemoteResourceManifestResponse,
  type RemoteResourceRef,
  type RemoteResourceStatus,
  type RemoteText,
} from '@cindy/device-link';

import type { RemoteInvoke } from './mobileMakerTransport';

export const MOBILE_REMOTE_RESOURCE_PRIMITIVES = [
  'status',
  'session-link',
] as const;

export interface RemoteResourceHostTarget {
  deviceId: string;
  deviceName: string;
}

export interface RemoteHomeCollection {
  id: string;
  title: string;
  resourceKind: string;
  placement?: string;
  iconName?: string;
  targets: RemoteResourceHostTarget[];
}

function clientDescriptor(locale?: string): RemoteResourceClientDescriptor {
  return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    primitives: [...MOBILE_REMOTE_RESOURCE_PRIMITIVES],
    ...(locale ? { locale } : {}),
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const MAX_REMOTE_ID_CHARS = 160;
const MAX_REMOTE_TEXT_CHARS = 20_000;
const MAX_REMOTE_TRANSLATIONS = 32;

function boundedString(value: unknown, max: number, allowEmpty = false): string | null {
  return typeof value === 'string'
    && value.length <= max
    && (allowEmpty || value.length > 0)
    ? value
    : null;
}

function normalizeRemoteText(value: unknown, max = MAX_REMOTE_TEXT_CHARS): RemoteText | null {
  const direct = boundedString(value, max);
  if (direct) return direct;
  const record = recordOf(value);
  const fallback = boundedString(record?.fallback, max);
  if (!record || !fallback) return null;
  const translationsRecord = recordOf(record.translations);
  if (!translationsRecord) return { fallback };
  const translations: Record<string, string> = {};
  for (const [locale, text] of Object.entries(translationsRecord)) {
    if (Object.keys(translations).length >= MAX_REMOTE_TRANSLATIONS) break;
    const normalizedLocale = boundedString(locale, 64);
    const normalizedText = boundedString(text, max);
    if (normalizedLocale && normalizedText) translations[normalizedLocale] = normalizedText;
  }
  return Object.keys(translations).length > 0 ? { fallback, translations } : { fallback };
}

function normalizeRemoteRef(value: unknown): RemoteResourceRef | null {
  const record = recordOf(value);
  const collectionId = boundedString(record?.collectionId, MAX_REMOTE_ID_CHARS);
  const kind = boundedString(record?.kind, MAX_REMOTE_ID_CHARS);
  const id = boundedString(record?.id, MAX_REMOTE_ID_CHARS);
  return collectionId && kind && id ? { collectionId, kind, id } : null;
}

function normalizeRemoteStatus(value: unknown): RemoteResourceStatus | null {
  const record = recordOf(value);
  const label = normalizeRemoteText(record?.label, 512);
  if (!record || !label) return null;
  const tone = boundedString(record.tone, 64);
  return { label, ...(tone ? { tone } : {}) };
}

function normalizeRemoteAvatar(value: unknown): RemoteResourceAvatar | null {
  const record = recordOf(value);
  const kind = boundedString(record?.kind, 64);
  const avatarValue = boundedString(record?.value, 4_096, true);
  const fallbackText = boundedString(record?.fallbackText, 64, true);
  if (!record || !kind || avatarValue === null || fallbackText === null) return null;
  const color = boundedString(record.color, 64);
  return {
    kind,
    value: avatarValue,
    fallbackText,
    ...(color ? { color } : {}),
  };
}

function normalizeRemoteTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number.isFinite(new Date(value).getTime()) ? value : undefined;
}

function normalizeRemoteDisplay(value: unknown): RemoteResourceDisplay | null {
  const record = recordOf(value);
  const title = normalizeRemoteText(record?.title, 512);
  if (!record || !title) return null;
  const subtitle = normalizeRemoteText(record.subtitle, 4_096);
  const preview = normalizeRemoteText(record.preview, 4_096);
  const timestamp = normalizeRemoteTimestamp(record.timestamp);
  const avatar = normalizeRemoteAvatar(record.avatar);
  const status = normalizeRemoteStatus(record.status);
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(preview ? { preview } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(avatar ? { avatar } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeRemoteLink(value: unknown): RemoteResourceLink | null {
  const record = recordOf(value);
  const rel = boundedString(record?.rel, MAX_REMOTE_ID_CHARS);
  const target = recordOf(record?.target);
  if (!record || !rel || !target) return null;
  let normalizedTarget: RemoteResourceLink['target'] | null = null;
  if (target.kind === 'session') {
    const sessionId = boundedString(target.sessionId, MAX_REMOTE_ID_CHARS);
    if (sessionId) normalizedTarget = { kind: 'session', sessionId };
  } else if (target.kind === 'resource') {
    const ref = normalizeRemoteRef(target.ref);
    if (ref) normalizedTarget = { kind: 'resource', ref };
  }
  if (!normalizedTarget) return null;
  const label = normalizeRemoteText(record.label, 512);
  return { rel, target: normalizedTarget, ...(label ? { label } : {}) };
}

function validDescriptor(value: unknown): RemoteCollectionDescriptor | null {
  const record = recordOf(value);
  if (!record) return null;
  const id = boundedString(record.id, MAX_REMOTE_ID_CHARS);
  const resourceKind = boundedString(record.resourceKind, MAX_REMOTE_ID_CHARS);
  const title = normalizeRemoteText(record.title, 512);
  if (!id || !resourceKind || !title) return null;
  const placement = boundedString(record.placement, MAX_REMOTE_ID_CHARS);
  const iconRecord = recordOf(record.icon);
  const iconName = boundedString(iconRecord?.name, MAX_REMOTE_ID_CHARS);
  const iconFallbackText = boundedString(iconRecord?.fallbackText, 64, true);
  return {
    id,
    resourceKind,
    title,
    ...(placement ? { placement } : {}),
    ...(iconName && iconFallbackText !== null
      ? { icon: { name: iconName, fallbackText: iconFallbackText } }
      : {}),
  };
}

function normalizeManifest(value: unknown): RemoteResourceManifestResponse | null {
  const record = recordOf(value);
  if (!record || !Array.isArray(record.collections)) return null;
  const collections = record.collections.flatMap((item) => {
    const descriptor = validDescriptor(item);
    return descriptor ? [descriptor] : [];
  });
  const protocolVersion = typeof record.protocolVersion === 'number'
    ? record.protocolVersion
    : REMOTE_RESOURCE_PROTOCOL_VERSION;
  return { protocolVersion, collections };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return '';
}

export function isRemoteResourcesUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'CHANNEL_NOT_ALLOWED' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('CHANNEL_NOT_ALLOWED');
}

export async function loadRemoteResourceManifest(
  invoke: RemoteInvoke,
  target: RemoteResourceHostTarget,
  locale?: string,
): Promise<RemoteResourceManifestResponse | null> {
  try {
    const raw = await invoke(target.deviceId, REMOTE_RESOURCE_MANIFEST_CHANNEL, [{
      client: clientDescriptor(locale),
    }]);
    return normalizeManifest(raw);
  } catch (error) {
    if (isRemoteResourcesUnsupported(error)) return null;
    throw error;
  }
}

/**
 * Merge the same host-advertised collection across computers. The mobile shell
 * only understands placement and portable display primitives, not module ids.
 */
export async function discoverRemoteHomeCollections(
  invoke: RemoteInvoke,
  targets: readonly RemoteResourceHostTarget[],
  locale?: string,
  previous: readonly RemoteHomeCollection[] = [],
): Promise<RemoteHomeCollection[]> {
  const settled = await Promise.allSettled(targets.map(async (target) => ({
    target,
    manifest: await loadRemoteResourceManifest(invoke, target, locale),
  })));
  const discovered = settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value.manifest ? [result.value] : [];
    }
    const target = targets[index];
    if (!target) return [];
    return previous.flatMap((collection) => collection.targets.some(
      (candidate) => candidate.deviceId === target.deviceId,
    ) ? [{
      target,
      manifest: {
        protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
        collections: [{
          id: collection.id,
          resourceKind: collection.resourceKind,
          title: collection.title,
          ...(collection.placement ? { placement: collection.placement } : {}),
          ...(collection.iconName
            ? { icon: { name: collection.iconName, fallbackText: '' } }
            : {}),
        }],
      },
    }] : []);
  });
  if (targets.length > 0 && discovered.length === 0) {
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure && failure.status === 'rejected') throw failure.reason;
  }
  const byId = new Map<string, RemoteHomeCollection>();
  for (const { target, manifest } of discovered) {
    for (const collection of manifest?.collections ?? []) {
      if (collection.placement !== 'home-scope') continue;
      const existing = byId.get(collection.id);
      if (existing && existing.resourceKind === collection.resourceKind) {
        existing.targets.push(target);
        continue;
      }
      if (existing) continue;
      byId.set(collection.id, {
        id: collection.id,
        title: resolveRemoteText(collection.title, locale),
        resourceKind: collection.resourceKind,
        placement: collection.placement,
        iconName: collection.icon?.name,
        targets: [target],
      });
    }
  }
  return [...byId.values()];
}

export async function invokeRemoteResourceAction(
  invoke: RemoteInvoke,
  target: RemoteResourceHostTarget,
  request: {
    collectionId: string;
    actionId: string;
    resourceRef?: RemoteResourceRef;
    input?: Record<string, unknown>;
  },
  locale?: string,
): Promise<RemoteActionInvokeResponse> {
  return invoke<RemoteActionInvokeResponse>(target.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: clientDescriptor(locale),
    ...request,
  }]);
}

export async function getRemoteResource(
  invoke: RemoteInvoke,
  target: RemoteResourceHostTarget,
  ref: RemoteResourceRef,
  locale?: string,
): Promise<RemoteResource> {
  const raw = await invoke<unknown>(target.deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
    client: clientDescriptor(locale),
    ref,
  }]);
  const normalized = normalizeRemoteCollectionItem(raw, ref.collectionId);
  if (!normalized || normalized.ref.kind !== ref.kind || normalized.ref.id !== ref.id) {
    throw new Error('invalid remote resource response');
  }
  return normalized;
}

function normalizeRemoteCollectionItem(
  candidate: unknown,
  collectionId: string,
): RemoteCollectionItem | null {
  const item = recordOf(candidate);
  const ref = normalizeRemoteRef(item?.ref);
  const display = normalizeRemoteDisplay(item?.display);
  const revision = boundedString(item?.revision, 1_024);
  if (!item || !ref || ref.collectionId !== collectionId || !display || !revision) return null;
  const links = Array.isArray(item.links)
    ? item.links.slice(0, 64).flatMap((link) => {
        const normalized = normalizeRemoteLink(link);
        return normalized ? [normalized] : [];
      })
    : [];
  return { ref, display, links, revision };
}

export function normalizeRemoteCollectionItems(
  value: unknown,
  collectionId: string,
): RemoteCollectionItem[] {
  const record = recordOf(value);
  if (!record || !Array.isArray(record.items)) return [];
  return record.items.slice(0, 200).flatMap((candidate) => {
    const item = normalizeRemoteCollectionItem(candidate, collectionId);
    return item ? [item] : [];
  });
}

export interface HostedRemoteCollectionItem {
  key: string;
  host: RemoteResourceHostTarget;
  item: RemoteCollectionItem;
}

/** Replace successful host shards while retaining stale rows for transiently failed hosts. */
export function mergeRemoteCollectionHostShards(
  current: readonly HostedRemoteCollectionItem[],
  next: readonly HostedRemoteCollectionItem[],
  successfulDeviceIds: ReadonlySet<string>,
  targets: readonly RemoteResourceHostTarget[],
): HostedRemoteCollectionItem[] {
  const sourceFor = (deviceId: string) => (successfulDeviceIds.has(deviceId) ? next : current)
    .filter((entry) => entry.host.deviceId === deviceId);
  return targets.flatMap((target) => sourceFor(target.deviceId));
}

export async function listRemoteCollection(
  invoke: RemoteInvoke,
  target: RemoteResourceHostTarget,
  collectionId: string,
  locale?: string,
): Promise<RemoteCollectionListResponse> {
  return invoke<RemoteCollectionListResponse>(target.deviceId, REMOTE_RESOURCE_LIST_CHANNEL, [{
    client: clientDescriptor(locale),
    collectionId,
    limit: 200,
  }]);
}

const MAX_TARGETS = 32;
const MAX_TARGET_FIELD_CHARS = 256;

export function serializeRemoteResourceTargets(
  targets: readonly RemoteResourceHostTarget[],
): string {
  return JSON.stringify(targets.slice(0, MAX_TARGETS).map((target) => ({
    deviceId: target.deviceId.slice(0, MAX_TARGET_FIELD_CHARS),
    deviceName: target.deviceName.slice(0, MAX_TARGET_FIELD_CHARS),
  })));
}

export function parseRemoteResourceTargets(value: unknown): RemoteResourceHostTarget[] {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length > 32_000) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_TARGETS).flatMap((item) => {
      const record = recordOf(item);
      if (!record) return [];
      const deviceId = typeof record.deviceId === 'string' ? record.deviceId : '';
      const deviceName = typeof record.deviceName === 'string' ? record.deviceName : '';
      if (
        !deviceId
        || deviceId.length > MAX_TARGET_FIELD_CHARS
        || deviceName.length > MAX_TARGET_FIELD_CHARS
      ) {
        return [];
      }
      return [{ deviceId, deviceName: deviceName || deviceId }];
    });
  } catch {
    return [];
  }
}
