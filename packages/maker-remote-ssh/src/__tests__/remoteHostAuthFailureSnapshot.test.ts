/**
 * #4201: connect 认证失败时 snapshot 同时带英文正本 lastError 与结构化
 * authFailure(renderer 据此做五语渲染),二者必须同生同灭——lastError 被
 * 非认证错误替换或连接成功后,authFailure 不得残留成上一次的认证说明。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeClient extends EventEmitter {
  connect(): void {}
  end(): void {
    queueMicrotask(() => this.emit('close'));
  }
}

const h = vi.hoisted(() => ({
  client: null as FakeClient | null,
  outcome: { offeredCount: 0 as number | null, signedCount: 0, signFailureCount: 0 },
  resolveAuth: vi.fn(),
}));

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    h.client = new FakeClient();
    return h.client;
  }),
}));
vi.mock('../credentials.js', () => ({
  resolveAuth: h.resolveAuth,
  defaultAgentEndpoint: vi.fn(() => ''),
}));

import { RemoteHost, formatAuthFailureHint, isAuthFailure } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

const HOST_CONFIG: HostConfig = {
  id: 'auth-host',
  hostname: '10.0.0.9',
  port: 22,
  user: 'deploy',
  authMethod: 'agent',
  source: 'ssh-config',
  managedByCindy: false,
  sshAuthentication: {
    identitiesOnly: true,
    configuredIdentityFiles: ['/srv/keys/id_deploy'],
    identityFileDirectiveSeen: true,
    identityFileNoneSeen: false,
    allowedAgentFingerprints: ['SHA256:test'],
  },
};

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

async function failWith(host: RemoteHost, err: Error): Promise<Error> {
  const p = host.connect().then(
    () => { throw new Error('expected connect to fail'); },
    (e: Error) => e,
  );
  await flush();
  h.client!.emit('error', err);
  return p;
}

describe('RemoteHost snapshot carries a structured auth failure (#4201)', () => {
  h.resolveAuth.mockImplementation(async () => ({
    label: 'ssh-agent[filtered]',
    pinnedIdentityFiles: ['/srv/keys/id_deploy'],
    readAgentAuthOutcome: () => ({ ...h.outcome }),
  }));

  it('sets authFailure together with the English lastError, and clears it with the next non-auth error', async () => {
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });

    h.outcome = { offeredCount: 0, signedCount: 0, signFailureCount: 0 };
    const rejected = await failWith(host, new Error('All configured authentication methods failed'));
    const snap = host.snapshot();
    expect(snap.status).toBe('failed');
    expect(snap.authFailure).toEqual({
      kind: 'agent-not-loaded',
      user: 'deploy',
      hostname: '10.0.0.9',
      identities: ['id_deploy'],
      cause: 'All configured authentication methods failed',
    });
    // 英文正本仍是 lastError / reject message,供日志、isAuthFailure 与 MCP 使用。
    expect(snap.lastError).toBe(formatAuthFailureHint(snap.authFailure!));
    expect(rejected.message).toBe(snap.lastError);
    expect(isAuthFailure(rejected.message)).toBe(true);
    // snapshot 是副本,改它不影响主机内部状态。
    snap.authFailure!.identities.push('tampered');
    expect(host.snapshot().authFailure!.identities).toEqual(['id_deploy']);

    await failWith(host, new Error('connect ETIMEDOUT 10.0.0.9:22'));
    expect(host.snapshot().lastError).toBe('connect ETIMEDOUT 10.0.0.9:22');
    expect(host.snapshot().authFailure).toBeUndefined();
  });

  it('clears authFailure once a later attempt succeeds', async () => {
    const host = new RemoteHost(HOST_CONFIG, { logger: noopLogger });
    h.outcome = { offeredCount: 1, signedCount: 1, signFailureCount: 0 };
    await failWith(host, new Error('All configured authentication methods failed'));
    expect(host.snapshot().authFailure?.kind).toBe('agent-signed-not-accepted');

    const ok = host.connect();
    await flush();
    h.client!.emit('ready');
    await ok;
    expect(host.snapshot().status).toBe('ready');
    expect(host.snapshot().lastError).toBeUndefined();
    expect(host.snapshot().authFailure).toBeUndefined();
  });
});
