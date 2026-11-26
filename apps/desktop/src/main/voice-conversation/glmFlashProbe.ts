import type WebSocket from 'ws';
import { GLM_API_BASE, GLM_REALTIME_FLASH } from '../../shared/glmRealtimeDiscovery.js';
import { modelSourceRequestSignature } from '../maker-host/model-source-snapshots.js';
import { realtimeSocketUrl, RealtimeProtocolAdapter } from './realtimeProtocol.js';
import { connectRealtimeSocket } from './realtimeSocket.js';

export type GlmFlashAccess = 'available' | 'unavailable' | 'unknown';

const socketUrl = realtimeSocketUrl(new URL(GLM_API_BASE), GLM_REALTIME_FLASH, 'glm-realtime');

export function probeGlmFlash(
  headers: Record<string, string>, current: () => boolean, connect = connectRealtimeSocket,
): Promise<GlmFlashAccess> {
  const adapter = new RealtimeProtocolAdapter('glm-realtime');
  return new Promise(resolve => {
    let socket: WebSocket | undefined;
    let finished = false;
    let sent = false;
    const assertCurrent = () => {
      if (finished || !current()) throw new Error('expired model discovery');
    };
    const finish = (status: GlmFlashAccess) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket?.terminate();
      resolve(status);
    };
    const timeout = setTimeout(() => finish('unknown'), 3_000);
    void connect({ url: socketUrl, headers, protocol: 'glm-realtime' }, assertCurrent).then(ws => {
      socket = ws;
      ws.on('error', () => finish('unknown'));
      ws.once('close', () => finish('unknown'));
      ws.once('unexpected-response', (_request, response) => {
        const denied = response.statusCode === 401 || response.statusCode === 403;
        response.destroy();
        finish(denied ? 'unavailable' : 'unknown');
      });
      if (finished || !current()) {
        if (finished) ws.terminate();
        else finish('unknown');
        return;
      }
      ws.once('open', () => {
        try {
          assertCurrent();
          ws.send(adapter.encode(adapter.start({ kind: 'preview', model: GLM_REALTIME_FLASH, voice: 'tongtong' })));
          sent = true;
        } catch { finish('unknown'); }
      });
      ws.on('message', raw => {
        try {
          assertCurrent();
          const event = adapter.decode(raw.toString());
          if (!sent) return;
          if (event.type === 'session.updated')
            finish(event.session?.model === GLM_REALTIME_FLASH ? 'available' : 'unknown');
          else if (event.type === 'error') {
            const code = String(event.error?.code ?? '');
            finish(['1211', 'model_not_found', 'model_not_available', 'permission_denied'].includes(code)
              ? 'unavailable' : 'unknown');
          }
        } catch { finish('unknown'); }
      });
    }).catch(() => finish('unknown'));
  });
}

// One Settings refresh can enumerate several runtimes sequentially. Share its
// result only within that gesture, owner, connection and effective WS credentials.
export function createGlmFlashProbeBatch(probe = probeGlmFlash) {
  const batches = new Map<string, { result: Promise<GlmFlashAccess>; current: () => boolean; expires: number }>();
  return (headers: Record<string, string>, current: () => boolean, batch?: string) => {
    if (!batch) return probe(headers, current);
    const now = Date.now();
    for (const [id, entry] of batches)
      if (entry.expires <= now || !entry.current()) batches.delete(id);
    const id = JSON.stringify([batch, modelSourceRequestSignature(socketUrl, { headers })]);
    const existing = batches.get(id);
    if (existing) return existing.result;
    const result = probe(headers, current);
    const entry = { result, current, expires: now + 120_000 };
    batches.set(id, entry);
    setTimeout(() => {
      if (batches.get(id) === entry) batches.delete(id);
    }, 120_000).unref();
    if (batches.size > 32) batches.delete(batches.keys().next().value!);
    return result;
  };
}
