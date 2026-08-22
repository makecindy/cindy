import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

class FakeClient extends EventEmitter {
  connectConfig: {
    host?: string;
    port?: number;
    hostVerifier?: (key: Buffer, verify: (valid: boolean) => void) => void;
  } | null = null;
  ended = false;

  connect(config: FakeClient['connectConfig']): void {
    this.connectConfig = config;
  }

  end(): void {
    // Deliberately do not emit close. Real ssh2 may deliver it later, after a
    // refreshed endpoint has already connected.
    this.ended = true;
  }
}

const h = vi.hoisted(() => ({ clients: [] as FakeClient[] }));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const client = new FakeClient();
    h.clients.push(client);
    return client;
  }),
}));
vi.mock('../credentials.js', () => ({
  resolveAuth: vi.fn(async () => ({ label: 'agent' })),
  defaultAgentEndpoint: vi.fn(() => ''),
  pinnedPublicKeyCandidates: vi.fn(() => []),
}));

import { RemoteHost } from '../RemoteHost.js';
import { hostKeyFingerprint, type HostKeyStore } from '../hostKeys.js';
import type { HostConfig } from '../types.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const initialConfig: HostConfig = {
  id: 'ssh-config:ci.example',
  alias: 'ci.example',
  hostname: '192.0.2.7',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'ssh-config',
};

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function verify(client: FakeClient, key: Buffer): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    client.connectConfig?.hostVerifier?.(key, resolve);
  });
}

describe('RemoteHost connection generation', () => {
  it('ignores stale client events and keeps TOFU scoped to the attempt config', async () => {
    h.clients.length = 0;
    const trusted = new Map<string, string>();
    const hostKeys: HostKeyStore = {
      reload: () => undefined,
      get: async (key) => trusted.get(key) ?? null,
      set: async (key, fingerprint) => { trusted.set(key, fingerprint); },
    };
    const host = new RemoteHost(initialConfig, { logger, hostKeys });

    const firstConnect = host.connect();
    await tick();
    const oldClient = h.clients[0]!;
    expect(await verify(oldClient, Buffer.from('old-host-key'))).toBe(true);
    oldClient.emit('ready');
    await firstConnect;

    await host.disconnect();
    host.updateConfig({ ...initialConfig, hostname: '192.0.2.8' });
    const secondConnect = host.connect();
    await tick();
    const newClient = h.clients[1]!;
    expect(await verify(newClient, Buffer.from('new-host-key'))).toBe(true);
    newClient.emit('ready');
    await secondConnect;

    oldClient.emit('handshake');
    oldClient.emit('error', new Error('late old endpoint error'));
    oldClient.emit('close');

    expect(host.getStatus()).toBe('ready');
    expect(host.config.hostname).toBe('192.0.2.8');
    expect(trusted.get('192.0.2.7:22')).toBe(hostKeyFingerprint(Buffer.from('old-host-key')));
    expect(trusted.get('192.0.2.8:22')).toBe(hostKeyFingerprint(Buffer.from('new-host-key')));
  });
});
