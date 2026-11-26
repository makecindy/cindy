import WebSocket from 'ws';
import { createOutboundHttpAgent } from '../maker-host/outbound-fetch.desktop.js';
import type { RealtimeConnection } from './realtimeModels.js';

export async function connectRealtimeSocket(
  binding: RealtimeConnection,
  assertCurrent: () => void,
) {
  const agent = await createOutboundHttpAgent(binding.url);
  assertCurrent();
  return new WebSocket(binding.url, {
    agent,
    headers: binding.headers,
    followRedirects: false,
    maxPayload: 2 * 1024 * 1024,
    handshakeTimeout: 15_000,
  });
}
