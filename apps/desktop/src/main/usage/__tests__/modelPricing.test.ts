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
import { modelPricingKey, providerReferencePriceQuote } from '../../../shared/modelPriceQuote';
import { getActiveCatalog } from '../../maker-host/active-catalog';
import {
  applyModelPriceOverrides,
  clearModelPriceOverride,
  readModelPriceOverridesSnapshot,
  setModelPriceOverride,
} from '../modelPriceOverrideStore';
import {
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
  LEDGER_CURRENCY_FALLBACK,
} from '../ledgerCurrency';
import {
  __resetModelPricingCacheForTesting,
  clearGatewayModelPricing,
  getGatewayModelPricing,
  getGatewayModelPricingForModel,
  MODEL_PRICING_CHANGED_CHANNEL,
  prewarmModelPricing,
  replaceGatewayModelPricing,
  trackGatewayModelPricingSync,
} from '../modelPricing';
import {
  getClaudeSubscriptionValuePrice,
  getCodexProviderSubscriptionValuePrice,
  getCodexSubscriptionValuePrice,
  getSubscriptionDirectValuePrice,
} from '../referenceModelPricing';

let tempUserDataDir: string | null = null;
// 目录整份没声明 currency 时的回落值。不再按构建区域推断 —— 服务端漏发 currency 时
// 按区域猜会把 USD 口径的报价数值盖上 CNY 戳,产生 6.7 倍量级的错账。回落链是
// 「上次已知 → USD」(见 usage/ledgerCurrency),测试从干净状态起跑,所以是 USD。
const EXPECTED_GATEWAY_CURRENCY = 'USD';

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
          // 这批 model 都没声明 currency,回落值是本地推断的 —— 下游据此把金额标成估算。
          currencyInferred: true,
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
          currencyInferred: true,
        },
      },
    });
    expect(mocks.send).toHaveBeenCalledWith(
      MODEL_PRICING_CHANGED_CHANNEL,
      expect.objectContaining(pricing),
    );
  });

  it('preserves Gateway context-length tiers in the effective quote', () => {
    const pricing = replaceGatewayModelPricing([
      {
        id: 'gpt-tiered',
        inputCostPerToken: 0.000002,
        outputCostPerToken: 0.000008,
        tieredPricing: [
          {
            range: [200_001, 1_000_001],
            inputCostPerToken: 0.000004,
            outputCostPerToken: 0.000012,
            cacheReadInputTokenCost: 0.0000004,
          },
        ],
      },
    ]);

    const [band] = pricing?.xd?.['gpt-tiered']?.inputTokenPriceBands ?? [];
    expect(band).toMatchObject({
      minInputTokens: 200_001,
      maxInputTokens: 1_000_001,
      inputPerMtok: 4,
      outputPerMtok: 12,
    });
    expect(band?.cacheReadPerMtok).toBeCloseTo(0.4);
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
    expect(await getGatewayModelPricing()).not.toBeNull();

    expect(replaceGatewayModelPricing([{ id: 'unpriced' }])).toEqual({});
    expect((await getGatewayModelPricing())?.xd).toBeUndefined();
    expect(mocks.send).toHaveBeenLastCalledWith(MODEL_PRICING_CHANGED_CHANNEL, {});

    clearGatewayModelPricing();
    expect((await getGatewayModelPricing())?.xd).toBeUndefined();
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
    await expect(getGatewayModelPricing()).resolves.toEqual({});
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
        tieredPricing: [
          {
            range: [272_001, 1_000_001],
            inputCostPerToken: 0.00001,
            outputCostPerToken: 0.000045,
          },
        ],
      },
    ]);

    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(userDataPath('cache', 'model-pricing.json'), 'utf8'));
      expect(raw).toMatchObject({
        // 币种回落不再按构建区域猜之后升到 9:v8 快照里那些按区域兜底写入的
        // accountCurrency 与 quote 没有 currencyInferred 标记，复用会让猜出来的币种
        // 重新冒充精确报价。改缓存结构或币种语义时同步这里。
        version: 9,
        scope: expectedScope(),
        pricing,
      });
    });

    __resetModelPricingCacheForTesting();
    await expect(getGatewayModelPricing()).resolves.toMatchObject(pricing);
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

    // 模拟重启:清掉内存缓存与账本币种，只留磁盘缓存。重置后回退链落在最后一档
    // USD(不按构建区域猜,见 usage/ledgerCurrency),下面从磁盘恢复出 USD 才是
    // 「快照真的把币种带回来了」的证据。
    __resetModelPricingCacheForTesting();
    __resetActiveLedgerCurrencyForTesting();
    expect(currentLedgerCurrency()).toBe(LEDGER_CURRENCY_FALLBACK);

    const hydrated = await getGatewayModelPricing();
    expect(hydrated).toEqual({});

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
    await expect(getGatewayModelPricing()).resolves.toMatchObject(pricing);
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

    await expect(getGatewayModelPricing()).resolves.toBeNull();
  });

  it('discards a v8 snapshot whose currency was guessed by build region', async () => {
    // 回归护栏。v8 快照里的 accountCurrency 与 quote 币种可能是旧版本按构建区域兜底
    // 写进去的，而那一版还没有 currencyInferred 字段 —— 无从分辨「服务端声明的」与
    // 「本地猜的」。若继续复用，离线或 /models 失败时猜出来的币种会重新冒充精确报价，
    // 正好绕过本次修复。只能靠版本号整份作废。
    await mkdir(userDataPath('cache'), { recursive: true });
    await writeFile(
      userDataPath('cache', 'model-pricing.json'),
      JSON.stringify({
        version: 8,
        scope: expectedScope(),
        fetchedAt: Date.now(),
        accountCurrency: 'CNY',
        pricing: {
          xd: {
            'gpt-5.5': {
              providerId: 'xd',
              modelId: 'gpt-5.5',
              currency: 'CNY',
              source: 'gateway',
              approximate: false,
              inputPerMtok: 5,
              outputPerMtok: 30,
            },
          },
        },
      }),
      'utf8',
    );

    __resetActiveLedgerCurrencyForTesting();
    const hydrated = await getGatewayModelPricing();
    expect(hydrated).toBeNull();
    // 账本币种也不能被它带偏，回退链重新从「上次已知 → USD」起算。
    expect(currentLedgerCurrency()).toBe('USD');
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

    await expect(getGatewayModelPricing()).resolves.toBeNull();
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
              source: 'provider-reference',
              approximate: true,
              inputPerMtok: -1,
              outputPerMtok: 2,
            },
          },
        },
      }),
      'utf8',
    );
    await expect(getGatewayModelPricing()).resolves.toBeNull();
  });

  it('returns only the Gateway snapshot on accounting lookups', async () => {
    replaceGatewayModelPricing([
      {
        id: 'same-id',
        inputCostPerToken: 0.000001,
        outputCostPerToken: 0.000002,
      },
    ]);
    await expect(getGatewayModelPricingForModel()).resolves.toMatchObject({
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
      const lookup = getGatewayModelPricingForModel().then((value) => {
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
  it('resolves historical subscription prices by their effective date', () => {
    expect(getClaudeSubscriptionValuePrice('claude-sonnet-5', null, '2026-08-31')).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 10,
    });
    expect(getClaudeSubscriptionValuePrice('claude-sonnet-5', null, '2026-09-01')).toMatchObject({
      inputPerMtok: 3,
      outputPerMtok: 15,
    });
    expect(getClaudeSubscriptionValuePrice('claude-sonnet-5', null, '2026-06-29')).toBeUndefined();
    expect(getClaudeSubscriptionValuePrice('sonnet', null, '2026-03-01')).toMatchObject({
      modelId: 'sonnet',
      inputPerMtok: 3,
      outputPerMtok: 15,
    });
    expect(
      getClaudeSubscriptionValuePrice('claude-sonnet-4-6-20260701', null, '2026-08-01'),
    ).toMatchObject({
      modelId: 'claude-sonnet-4-6-20260701',
      inputPerMtok: 3,
      outputPerMtok: 15,
    });
  });

  it('returns subscription reference quotes separately from the XD cache', () => {
    expect(getCodexSubscriptionValuePrice('gpt-5.5', null)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      currency: 'USD',
      source: 'provider-reference',
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
    // Pi SuperGrok 目录 id 是裸 grok-*,报价户口是 xai/grok-*。两条都要能取到参考价,
    // 否则消息 tooltip 会落到「本轮费用暂不可用」。
    expect(getSubscriptionDirectValuePrice('grok-4.6')).toMatchObject({
      providerId: 'xai',
      modelId: 'grok-4.6',
      source: 'subscription-reference',
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.5,
    });
    expect(getSubscriptionDirectValuePrice('xai/grok-4.6')).toMatchObject({
      providerId: 'xai',
      modelId: 'xai/grok-4.6',
      source: 'subscription-reference',
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheReadPerMtok: 0.5,
    });
    expect(
      getSubscriptionDirectValuePrice('grok-4.6', 'pi', {
        xai: {
          [modelPricingKey('grok-4.6', 'pi')]: {
            providerId: 'xai',
            modelId: 'grok-4.6',
            currency: 'USD',
            source: 'user-override',
            approximate: true,
            inputPerMtok: 9,
            outputPerMtok: 27,
          },
        },
      }),
    ).toMatchObject({
      modelId: 'grok-4.6',
      source: 'user-override',
      inputPerMtok: 9,
      outputPerMtok: 27,
    });
    expect(
      getSubscriptionDirectValuePrice('grok-4.6', undefined, {
        xai: {
          [modelPricingKey('grok-4.6', 'pi')]: {
            providerId: 'xai',
            modelId: 'grok-4.6',
            currency: 'USD',
            source: 'user-override',
            approximate: true,
            inputPerMtok: 9,
            outputPerMtok: 27,
          },
        },
      }),
    ).toMatchObject({
      source: 'subscription-reference',
      inputPerMtok: 2,
    });
    expect(
      getSubscriptionDirectValuePrice('chatgpt/gpt-5.5', 'claude-code', {
        openai: {
          'gpt-5.5': {
            providerId: 'openai',
            modelId: 'gpt-5.5',
            currency: 'USD',
            source: 'user-override',
            approximate: true,
            inputPerMtok: 9,
            outputPerMtok: 27,
          },
        },
      }),
    ).toMatchObject({
      modelId: 'chatgpt/gpt-5.5',
      source: 'user-override',
      inputPerMtok: 9,
      outputPerMtok: 27,
    });
    expect(getSubscriptionDirectValuePrice('unknown')).toBeUndefined();
  });

  it('prices Codex Anthropic subscription rounds through the anthropic date route', () => {
    expect(
      getCodexProviderSubscriptionValuePrice('anthropic', 'claude-sonnet-5', null, '2026-08-31'),
    ).toMatchObject({ providerId: 'anthropic', inputPerMtok: 2, outputPerMtok: 10 });
    expect(
      getCodexProviderSubscriptionValuePrice('anthropic', 'claude-sonnet-5', null, '2026-09-01'),
    ).toMatchObject({ inputPerMtok: 3, outputPerMtok: 15 });
  });

  it('re-merges sparse price overrides against the reference effective at the queried date', () => {
    const registry = getActiveCatalog().modelRegistry;
    const target = {
      providerId: 'anthropic',
      agent: 'claude-code',
      modelId: 'claude-sonnet-5',
    } as const;
    const currentReference = providerReferencePriceQuote(
      target.providerId,
      target.modelId,
      registry,
      { agent: target.agent },
    );
    expect(currentReference).toBeDefined();
    try {
      // 只覆盖输入价:其余字段保持跟随参考价,形成稀疏 override。
      setModelPriceOverride(
        target,
        {
          currency: currentReference!.currency,
          inputPerMtok: 2.5,
          outputPerMtok: currentReference!.outputPerMtok,
          cacheReadPerMtok: currentReference!.cacheReadPerMtok ?? null,
          cacheCreatePerMtok: currentReference!.cacheCreatePerMtok ?? null,
        },
        registry,
      );
      const pricing = applyModelPriceOverrides({}, registry);
      expect(
        getClaudeSubscriptionValuePrice('claude-sonnet-5', pricing, '2026-08-31'),
      ).toMatchObject({ source: 'user-override', inputPerMtok: 2.5, outputPerMtok: 10 });
      expect(
        getClaudeSubscriptionValuePrice('claude-sonnet-5', pricing, '2026-09-01'),
      ).toMatchObject({ source: 'user-override', inputPerMtok: 2.5, outputPerMtok: 15 });
      expect(getClaudeSubscriptionValuePrice('claude-sonnet-5', pricing)).toMatchObject({
        source: 'user-override',
        inputPerMtok: 2.5,
      });
      // 批量路径:传入一次性快照时结果一致,不逐行重读覆盖文件。
      const snapshot = readModelPriceOverridesSnapshot();
      expect(
        getClaudeSubscriptionValuePrice('claude-sonnet-5', pricing, '2026-08-31', snapshot),
      ).toMatchObject({ source: 'user-override', inputPerMtok: 2.5, outputPerMtok: 10 });
    } finally {
      clearModelPriceOverride(target);
    }
  });
});
