import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessClaudeProxy } from './claude-proxy.js';
import { HeadlessCodexProxy } from './codex-proxy.js';
import { HeadlessConfigStore } from './config.js';
import { HeadlessProviderRouter } from './provider-router.js';
import { MemorySecretStore } from './secret-store.js';
import { HeadlessSessionStorage } from './session-storage.js';
import type { HeadlessCindyAccountService } from './cindy-account.js';

const dirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

function upstream(): Promise<{ url: string; received: Array<{ url?: string; headers: http.IncomingHttpHeaders }> }> {
  const received: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((request, response) => {
    received.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${address.port}/v1`, received });
  }));
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-provider-proxy-'));
  dirs.push(dir);
  const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
  const secrets = new MemorySecretStore();
  return { storage, config, secrets, router: new HeadlessProviderRouter(storage, config, secrets) };
}

describe('headless loopback provider proxies', () => {
  it('forwards a Claude session only to its configured custom upstream with an injected key', async () => {
    const target = await upstream();
    const { storage, config, secrets, router } = await fixture();
    const base = await config.read();
    await config.write({
      ...base,
      providerProfiles: [{
        id: 'custom-claude', enabled: true, secretRef: 'custom_claude',
        custom: { id: 'custom-claude', name: 'Custom Claude', runtimes: {
          'claude-code': { baseUrl: target.url, models: [{ id: 'company-claude', name: 'Company Claude' }] },
        } },
      }],
    });
    await secrets.set('custom_claude', 'test-claude-key');
    await storage.create({ id: 'claude-session', agentKind: 'claude-code', providerId: 'custom-claude', workDir: '', title: 'Test', model: 'company-claude' });
    router.registerClaudeSdkSession('claude-session', 'sdk-session');
    const proxy = new HeadlessClaudeProxy(router);
    const endpoint = await proxy.start();

    const response = await fetch(`${endpoint}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sdk-session', 'x-api-key': 'placeholder' },
      body: JSON.stringify({ model: 'company-claude', messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]).toMatchObject({ url: '/v1/messages', headers: {
      'x-api-key': 'test-claude-key', authorization: 'Bearer test-claude-key',
    } });
    await proxy.stop();
    storage.close();
  });

  it('forwards a Codex session only to its configured Responses upstream with an injected key', async () => {
    const target = await upstream();
    const { storage, config, secrets, router } = await fixture();
    const base = await config.read();
    await config.write({
      ...base,
      providerProfiles: [{
        id: 'custom-codex', enabled: true, secretRef: 'custom_codex',
        custom: { id: 'custom-codex', name: 'Custom Codex', runtimes: {
          codex: { baseUrl: target.url, models: [{ id: 'company-code', name: 'Company Code' }] },
        } },
      }],
    });
    await secrets.set('custom_codex', 'test-codex-key');
    await storage.create({ id: 'codex-session', agentKind: 'codex', providerId: 'custom-codex', workDir: '', title: 'Test', model: 'company-code' });
    router.registerCodexThread('codex-session', 'thread-session');
    const proxy = new HeadlessCodexProxy(router);
    const endpoint = await proxy.start();

    const response = await fetch(`${endpoint}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'thread-id': 'thread-session', authorization: 'Bearer placeholder' },
      body: JSON.stringify({ model: 'company-code', input: [] }),
    });
    expect(response.status).toBe(200);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]).toMatchObject({ url: '/v1/responses', headers: { authorization: 'Bearer test-codex-key' } });
    await proxy.stop();
    storage.close();
  });

  it('routes a Cindy-account gateway session without any Codex or Claude OAuth state', async () => {
    const target = await upstream();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-cindy-proxy-'));
    dirs.push(dir);
    const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const account = {
      // Model-access returns the gateway root; Codex needs the /v1 Responses base.
      getGatewayKey: () => 'cindy-gateway-key', getGatewayEndpoint: () => new URL(target.url).origin,
    } as unknown as HeadlessCindyAccountService;
    const router = new HeadlessProviderRouter(storage, config, new MemorySecretStore(), process.env, account);
    await storage.create({ id: 'cindy-session', agentKind: 'codex', providerId: 'xd', workDir: '', title: 'Test', model: 'cindy-gpt' });
    router.registerCodexThread('cindy-session', 'cindy-thread');
    const proxy = new HeadlessCodexProxy(router);
    const endpoint = await proxy.start();

    const response = await fetch(`${endpoint}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'thread-id': 'cindy-thread' },
      body: JSON.stringify({ model: 'cindy-gpt', input: [] }),
    });
    expect(response.status).toBe(200);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]).toMatchObject({ url: '/v1/responses', headers: {
      authorization: 'Bearer cindy-gateway-key', 'x-api-key': 'cindy-gateway-key',
    } });
    await proxy.stop();
    storage.close();
  });
});
