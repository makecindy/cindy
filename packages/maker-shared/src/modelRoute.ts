const ACP_PLUGIN_PROVIDER_PREFIX = 'acp-plugin:';

function isPluginEngineProviderId(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(ACP_PLUGIN_PROVIDER_PREFIX)) return false;
  const key = value.slice(ACP_PLUGIN_PROVIDER_PREFIX.length);
  const separator = key.lastIndexOf(':');
  return separator > 0 && separator < key.length - 1 && !/\s/.test(key);
}

/** Persisted model selection shared by settings, defaults and companion chains.
 * Missing location is the task's own computer; a share uses the ordinary share:<id> location.
 * No credentials or provider metadata belong in this record.
 */
export interface ModelRoute {
  harness: 'claude' | 'codex' | 'pi' | 'antigravity';
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean | 'ultrafast';
  agentDeviceId?: string | null;
  /**
   * A model group (route id in model-groups.json on the computer that runs this route)
   * picks the concrete source at run time. The other fields stay a usable route: older
   * peers drop this field and run them, as does a computer without that group.
   */
  modelGroup?: string;
}

export type CompanionModelRoute = ModelRoute | (Omit<ModelRoute, 'harness'> & { harness: 'acp' });

const MODEL_GROUP_ID_MAX = 64;

function modelGroupId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MODEL_GROUP_ID_MAX ? id : null;
}

export function normalizeModelRoute(value: unknown): ModelRoute | null {
  const route = normalizeCompanionModelRoute(value);
  return route?.harness === 'acp' ? null : route;
}

export function normalizeCompanionModelRoute(value: unknown): CompanionModelRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let record = value as Record<string, unknown>;
  if (typeof record.providerId === 'string' && record.providerId.startsWith(REMOTE_SOURCE_PREFIX)) {
    try {
      const source: unknown = JSON.parse(record.providerId.slice(REMOTE_SOURCE_PREFIX.length));
      if (!Array.isArray(source) || source.length !== 2 || typeof source[0] !== 'string'
        || (source[1] !== null && typeof source[1] !== 'string')
        || (record.agentDeviceId != null && record.agentDeviceId !== source[0])) return null;
      record = { ...record, agentDeviceId: source[0], providerId: source[1] };
    } catch { return null; }
  }
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  if (record.agentDeviceId != null && (typeof record.agentDeviceId !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,128}$/.test(record.agentDeviceId))) return null;
  if (record.harness === 'antigravity' && (record.providerId !== 'google-antigravity-subscription' || record.agentDeviceId)) return null;
  const providerId = typeof record.providerId === 'string' && record.providerId.trim() ? record.providerId.trim() : null;
  const agentDeviceId = typeof record.agentDeviceId === 'string' ? record.agentDeviceId.trim() : undefined;
  const modelGroup = modelGroupId(record.modelGroup);
  if (record.harness === 'acp') {
    if (!isPluginEngineProviderId(providerId) || agentDeviceId) return null;
    return {
      harness: 'acp',
      model: record.model.trim(),
      providerId,
      effort: typeof record.effort === 'string' ? record.effort : '',
      fastMode: false,
      ...(agentDeviceId ? { agentDeviceId } : {}),
      ...(modelGroup ? { modelGroup } : {}),
    };
  }
  if (providerId?.startsWith(ACP_PLUGIN_PROVIDER_PREFIX)) return null;
  return {
    harness: record.harness === 'codex' || record.harness === 'pi' || record.harness === 'antigravity' ? record.harness : 'claude',
    model: record.model.trim(),
    providerId,
    effort: typeof record.effort === 'string' ? record.effort : '',
    fastMode: (record.fastMode === 'ultrafast' ? 'ultrafast' : record.fastMode === true),
    ...(agentDeviceId ? { agentDeviceId } : {}),
    ...(modelGroup ? { modelGroup } : {}),
  };
}

export function modelRouteLocationKey(agentDeviceId: string | null | undefined): string {
  return agentDeviceId ? `\u0000${agentDeviceId}` : '';
}

// Older peers discard unknown route fields. Encode the location into the source on
// remote forms so they fail closed instead of spending a local account with the same ID.
const REMOTE_SOURCE_PREFIX = 'model-route:';
export function serializeModelRoutes(routes: readonly CompanionModelRoute[]): string {
  return JSON.stringify(routes.map(route => route.agentDeviceId
    ? { ...route, providerId: REMOTE_SOURCE_PREFIX + JSON.stringify([route.agentDeviceId, route.providerId]) }
    : route));
}
