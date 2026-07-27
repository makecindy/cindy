/**
 * model-discovery/anthropic 单测。
 *
 * 覆盖:SDK ModelInfo 映射(别名过滤 / dated id 归一 / 能力字段在场 = 权威、全缺席 =
 * 未知按确定性默认合成 / haiku 默认收起)、HTTP /v1/models 映射(能力字段容错 / haiku
 * 例外 / max_input_tokens 优先 / dated 去重)、contextWindow 规则(HTTP 明示 > 目录 >
 * 默认 1M / haiku 200k)、
 * SDK 捕获入口的登录态门控与合并纪律(登出不注入 / 无能力信息保留已精化条目 /
 * HTTP 明说窗口不被 SDK 打回猜测值 / 磁盘缓存恢复 explicitWindows)。
 * HTTP 拉取的网络路径不在此测(登录态 + fetch 依赖,行为由代码注释契约覆盖)。
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Catalog } from '@cindy/model-providers';

// 规则 23:测试涉及路径一律用 os.tmpdir() 下的临时目录,收尾清理。
const TEST_USER_DATA = path.join(os.tmpdir(), `cindy-anthropic-discovery-test-${process.pid}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => TEST_USER_DATA),
    getAppPath: vi.fn(() => TEST_USER_DATA),
    isPackaged: false,
  },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

const authState = vi.hoisted(() => ({ loggedIn: true }));
// refreshToken 决定「401 后没换到新 token」是暂时故障还是真的无从刷新（见归因分流）。
const credentialsMock = vi.hoisted(() => ({ refreshToken: 'refresh-token' as string | null }));
vi.mock('../claude-credentials-store.js', () => ({
  hasClaudeAiOAuth: () => authState.loggedIn,
  readClaudeAiOAuth: () =>
    authState.loggedIn
      ? { accessToken: 'test-token', refreshToken: credentialsMock.refreshToken }
      : null,
}));
const oauthRefreshMock = vi.hoisted(() => ({
  getValidClaudeAiOAuth: vi.fn(async () => null as unknown),
}));
vi.mock('../claude-oauth-refresh.js', () => oauthRefreshMock);

import {
  evaluateHttpShrink,
  isDegenerateModelListShrink,
  mapAnthropicSdkModels,
  mapAnthropicHttpModels,
  noteAnthropicSdkSupportedModels,
  loadAnthropicModelsFromDiskCache,
  refreshAnthropicModelsFromHttp,
  getAnthropicModelDiscoveryFailure,
  setAnthropicDiscoveryFailureListener,
  clearAnthropicDiscoveredModels,
  resetAnthropicDiscoveryForTest,
  waitForAnthropicDiscoveryIdleForTest,
} from '../model-discovery/anthropic.js';
import {
  getActiveCatalog,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
} from '../active-catalog.js';

function anthropicIds(): string[] {
  const p = getActiveCatalog().providers.find((x) => x.id === 'anthropic');
  return (p?.models['claude-code'] ?? []).map((m) => m.id);
}

function anthropicModel(id: string) {
  const p = getActiveCatalog().providers.find((x) => x.id === 'anthropic');
  return (p?.models['claude-code'] ?? []).find((m) => m.id === id);
}

afterAll(async () => {
  await fsp.rm(TEST_USER_DATA, { recursive: true, force: true });
});

afterEach(() => {
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('mapAnthropicSdkModels', () => {
  it('映射 value/displayName/efforts/fastMode;能力字段在场 = SDK 是权威', () => {
    const out = mapAnthropicSdkModels([
      {
        value: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        description: 'Most capable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: true,
      },
      {
        value: 'claude-haiku-4-5',
        displayName: 'Haiku 4.5',
        description: 'Fastest',
        supportsEffort: false,
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ hasEffortInfo: true, hasFastModeInfo: true });
    expect(out[0].model).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      group: 'anthropic',
      sortOrder: 0,
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
    // supportsEffort=false → 不可调;fast 缺省 false;haiku → 200k + 默认收起。
    expect(out[1]).toMatchObject({ hasEffortInfo: true, hasFastModeInfo: false });
    expect(out[1].model).toMatchObject({
      id: 'claude-haiku-4-5',
      contextWindow: 200_000,
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
      defaultEnabled: false,
    });
  });

  it('能力字段全缺席 = 未知:目录基线优先,两项来源都为 false', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false, hasFastModeInfo: false });
    expect(out[0].model).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    });
    expect(out[1].model).toMatchObject({ efforts: [], defaultEnabled: false });
  });

  it('SDK 未下发窗口时使用目录中的官方窗口', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-opus-5', displayName: 'Opus 5' },
      { value: 'claude-opus-4-5', displayName: 'Opus 4.5' },
      { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
    ]);
    expect(out.map(({ model }) => [model.id, model.contextWindow])).toEqual([
      ['claude-opus-5', 1_000_000],
      ['claude-opus-4-5', 200_000],
      ['claude-sonnet-4-5', 200_000],
    ]);
  });

  it('active v1 元数据缺字段时仍从 bundled v1 取得窗口和 effort', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    catalog.cindyModelMeta = {
      version: 1,
      models: {
        'claude-sonnet-4-5': { name: 'Remote Sonnet 4.5' },
      },
    };
    setActiveCatalog(catalog);

    const out = mapAnthropicSdkModels([
      { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5' },
      { value: 'claude-opus-5', displayName: 'Opus 5' },
    ]);

    expect(out.map(({ model }) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      efforts: model.efforts,
    }))).toEqual([
      { id: 'claude-sonnet-4-5', contextWindow: 200_000, efforts: [] },
      {
        id: 'claude-opus-5',
        contextWindow: 1_000_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    ]);
  });

  it('supportsEffort=true 但缺档位清单:使用目录基线,不解读为不可调', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-opus-4-8', displayName: 'Opus', supportsEffort: true },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: true, hasFastModeInfo: false });
    expect(out[0].model.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('只声明 fastMode 时 effort 仍使用目录基线,两项来源独立', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-opus-4-8', displayName: 'Opus', supportsFastMode: true },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false, hasFastModeInfo: true });
    expect(out[0].model).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true,
    });
  });

  it('目录未知且能力缺席时,非 Haiku 新模型先开放 5 档,Haiku 仍保持 0 档', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-opus-6', displayName: 'Opus 6' },
      { value: 'claude-haiku-5', displayName: 'Haiku 5' },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false });
    expect(out[0].model).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
    expect(out[1].model).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
  });

  it('过滤别名与非 claude id(规则 10:禁止裸别名进目录);dated id 归一去重', () => {
    const out = mapAnthropicSdkModels([
      { value: 'opus', displayName: 'Opus' },
      { value: 'opusplan', displayName: 'Opus Plan' },
      { value: 'claude-sonnet-5-20260301', displayName: 'Sonnet 5' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5 dup' },
    ]);
    expect(out.map((e) => e.model.id)).toEqual(['claude-sonnet-5']);
    expect(out[0].model.name).toBe('Sonnet 5'); // dated 先出现,first-wins
  });

  it('坏输入安全:非数组 / 空条目 / 缺 value 全部跳过', () => {
    expect(mapAnthropicSdkModels(null)).toEqual([]);
    expect(mapAnthropicSdkModels([null, {}, { value: '' }, 42])).toEqual([]);
  });

  it('defaultEffort:含 high 取 high,否则取最后一档', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-x', displayName: 'X', supportedEffortLevels: ['low', 'medium'] },
    ]);
    expect(out[0].model.defaultEffort).toBe('medium');
  });
});

describe('mapAnthropicHttpModels', () => {
  it('无能力信息 → 使用目录基线(两项来源都为 false);haiku 仍为 0 档 + 默认收起', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-opus-4-8-20260401', display_name: 'Opus 4.8', type: 'model' },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5', type: 'model' },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false, hasFastModeInfo: false });
    expect(out[0].explicitContextWindow).toBeNull();
    expect(out[0].model).toMatchObject({
      id: 'claude-opus-4-8',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    });
    expect(out[1].model).toMatchObject({
      id: 'claude-haiku-4-5',
      contextWindow: 200_000,
      efforts: [],
      defaultEnabled: false,
    });
  });

  it('响应带完整能力信息时逐项标记来源,explicitContextWindow 单独记账', () => {
    const out = mapAnthropicHttpModels([
      {
        id: 'claude-opus-4-8',
        display_name: 'Opus 4.8',
        max_input_tokens: 900_000,
        capabilities: { efforts: ['low', 'high', 'max'], fast_mode: true },
      },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: true, hasFastModeInfo: true });
    expect(out[0].explicitContextWindow).toBe(900_000);
    expect(out[0].model).toMatchObject({
      contextWindow: 900_000, // max_input_tokens 优先于 1M 规则
      efforts: ['low', 'high', 'max'],
      supportsFastMode: true,
    });
  });

  it('HTTP 未下发 max_input_tokens 时使用目录中的官方窗口', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-opus-5', display_name: 'Opus 5', type: 'model' },
      { id: 'claude-opus-4-5', display_name: 'Opus 4.5', type: 'model' },
      { id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5', type: 'model' },
    ]);
    expect(out.map(({ model }) => [model.id, model.contextWindow])).toEqual([
      ['claude-opus-5', 1_000_000],
      ['claude-opus-4-5', 200_000],
      ['claude-sonnet-4-5', 200_000],
    ]);
  });

  it('HTTP 未知新模型缺 capability 时同样使用 5 档临时基线', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-sonnet-6', display_name: 'Sonnet 6', type: 'model' },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false });
    expect(out[0].model).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
  });

  it('HTTP 只声明 fast_mode 时不把目录 effort 基线标成明确能力', () => {
    const out = mapAnthropicHttpModels([
      {
        id: 'claude-opus-4-8',
        display_name: 'Opus 4.8',
        capabilities: { fast_mode: true },
      },
    ]);
    expect(out[0]).toMatchObject({ hasEffortInfo: false, hasFastModeInfo: true });
    expect(out[0].model).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsFastMode: true,
    });
  });

  it('dated 变体归一后 first-wins(API 新发布在前 = 保留最新);过滤非 model 条目与别名', () => {
    const out = mapAnthropicHttpModels([
      { id: 'claude-sonnet-5-20260601', display_name: 'Sonnet 5 (new)' },
      { id: 'claude-sonnet-5-20260101', display_name: 'Sonnet 5 (old)' },
      { id: 'not-a-claude-model', display_name: 'Other' },
      { id: 'claude-opus-4-8', type: 'alias' },
    ]);
    expect(out.map((e) => e.model.id)).toEqual(['claude-sonnet-5']);
    expect(out[0].model.name).toBe('Sonnet 5 (new)');
  });

  it('坏输入安全', () => {
    expect(mapAnthropicHttpModels(undefined)).toEqual([]);
    expect(mapAnthropicHttpModels([null, {}, { id: 42 }])).toEqual([]);
  });
});

describe('isDegenerateModelListShrink(退化快照护栏,纯函数)', () => {
  it('骤减(一次少 2 条以上且掉到不足现值一半)判退化;增长 / 持平 / 首次 / 单步递减放行', () => {
    // 事故形态:7 条被单条家族级响应打塌。
    expect(isDegenerateModelListShrink(7, 1)).toBe(true);
    expect(isDegenerateModelListShrink(5, 2)).toBe(true);
    expect(isDegenerateModelListShrink(3, 1)).toBe(true);
    // 合法演进:首次发现 / 增长 / 持平 / 单步递减(含 2→1,review P1) / 恰好半数。
    expect(isDegenerateModelListShrink(0, 1)).toBe(false);
    expect(isDegenerateModelListShrink(3, 7)).toBe(false);
    expect(isDegenerateModelListShrink(7, 7)).toBe(false);
    expect(isDegenerateModelListShrink(7, 6)).toBe(false);
    expect(isDegenerateModelListShrink(2, 1)).toBe(false);
    expect(isDegenerateModelListShrink(4, 2)).toBe(false);
  });
});

describe('evaluateHttpShrink(HTTP 骤减收敛,review P2)', () => {
  beforeEach(() => {
    resetAnthropicDiscoveryForTest();
    authState.loggedIn = true;
  });

  afterEach(async () => {
    await waitForAnthropicDiscoveryIdleForTest();
    resetAnthropicDiscoveryForTest();
    await fsp.rm(TEST_USER_DATA, { recursive: true, force: true });
  });

  it('连续 3 次相同的骤减快照 = 确认真实下架,第 3 次放行;之前一直拒绝', () => {
    expect(evaluateHttpShrink(7, ['claude-a', 'claude-b'])).toBe('reject');
    expect(evaluateHttpShrink(7, ['claude-b', 'claude-a'])).toBe('reject'); // 顺序无关,签名相同
    expect(evaluateHttpShrink(7, ['claude-a', 'claude-b'])).toBe('accept');
  });

  it('签名变化(上游还在抖)重新计数;非骤减快照清零 streak', () => {
    expect(evaluateHttpShrink(7, ['claude-a'])).toBe('reject');
    expect(evaluateHttpShrink(7, ['claude-b'])).toBe('reject'); // 换了内容,streak 重回 1
    expect(evaluateHttpShrink(7, ['claude-b'])).toBe('reject');
    // 中间来了一次正常快照 → streak 清零,再骤减要重新累计。
    expect(evaluateHttpShrink(7, ['1', '2', '3', '4', '5', '6', '7'].map((n) => `claude-${n}`))).toBe('accept');
    expect(evaluateHttpShrink(7, ['claude-b'])).toBe('reject');
  });

  it('记账跨重启持久化:落盘进缓存 pendingShrink,重启加载后继续累计(review P2 二轮回归)', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    const cacheFile = path.join(cacheDir, 'anthropic-models.json');
    const cachedModel = {
      id: 'claude-opus-4-8',
      name: 'Opus 4.8',
      group: 'anthropic',
      sortOrder: 0,
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsFastMode: false,
      status: 'active',
    };
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      cacheFile,
      JSON.stringify({ fetchedAt: '2026-07-21T00:00:00.000Z', models: [cachedModel] }),
      'utf-8',
    );

    // 进程 1:两次相同骤减被拒,记账落盘。
    expect(evaluateHttpShrink(7, ['claude-x'])).toBe('reject');
    expect(evaluateHttpShrink(7, ['claude-x'])).toBe('reject');
    await waitForAnthropicDiscoveryIdleForTest();
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as {
      pendingShrink?: { signature: string; streak: number };
    };
    expect(persisted.pendingShrink).toEqual({ signature: 'claude-x', streak: 2 });

    // 「重启」:清内存态 → 从缓存恢复 → 第 3 次相同骤减即确认放行。
    resetAnthropicDiscoveryForTest();
    await loadAnthropicModelsFromDiskCache();
    expect(evaluateHttpShrink(7, ['claude-x'])).toBe('accept');
    // 确认放行后记账清零并落盘(缓存里不再有 pendingShrink)。
    await waitForAnthropicDiscoveryIdleForTest();
    const cleared = JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as {
      pendingShrink?: unknown;
    };
    expect(cleared.pendingShrink).toBeUndefined();
  });
});

describe('noteAnthropicSdkSupportedModels(登录态门控 + 合并纪律)', () => {
  beforeEach(() => {
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    authState.loggedIn = true;
    oauthRefreshMock.getValidClaudeAiOAuth.mockReset();
    oauthRefreshMock.getValidClaudeAiOAuth.mockResolvedValue(null);
  });

  afterEach(async () => {
    await clearAnthropicDiscoveredModels();
    await waitForAnthropicDiscoveryIdleForTest();
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    vi.unstubAllGlobals();
    await fsp.rm(TEST_USER_DATA, { recursive: true, force: true });
  });

  it('未登录 Claude.ai 时不注入(登出击穿 / 纯网关用户长清单,review P1 回归)', () => {
    authState.loggedIn = false;
    noteAnthropicSdkSupportedModels([
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    ]);
    expect(anthropicIds()).toEqual([]);
  });

  it('已登录时注入并生效到 active catalog', () => {
    noteAnthropicSdkSupportedModels([
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
    ]);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
  });

  it('直接换号边界先清旧账号清单与缓存,新账号发现失败也不继承(review P1 回归)', async () => {
    noteAnthropicSdkSupportedModels([
      { value: 'claude-opus-4-8', displayName: 'Account A Opus' },
    ]);
    await waitForAnthropicDiscoveryIdleForTest();
    const cache = path.join(TEST_USER_DATA, 'model-discovery', 'anthropic-models.json');
    await expect(fsp.access(cache)).resolves.toBeUndefined();

    // 模拟 OAuth 成功后凭证已被 B 覆盖、但 B 的 HTTP / SDK 尚未返回任何清单。
    await clearAnthropicDiscoveredModels();

    expect(anthropicIds()).toEqual([]);
    await expect(fsp.access(cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('登出删除排在旧 SDK 在途持久化之后,缓存不会死灰复燃(review P1 回归)', async () => {
    const originalWriteFile = fsp.writeFile.bind(fsp);
    let releaseWrite!: () => void;
    let signalWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementationOnce(async (...args) => {
      signalWriteStarted();
      await writeGate;
      return originalWriteFile(...args);
    });

    try {
      noteAnthropicSdkSupportedModels([
        { value: 'claude-opus-4-8', displayName: 'Account A Opus' },
      ]);
      await writeStarted;
      authState.loggedIn = false;
      const clearPromise = clearAnthropicDiscoveredModels();
      releaseWrite();
      await clearPromise;
      await waitForAnthropicDiscoveryIdleForTest();

      const cache = path.join(TEST_USER_DATA, 'model-discovery', 'anthropic-models.json');
      expect(anthropicIds()).toEqual([]);
      await expect(fsp.access(cache)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseWrite();
      writeSpy.mockRestore();
    }
  });

  it('退化捕获只合并同 id 能力、不缩减清单;正常演进照常生效', () => {
    noteAnthropicSdkSupportedModels([
      { value: 'claude-fable-5', displayName: 'Fable 5' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5' },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    ]);
    expect(anthropicIds()).toHaveLength(4);
    // cc 只回当前模型一条:清单不塌,且只声明 fast 时不能清空已有 effort 基线。
    oauthRefreshMock.getValidClaudeAiOAuth.mockClear();
    noteAnthropicSdkSupportedModels([
      {
        value: 'claude-fable-5',
        displayName: 'Fable',
        supportsFastMode: true,
      },
    ]);
    expect(anthropicIds()).toHaveLength(4);
    expect(anthropicModel('claude-fable-5')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
    // 后续 effort-only 补丁只精化档位,不能把刚明确的 fastMode 打回 false。
    noteAnthropicSdkSupportedModels([
      {
        value: 'claude-fable-5',
        displayName: 'Fable',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
    ]);
    expect(anthropicIds()).toHaveLength(4);
    expect(anthropicModel('claude-fable-5')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
    expect(anthropicModel('claude-opus-4-8')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(oauthRefreshMock.getValidClaudeAiOAuth).toHaveBeenCalled();
    // 后续单条若不带能力字段,未知不能把刚精化的 xhigh 擦掉。
    noteAnthropicSdkSupportedModels([{ value: 'claude-fable-5', displayName: 'Fable' }]);
    expect(anthropicIds()).toHaveLength(4);
    expect(anthropicModel('claude-fable-5')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    // 逐个下架(4→3)是合法演进,照常生效。
    noteAnthropicSdkSupportedModels([
      { value: 'claude-fable-5', displayName: 'Fable 5' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-sonnet-5', displayName: 'Sonnet 5' },
    ]);
    expect(anthropicIds()).toHaveLength(3);
    expect(anthropicModel('claude-fable-5')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('无能力信息的捕获不打回已精化条目的档位 / fast(合并纪律)', () => {
    noteAnthropicSdkSupportedModels([
      {
        value: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        supportsFastMode: true,
      },
    ]);
    // 第二次捕获:同模型但 CLI 没填能力字段(未知 ≠ 不支持)。
    noteAnthropicSdkSupportedModels([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }]);
    expect(anthropicModel('claude-opus-4-8')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
  });

  it('磁盘恢复即用当前目录基线替换旧版缓存的三档合成值', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    const cacheFile = path.join(cacheDir, 'anthropic-models.json');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: '2026-07-22T00:00:00.000Z',
        models: [
          {
            id: 'claude-fable-5',
            name: 'Fable from stale cache',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
        ],
        // 旧整模型来源字段有歧义,不能据此把历史三档当成明确 effort。
        explicitCapabilityModelIds: ['claude-fable-5'],
      }),
      'utf-8',
    );
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicModel('claude-fable-5')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    oauthRefreshMock.getValidClaudeAiOAuth.mockResolvedValue({ accessToken: 'test-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [{ id: 'claude-fable-5', display_name: 'Fable 5', type: 'model' }],
          has_more: false,
        }),
      })),
    );
    await refreshAnthropicModelsFromHttp();

    expect(anthropicModel('claude-fable-5')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as {
      explicitEffortModelIds?: unknown;
      explicitFastModeModelIds?: unknown;
      models: Array<{ id: string; efforts: string[] }>;
    };
    expect(persisted.models.find((model) => model.id === 'claude-fable-5')?.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(persisted.explicitEffortModelIds).toEqual([]);
    expect(persisted.explicitFastModeModelIds).toEqual([]);
  });

  it('HTTP fast-only 响应跨重启只更新 fast,保留已持久化的明确 effort', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    const cacheFile = path.join(cacheDir, 'anthropic-models.json');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      cacheFile,
      JSON.stringify({
        fetchedAt: '2026-07-22T00:00:00.000Z',
        models: [
          {
            id: 'claude-fable-5',
            name: 'Fable from SDK',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high', 'xhigh'],
            defaultEffort: 'high',
            supportsFastMode: true,
            status: 'active',
          },
        ],
        explicitEffortModelIds: ['claude-fable-5', 'claude-removed-model'],
        explicitFastModeModelIds: ['claude-fable-5', 'claude-removed-model'],
      }),
      'utf-8',
    );
    await loadAnthropicModelsFromDiskCache();

    oauthRefreshMock.getValidClaudeAiOAuth.mockResolvedValue({ accessToken: 'test-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'claude-fable-5',
              display_name: 'Fable 5',
              type: 'model',
              capabilities: { fast_mode: false },
            },
          ],
          has_more: false,
        }),
      })),
    );
    await refreshAnthropicModelsFromHttp();

    expect(anthropicModel('claude-fable-5')).toMatchObject({
      name: 'Fable 5',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      supportsFastMode: false,
    });
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as {
      explicitEffortModelIds?: unknown;
      explicitFastModeModelIds?: unknown;
    };
    expect(persisted.explicitEffortModelIds).toEqual(['claude-fable-5']);
    expect(persisted.explicitFastModeModelIds).toEqual(['claude-fable-5']);
  });

  it('磁盘缓存会按当前目录修正未明确声明的旧窗口', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-19T00:00:00.000Z',
        models: [
          {
            id: 'claude-sonnet-4-5',
            name: 'Sonnet 4.5',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 1_000_000,
            efforts: [],
            defaultEffort: null,
            supportsFastMode: false,
            status: 'active',
          },
        ],
      }),
      'utf-8',
    );

    await loadAnthropicModelsFromDiskCache();

    expect(anthropicModel('claude-sonnet-4-5')?.contextWindow).toBe(200_000);
  });

  it('磁盘缓存按当前目录刷新非明确 effort,同时保留明确能力', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-22T00:00:00.000Z',
        models: [
          {
            id: 'claude-sonnet-5',
            name: 'Sonnet 5',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
          {
            id: 'claude-opus-5',
            name: 'Opus 5',
            group: 'anthropic',
            sortOrder: 1,
            contextWindow: 1_000_000,
            efforts: ['low', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
        ],
        explicitEffortModelIds: ['claude-opus-5'],
      }),
      'utf-8',
    );

    await loadAnthropicModelsFromDiskCache();

    expect(anthropicModel('claude-sonnet-5')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
    expect(anthropicModel('claude-opus-5')).toMatchObject({
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    });
  });

  it('磁盘缓存恢复 explicitWindows:重启后 SDK 捕获不把 HTTP 明说窗口打回猜测值(review P2 回归)', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-19T00:00:00.000Z',
        models: [
          {
            id: 'claude-opus-4-8',
            name: 'Opus 4.8',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 900_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
        ],
        explicitWindows: { 'claude-opus-4-8': 900_000 },
      }),
      'utf-8',
    );
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicModel('claude-opus-4-8')?.contextWindow).toBe(900_000);
    noteAnthropicSdkSupportedModels([
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    ]);
    // SDK 覆盖能力字段,但窗口保留 HTTP 明说的 900k,不回退 contextWindowFor 的 1M。
    expect(anthropicModel('claude-opus-4-8')).toMatchObject({
      contextWindow: 900_000,
      efforts: ['low', 'high'],
    });
  });
});

describe('HTTP 发现失败的归因与选择性重试', () => {
  const okResponse = {
    ok: true,
    json: async () => ({
      data: [{ id: 'claude-opus-4-8', display_name: 'Opus 4.8', type: 'model' }],
      has_more: false,
    }),
  };
  /** 非 2xx 响应:归因要读正文,所以 stub 必须给 text()。 */
  function errorResponse(status: number, body = '') {
    return { ok: false, status, text: async () => body };
  }
  const REGION_BLOCK_BODY = JSON.stringify({
    type: 'error',
    error: {
      type: 'unsupported_country_region_territory',
      message:
        'Access to Anthropic models is not allowed from unsupported countries, regions, or territories.',
    },
  });

  beforeEach(() => {
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    authState.loggedIn = true;
    credentialsMock.refreshToken = 'refresh-token';
    oauthRefreshMock.getValidClaudeAiOAuth.mockReset();
    oauthRefreshMock.getValidClaudeAiOAuth.mockResolvedValue({ accessToken: 'test-token' });
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await clearAnthropicDiscoveredModels();
    await waitForAnthropicDiscoveryIdleForTest();
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    vi.unstubAllGlobals();
    await fsp.rm(TEST_USER_DATA, { recursive: true, force: true });
  });

  it('连不上归 network,并把 undici 的 cause code 记进 detail', async () => {
    const err = new TypeError('fetch failed');
    (err as Error & { cause?: unknown }).cause = { code: 'ENOTFOUND' };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));

    await refreshAnthropicModelsFromHttp();

    const failure = getAnthropicModelDiscoveryFailure();
    expect(failure?.kind).toBe('network');
    expect(failure?.detail).toContain('ENOTFOUND');
    expect(typeof failure?.at).toBe('string');
  });

  it('超时归 timeout(TimeoutError 与 connect 超时 code 都算)', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('timeout');

    resetAnthropicDiscoveryForTest();
    const connectTimeout = new TypeError('fetch failed');
    (connectTimeout as Error & { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connectTimeout));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('timeout');
  });

  it('地域拒绝按正文识别,403 与 400 都算(状态码不足以判定)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(403, REGION_BLOCK_BODY)));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('regionBlocked');

    resetAnthropicDiscoveryForTest();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400, REGION_BLOCK_BODY)));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('regionBlocked');
  });

  it('同为 403 的 Cloudflare 式拒绝归 forbidden,不与地域拒绝混为一谈', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse(403, JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } })),
        ),
    );
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('forbidden');
  });

  it('401 归 unauthorized;408 归 timeout;5xx / 429 归 upstream;其它 4xx 归 rejected', async () => {
    for (const [status, kind] of [
      [401, 'unauthorized'],
      // 408 是上游 / 中间代理说「这次超时了」,与本地超时同源 —— 必须可重试。
      [408, 'timeout'],
      [503, 'upstream'],
      [429, 'upstream'],
      [418, 'rejected'],
    ] as const) {
      resetAnthropicDiscoveryForTest();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(status)));
      await refreshAnthropicModelsFromHttp();
      expect(getAnthropicModelDiscoveryFailure()?.kind).toBe(kind);
    }
  });

  it('200 但正文坏掉归 upstream(破损代理 / CDN 截断),不能说成「连不上」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }),
    );
    await refreshAnthropicModelsFromHttp();
    const failure = getAnthropicModelDiscoveryFailure();
    expect(failure?.kind).toBe('upstream');
    expect(failure?.detail).toContain('malformed response body');
  });

  it('401 先强制换一枚 token 重试一次;换到新 token 且成功就不该报「请重新连接」', async () => {
    oauthRefreshMock.getValidClaudeAiOAuth.mockReset();
    oauthRefreshMock.getValidClaudeAiOAuth
      .mockResolvedValueOnce({ accessToken: 'stale-token' })
      .mockResolvedValueOnce({ accessToken: 'fresh-token' })
      .mockResolvedValue({ accessToken: 'fresh-token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();

    expect(oauthRefreshMock.getValidClaudeAiOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ forceRefresh: true, staleToken: 'stale-token' }),
    );
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
  });

  it('强制换 token 后仍是 401 就如实报 unauthorized,不无限换', async () => {
    oauthRefreshMock.getValidClaudeAiOAuth.mockReset();
    oauthRefreshMock.getValidClaudeAiOAuth
      .mockResolvedValueOnce({ accessToken: 'stale-token' })
      .mockResolvedValue({ accessToken: 'fresh-token' });
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();

    // 首次 + 换 token 后一次,不再继续。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('unauthorized');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('换不到新 token(刷新失败 / 仍是同一枚)时直接如实报 unauthorized', async () => {
    oauthRefreshMock.getValidClaudeAiOAuth.mockReset();
    oauthRefreshMock.getValidClaudeAiOAuth.mockResolvedValue({ accessToken: 'stale-token' });
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('unauthorized');
  });

  it('200 但 data 不是 /v1/models 的形状归 upstream,不能一路走到 empty', async () => {
    // 典型:代理生成的 {"error":...} 却带 200。静默跳过会落到确定性的 empty(不重试),
    // 还会把上游故障说成「你的账号没有可用模型」。
    for (const payload of [{ error: { message: 'proxy failure' } }, { data: 'nope' }]) {
      resetAnthropicDiscoveryForTest();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
      await refreshAnthropicModelsFromHttp();
      const failure = getAnthropicModelDiscoveryFailure();
      expect(failure?.kind).toBe('upstream');
      expect(failure?.detail).toContain('unexpected payload shape');
    }
  });

  it('200 但根不是对象(JSON null / 标量 / 数组)也归 upstream,不是 network', async () => {
    // 直接取 .data 会抛 TypeError,落到 classifyDiscoveryError 的兜底就成了「连不上」,
    // 让用户白查网络和 Proxy。
    for (const payload of [null, 'oops', 42, [{ id: 'x' }]]) {
      resetAnthropicDiscoveryForTest();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
      await refreshAnthropicModelsFromHttp();
      const failure = getAnthropicModelDiscoveryFailure();
      expect(failure?.kind).toBe('upstream');
      expect(failure?.detail).toContain('unexpected payload root');
    }
  });

  it('has_more=true 但没有可用游标归 upstream,不把半截清单当完整清单', async () => {
    // 静默收尾会把「只翻了一页的前缀」当成完整清单交出去,而它完全可能小到刚好落进 shrink
    // 守卫的放行区间 —— 真清单被截断替换、失败态被清、也不排重试(PR #548 review)。
    const model = (id: string) => ({ id, display_name: id, type: 'model' });
    for (const bad of [{ has_more: true }, { has_more: true, last_id: 42 }, { has_more: true, last_id: '' }]) {
      resetAnthropicDiscoveryForTest();
      setAnthropicDiscoveredModels([]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ data: [model('claude-opus-4-8')], ...bad }),
        }),
      );
      await refreshAnthropicModelsFromHttp();
      expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('upstream');
      // 半截结果一律不生效。
      expect(anthropicIds()).toEqual([]);
    }
  });

  it('连接态由调用方给出时不再重读凭证库(macOS 上那是一次同步 Keychain 子进程)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await refreshAnthropicModelsFromHttp();

    // 显式传 false = 调用方已知未连接:不暴露失败态,且不去问凭证库。
    authState.loggedIn = true;
    expect(getAnthropicModelDiscoveryFailure(false)).toBeNull();
    // 显式传 true 同理:即便凭证库此刻说未登录,也按调用方给的连接态走。
    authState.loggedIn = false;
    expect(getAnthropicModelDiscoveryFailure(true)?.kind).toBe('network');
    // 不传时保持原有的自查语义。
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
  });

  it('答复正常但没有可用模型归 empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [], has_more: false }) }),
    );
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('empty');
  });

  it('data 非空却一条都映射不出来归 upstream(不是 empty),并继续重试', async () => {
    // 「这个账号没有可用模型」是确定性事实,该停;「上游答的结构不对」是故障,该重试。
    // 两者都会走到 mapped.length === 0,一律归 empty 就会既取消重试、又叫用户去查账号
    // 权限(PR #548 review)。
    const malformed = {
      ok: true,
      json: async () => ({ data: [{ type: 'model' }, { display_name: 'no id' }], has_more: false }),
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(malformed).mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    const failure = getAnthropicModelDiscoveryFailure();
    expect(failure?.kind).toBe('upstream');
    expect(failure?.detail).toContain('2 entries');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
  });

  it('401 后强制刷新自身故障归 upstream(不是 unauthorized),重试链继续', async () => {
    // token 端点超时 / 5xx / 拿不到刷新锁 ≠ 授权被拒。归 unauthorized 会取消全部重试、
    // 还叫用户去断开重连,而 refresh token 很可能完全有效(PR #548 review)。
    const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(401)).mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);
    oauthRefreshMock.getValidClaudeAiOAuth
      .mockResolvedValueOnce({ accessToken: 'test-token' }) // 首次取 token
      .mockRejectedValueOnce(new Error('token endpoint 503')) // 强制刷新失败
      .mockResolvedValue({ accessToken: 'test-token-2' });

    await refreshAnthropicModelsFromHttp();
    const failure = getAnthropicModelDiscoveryFailure();
    expect(failure?.kind).toBe('upstream');
    expect(failure?.detail).toContain('yielded nothing');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
  });

  it('强制刷新「返回 null」同样按 upstream 处理 —— 凭证还在且还能刷', async () => {
    // getValidClaudeAiOAuth 对超时 / 5xx / 抢不到锁是**返回 null**,不 reject。只认异常
    // 就会让这些最常见的暂时性失败仍旧落到 unauthorized(PR #548 review)。
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);
    oauthRefreshMock.getValidClaudeAiOAuth
      .mockResolvedValueOnce({ accessToken: 'test-token' })
      .mockResolvedValue(null); // 强制刷新没拿到新 token,也没抛

    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('upstream');
  });

  it('凭证已被判定失效(没有 refresh token)时仍归 unauthorized', async () => {
    // 与上一条相反的一侧:真的无从刷新,就该停下来告诉用户重新连接,而不是空转重试。
    credentialsMock.refreshToken = null;
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);
    oauthRefreshMock.getValidClaudeAiOAuth
      .mockResolvedValueOnce({ accessToken: 'test-token' })
      .mockResolvedValue(null);

    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('unauthorized');
  });

  it('暂时性失败(连不上)自动重试,成功即生效并清失败态', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();

    // 成功后退避计数归零,不再排下一次。
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('上游 5xx 同样自动重试(服务端侧故障可能几秒后自愈)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
  });

  it('暂时性失败持续不好转时退避有限次后停手,不做无限轮询', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    // 首次 + 3 次退避重试(2s / 8s / 30s)后停手。
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('地域拒绝一次都不重试 —— 同一请求再发一百次也是同一答复', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, REGION_BLOCK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('regionBlocked');
  });

  it('凭证被拒 / 请求被拒 / 空清单同样不重试', async () => {
    for (const [status, body] of [
      [401, ''],
      [403, JSON.stringify({ error: { type: 'forbidden' } })],
      [418, ''],
    ] as const) {
      resetAnthropicDiscoveryForTest();
      const fetchMock = vi.fn().mockResolvedValue(errorResponse(status, body));
      vi.stubGlobal('fetch', fetchMock);
      await refreshAnthropicModelsFromHttp();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('确定性拒绝会取消上一轮暂时性失败排下的重试,失败理由不在两者间跳变', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(errorResponse(403, REGION_BLOCK_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');

    // 排下的那次重试跑出「地域拒绝」——此后不该再有任何自动重试。
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('regionBlocked');

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('退避耗尽后,外部触发重开一轮退避(手动重试 / 认领不能只剩单次请求)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    // 第一轮:首次 + 三档退避后停手。
    await refreshAnthropicModelsFromHttp();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // 用户点「重试」= 外部触发:必须重新开一轮退避,而不是只发一次就再次卡死。
    await refreshAnthropicModelsFromHttp();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('失败记账会通知收口,让已取走快照的 renderer 能重取到失败理由', async () => {
    const onFailureChanged = vi.fn();
    setAnthropicDiscoveryFailureListener(onFailureChanged);
    try {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      await refreshAnthropicModelsFromHttp();
      expect(onFailureChanged).toHaveBeenCalled();
    } finally {
      setAnthropicDiscoveryFailureListener(null);
    }
  });

  it('失败后成功但清单未变时同样通知 —— apply 的 early return 会吞掉这次广播', async () => {
    // 先成功一次拿到清单,再失败,再用**同一份**清单成功:applyModels 因为 modelsChanged
    // 为 false 直接 early return、不 markChanged,只有清失败态这条通知能让 UI 知道恢复了。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);

    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');

    const onFailureChanged = vi.fn();
    setAnthropicDiscoveryFailureListener(onFailureChanged);
    try {
      await refreshAnthropicModelsFromHttp();
      expect(getAnthropicModelDiscoveryFailure()).toBeNull();
      expect(onFailureChanged).toHaveBeenCalled();
    } finally {
      setAnthropicDiscoveryFailureListener(null);
    }
  });

  it('通知收口抛错不打断发现流程', async () => {
    setAnthropicDiscoveryFailureListener(() => {
      throw new Error('broadcast boom');
    });
    try {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      await expect(refreshAnthropicModelsFromHttp()).resolves.toBeUndefined();
      expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');
    } finally {
      setAnthropicDiscoveryFailureListener(null);
    }
  });

  it('未登录时不暴露失败态(该讲的是「去连接」,不是上一个账号的失败理由)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');

    authState.loggedIn = false;
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
  });

  it('408 走重试链(不是被 rejected 挡死)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(408))
      .mockResolvedValue(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
  });

  it('首次就失败时,登出 / 换号仍要通知 —— applyModels([]) 那条路不广播', async () => {
    // lastApplied 本来就是空,applyModels([]) 走「清单没变」早退;不补通知的话 device-link
    // 对端会一直留着旧的失败理由(本地窗口只是碰巧有 auth 事件兜底)。
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()).not.toBeNull();
    expect(anthropicIds()).toEqual([]);

    const onFailureChanged = vi.fn();
    setAnthropicDiscoveryFailureListener(onFailureChanged);
    try {
      await clearAnthropicDiscoveredModels();
      expect(onFailureChanged).toHaveBeenCalled();
      expect(getAnthropicModelDiscoveryFailure()).toBeNull();
    } finally {
      setAnthropicDiscoveryFailureListener(null);
    }
  });

  it('快照被退化守卫拒绝 = 上游已经答了,过期的失败理由必须一起清掉', async () => {
    // 有旧清单 + 上一轮记了 network:此刻上游其实已经能连上,只是这次回来的快照太短被守卫
    // 挡下、旧清单原样留用 —— 用户手里明明有模型可选,UI 却还挂着「连不上」;而这条早退路径
    // 既不记新失败也不排重试,过期理由会一直挂到下次成功发现(PR #548 review)。
    const model = (id: string) => ({ id, display_name: id, type: 'model' });
    const wide = {
      ok: true,
      json: async () => ({
        data: ['claude-opus-4-8', 'claude-sonnet-4-8', 'claude-haiku-4-8', 'claude-opus-4-7'].map(model),
        has_more: false,
      }),
    };
    const shrunk = {
      ok: true,
      json: async () => ({ data: [model('claude-opus-4-8')], has_more: false }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wide)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(shrunk);
    vi.stubGlobal('fetch', fetchMock);

    await refreshAnthropicModelsFromHttp();
    expect(anthropicIds()).toHaveLength(4);

    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()?.kind).toBe('network');

    const onFailureChanged = vi.fn();
    setAnthropicDiscoveryFailureListener(onFailureChanged);
    try {
      // network 排的重试到点 —— 这次上游答了,但快照退化被拒。
      await vi.advanceTimersByTimeAsync(2_000);
      expect(anthropicIds()).toHaveLength(4); // 旧清单保住
      expect(getAnthropicModelDiscoveryFailure()).toBeNull();
      expect(onFailureChanged).toHaveBeenCalled();
    } finally {
      setAnthropicDiscoveryFailureListener(null);
    }
    // 失败态已清 = 重试链也停了,不再按退避空转打网络。
    const callsSoFar = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsSoFar);
  });

  it('登出 / 换号清掉失败态与待执行的重试', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await refreshAnthropicModelsFromHttp();
    expect(getAnthropicModelDiscoveryFailure()).not.toBeNull();

    await clearAnthropicDiscoveredModels();
    expect(getAnthropicModelDiscoveryFailure()).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
