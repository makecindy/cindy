/** Explicit task scope; src/dst always remain physical device identifiers. */
export const SHARED_TASK_RELAY_CAPABILITY = 'shared-task-v2';
export type SharedTaskEndpoint = { role: 'host' } | { role: 'guest'; memberId: string };
export interface SharedTaskScope {
  sharedTaskId: string;
  target: SharedTaskEndpoint;
  /** Authored by the relay, never trusted from a sending client. */
  source?: SharedTaskEndpoint;
}
export function sharedTaskDeviceId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('Invalid sharedTask device identifier');
  return value;
}
export function sharedTaskIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error('Invalid sharedTask identifier');
  return value;
}
function endpoint(value: unknown): SharedTaskEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sharedTask endpoint');
  const row = value as Record<string, unknown>;
  if (row.role === 'host' && row.memberId === undefined) return { role: 'host' };
  if (row.role === 'guest') return { role: 'guest', memberId: sharedTaskIdentifier(row.memberId) };
  throw new Error('Invalid sharedTask endpoint');
}
/** Request parsing deliberately discards any client-supplied source. */
export function parseSharedTaskScope(value: unknown, withSource = false): SharedTaskScope | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const scope: SharedTaskScope = { sharedTaskId: sharedTaskIdentifier(row.sharedTaskId), target: endpoint(row.target) };
    if (withSource) {
      scope.source = endpoint(row.source);
      if (scope.source.role === scope.target.role) return null;
    }
    return scope;
  } catch { return null; }
}
