/**
 * model-discovery/anthropic 单测。
 *
 * 覆盖:SDK ModelInfo 映射(别名过滤 / dated id 与 [1m] 归一 / 能力字段在场 = 权威、
 * 全缺席 = 未知按确定性默认合成 / haiku 默认收起)、contextWindow 规则(旧缓存明示 >
 * 目录 > 默认 1M / haiku 200k)、
 * SDK 捕获入口的登录态门控(hasClaudeNativeLogin)与合并纪律(登出不注入 / 无能力信息
 * 保留已精化条目 / 退化快照只合并能力补丁 / 旧版 HTTP 明说窗口不被 SDK 打回猜测值 /
 * 磁盘缓存恢复 explicitWindows)。
 * Claude 订阅凭证只在内置 Claude Code CLI 里,Cindy 不再直连 Anthropic `/v1/models`,
 * 因此这里没有 HTTP 通道:SDK 捕获路径也不得发出任何网络请求。
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

// 登录态门控:「Cindy 已连接本机 Claude Code 登录」(CLI 已登录 + Cindy 绑定)。
const authState = vi.hoisted(() => ({ loggedIn: true }));
vi.mock('../claude-native-auth.js', () => ({
  hasClaudeNativeLogin: () => authState.loggedIn,
  hasClaudeNativeLoginUnbound: () => authState.loggedIn,
}));

import {
  isDegenerateModelListShrink,
  mapAnthropicSdkModels,
  noteAnthropicSdkSupportedModels,
  loadAnthropicModelsFromDiskCache,
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

/**
 * registry-free 基线:本文件验 discovery 登录门控/合并纪律,与 registry 实体化层
 * (bundled registry 的 status=active 条目会独立长实体,见 modelPlane.test.ts)隔离。
 */
function bundledWithoutRegistry(): Catalog {
  const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  delete catalog.modelRegistry;
  return catalog;
}

beforeEach(() => {
  setActiveCatalog(bundledWithoutRegistry());
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
    setActiveCatalog(BUNDLED_CATALOG); // 这三例正要用 bundled registry 的官方窗口基线

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
    // 目录窗口是显式声明的真实上限,可用于收敛运行期上报值。
    expect(out.every(({ model }) => model.contextWindowVerified === true)).toBe(true);
  });

  it('未知新模型的启发式窗口不标记为已核实(不得拿它收敛上报值)', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-sonnet-9-unknown', displayName: 'Sonnet 9' },
      { value: 'claude-haiku-9-unknown', displayName: 'Haiku 9' },
    ]);
    // 目录没有该模型、也没有旧缓存明示窗口 → 1M / 200k 是猜的,只能展示。
    expect(out[0].model.contextWindow).toBe(1_000_000);
    expect(out[0].model.contextWindowVerified).toBeUndefined();
    expect(out[1].model.contextWindow).toBe(200_000);
    expect(out[1].model.contextWindowVerified).toBeUndefined();
  });

  it('active registry 快照提供窗口和 effort 基线', () => {
    const catalog = bundledWithoutRegistry();
    catalog.modelRegistry = {
      schemaVersion: 1,
      updatedAt: '2026-07-31T00:00:00.000Z',
      models: [
        {
          id: 'anthropic/claude-sonnet-4-5',
          name: 'Remote Sonnet 4.5',
          contextWindow: 200_000,
          efforts: [],
          routes: [{
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            agents: ['claude-code'],
          }],
        },
        {
          id: 'anthropic/claude-opus-5',
          name: 'Opus 5',
          contextWindow: 1_000_000,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'high',
          routes: [{
            providerId: 'anthropic',
            modelId: 'claude-opus-5',
            agents: ['claude-code'],
          }],
        },
      ],
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

  it('[1m] 长上下文后缀归一并去重(顶栏误报「已断开」回归):目录基线按裸 id 命中', () => {
    const out = mapAnthropicSdkModels([
      { value: 'claude-fable-5[1m]', displayName: 'Fable 5' },
      { value: 'claude-fable-5', displayName: 'Fable 5 dup' },
      { value: 'claude-opus-4-8-20260401[1m]', displayName: 'Opus 4.8' },
    ]);
    expect(out.map((e) => e.model.id)).toEqual(['claude-fable-5', 'claude-opus-4-8']);
    expect(out[0].model.name).toBe('Fable 5'); // first-wins
    // 归一化前 [1m] id 查不到 registry 基线,会塌回合成三档;归一化后按裸 id 命中。
    expect(out[0].model.efforts).toContain('xhigh');
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

describe('noteAnthropicSdkSupportedModels(登录态门控 + 合并纪律)', () => {
  // Cindy 不持有订阅凭证,发现路径(SDK 捕获 / 缓存加载 / 退化合并)一律不得直连网络。
  const fetchSpy = vi.fn(async () => {
    throw new Error('anthropic model discovery must not perform HTTP requests');
  });

  beforeEach(() => {
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    authState.loggedIn = true;
    fetchSpy.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(async () => {
    await clearAnthropicDiscoveredModels();
    await waitForAnthropicDiscoveryIdleForTest();
    expect(fetchSpy).not.toHaveBeenCalled();
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

    // 模拟 CLI 登录已换成账号 B、但 B 的 SDK 捕获尚未返回任何清单。
    await clearAnthropicDiscoveredModels();

    expect(anthropicIds()).toEqual([]);
    await expect(fsp.access(cache)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('SDK 捕获落盘后重启可从磁盘缓存恢复,逐字段明确来源一起恢复', async () => {
    noteAnthropicSdkSupportedModels([
      {
        value: 'claude-fable-5',
        displayName: 'Fable 5',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsFastMode: true,
      },
    ]);
    await waitForAnthropicDiscoveryIdleForTest();
    const cacheFile = path.join(TEST_USER_DATA, 'model-discovery', 'anthropic-models.json');
    const persisted = JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as Record<string, unknown>;
    expect(persisted.explicitEffortModelIds).toEqual(['claude-fable-5']);
    expect(persisted.explicitFastModeModelIds).toEqual(['claude-fable-5']);
    // HTTP 骤减收敛已随 HTTP 通道一起移除,缓存不再携带 pendingShrink 记账。
    expect(persisted).not.toHaveProperty('pendingShrink');

    // 「重启」:清内存态后仅凭磁盘缓存恢复;明确 effort 不被目录基线刷新覆盖。
    resetAnthropicDiscoveryForTest();
    setAnthropicDiscoveredModels([]);
    expect(anthropicIds()).toEqual([]);
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicModel('claude-fable-5')).toMatchObject({
      name: 'Fable 5',
      efforts: ['low', 'high'],
      supportsFastMode: true,
    });
  });

  it('未连接本机 Claude Code 登录时不加载残留磁盘缓存', async () => {
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
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
        ],
      }),
      'utf-8',
    );

    authState.loggedIn = false;
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicIds()).toEqual([]);

    // 同一份缓存在已连接时正常恢复,证明上面是门控而非缓存本身无效。
    authState.loggedIn = true;
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicIds()).toEqual(['claude-opus-4-8']);
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

  it('磁盘缓存脏 id 自愈:历史缓存里的 [1m] 后缀 id 加载时归一化 + 去重 + 记账跟随', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    const dirtyModel = (id: string, name: string, sortOrder: number) => ({
      id,
      name,
      group: 'anthropic',
      sortOrder,
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsFastMode: false,
      status: 'active',
    });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-30T00:00:00.000Z',
        models: [
          dirtyModel('claude-fable-5[1m]', 'Fable 5', 0),
          dirtyModel('claude-fable-5', 'Fable 5 dup', 1),
          dirtyModel('claude-opus-4-8', 'Opus 4.8', 2),
        ],
        explicitWindows: { 'claude-fable-5[1m]': 800_000 },
        explicitEffortModelIds: ['claude-fable-5[1m]'],
      }),
      'utf-8',
    );

    await loadAnthropicModelsFromDiskCache();
    // 脏 id 归一化 + first-wins 去重:选中 claude-fable-5 的会话恢复来源匹配。
    expect(anthropicIds()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
    expect(anthropicModel('claude-fable-5')?.name).toBe('Fable 5');

    // explicitWindows / explicitEffort 记账按归一化 id 跟随:后续 SDK 捕获(注册表仍报
    // [1m] 变体)归一化后能命中记账——精确窗口不被打回猜测值,已精化档位不被抹掉。
    noteAnthropicSdkSupportedModels([{ value: 'claude-fable-5[1m]', displayName: 'Fable 5' }]);
    expect(anthropicModel('claude-fable-5')?.contextWindow).toBe(800_000);
    expect(anthropicModel('claude-fable-5')?.efforts).toEqual(['low', 'medium', 'high']);
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
    // 退化快照不再触发任何 HTTP 兜底刷新(订阅凭证只在 CLI 内,Cindy 不直连 Anthropic)。
    expect(fetchSpy).not.toHaveBeenCalled();
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

    // 下一次 SDK 捕获同样不带能力字段:目录基线沿用,来源仍记为非明确。
    noteAnthropicSdkSupportedModels([{ value: 'claude-fable-5', displayName: 'Fable 5' }]);
    await waitForAnthropicDiscoveryIdleForTest();

    expect(anthropicModel('claude-fable-5')).toMatchObject({
      name: 'Fable 5',
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

  it('SDK fast-only 捕获跨重启只更新 fast,保留已持久化的明确 effort', async () => {
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

    noteAnthropicSdkSupportedModels([
      { value: 'claude-fable-5', displayName: 'Fable 5', supportsFastMode: false },
    ]);
    await waitForAnthropicDiscoveryIdleForTest();

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
    setActiveCatalog(BUNDLED_CATALOG);

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

  it('磁盘缓存恢复 explicitWindows:重启后 SDK 捕获不把旧版 HTTP 明说窗口打回猜测值(review P2 回归)', async () => {
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
    // SDK 覆盖能力字段,但窗口保留旧缓存里 HTTP 明说的 900k,不回退 contextWindowFor 的 1M。
    expect(anthropicModel('claude-opus-4-8')).toMatchObject({
      contextWindow: 900_000,
      efforts: ['low', 'high'],
    });
  });

  // 磁盘缓存里可能带着上一版目录算出的 contextWindowVerified。若该模型在新版目录里被移除、
  // 且不在 explicitWindows(命中目录的窗口不进那张表)里,重载会走启发式分支 —— 残留的
  // true 会盖在猜测值上,得到一个「已核实」的启发式窗口。Haiku 这种残留 200K 而运行期真实
  // 1M 的情形,反倒会把上报值压小,正是本 PR 要消除的失败模式。
  it('磁盘缓存重载抹掉旧 provenance,不让启发式窗口冒充已核实', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-19T00:00:00.000Z',
        models: [
          {
            // 目录里没有这个 id、也没有 explicitWindows 记录 → 重载必须落到启发式。
            id: 'claude-haiku-removed-from-catalog',
            name: 'Haiku (removed)',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 200_000,
            contextWindowVerified: true, // 上一版目录留下的陈旧标记
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

    const reloaded = anthropicModel('claude-haiku-removed-from-catalog');
    // 窗口按启发式重算(id 含 haiku → 200K),但**不得**再声称已核实。
    expect(reloaded?.contextWindow).toBe(200_000);
    expect(reloaded?.contextWindowVerified).toBeUndefined();
  });

  // 目录里**没有**的新模型:旧版缓存里 HTTP 记下的 max_input_tokens 是它唯一的已核实窗口。SDK 通道
  // 重新映射时走「无 explicit」分支(落到启发式、不带标记),恢复 explicitWindows 时
  // 只覆盖 contextWindow 会把 provenance 静默擦掉 —— 之后就不再用这个真实上限收敛
  // 虚高的上报值了。
  it('SDK 重映射不得擦掉旧缓存 HTTP 明说窗口的 provenance(目录未覆盖的新模型)', async () => {
    const cacheDir = path.join(TEST_USER_DATA, 'model-discovery');
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(
      path.join(cacheDir, 'anthropic-models.json'),
      JSON.stringify({
        fetchedAt: '2026-07-19T00:00:00.000Z',
        models: [
          {
            id: 'claude-brandnew-9',
            name: 'Brand New 9',
            group: 'anthropic',
            sortOrder: 0,
            contextWindow: 640_000,
            contextWindowVerified: true,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
            supportsFastMode: false,
            status: 'active',
          },
        ],
        explicitWindows: { 'claude-brandnew-9': 640_000 },
      }),
      'utf-8',
    );
    await loadAnthropicModelsFromDiskCache();
    expect(anthropicModel('claude-brandnew-9')).toMatchObject({
      contextWindow: 640_000,
      contextWindowVerified: true,
    });

    noteAnthropicSdkSupportedModels([
      { value: 'claude-brandnew-9', displayName: 'Brand New 9', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    ]);
    expect(anthropicModel('claude-brandnew-9')).toMatchObject({
      contextWindow: 640_000,
      // 关键:标记必须一起恢复,不能只留数值。
      contextWindowVerified: true,
      efforts: ['low', 'high'],
    });
  });
});
