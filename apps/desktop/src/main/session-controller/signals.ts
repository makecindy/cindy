/** Invalidation observers only. Existing broadcasts remain the event source;
 * this fanout owns no snapshots, delivery log or recovery timer. */
import type { SessionControllerEvent } from '@cindy/maker-shared/session-controller';
export const SESSION_CONTROL_CHANGED = 'maker:session-control:changed';
export interface SessionSignal { deviceId?: string; channel: string; sessionId?: string; kind: SessionControllerEvent['kind']; inputId?: string }
const observers = new Set<(event: SessionSignal) => void>();
export function observeSessionSignals(observer: (event: SessionSignal) => void): () => void {
  observers.add(observer); return () => { observers.delete(observer); };
}
export function publishSessionSignal(channel: string, payload: unknown, deviceId?: string): void {
  if (!observers.size || (!channel.startsWith('maker:') && !channel.startsWith('local-db:') && !channel.startsWith('device-link:'))) return;
  const row = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : undefined;
  // Never expose raw payloads, messages or paths to a subscriber before policy
  // revalidation. A signal causes an authorized read of the owning host instead.
  const kind: SessionControllerEvent['kind'] = channel === SESSION_CONTROL_CHANGED &&
    ['input-accepted', 'input-dispatched', 'input-withdrawn'].includes(String(row?.kind))
      ? row!.kind as SessionControllerEvent['kind']
      : channel.startsWith('device-link:') ? 'connection-invalidated'
      : channel.includes('interaction') ? 'interaction-changed'
      : channel === 'maker:event' || channel === 'maker:status-changed' ? 'turn-changed'
      : channel.startsWith('local-db:sessions:') && row?.patch && typeof row.patch === 'object'
        && ('runtimePending' in row.patch || 'agentSwitchIntent' in row.patch)
        ? ((row.patch as Record<string, unknown>).runtimePending || (row.patch as Record<string, unknown>).agentSwitchIntent ? 'runtime-intent' : 'runtime-applied')
      : channel.startsWith('local-db:sessions:') ? 'record-changed' : 'snapshot-resync';
  const event = { channel, sessionId, kind,
    ...(channel === SESSION_CONTROL_CHANGED && typeof row?.inputId === 'string' ? { inputId: row.inputId } : {}),
    deviceId: deviceId ?? (channel.startsWith('device-link:') && typeof row?.deviceId === 'string' ? row.deviceId : undefined) };
  for (const observer of observers) {
    try { observer(event); } catch { /* An observer cannot break the original broadcast. */ }
  }
}
