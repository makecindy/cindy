import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessConfigStore } from './config.js';
import { HeadlessProviderRouter } from './provider-router.js';
import { MemorySecretStore } from './secret-store.js';
import { HeadlessSessionStorage } from './session-storage.js';

const dirs: string[] = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-router-'));
  dirs.push(dir);
  const storage = new HeadlessSessionStorage(path.join(dir, 'sessions.db'));
  const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
  const secrets = new MemorySecretStore();
  return { storage, config, secrets };
}

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('HeadlessProviderRouter', () => {
  it('binds a custom Claude request to its session provider without reading a global API key', async () => {
    const { storage, config, secrets } = fixture();
    const base = await config.read();
    await config.write({
      ...base,
      providerProfiles: [{
        id: 'company-anthropic', enabled: true, secretRef: 'company_anthropic_key',
        custom: {
          id: 'company-anthropic', name: 'Company Anthropic',
          runtimes: {
            'claude-code': {
              baseUrl: 'https://models.example.test/anthropic',
              headers: { 'x-company-region': 'test' },
              models: [{ id: 'company-claude-1', name: 'Company Claude 1' }],
            },
          },
        },
      }],
    });
    await secrets.set('company_anthropic_key', 'test-company-key');
    await storage.create({
      id: 'session-1', agentKind: 'claude-code', providerId: 'company-anthropic',
      workDir: '', title: 'Test', model: 'company-claude-1',
    });
    const router = new HeadlessProviderRouter(storage, config, secrets, { CINDY_ANTHROPIC_API_KEY: 'must-not-be-used' });
    router.registerClaudeSdkSession('session-1', 'sdk-1');

    await expect(router.routeClaudeRequest('sdk-1')).resolves.toEqual({
      upstreamOverride: 'https://models.example.test/anthropic',
      headerOverride: {
        'x-company-region': 'test',
        'x-api-key': 'test-company-key',
        authorization: 'Bearer test-company-key',
      },
    });
    expect(router.proxyAuthEnv()).toEqual({ ANTHROPIC_API_KEY: 'cindy-headless-proxy-placeholder' });
    storage.close();
  });

  it('uses the daemon-owned system credential only for an unselected/default Claude provider', async () => {
    const { storage, config, secrets } = fixture();
    await storage.create({
      id: 'session-2', agentKind: 'claude-code', workDir: '', title: 'Test', model: 'claude-sonnet-5',
    });
    const router = new HeadlessProviderRouter(storage, config, secrets, { CINDY_ANTHROPIC_API_KEY: 'system-key' });
    router.registerClaudeSdkSession('session-2', 'sdk-2');

    await expect(router.routeClaudeRequest('sdk-2')).resolves.toEqual({
      upstreamOverride: 'https://api.anthropic.com',
      headerOverride: { 'x-api-key': 'system-key', authorization: 'Bearer system-key' },
    });
    storage.close();
  });

  it('routes a custom Codex Responses request using its thread-to-session binding', async () => {
    const { storage, config, secrets } = fixture();
    const base = await config.read();
    await config.write({
      ...base,
      providerProfiles: [{
        id: 'company-responses', enabled: true, secretRef: 'company_responses_key',
        custom: {
          id: 'company-responses', name: 'Company Responses',
          runtimes: {
            codex: {
              baseUrl: 'https://responses.example.test/v1',
              headers: { 'x-tenant': 'engineering' },
              models: [{ id: 'company-code-2', name: 'Company Code 2' }],
            },
          },
        },
      }],
    });
    await secrets.set('company_responses_key', 'test-responses-key');
    await storage.create({
      id: 'session-3', agentKind: 'codex', providerId: 'company-responses',
      workDir: '', title: 'Test', model: 'company-code-2',
    });
    const router = new HeadlessProviderRouter(storage, config, secrets);
    router.registerCodexThread('session-3', 'thread-3');

    await expect(router.routeCodexRequest('thread-3')).resolves.toEqual({
      upstreamOverride: 'https://responses.example.test/v1',
      headerOverride: { 'x-tenant': 'engineering', authorization: 'Bearer test-responses-key' },
    });
    storage.close();
  });

  it('adds the OpenAI-compatible /v1 base for Cindy gateway Codex requests only', async () => {
    const { storage, config, secrets } = fixture();
    const account = {
      getGatewayKey: () => 'cindy-gateway-key',
      getGatewayEndpoint: () => 'https://gateway.example.test/',
    } as never;
    const router = new HeadlessProviderRouter(storage, config, secrets, process.env, account);
    await storage.create({ id: 'codex-session', agentKind: 'codex', providerId: 'xd', workDir: '', title: 'Test', model: 'cindy-gpt' });
    await storage.create({ id: 'claude-session', agentKind: 'claude-code', providerId: 'xd', workDir: '', title: 'Test', model: 'cindy-claude' });
    router.registerCodexThread('codex-session', 'codex-thread');
    router.registerClaudeSdkSession('claude-session', 'claude-sdk-session');

    await expect(router.routeCodexRequest('codex-thread')).resolves.toMatchObject({
      upstreamOverride: 'https://gateway.example.test/v1',
      headerOverride: { authorization: 'Bearer cindy-gateway-key', 'x-api-key': 'cindy-gateway-key' },
    });
    await expect(router.routeClaudeRequest('claude-sdk-session')).resolves.toMatchObject({
      upstreamOverride: 'https://gateway.example.test/',
      headerOverride: { authorization: 'Bearer cindy-gateway-key', 'x-api-key': 'cindy-gateway-key' },
    });
    storage.close();
  });
});
