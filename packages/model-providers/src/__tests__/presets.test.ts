/**
 * presets 段（自定义供应商创建模板）的解析容错 + 合并兜底。
 *
 * 关键不变量：
 *   - presets 是纯 UI 模板数据，坏条目**逐条丢弃**，绝不让整份目录 parse 失败回退 bundled；
 *   - mergeWithBundled：远端与 bundled 按 id 合并，同 id 远端优先、bundled 补缺；
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
  it('accepts explicit Pi reasoning metadata and rejects ambiguous capability declarations', () => {
    const piReasoning = {
      ...VALID_PRESET,
      id: 'pi-reasoning',
      runtimes: {
        pi: {
          baseUrl: 'https://example.com/v1',
          wireProtocol: 'openai-responses',
          models: [
            {
              id: 'reasoner',
              name: 'Reasoner',
              reasoning: true,
              reasoningEfforts: ['low', 'high', 'xhigh'],
            },
          ],
        },
      },
    };
    expect(sanitizePresets([piReasoning])).toEqual([piReasoning]);
    expect(
      sanitizePresets([
        {
          ...piReasoning,
          id: 'missing-efforts',
          runtimes: {
            pi: {
              ...piReasoning.runtimes.pi,
              models: [{ id: 'reasoner', name: 'Reasoner', reasoning: true }],
            },
          },
        },
      ]),
    ).toEqual([]);
    expect(
      sanitizePresets([
        {
          ...piReasoning,
          id: 'wrong-runtime',
          runtimes: {
            codex: {
              baseUrl: 'https://example.com/v1',
              models: [
                {
                  id: 'reasoner',
                  name: 'Reasoner',
                  reasoning: true,
                  reasoningEfforts: ['high'],
                },
              ],
            },
          },
        },
      ]),
    ).toEqual([]);
  });

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

  it('authMethod / baseUrlEditable 只接受受支持的枚举与布尔值', () => {
    const valid = {
      ...VALID_PRESET,
      id: 'local-proxy',
      authMethod: 'none',
      runtimes: {
        codex: {
          baseUrl: 'http://127.0.0.1:4000/v1',
          baseUrlEditable: true,
          models: [{ id: 'local', name: 'Local' }],
        },
      },
    };
    expect(sanitizePresets([valid])).toEqual([valid]);
    expect(sanitizePresets([{ ...valid, id: 'bad-auth', authMethod: 'oauth' }])).toEqual([]);
    expect(sanitizePresets([{
      ...valid,
      id: 'bad-editable',
      runtimes: { codex: { ...valid.runtimes.codex, baseUrlEditable: 'yes' } },
    }])).toEqual([]);
  });

  it('Pi 图片输入能力只接受显式布尔值', () => {
    const visual = {
      id: 'visual-pi',
      name: 'Visual Pi',
      runtimes: {
        pi: {
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'vision', name: 'Vision', supportsImageInput: true }],
        },
      },
    };
    expect(sanitizePresets([visual])).toEqual([visual]);
    expect(sanitizePresets([{
      ...visual,
      runtimes: {
        pi: {
          ...visual.runtimes.pi,
          models: [{ id: 'vision', name: 'Vision', supportsImageInput: 'yes' }],
        },
      },
    }])).toEqual([]);
  });

  it('requestPath 合法时保留；跨主机、fragment 与 CRLF 形态剥字段但保留预设', () => {
    const runtime = (requestPath: unknown) => ({
      codex: {
        baseUrl: 'https://x.example/v1',
        models: [{ id: 'm', name: 'M' }],
        requestPath,
      },
    });
    const out = sanitizePresets([
      { id: 'good-path', name: 'Good', runtimes: runtime('/custom/infer?tenant=1') },
      { id: 'authority-path', name: 'Bad', runtimes: runtime('//evil.example/infer') },
      { id: 'fragment-path', name: 'Bad', runtimes: runtime('/infer#secret') },
      { id: 'newline-path', name: 'Bad', runtimes: runtime('/infer\r\nx: y') },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]!.runtimes.codex?.requestPath).toBe('/custom/infer?tenant=1');
    for (const preset of out.slice(1)) {
      expect(preset.runtimes.codex?.requestPath).toBeUndefined();
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
  it('远端 presets 与 bundled 按 id 合并：远端同 id 优先，bundled 缺项不丢', () => {
    const merged = mergeWithBundled(minimalCatalog({ presets: [VALID_PRESET] }));
    expect(merged.presets?.find((preset) => preset.id === 'openrouter')).toEqual(VALID_PRESET);
    expect(merged.presets?.map((preset) => preset.id)).toEqual(
      BUNDLED_CATALOG.presets?.map((preset) => preset.id),
    );
    expect(merged.presets?.map((preset) => preset.id)).toEqual(
      expect.arrayContaining(['zhipu-coding-plan-cn', 'zai-coding-plan-global']),
    );
  });

  it('远端没带 presets → 回落 bundled 的', () => {
    const merged = mergeWithBundled(minimalCatalog());
    expect(merged.presets).toEqual(BUNDLED_CATALOG.presets);
    expect(merged.presets?.length ?? 0).toBeGreaterThan(0);
  });

  it('远端独有 preset 按远端原序追加在 bundled 之后', () => {
    const remoteOnly = { ...VALID_PRESET, id: 'remote-only' };
    const merged = mergeWithBundled(minimalCatalog({ presets: [remoteOnly] }));
    expect(merged.presets?.at(-1)).toEqual(remoteOnly);
  });

  it('同 id 远端保留 runtime/model 时回填 bundled contextWindow，不复活被移除的 runtime/model', () => {
    const remoteMiniMax = {
      id: 'minimax-global',
      name: 'Remote MiniMax',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://remote.example/anthropic',
          models: [{ id: 'MiniMax-M3', name: 'Remote M3' }],
        },
      },
    };
    const merged = mergeWithBundled(minimalCatalog({ presets: [remoteMiniMax] }));
    const preset = merged.presets?.find((candidate) => candidate.id === 'minimax-global');
    expect(preset).toEqual({
      ...remoteMiniMax,
      runtimes: {
        'claude-code': {
          ...remoteMiniMax.runtimes['claude-code'],
          models: [{ id: 'MiniMax-M3', name: 'Remote M3', contextWindow: 1_000_000 }],
        },
      },
    });
    expect(preset?.runtimes.codex).toBeUndefined();
  });

  it('远端显式 contextWindow 优先于 bundled', () => {
    const remoteMiniMax = {
      id: 'minimax-global',
      name: 'Remote MiniMax',
      runtimes: {
        'claude-code': {
          baseUrl: 'https://remote.example/anthropic',
          models: [{ id: 'MiniMax-M3', name: 'Remote M3', contextWindow: 512_000 }],
        },
      },
    };
    const merged = mergeWithBundled(minimalCatalog({ presets: [remoteMiniMax] }));
    expect(
      merged.presets
        ?.find((candidate) => candidate.id === 'minimax-global')
        ?.runtimes['claude-code']
        ?.models[0]
        ?.contextWindow,
    ).toBe(512_000);
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

  it('智谱与 Z.AI Coding Plan 使用同一厂商分组并按 locale 排区域顺序', () => {
    const presets = sanitizePresets([
      mk('zai-coding-plan-global', 'global'),
      mk('zhipu-coding-plan-cn', 'cn'),
      mk('volcengine-coding-plan'),
    ]);
    expect(sortPresetsForLocale(presets, 'zh-CN').map((p) => p.id)).toEqual([
      'volcengine-coding-plan',
      'zhipu-coding-plan-cn',
      'zai-coding-plan-global',
    ]);
    expect(sortPresetsForLocale(presets, 'en').map((p) => p.id)).toEqual([
      'volcengine-coding-plan',
      'zai-coding-plan-global',
      'zhipu-coding-plan-cn',
    ]);
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
    expect(() =>
      parseCatalog(
        catalogWithAuth({
          method: 'oauth',
          oauth: {
            flow: 'device-code',
            deviceAuthorizationUrl: 'https://auth.acme.example/device',
            tokenUrl: 'https://auth.acme.example/token',
            clientId: 'device-client',
            scopes: 'openid',
          },
        }),
      ),
    ).not.toThrow();
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
    expect(() =>
      parseCatalog(
        catalogWithAuth({
          method: 'oauth',
          oauth: {
            flow: 'device-code',
            deviceAuthorizationUrl: 'http://auth.acme.example/device',
            tokenUrl: oauth.tokenUrl,
            clientId: oauth.clientId,
            scopes: oauth.scopes,
          },
        }),
      ),
    ).toThrow(/deviceAuthorizationUrl/);
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

  it('内置预设仅允许 https；明确无鉴权且可编辑的回环代理可使用 http', () => {
    for (const p of BUNDLED_CATALOG.presets ?? []) {
      for (const rt of Object.values(p.runtimes)) {
        const url = new URL(rt.baseUrl);
        const secureLocal =
          p.authMethod === 'none'
          && rt.baseUrlEditable === true
          && url.protocol === 'http:'
          && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
        expect(url.protocol === 'https:' || secureLocal, `${p.id}: ${rt.baseUrl}`).toBe(true);
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
    expect(preset?.runtimes['claude-code']?.models).toEqual([
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
    ]);
    expect(preset?.runtimes.codex).toEqual({
      baseUrl: codexBaseUrl,
      models: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000 },
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      ],
    });
  });
});

describe('官方渠道预设契约', () => {
  const preset = (id: string) =>
    BUNDLED_CATALOG.presets?.find((candidate) => candidate.id === id);

  it('LiteLLM 是可编辑回环端点，并明确走无鉴权而非复用 CLI 订阅凭证', () => {
    const liteLlm = preset('litellm');
    expect(liteLlm?.authMethod).toBe('none');
    expect(liteLlm?.runtimes.codex).toEqual(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:4000/v1',
      baseUrlEditable: true,
      models: [],
    }));
  });

  it('LongCat 同时提供 Anthropic Messages 与官方 Codex Responses 端点', () => {
    expect(preset('longcat')?.runtimes).toEqual({
      'claude-code': {
        baseUrl: 'https://api.longcat.chat/anthropic',
        modelsUrl: 'https://api.longcat.chat/openai/v1/models',
        models: [{ id: 'LongCat-2.0', name: 'LongCat 2.0', contextWindow: 1_000_000 }],
      },
      codex: {
        baseUrl: 'https://api.longcat.chat/openai/v1',
        modelsUrl: 'https://api.longcat.chat/openai/v1/models',
        models: [{ id: 'LongCat-2.0', name: 'LongCat 2.0', contextWindow: 1_000_000 }],
      },
    });
  });

  it.each([
    ['zhipu-coding-plan-cn', 'https://open.bigmodel.cn/api/coding/paas/v4'],
    ['zai-coding-plan-global', 'https://api.z.ai/api/coding/paas/v4'],
    ['volcengine-coding-plan', 'https://ark.cn-beijing.volces.com/api/coding/v3'],
    ['tencentcloud-coding-plan', 'https://api.lkeap.cloud.tencent.com/coding/v3'],
  ])('%s 使用专属 Coding Plan OpenAI Chat 端点', (id, baseUrl) => {
    expect(preset(id)?.runtimes.codex).toEqual(expect.objectContaining({
      baseUrl,
      wireProtocol: 'openai-chat',
    }));
  });

  it('阿里云百炼 Coding Plan 与 Token Plan 使用专属端点，个人/团队版分开锁定模型窗口', () => {
    const codingPlan = preset('aliyun-bailian-coding');
    const personalTokenPlan = preset('aliyun-bailian-token-plan-cn');
    const teamTokenPlan = preset('aliyun-bailian-token-plan-team-cn');
    const codingPlanModels = [
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus' },
      { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
    ];
    const personalTokenPlanModels = [
      { id: 'qwen3.8-max-preview', name: 'Qwen 3.8 Max Preview', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', contextWindow: 992_000 },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', contextWindow: 1_000_000 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576 },
    ];
    const teamTokenPlanModels = [
      { id: 'qwen3.8-max-preview', name: 'Qwen 3.8 Max Preview', contextWindow: 983_616 },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', contextWindow: 992_000 },
      { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus', contextWindow: 1_000_000 },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: 131_072 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262_144 },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262_144 },
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000 },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 202_752 },
      { id: 'glm-5', name: 'GLM-5', contextWindow: 202_752 },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', contextWindow: 196_608 },
    ];
    const tokenPlanModelsUrl =
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models';

    expect(codingPlan).toEqual(expect.objectContaining({
      name: '阿里云百炼 Coding Plan（包月）',
      nameEn: 'Alibaba Cloud Bailian Coding Plan',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
      regionHint: 'cn',
    }));
    expect(personalTokenPlan).toEqual(expect.objectContaining({
      name: '阿里云百炼 Token Plan（个人版）',
      nameEn: 'Alibaba Cloud Bailian Token Plan (Personal)',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-overview',
      regionHint: 'cn',
    }));
    expect(teamTokenPlan).toEqual(expect.objectContaining({
      name: '阿里云百炼 Token Plan（团队版）',
      nameEn: 'Alibaba Cloud Bailian Token Plan (Team)',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/token-plan-team-overview',
      regionHint: 'cn',
    }));
    expect(codingPlan?.runtimes['claude-code']).toEqual({
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      modelsUrl: 'https://coding.dashscope.aliyuncs.com/v1/models',
      models: codingPlanModels,
    });
    expect(codingPlan?.runtimes.codex).toEqual({
      baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      wireProtocol: 'openai-chat',
      models: codingPlanModels,
    });
    for (const [tokenPlan, models] of [
      [personalTokenPlan, personalTokenPlanModels],
      [teamTokenPlan, teamTokenPlanModels],
    ] as const) {
      expect(tokenPlan?.runtimes['claude-code']).toEqual({
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
        modelsUrl: tokenPlanModelsUrl,
        models,
      });
      expect(tokenPlan?.runtimes.codex).toEqual({
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        wireProtocol: 'openai-chat',
        modelsUrl: tokenPlanModelsUrl,
        models,
      });
    }
  });

  it.each(['zhipu-coding-plan-cn', 'zai-coding-plan-global'])(
    '%s 的 Claude Code GLM-5.2 1M 入口保留完整窗口元数据',
    (id) => {
      expect(
        preset(id)?.runtimes['claude-code']?.models.find((model) => model.id === 'glm-5.2[1m]'),
      ).toEqual({
        id: 'glm-5.2[1m]',
        name: 'GLM-5.2 (1M)',
        contextWindow: 1_000_000,
      });
    },
  );

  it('小米按量与 Token Plan 凭证不会混用端点', () => {
    expect(preset('xiaomi-mimo-api-cn')?.runtimes.codex?.baseUrl)
      .toBe('https://api.xiaomimimo.com/v1');
    expect(preset('xiaomi-mimo-token-plan-cn')?.runtimes.codex?.baseUrl)
      .toBe('https://token-plan-cn.xiaomimimo.com/v1');
  });

  it('OpenCode Go 按官方逐模型协议拆成 Claude Messages 与 Codex Chat 两个 runtime', () => {
    const go = preset('opencode-go');
    expect(go?.runtimes['claude-code']?.models.map((model) => model.id)).toContain('minimax-m3');
    expect(go?.runtimes.codex?.models.map((model) => model.id)).toContain('glm-5.2');
    expect(go?.runtimes.codex?.wireProtocol).toBe('openai-chat');
    expect(go?.runtimes['claude-code']?.modelsUrl)
      .toBe('https://opencode.ai/zen/go/v1/models');
  });

  it('Vercel AI Gateway 使用 Messages 与 Responses 原生端点', () => {
    const vercel = preset('vercel-ai-gateway');
    expect(vercel?.runtimes['claude-code']?.baseUrl).toBe('https://ai-gateway.vercel.sh');
    expect(vercel?.runtimes.codex?.baseUrl).toBe('https://ai-gateway.vercel.sh/v1');
    expect(vercel?.runtimes.codex?.wireProtocol).toBeUndefined();
  });

  it('Google Gemini API 走公开 OpenAI Chat 兼容端点，不依赖 Gemini CLI 私有接口', () => {
    const gemini = preset('google-gemini-api');
    expect(gemini?.runtimes['claude-code']).toBeUndefined();
    expect(gemini?.runtimes.codex).toEqual(expect.objectContaining({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      wireProtocol: 'openai-chat',
      modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    }));
    expect(gemini?.runtimes.codex?.models.map((model) => model.id))
      .toContain('gemini-3.6-flash');
  });
});
