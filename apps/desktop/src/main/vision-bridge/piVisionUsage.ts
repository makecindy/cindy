import { createAuxiliaryUsageRecorder } from '../usage/auxiliaryUsage.js';
import { parseAuxiliaryTokens } from '../../shared/auxiliaryUsage.js';
import { PI_VISION_BRIDGE_ENV, type PiVisionBridgeEnvPayload } from './piVisionBridgeEnvCore.js';

/** Private Pi notifications carry facts; routing and owner come from the spawn snapshot. */
export function createPiVisionUsageRecorder(env: Record<string, string>, sessionId?: string) {
  let config: PiVisionBridgeEnvPayload = { enabled: false, primary: null, fallback: null };
  try { config = JSON.parse(env[PI_VISION_BRIDGE_ENV]) ?? config; }
  catch { /* Invalid legacy config already disables the Pi vision tools. */ }
  const record = createAuxiliaryUsageRecorder({ source: 'vision-bridge', sessionId });
  const pending = new Set<Promise<void>>();
  let closed = false;
  return {
    async observe(payload: unknown): Promise<void> {
      if (closed || !payload || typeof payload !== 'object') return;
      const value = payload as Record<string, unknown>;
      if (typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)) return;
      const backend = value.backendRole === 'primary' ? config.primary
        : value.backendRole === 'fallback' ? config.fallback : null;
      if (!backend?.providerId || !backend.model) return;
      const tokens = parseAuxiliaryTokens({ usage: value.usage }, backend.wireProtocol);
      if (!tokens) return;
      const model = typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 1024
        ? value.model : backend.model;
      const write = record(tokens, { providerId: backend.providerId, model, transport: backend.wireProtocol },
        `pi-vision:${value.requestId}`);
      pending.add(write);
      try { await write; } finally { pending.delete(write); }
    },
    close(): void {
      if (closed) return;
      closed = true;
      // Keep the original owner alive until already-observed receipts have settled.
      void Promise.allSettled([...pending]).then(() => record.close());
    },
  };
}
