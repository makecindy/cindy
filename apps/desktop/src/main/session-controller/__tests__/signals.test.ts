import { expect, it, vi } from 'vitest';
import { observeSessionSignals, publishSessionSignal, SESSION_CONTROL_CHANGED } from '../signals.js';
it('projects actual host payloads into invalidations without leaking content and retains the source device', () => {
  const emit = vi.fn(); const stop = observeSessionSignals(emit);
  try {
    publishSessionSignal(SESSION_CONTROL_CHANGED, { sessionId: 'task', inputId: 'input', kind: 'input-dispatched', message: 'private' }, 'remote');
    publishSessionSignal('local-db:sessions:patched', { sessionId: 'task', patch: { runtimePending: { generation: 1 } } });
    publishSessionSignal('local-db:sessions:patched', { sessionId: 'task', patch: { runtimePending: null } });
    publishSessionSignal('maker:status-changed', { sessionId: 'task', status: 'running' });
    publishSessionSignal('device-link:status', { deviceId: 'remote' });
    expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(['input-dispatched', 'runtime-intent', 'runtime-applied', 'turn-changed', 'connection-invalidated']);
    expect(emit.mock.calls[0][0]).toMatchObject({ deviceId: 'remote', sessionId: 'task', inputId: 'input' });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private');
  } finally { stop(); }
});
