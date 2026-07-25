import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadlessCindyAccountService } from './cindy-account.js';
import { HeadlessConfigStore } from './config.js';
import { MemorySecretStore, type HeadlessSecretStore } from './secret-store.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HeadlessCindyAccountService', () => {
  it('restores a Cindy login after daemon restart from the OS-secret-store refresh token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-'));
    dirs.push(dir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({ ...(await config.read()), account: { deviceId: 'linux-device', region: 'cn' }, managedModels: [{ id: 'old-model' }] });
    const secrets = new MemorySecretStore();
    await secrets.set('cindy_account_refresh', 'persisted-refresh-token');
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('endpoint.json')) return response({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.test', modelAccessApiBaseUrl: 'https://models.example.test' });
      if (target.endsWith('/api/auth/refresh')) return response({ accessToken: 'restored-access-token', refreshToken: 'rotated-refresh-token', membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null } });
      if (target.endsWith('/api/me')) return response({ membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null }, passportId: 'passport-1', identities: [] });
      if (target.endsWith('/api/model-access/credentials')) return response({ endpoint: 'https://gateway.example.test/v1', apiKey: 'gateway-key' });
      if (target.endsWith('/api/model-access/models')) return response({ models: [{ id: 'restored-model', agents: ['codex'] }] });
      throw new Error(`Unexpected request ${target}`);
    }) as unknown as typeof fetch;
    const subject = new HeadlessCindyAccountService(config, fetchImpl, secrets);

    await expect(subject.restore()).resolves.toMatchObject({ authenticated: true, membership: { id: 'member-1' } });
    expect(subject.getGatewayKey()).toBe('gateway-key');
    await expect(secrets.get('cindy_account_refresh')).resolves.toBe('rotated-refresh-token');
    await expect(config.read()).resolves.toMatchObject({ managedModels: [{ id: 'restored-model' }] });
  });

  it('does not expose a Device Link route when an old account config has no saved credential', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-'));
    dirs.push(dir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    await config.write({ ...(await config.read()), account: { deviceId: 'linux-device', region: 'cn' } });
    const fetchImpl = vi.fn(async () => response({
      schemaVersion: 1,
      authApiBaseUrl: 'https://auth.example.test',
      modelAccessApiBaseUrl: 'https://models.example.test',
      deviceLinkApiBaseUrl: 'https://relay.example.test',
    })) as unknown as typeof fetch;
    const subject = new HeadlessCindyAccountService(config, fetchImpl, new MemorySecretStore());

    await expect(subject.restore()).resolves.toMatchObject({
      authenticated: false,
      error: expect.stringContaining('saved refresh credential'),
    });
    expect(subject.getDeviceLinkApiBase()).toBeNull();
    await expect(subject.getRelayToken()).resolves.toBeNull();
  });

  it('persists a just-completed login only in the secret store, never in config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-'));
    dirs.push(dir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('endpoint.json')) return response({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.test', modelAccessApiBaseUrl: 'https://models.example.test' });
      if (target.endsWith('/api/me')) return response({ membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null }, passportId: 'passport-1', identities: [] });
      if (target.endsWith('/api/model-access/credentials')) return response({ endpoint: 'https://gateway.example.test/v1', apiKey: 'gateway-key' });
      if (target.endsWith('/api/model-access/models')) return response({ models: [{ id: 'cindy-gpt', agents: ['codex'] }] });
      throw new Error(`Unexpected request ${target}`);
    }) as unknown as typeof fetch;
    const secrets = new MemorySecretStore();
    const subject = new HeadlessCindyAccountService(config, fetchImpl, secrets);

    await expect(subject.activateLogin({ region: 'cn', deviceId: 'linux-device', accessToken: 'access-token', refreshToken: 'refresh-token' }))
      .resolves.toMatchObject({ authenticated: true, membership: { id: 'member-1' } });
    expect(subject.getGatewayKey()).toBe('gateway-key');
    const persisted = JSON.stringify(await config.read());
    expect(persisted).not.toContain('access-token');
    expect(persisted).not.toContain('refresh-token');
    expect(persisted).not.toContain('gateway-key');
    await expect(secrets.get('cindy_account_refresh')).resolves.toBe('refresh-token');
    await expect(config.read()).resolves.toMatchObject({
      providerProfiles: [expect.objectContaining({ id: 'xd', enabled: true })],
    });
  });

  it('rotates an expiring token in the secret store', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-'));
    dirs.push(dir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const expiredJwt = 'header.eyJleHAiOjB9.signature';
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('endpoint.json')) return response({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.test', modelAccessApiBaseUrl: 'https://models.example.test', deviceLinkApiBaseUrl: 'https://relay.example.test' });
      if (target.endsWith('/api/me')) return response({ membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null }, passportId: 'passport-1', identities: [] });
      if (target.endsWith('/api/model-access/credentials')) return response({ endpoint: 'https://gateway.example.test/v1', apiKey: 'gateway-key' });
      if (target.endsWith('/api/model-access/models')) return response({ models: [{ id: 'cindy-gpt', agents: ['codex'] }] });
      if (target.endsWith('/api/auth/refresh')) return response({ accessToken: 'refreshed-access-token', refreshToken: 'rotated-refresh-token', membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null } });
      throw new Error(`Unexpected request ${target}`);
    }) as unknown as typeof fetch;
    const secrets = new MemorySecretStore();
    const subject = new HeadlessCindyAccountService(config, fetchImpl, secrets);

    await subject.activateLogin({ region: 'cn', deviceId: 'linux-device', accessToken: expiredJwt, refreshToken: 'initial-refresh-token' });
    await expect(subject.getRelayToken()).resolves.toBe('refreshed-access-token');
    expect(JSON.stringify(await config.read())).not.toContain('rotated-refresh-token');
    await expect(secrets.get('cindy_account_refresh')).resolves.toBe('rotated-refresh-token');
  });

  it('keeps a secure-storage-unavailable login in daemon memory without claiming it is durable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-account-'));
    dirs.push(dir);
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const unavailable: HeadlessSecretStore = {
      get: async () => null,
      set: async () => { throw new Error('Secret Service is unavailable'); },
      delete: async () => undefined,
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('endpoint.json')) return response({ schemaVersion: 1, authApiBaseUrl: 'https://auth.example.test', modelAccessApiBaseUrl: 'https://models.example.test' });
      if (target.endsWith('/api/me')) return response({ membership: { id: 'member-1', kind: 'personal', role: 'owner', displayName: 'Ada', email: null, orgId: null, orgName: null }, passportId: 'passport-1', identities: [] });
      if (target.endsWith('/api/model-access/credentials')) return response({ endpoint: 'https://gateway.example.test/v1', apiKey: 'gateway-key' });
      if (target.endsWith('/api/model-access/models')) return response({ models: [{ id: 'cindy-gpt', agents: ['codex'] }] });
      throw new Error(`Unexpected request ${target}`);
    }) as unknown as typeof fetch;
    const subject = new HeadlessCindyAccountService(config, fetchImpl, unavailable);

    await expect(subject.activateLogin({ region: 'cn', deviceId: 'linux-device', accessToken: 'access-token', refreshToken: 'refresh-token' }))
      .resolves.toMatchObject({ authenticated: true, persistent: false, membership: { id: 'member-1' } });
    expect(subject.getGatewayKey()).toBe('gateway-key');
    expect((await config.read()).account).toBeUndefined();
    expect(JSON.stringify(await config.read())).not.toContain('refresh-token');
  });
});
