/** Same-account, read-only model discovery from the task computer's perspective. */
export const CONTROLLED_MODEL_CATALOG_CHANNEL = 'maker:model-catalog:read';
export const CONTROLLED_MODEL_CATALOG_CHANGED = 'maker:model-catalog:changed';
export function isModelCatalogSourceChange(channel: string): boolean {
  return channel === 'maker:provider:changed' || channel === 'maker:agents:changed';
}
export const MODEL_CATALOG_READ_CHANNELS = [
  'maker:provider:list',
  'maker:get-capabilities',
  'maker:list-available-agents',
  'maker:agent:status',
] as const;

export interface ControlledModelLocation {
  agentDeviceId: string;
  name: string;
  /** Favorite identity only; not a credential or an execution authorization. */
  favoriteSource?: ControlledModelFavoriteSource;
}

export interface ControlledModelFavoriteSource {
  shareId: string;
  memberId: string;
  providerId: string;
  owner: { region: 'cn' | 'global' };
}

export function readControlledFavoriteSource(value: unknown, deviceId: string): ControlledModelFavoriteSource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as ControlledModelFavoriteSource;
  if (![source.shareId, source.memberId, source.providerId].every(part => typeof part === 'string' && part.length > 0)
    || deviceId !== `share:${source.shareId}` || !['cn', 'global'].includes(source.owner?.region)) return undefined;
  return { shareId: source.shareId, memberId: source.memberId, providerId: source.providerId, owner: { region: source.owner.region } };
}

// Renderer cache identity only. Never persist this as an Agent/device location.
const PREFIX = 'model-catalog:';
export function modelCatalogKey(deviceId: string | undefined, taskDeviceId?: string): string | undefined {
  if (!deviceId || !taskDeviceId || deviceId === taskDeviceId) return deviceId;
  return PREFIX + JSON.stringify([taskDeviceId, deviceId]);
}

export function parseModelCatalogKey(key: string): { taskDeviceId: string; agentDeviceId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(key.slice(PREFIX.length));
    if (Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'string' && v.length > 0)) {
      return { taskDeviceId: value[0], agentDeviceId: value[1] };
    }
  } catch { /* Not a catalog cache key. */ }
  return null;
}
