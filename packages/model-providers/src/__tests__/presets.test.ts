/**
 * presets 段（自定义供应商创建模板）的解析容错 + 合并兜底。
 *
 * 关键不变量：
 *   - presets 是纯 UI 模板数据，坏条目**逐条丢弃**，绝不让整份目录 parse 失败回退 bundled；
 *   - mergeWithBundled：远端带 presets 用远端的，远端没带回落 bundled 的；
 *   - BUNDLED_CATALOG 自带的首批预设本身合法（每条至少一个 runtime、字段完整）。
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG, parseCatalog, presetDisplayName, sanitizePresets, sortPresetsForLocale } from '../catalog.js';
import { mergeWithBundled } from '../source.js';
import type { Catalog } from '../types.js';

/** 最小合法目录（单 provider）。 */
function minimalCatalog(extra?: Partial<Catalog>): Catalog {
  return {
    version: 'test',
    providers: [
      {
        id: 'p1',
        name: 'P1',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'apiKey' },
        routing: { 'claude-code': { upstream: 'https://x.example', authStrategy: 'api-key-header' } },
        models: {
          'claude-code': [
            { id: 'm1', name: 'M1', contextWindow: 1000, efforts: [], defaultEffort: null },
          ],
        },
      },
    ],
    ...extra,
  };
}

const VALID_PRESET = {
  id: 'openrouter',
  name: 'OpenRouter',
  runtimes: {
    'claude-code': { baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'a', name: 'A' }] },
  },
};

describe('sanitizePresets', () => {
  it('保留合法条目、丢弃坏条目，不抛错', () => {
    const out = sanitizePresets([
      VALID_PRESET,
      null,
      42,
      { id: '', name: 'x', runtimes: {} }, // id 空
      { id: 'no-runtime', name: 'X', runtimes: {} }, // 无 runtime
      { id: 'bad-agent', name: 'X', runtimes: { gemini: { baseUrl: 'https://x', models: [] } } }, // 非法 agent
      { id: 'bad-model', name: 'X', runtimes: { codex: { baseUrl: 'https://x', models: [{ id: '' }] } } },
    ]);
    expect(out.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('按 id 去重（first-wins）', () => {
    const out = sanitizePresets([VALID_PRESET, { ...VALID_PRESET, name: 'Dup' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('OpenRouter');
  });

  it('非数组输入返回空数组', () => {
    expect(sanitizePresets(undefined)).toEqual([]);
    expect(sanitizePresets({})).toEqual([]);
  });

  it('modelsUrl 合法保留；非法（空串 / 非字符串 / 非 http(s)）剥字段不淘汰整条', () => {
    const rt = (modelsUrl: unknown) => ({
      'claude-code': {
        baseUrl: 'https://x.example/anthropic',
        models: [{ id: 'a', name: 'A' }],
        modelsUrl,
      },
    });
    const out = sanitizePresets([
      { id: 'with-url', name: 'X', runtimes: rt('https://x.example/v1/models') },
      { id: 'bad-empty', name: 'X', runtimes: rt('') },
      { id: 'bad-type', name: 'X', runtimes: rt(42) },
      { id: 'bad-proto', name: 'X', runtimes: rt('ftp://x.example/models') },
    ]);
    expect(out.map((p) => p.id)).toEqual(['with-url', 'bad-empty', 'bad-type', 'bad-proto']);
    expect(out[0]!.runtimes['claude-code']?.modelsUrl).toBe('https://x.example/v1/models');
    for (const p of out.slice(1)) {
      expect(p.runtimes['claude-code']?.modelsUrl).toBeUndefined();
    }
  });
});

describe('parseCatalog presets 容错', () => {
  it('presets 含坏条目时目录仍解析成功、坏条目被清洗', () => {
    const parsed = parseCatalog(minimalCatalog({ presets: [VALID_PRESET, { broken: true }] as never }));
    expect(parsed.presets?.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('presets 全坏 / 缺省时不产出空数组字段', () => {
    expect(parseCatalog(minimalCatalog()).presets).toBeUndefined();
    expect(parseCatalog(minimalCatalog({ presets: [{ broken: true }] as never })).presets).toBeUndefined();
  });
});

describe('mergeWithBundled presets 兜底', () => {
  it('远端带 presets → 用远端的', () => {
    const merged = mergeWithBundled(minimalCatalog({ presets: [VALID_PRESET] }));
    expect(merged.presets?.map((p) => p.id)).toEqual(['openrouter']);
  });

  it('远端没带 presets → 回落 bundled 的', () => {
    const merged = mergeWithBundled(minimalCatalog());
    expect(merged.presets).toEqual(BUNDLED_CATALOG.presets);
    expect(merged.presets?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('presetDisplayName', () => {
  it('中文 locale 用 name;其它 locale 优先 nameEn,缺省回落 name', () => {
    const p = { name: '智谱 GLM(中国大陆)', nameEn: 'Zhipu GLM (China)' };
    expect(presetDisplayName(p, 'zh-CN')).toBe('智谱 GLM(中国大陆)');
    expect(presetDisplayName(p, 'zh')).toBe('智谱 GLM(中国大陆)');
    expect(presetDisplayName(p, 'en')).toBe('Zhipu GLM (China)');
    expect(presetDisplayName(p, 'ja')).toBe('Zhipu GLM (China)');
    // 无 nameEn(全球厂商预设本就是英文名)→ 一律回落 name。
    expect(presetDisplayName({ name: 'DeepSeek' }, 'en')).toBe('DeepSeek');
    expect(presetDisplayName({ name: 'DeepSeek' }, 'zh-CN')).toBe('DeepSeek');
  });
});

describe('regionHint 归一化与 locale 排序', () => {
  const mk = (id: string, regionHint?: unknown) =>
    ({ ...VALID_PRESET, id, ...(regionHint !== undefined ? { regionHint } : {}) }) as never;

  it('非法 regionHint 不淘汰预设，归一化为区域中立', () => {
    const out = sanitizePresets([mk('a', 'mars')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.regionHint).toBeUndefined();
  });

  it('非法 nameEn(非字符串/空白串)剥字段;与非法 regionHint 同现时两者都被清洗(Codex P2 回归)', () => {
    const out = sanitizePresets([
      { ...VALID_PRESET, id: 'a', nameEn: 42 } as never,
      { ...VALID_PRESET, id: 'b', nameEn: '   ' } as never,
      // 两字段同时非法:早退式清洗会漏掉 nameEn。
      { ...VALID_PRESET, id: 'c', regionHint: 'mars', nameEn: 42 } as never,
      { ...VALID_PRESET, id: 'd', nameEn: 'OpenRouter Intl' } as never,
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((p) => p.nameEn)).toEqual([undefined, undefined, undefined, 'OpenRouter Intl']);
    expect(out[2]!.regionHint).toBeUndefined();
  });

  it('厂商按首字母分组排序；同厂商 cn/global 相邻，组内按语言排先后', () => {
    const presets = sanitizePresets([
      mk('zhipu-glm-global', 'global'),
      mk('openrouter', 'global'),
      mk('zhipu-glm-cn', 'cn'),
      mk('deepseek'),
      mk('minimax-cn', 'cn'),
      mk('minimax-global', 'global'),
    ]);
    // zh：厂商序 deepseek < minimax < openrouter < zhipu-glm；组内 cn 在前。
    expect(sortPresetsForLocale(presets, 'zh-CN').map((p) => p.id)).toEqual([
      'deepseek', 'minimax-cn', 'minimax-global', 'openrouter', 'zhipu-glm-cn', 'zhipu-glm-global',
    ]);
    // en/ja：厂商序不变，组内 global 在前。
    expect(sortPresetsForLocale(presets, 'en').map((p) => p.id)).toEqual([
      'deepseek', 'minimax-global', 'minimax-cn', 'openrouter', 'zhipu-glm-global', 'zhipu-glm-cn',
    ]);
    expect(sortPresetsForLocale(presets, 'ja').map((p) => p.id)).toEqual(
      sortPresetsForLocale(presets, 'en').map((p) => p.id),
    );
  });

  it('内置目录的双端点厂商 cn/global 各有一条', () => {
    const presets = BUNDLED_CATALOG.presets ?? [];
    for (const vendor of ['zhipu-glm', 'moonshot-kimi', 'minimax']) {
      expect(presets.find((p) => p.id === `${vendor}-cn`)?.regionHint).toBe('cn');
      expect(presets.find((p) => p.id === `${vendor}-global`)?.regionHint).toBe('global');
    }
  });
});

describe('parseCatalog provider.id 字符集校验', () => {
  it('含路径分隔等非法字符的 id 拒绝解析（防拼进 safeStorage 键名逃逸目录）', () => {
    const bad = minimalCatalog();
    (bad.providers[0] as { id: string }).id = 'x/../../oauth';
    expect(() => parseCatalog(bad)).toThrow(/illegal characters/);
  });
});

describe('parseCatalog oauth 描述符校验', () => {
  const oauth = {
    authorizeUrl: 'https://auth.acme.example/authorize',
    tokenUrl: 'https://auth.acme.example/token',
    clientId: 'c1',
    scopes: 'openid',
  };

  function catalogWithAuth(auth: unknown): Catalog {
    const c = minimalCatalog();
    (c.providers[0] as { auth: unknown }).auth = auth;
    return c;
  }

  it('完整描述符通过', () => {
    expect(() => parseCatalog(catalogWithAuth({ method: 'oauth', oauth }))).not.toThrow();
  });

  it('缺字段 / 非 https / 非法端口 → parse 失败（回退 bundled 的路径）', () => {
    expect(() => parseCatalog(catalogWithAuth({ method: 'oauth', oauth: { ...oauth, tokenUrl: '' } }))).toThrow(
      /tokenUrl/,
    );
    expect(() =>
      parseCatalog(catalogWithAuth({ method: 'oauth', oauth: { ...oauth, authorizeUrl: 'http://x.example' } })),
    ).toThrow(/https/);
    expect(() =>
      parseCatalog(catalogWithAuth({ method: 'oauth', oauth: { ...oauth, redirectPort: 99999 } })),
    ).toThrow(/redirectPort/);
  });

  it('扩展参数不能覆盖 OAuth 标准字段', () => {
    expect(() =>
      parseCatalog(catalogWithAuth({
        method: 'oauth',
        oauth: { ...oauth, extraAuthParams: { state: 'fixed-state' } },
      })),
    ).toThrow(/cannot override 'state'/);
    expect(() =>
      parseCatalog(catalogWithAuth({
        method: 'oauth',
        oauth: {
          flow: 'device-code',
          deviceAuthorizationUrl: 'https://auth.acme.example/device',
          tokenUrl: oauth.tokenUrl,
          clientId: oauth.clientId,
          scopes: oauth.scopes,
          extraDeviceParams: { client_id: 'other-client' },
        },
      })),
    ).toThrow(/cannot override 'client_id'/);
  });

  it('不带描述符的 oauth 供应商（bespoke 现状）不受影响', () => {
    expect(() => parseCatalog(catalogWithAuth({ method: 'oauth' }))).not.toThrow();
  });
});

describe('BUNDLED_CATALOG 首批预设自检', () => {
  it('内置预设逐条合法（sanitize 后无损）', () => {
    const presets = BUNDLED_CATALOG.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(sanitizePresets(presets)).toHaveLength(presets.length);
  });

  it('内置预设 baseUrl 均为 https', () => {
    for (const p of BUNDLED_CATALOG.presets ?? []) {
      for (const rt of Object.values(p.runtimes)) {
        expect(rt.baseUrl.startsWith('https://')).toBe(true);
      }
    }
  });
});

describe('MiniMax OpenAI Responses 预设契约 (issue #345)', () => {
  it.each([
    {
      id: 'minimax-cn',
      docsUrl: 'https://platform.minimaxi.com/docs/api-reference/responses-create',
      codexBaseUrl: 'https://api.minimaxi.com/v1',
    },
    {
      id: 'minimax-global',
      docsUrl: 'https://platform.minimax.io/docs/api-reference/responses-create',
      codexBaseUrl: 'https://api.minimax.io/v1',
    },
  ])('$id 同时提供 Anthropic 与 Responses runtime', ({ id, docsUrl, codexBaseUrl }) => {
    const preset = BUNDLED_CATALOG.presets?.find((candidate) => candidate.id === id);
    expect(preset?.docsUrl).toBe(docsUrl);
    expect(preset?.runtimes['claude-code']?.baseUrl).toMatch(/\/anthropic$/);
    expect(preset?.runtimes.codex).toEqual({
      baseUrl: codexBaseUrl,
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000 },
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      ],
    });
  });
});
