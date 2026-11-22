/**
 * After `cindy-host login`: let Device Link register this Host again.
 *
 * A device removed from the account in Device Link registers again only with a token from an explicit sign-in made after
 * the removal (the server reads the token's sign-in methods and time; refreshed tokens carry neither). `serve` always
 * starts from a refreshed token, so a removed Host could never come back, on Device Link nor on Agent-Net (which accepts
 * only devices in the Device Link list). The login command holds the freshly signed-in token in memory: it says hello once
 * with it and closes. The token is not stored or logged; a failure only means the Host stays removed, as before.
 */
import os from 'node:os';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@cindy/device-link';
import { createHostWebSocketAgent } from '../outbound.mjs';

const REGISTRATION_TIMEOUT_MS = 10_000;

/**
 * @param {{ apiBaseUrl: string, token: string, version: string, timeoutMs?: number,
 *   createWebSocket?: (url: string, headers: Record<string, string>) => Promise<WebSocket> }} options
 * @returns {Promise<'registered' | 'removed' | 'failed'>} `removed`: the server still refused it (not a fresh sign-in).
 */
export async function restoreDeviceLinkRegistration(options) {
  const url = options.apiBaseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/api/device-link/ws';
  const headers = { Authorization: `Bearer ${options.token}` };
  let socket;
  try {
    socket = options.createWebSocket
      ? await options.createWebSocket(url, headers)
      : new WebSocket(url, { headers, agent: await createHostWebSocketAgent(url) });
  } catch { return 'failed'; }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(1000); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish('failed'), options.timeoutMs ?? REGISTRATION_TIMEOUT_MS);
    timer.unref?.();
    socket.once('open', () => {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
        platform: process.platform, deviceName: process.env.CINDY_HOST_DEVICE_NAME?.trim() || `${os.hostname()} · Cindy Host`,
        appVersion: options.version, remoteControlEnabled: false, busy: false, capabilities: [],
      } }));
    });
    socket.on('message', (raw) => {
      try { if (JSON.parse(String(raw))?.kind === 'hello-ack') finish('registered'); } catch { /* not a frame */ }
    });
    socket.once('close', (code) => finish(code === 4410 ? 'removed' : 'failed'));
    socket.once('error', () => finish('failed'));
  });
}
