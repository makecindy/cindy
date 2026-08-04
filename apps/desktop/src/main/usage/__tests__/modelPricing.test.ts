import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  getCurrentDbClientUserId: vi.fn(() => 'user-a' as string | null),
  electronAppGetPath: vi.fn(() => ''),
  getClientEndpoint: vi.fn(() => 'https://model-access.example.test'),
  resolveOwnerScopedSecretStorageKey: vi.fn(() => 'provider-xd'),
  statSync: vi.fn(() => ({
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
  })),
  send: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  statSync: mocks.statSync,
}));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.electronAppGetPath,
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: mocks.send },
      },
    ],
  },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));
vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: mocks.getClientEndpoint,
}));
vi.mock('../../secrets/providerSecretStore', () => ({
  resolveOwnerScopedSecretStorageKey: mocks.resolveOwnerScopedSecretStorageKey,
}));

import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { DEFAULT_USAGE_CURRENCY } from '../../../shared/regionalMoney';
import {
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
} from '../ledgerCurrency';
import {
  __resetModelPricingCacheForTesting,
  clearGatewayModelPricing,
  getCodexSubscriptionValuePrice,
  getModelPricing,
  getModelPricingForModel,
  getSubscriptionDirectValuePrice,
  MODEL_PRICING_CHANGED_CHANNEL,
  prewarmModelPricing,
  replaceGatewayModelPricing,
  trackGatewayModelPricingSync,
} from '../modelPricing';

let tempUserDataDir: string | null = null;
const EXPECTED_GATEWAY_CURRENCY =
  CURRENT_CINDY_REGION === 'global' ? 'USD' : 'CNY';

function userDataPath(...segments: string[]): string {
  if (!tempUserDataDir) throw new Error('temp userData is not initialized');
  return path.join(tempUserDataDir, ...segments);
}

function expectedScope(userId = 'user-a'): string {
  return `v1|region=${CURRENT_CINDY_REGION}|base=https://model-access.example.test|user=${userId}|key=1:2:3:4:5`;
}

beforeEach(async () => {
  tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-model-pricing-'));
  mocks.electronAppGetPath.mockReturnValue(tempUserDataDir);
  mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
  mocks.getClientEndpoint.mockReturnValue('https://model-access.example.test');
  mocks.resolveOwnerScopedSecretStorageKey.mockReturnValue('provider-xd');
  mocks.statSync.mockReturnValue({
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
  });
  mocks.send.mockClear();
  __resetModelPricingCacheForTesting();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempUserDataDir) {
    await rm(tempUserDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    tempUserDataDir = null;
  }
});

describe('gateway model pricing projection', () => {
  it('converts model-groups per-token values to provider-scoped per-Mtok quotes', () => {
    const pricing = replaceGatewayModelPricing([
      {
        id: 'claude-sonnet-4',
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadInputTokenCost: 0.0000003,
        cacheCreationInputTokenCost: 0.00000375,
        costDiscount: 0.4,
      },
      {
        id: 'codex/gpt-5.5',
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        cacheReadInputTokenCost: 0.0000002,
      },
    ]);

    expect(pricing).toEqual({
      xd: {
        'claude-sonnet-4': {
          providerId: 'xd',
          modelId: 'claude-sonnet-4',
          currency: EXPECTED_GATEWAY_CURRENCY,
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.3,
          cacheCreatePerMtok: 3.75,
          costDiscount: 0.4,
        },
        'codex/gpt-5.5': {
          providerId: 'xd',
          modelId: 'codex/gpt-5.5',
          currency: EXPECTED_GATEWAY_CURRENCY,
          source: 'gateway',
          approximate: false,
          inputPerMtok: 2,
          outputPerMtok: 8,
          cacheReadPerMtok: expect.closeTo(0.2),
        },
      },
    });
    expect(mocks.send).toHaveBeenCalledWith(MODEL_PRICING_CHANGED_CHANNEL, pricing);
  });

  it('keeps legal zero tiers but drops missing, invalid and 0/0 standard prices', () => {
    const pricing = replaceGatewayModelPricing([
      {
        id: 'free-output',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0,
        cacheReadInputTokenCost: 0,
      },
      {
        id: 'missing-output',
        inputCostPerToken: 0.000001,
      },
      {
        id: 'zero-both',
        inputCostPerToken: 0,
        outputCostPerToken: 0,
      },
      {
        id: 'negative',
        inputCostPerToken: -1,
        outputCostPerToken: 1,
      },
    ]);

    expect(pricing?.xd?.['free-output']).toMatchObject({
      inputPerMtok: 1,
      outputPerMtok: 0,
      cacheReadPerMtok: 0,
    });
    expect(Object.keys(pricing?.xd ?? {})).toEqual(['free-output']);
  });

  it('successful empty or unpriced snapshots clear the old quote instead of reviving it', async () => {
    replaceGatewayModelPricing([
      {
        id: 'priced',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    expect(await getModelPricing()).not.toBeNull();

    expect(replaceGatewayModelPricing([{ id: 'unpriced' }])).toEqual({});
    expect(await getModelPricing()).toEqual({});
    expect(mocks.send).toHaveBeenLastCalledWith(MODEL_PRICING_CHANGED_CHANNEL, {});

    clearGatewayModelPricing();
    expect(await getModelPricing()).toEqual({});
  });

  it('hydrates a successful empty pricing snapshot as loaded', async () => {
    replaceGatewayModelPricing([
      {
        id: 'free',
        inputCostPerToken: 0,
        outputCostPerToken: 0,
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw.pricing).toEqual({});
    });

    __resetModelPricingCacheForTesting();
    await expect(getModelPricing()).resolves.toEqual({});
  });
});

describe('pricing cache lifecycle', () => {
  it('persists the model-sync projection and hydrates it without any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pricing = replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
        costDiscount: 0.2,
      },
    ]);

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        // 账号币种与报价同快照持久化后升到 8:旧缓存缺少账号币种，
        // 必须靠版本号失效掉。改缓存结构时同步这里。
        version: 8,
        scope: expectedScope(),
        pricing,
      });
    });

    __resetModelPricingCacheForTesting();
    await expect(getModelPricing()).resolves.toEqual(pricing);
    await prewarmModelPricing();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores the active ledger currency when only the disk cache is hydrated', async () => {
    // 模型即使没有可计价 quote，也可能明确声明账号结算币种；两者必须同快照恢复。
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        currency: 'USD',
      },
    ]);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        pricing: {},
        accountCurrency: 'USD',
      });
    });

    // 模拟重启:清掉内存缓存与账本币种，只留磁盘缓存
    __resetModelPricingCacheForTesting();
    __resetActiveLedgerCurrencyForTesting();
    expect(currentLedgerCurrency()).toBe(DEFAULT_USAGE_CURRENCY);

    await expect(getModelPricing()).resolves.toEqual({});

    expect(currentLedgerCurrency()).toBe('USD');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists a startup snapshot under the authenticated user before localDb is ready', async () => {
    mocks.getCurrentDbClientUserId.mockReturnValue(null);
    const pricing = replaceGatewayModelPricing(
      [
        {
          id: 'early-model',
          inputCostPerToken: 0.000001,
          outputCostPerToken: 0.000002,
        },
      ],
      'user-a',
    );

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        scope: expectedScope('user-a'),
        pricing,
      });
    });

    mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
    await expect(getModelPricing()).resolves.toEqual(pricing);
  });

  it('does not hydrate another account pricing snapshot', async () => {
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 6,
        scope: expectedScope(),
        fetchedAt: Date.now(),
        pricing: {
          xd: {
            secret: {
              providerId: 'xd',
              modelId: 'secret',
              currency: 'USD',
              source: 'gateway',
              approximate: false,
              inputPerMtok: 1,
              outputPerMtok: 2,
            },
          },
        },
      }),
      'utf8',
    );
    mocks.getCurrentDbClientUserId.mockReturnValue('user-b');

    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('does not hydrate pricing written for an older gateway key identity', async () => {
    replaceGatewayModelPricing([
      {
        id: 'gpt-5.5',
        inputCostPerToken: 0.000005,
        outputCostPerToken: 0.00003,
      },
    ]);
    await vi.waitFor(async () => {
      await expect(
        readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'),
      ).resolves.toContain(expectedScope());
    });

    __resetModelPricingCacheForTesting();
    mocks.statSync.mockReturnValue({
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 6n,
      ctimeNs: 7n,
    });

    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('rejects malformed or non-gateway disk quotes', async () => {
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 6,
        scope: expectedScope(),
        fetchedAt: Date.now(),
        pricing: {
          xd: {
            bad: {
              providerId: 'xd',
              modelId: 'bad',
              currency: 'USD',
              source: 'subscription-reference',
              approximate: true,
              inputPerMtok: -1,
              outputPerMtok: 2,
            },
          },
        },
      }),
      'utf8',
    );
    await expect(getModelPricing()).resolves.toBeNull();
  });

  it('requires provider identity on accounting lookups', async () => {
    replaceGatewayModelPricing([
      {
        id: 'same-id',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    await expect(getModelPricingForModel('xd', 'same-id')).resolves.toMatchObject({
      xd: { 'same-id': { inputPerMtok: 1, outputPerMtok: 2 } },
    });
    await expect(getModelPricingForModel('openai', 'same-id')).resolves.toMatchObject({
      xd: { 'same-id': { inputPerMtok: 1, outputPerMtok: 2 } },
    });
  });

  it('bounds the accounting-path wait when a model sync hangs', async () => {
    replaceGatewayModelPricing([
      {
        id: 'gpt-x',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    vi.useFakeTimers();
    try {
      // 永不 settle 的同步:黑洞网络下 /models fetch 没有超时。
      trackGatewayModelPricingSync(new Promise(() => {}));
      let settled = false;
      const lookup = getModelPricingForModel('xd', 'gpt-x').then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(lookup).resolves.toMatchObject({
        xd: { 'gpt-x': { inputPerMtok: 1, outputPerMtok: 2 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reference pricing helpers', () => {
  it('returns subscription reference quotes separately from the XD cache', () => {
    expect(getCodexSubscriptionValuePrice('gpt-5.5', null)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      currency: 'USD',
      source: 'subscription-reference',
      approximate: true,
      inputPerMtok: 5,
      outputPerMtok: 30,
      cacheReadPerMtok: 0.5,
    });
    expect(getSubscriptionDirectValuePrice('chatgpt/gpt-5.5')).toMatchObject({
      providerId: 'openai',
      modelId: 'chatgpt/gpt-5.5',
      source: 'subscription-reference',
    });
    expect(getSubscriptionDirectValuePrice('unknown')).toBeUndefined();
  });
});
