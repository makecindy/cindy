import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadXaiModelsFromDiskCache,
  parseXaiAccountModels,
  refreshXaiModelsFromHttp,
  resetXaiDiscoveryForTest,
  waitForXaiDiscoveryIdleForTest,
  XAI_ACCOUNT_MODELS_URL,
  XAI_ACCOUNT_USER_URL,
  XAI_GROK_CLIENT_VERSION,
} from '../model-discovery/xai.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const tempDirs: string[] = [];

afterEach(async () => {
  resetXaiDiscoveryForTest();
  await waitForXaiDiscoveryIdleForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('xAI account model discovery', () => {
  it('normalizes membership without inventing missing capabilities', () => {
    expect(
      parseXaiAccountModels({
        data: [
          {
            model: 'grok-4.5',
            name: 'Grok 4.5',
            contextWindow: 500_000,
            maxCompletionTokens: 64_000,
            reasoningEfforts: ['low', { value: 'high', default: true }],
          },
          { modelId: 'grok-4.6', supportedInApi: false },
          { model: 'hidden-model', hidden: true },
          { model: 'grok-4.5' },
        ],
      }),
    ).toEqual([
      {
        id: 'xai/grok-4.5',
        name: 'Grok 4.5',
        contextWindow: 500_000,
        contextWindowVerified: true,
        maxOutput: 64_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
      { id: 'xai/grok-4.6' },
    ]);
  });

  it('persists a successful empty table and reloads it as an authoritative LKG', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-xai-models-'));
    tempDirs.push(dir);
    const cacheFile = path.join(dir, 'xai-models.json');
    const applySnapshot = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer token-a');
      expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli');
      expect(headers.get('x-grok-client-version')).toBe(XAI_GROK_CLIENT_VERSION);
      if (String(input) === XAI_ACCOUNT_USER_URL) return jsonResponse({ userId: 'user-a' });
      expect(String(input)).toBe(XAI_ACCOUNT_MODELS_URL);
      expect(headers.get('x-userid')).toBe('user-a');
      return jsonResponse({ data: [] });
    });
    const deps = {
      fetchImpl: fetchImpl as typeof fetch,
      getAccessToken: async () => 'token-a',
      peekAccessToken: () => 'token-a',
      hasLogin: () => true,
      getConnectionSource: () => 'explicit-provider-oauth' as const,
      getScopeKey: () => 'owner-a:1',
      cacheFilePath: () => cacheFile,
      applySnapshot,
      invalidateAuth: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };

    await expect(refreshXaiModelsFromHttp(deps)).resolves.toBe(true);
    expect(applySnapshot).toHaveBeenLastCalledWith([]);
    applySnapshot.mockClear();
    await expect(loadXaiModelsFromDiskCache(deps)).resolves.toBe(true);
    expect(applySnapshot).toHaveBeenCalledWith([]);
  });

  it('keeps the current snapshot on temporary failure and never applies late account results', async () => {
    const applySnapshot = vi.fn();
    await expect(
      refreshXaiModelsFromHttp({
        fetchImpl: (async () => {
          throw new Error('offline');
        }) as typeof fetch,
        getAccessToken: async () => 'token-a',
        peekAccessToken: () => 'token-a',
        hasLogin: () => true,
        getConnectionSource: () => 'explicit-provider-oauth' as const,
        getScopeKey: () => 'owner-a:1',
        cacheFilePath: () => '/unused',
        applySnapshot,
        invalidateAuth: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toBe(false);
    expect(applySnapshot).not.toHaveBeenCalled();

    let scope = 'owner-a:1';
    await expect(
      refreshXaiModelsFromHttp({
        fetchImpl: (async (input: RequestInfo | URL) => {
          if (String(input) === XAI_ACCOUNT_USER_URL) return jsonResponse({ userId: 'user-a' });
          scope = 'owner-b:2';
          return jsonResponse({ data: [{ model: 'grok-4.6' }] });
        }) as typeof fetch,
        getAccessToken: async () => 'token-a',
        peekAccessToken: () => 'token-a',
        hasLogin: () => true,
        getConnectionSource: () => 'explicit-provider-oauth' as const,
        getScopeKey: () => scope,
        cacheFilePath: () => '/unused',
        applySnapshot,
        invalidateAuth: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toBe(false);
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it('refreshes a rejected token once and restarts the user-model chain', async () => {
    let token = 'token-old';
    const applySnapshot = vi.fn();
    const invalidateAuth = vi.fn(async () => {
      token = 'token-new';
      return 'refreshed' as const;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer token-old') {
        return jsonResponse(
          {
            code: 'unauthenticated:bad-credentials',
            error: 'The OAuth2 access token could not be validated.',
          },
          403,
        );
      }
      if (String(input) === XAI_ACCOUNT_USER_URL) return jsonResponse({ userId: 'user-new' });
      return jsonResponse({ data: [{ model: 'grok-4.6' }] });
    });
    await expect(
      refreshXaiModelsFromHttp({
        fetchImpl: fetchImpl as typeof fetch,
        getAccessToken: async () => token,
        peekAccessToken: () => token,
        hasLogin: () => true,
        getConnectionSource: () => 'explicit-provider-oauth' as const,
        getScopeKey: () => 'owner-a:1',
        cacheFilePath: () => path.join(os.tmpdir(), 'unused-xai-models.json'),
        applySnapshot,
        invalidateAuth,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toBe(true);
    expect(invalidateAuth).toHaveBeenCalledWith(
      expect.objectContaining({ status: 403, failedAccessToken: 'token-old' }),
    );
    expect(applySnapshot).toHaveBeenCalledWith([{ id: 'xai/grok-4.6' }]);
  });

  it('拒绝任何 inherited-local-cli 来源，不读取 token 也不发账号请求', async () => {
    const getAccessToken = vi.fn(async () => 'must-not-read');
    const fetchImpl = vi.fn();
    const applySnapshot = vi.fn();

    await expect(
      refreshXaiModelsFromHttp({
        fetchImpl: fetchImpl as typeof fetch,
        getAccessToken,
        peekAccessToken: () => 'must-not-read',
        hasLogin: () => true,
        getConnectionSource: () => null,
        getScopeKey: () => 'owner-a:1',
        cacheFilePath: () => '/unused',
        applySnapshot,
        invalidateAuth: vi.fn(),
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toBe(false);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
  });
});
