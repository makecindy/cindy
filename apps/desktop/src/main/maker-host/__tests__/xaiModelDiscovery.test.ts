import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discardXaiModelsDiskCache,
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

  it('降序 payload 归一为规范升序(Grok 4.5 滑轴反向回归,Chris 2026-08-19)', () => {
    // x.ai /v1/models 实测下发降序(['high','medium','low']);消费端(滑杆按下标画轴、
    // efforts[0]=最低 / at(-1)=最高)契约都是升序,原序透传会让整条轴反向。
    // declaredDefault 缺席于列表时的追加分支同样必须重排,不能 push 在尾部。
    expect(
      parseXaiAccountModels({
        data: [
          {
            model: 'grok-4.5',
            reasoningEfforts: ['high', 'medium', 'low'],
            reasoningEffort: 'high',
          },
          {
            model: 'grok-4.6',
            reasoningEfforts: ['xhigh', 'high', 'medium'],
            reasoningEffort: 'low',
          },
        ],
      }),
    ).toEqual([
      { id: 'xai/grok-4.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      // declaredDefault('low') 不在列表里 → 追加后仍是规范升序。
      { id: 'xai/grok-4.6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low' },
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

  it('skips discovery cleanly when no access token is available (not logged in)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-xai-models-'));
    tempDirs.push(dir);
    const cacheFile = path.join(dir, 'xai-models.json');
    const applySnapshot = vi.fn();
    const fetchImpl = vi.fn();
    const deps = {
      fetchImpl: fetchImpl as typeof fetch,
      getAccessToken: async () => {
        throw new Error('xAI 未登录:请先在「设置 → 模型供应商」登录 xAI(SuperGrok)');
      },
      peekAccessToken: () => null,
      hasLogin: () => false,
      getConnectionSource: () => 'explicit-provider-oauth' as const,
      getScopeKey: () => 'owner-a:1',
      cacheFilePath: () => cacheFile,
      applySnapshot,
      invalidateAuth: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };

    await expect(refreshXaiModelsFromHttp(deps)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
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

  it('drops a queued disk-cache deletion after the active owner scope changes', async () => {
    let scope = 'owner-a:1';
    const ownerACache = '/owner-a/xai-models.json';
    const ownerBCache = '/owner-b/xai-models.json';
    const cacheFilePath = vi.fn(() => (scope === 'owner-a:1' ? ownerACache : ownerBCache));
    let releaseFirstRemoval!: () => void;
    const firstRemovalReleased = new Promise<void>((resolve) => {
      releaseFirstRemoval = resolve;
    });
    let firstRemovalStarted!: () => void;
    const firstRemovalStartedPromise = new Promise<void>((resolve) => {
      firstRemovalStarted = resolve;
    });
    const rmSpy = vi.spyOn(fsp, 'rm').mockImplementation(async () => {
      firstRemovalStarted();
      await firstRemovalReleased;
    });
    const deps = {
      getScopeKey: () => scope,
      cacheFilePath,
      log: { info: vi.fn(), warn: vi.fn() },
    };

    try {
      const firstRemoval = discardXaiModelsDiskCache(deps);
      await firstRemovalStartedPromise;
      const queuedRemoval = discardXaiModelsDiskCache(deps);
      expect(cacheFilePath).toHaveBeenCalledTimes(2);

      scope = 'owner-b:2';
      releaseFirstRemoval();
      await Promise.all([firstRemoval, queuedRemoval]);

      expect(rmSpy).toHaveBeenCalledTimes(1);
      expect(rmSpy).toHaveBeenCalledWith(ownerACache, { force: true });
      expect(rmSpy).not.toHaveBeenCalledWith(ownerBCache, expect.anything());
    } finally {
      releaseFirstRemoval();
      rmSpy.mockRestore();
    }
  });

  it('does not reuse an older account flight when the token changes under the same owner scope', async () => {
    let token = 'token-a';
    let releaseAUser!: () => void;
    const aUserReleased = new Promise<void>((resolve) => {
      releaseAUser = resolve;
    });
    let aUserStarted!: () => void;
    const aUserStartedPromise = new Promise<void>((resolve) => {
      aUserStarted = resolve;
    });
    const applySnapshot = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (String(input) === XAI_ACCOUNT_USER_URL && auth === 'Bearer token-a') {
        aUserStarted();
        await aUserReleased;
        return jsonResponse({ userId: 'user-a' });
      }
      if (String(input) === XAI_ACCOUNT_USER_URL && auth === 'Bearer token-b') {
        return jsonResponse({ userId: 'user-b' });
      }
      if (String(input) === XAI_ACCOUNT_MODELS_URL && auth === 'Bearer token-b') {
        return jsonResponse({ data: [{ model: 'grok-4.6' }] });
      }
      throw new Error(`unexpected request ${String(input)} ${auth}`);
    });
    const deps = {
      fetchImpl: fetchImpl as typeof fetch,
      getAccessToken: async () => token,
      peekAccessToken: () => token,
      hasLogin: () => true,
      getConnectionSource: () => 'explicit-provider-oauth' as const,
      getScopeKey: () => 'owner-a:1',
      cacheFilePath: () => '/unused',
      applySnapshot,
      invalidateAuth: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const accountA = refreshXaiModelsFromHttp(deps);
    await aUserStartedPromise;
    token = 'token-b';
    const accountB = refreshXaiModelsFromHttp({
      ...deps,
      getAccessToken: async () => token,
      peekAccessToken: () => token,
    });
    await expect(accountB).resolves.toBe(true);
    expect(applySnapshot).toHaveBeenCalledWith([{ id: 'xai/grok-4.6' }]);

    releaseAUser();
    await expect(accountA).resolves.toBe(false);
    expect(applySnapshot).toHaveBeenCalledTimes(1);
  });

  it('joins startup refresh after getAccessToken rotates the same account token', async () => {
    let token = 'token-old';
    let releaseUser!: () => void;
    const userReleased = new Promise<void>((resolve) => {
      releaseUser = resolve;
    });
    let userStarted!: () => void;
    const userStartedPromise = new Promise<void>((resolve) => {
      userStarted = resolve;
    });
    const applySnapshot = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      expect(auth).toBe('Bearer token-new');
      if (String(input) === XAI_ACCOUNT_USER_URL) {
        userStarted();
        await userReleased;
        return jsonResponse({ userId: 'user-a' });
      }
      return jsonResponse({ data: [{ model: 'grok-4.6' }] });
    });
    const deps = {
      fetchImpl: fetchImpl as typeof fetch,
      getAccessToken: async () => {
        token = 'token-new';
        return token;
      },
      peekAccessToken: () => token,
      hasLogin: () => true,
      getConnectionSource: () => 'explicit-provider-oauth' as const,
      getScopeKey: () => 'owner-a:1',
      cacheFilePath: () => '/unused',
      applySnapshot,
      invalidateAuth: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const splashRefresh = refreshXaiModelsFromHttp(deps);
    await userStartedPromise;
    const readinessRefresh = refreshXaiModelsFromHttp(deps);
    releaseUser();

    await expect(Promise.all([splashRefresh, readinessRefresh])).resolves.toEqual([true, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(applySnapshot).toHaveBeenCalledTimes(1);
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

  it('warns and returns false when token refresh after invalidateAuth fails', async () => {
    let token = 'token-old';
    let getAccessTokenCalls = 0;
    const applySnapshot = vi.fn();
    const invalidateAuth = vi.fn(async () => 'refreshed' as const);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer token-old') {
        return jsonResponse(
          { code: 'unauthenticated:bad-credentials', error: 'bad creds' },
          403,
        );
      }
      // Should never reach here because second getAccessToken fails
      throw new Error('unexpected fetch after token failure');
    });
    const warn = vi.fn();
    await expect(
      refreshXaiModelsFromHttp({
        fetchImpl: fetchImpl as typeof fetch,
        getAccessToken: async () => {
          getAccessTokenCalls += 1;
          if (getAccessTokenCalls === 1) return token;
          throw new Error('token refresh failed after invalidate');
        },
        peekAccessToken: () => token,
        hasLogin: () => true,
        getConnectionSource: () => 'explicit-provider-oauth' as const,
        getScopeKey: () => 'owner-a:1',
        cacheFilePath: () => '/unused',
        applySnapshot,
        invalidateAuth,
        log: { info: vi.fn(), warn },
      }),
    ).resolves.toBe(false);
    expect(invalidateAuth).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'xAI account model discovery: token refresh after invalidate failed',
      expect.objectContaining({ error: 'token refresh failed after invalidate' }),
    );
    expect(applySnapshot).not.toHaveBeenCalled();
  });

});
