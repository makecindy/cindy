/** Persisted model selection shared by settings, defaults and companion chains.
 * Missing location is the task's own computer; a share uses the ordinary share:<id> location.
 * No credentials or provider metadata belong in this record.
 */
export interface ModelRoute {
  harness: 'claude' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort: string;
  fastMode: boolean | 'ultrafast';
  agentDeviceId?: string | null;
}

export function normalizeModelRoute(value: unknown): ModelRoute | null {
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
  return {
    harness: record.harness === 'codex' || record.harness === 'pi' ? record.harness : 'claude',
    model: record.model.trim(),
    providerId: typeof record.providerId === 'string' && record.providerId.trim() ? record.providerId.trim() : null,
    effort: typeof record.effort === 'string' ? record.effort : '',
    fastMode: (record.fastMode === 'ultrafast' ? 'ultrafast' : record.fastMode === true),
    ...(typeof record.agentDeviceId === 'string' ? { agentDeviceId: record.agentDeviceId.trim() } : {}),
  };
}

export function modelRouteLocationKey(agentDeviceId: string | null | undefined): string {
  return agentDeviceId ? `\u0000${agentDeviceId}` : '';
}

// Older peers discard unknown route fields. Encode the location into the source on
// remote forms so they fail closed instead of spending a local account with the same ID.
const REMOTE_SOURCE_PREFIX = 'model-route:';
export function serializeModelRoutes(routes: readonly ModelRoute[]): string {
  return JSON.stringify(routes.map(route => route.agentDeviceId
    ? { ...route, providerId: REMOTE_SOURCE_PREFIX + JSON.stringify([route.agentDeviceId, route.providerId]) }
    : route));
}
