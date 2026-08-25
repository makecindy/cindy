/**
 * 外部供应商 manifest 的 fail-closed 校验。
 *
 * 关键不变量（与目录 presets 的 sanitizePresets 语义相反）：
 *   - 任何未知字段 / 非法值 / 越界形态 → 整条拒绝并给出结构化原因，绝无部分结果；
 *   - v1 契约里关死的 runtime 字段（headers / requestPath / modelDiscovery /
 *     baseUrlEditable / piCatalogProviderId）出现即拒绝；
 *   - 端点 URL 仅 https、无凭证、无 query/hash；
 *   - 通过时输出逐字段新建的 preset，未校验字段不可能幸存。
 */

import { describe, it, expect } from 'vitest';

import { parseProviderManifest } from '../manifest.js';

/** 最小合法 manifest（单 runtime + 空模型清单，依赖 modelsUrl 实时拉取）。 */
const VALID_MANIFEST = {
  id: 'acme-gateway',
  name: 'Acme Gateway',
  docsUrl: 'https://gateway.example.com/docs',
  runtimes: {
    'claude-code': {
      baseUrl: 'https://gateway.example.com',
      modelsUrl: 'https://gateway.example.com/v1/models',
      models: [{ id: 'acme-large', name: 'Acme Large' }],
    },
    codex: {
      baseUrl: 'https://gateway.example.com/v1',
      models: [],
    },
  },
};

function manifestText(mutate?: (m: Record<string, unknown>) => void): string {
  const clone = JSON.parse(JSON.stringify(VALID_MANIFEST)) as Record<string, unknown>;
  mutate?.(clone);
  return JSON.stringify(clone);
}

type RuntimeRecord = Record<string, Record<string, unknown>>;

describe('parseProviderManifest — 合法形态', () => {
  it('接受最小合法 manifest 并逐字段重建 preset', () => {
    const result = parseProviderManifest(manifestText());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.id).toBe('acme-gateway');
    expect(result.preset.name).toBe('Acme Gateway');
    expect(result.preset.docsUrl).toBe('https://gateway.example.com/docs');
    expect(Object.keys(result.preset.runtimes).sort()).toEqual(['claude-code', 'codex']);
    expect(result.preset.runtimes['claude-code']?.modelsUrl).toBe(
      'https://gateway.example.com/v1/models',
    );
    expect(result.preset.runtimes.codex?.models).toEqual([]);
  });

  it('接受可选 nameEn / nameZhTW / authMethod=apiKey / wireProtocol / 模型元数据', () => {
    const result = parseProviderManifest(
      manifestText((m) => {
        m.nameEn = 'Acme Gateway EN';
        m.nameZhTW = 'Acme 閘道';
        m.authMethod = 'apiKey';
        const rt = m.runtimes as RuntimeRecord;
        rt.codex.wireProtocol = 'openai-responses';
        rt['claude-code'].models = [
          { id: 'acme-large', name: 'Acme Large', contextWindow: 200000, supportsImageInput: true },
        ];
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.nameEn).toBe('Acme Gateway EN');
    expect(result.preset.authMethod).toBe('apiKey');
    expect(result.preset.runtimes.codex?.wireProtocol).toBe('openai-responses');
    expect(result.preset.runtimes['claude-code']?.models[0]).toEqual({
      id: 'acme-large',
      name: 'Acme Large',
      contextWindow: 200000,
      supportsImageInput: true,
    });
  });

  it('展示名 trim 后写入 preset', () => {
    const result = parseProviderManifest(manifestText((m) => (m.name = '  Acme  ')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preset.name).toBe('Acme');
  });
});

describe('parseProviderManifest — JSON / 根形态拒绝', () => {
  it.each([
    ['非法 JSON', 'not json {'],
    ['根是数组', JSON.stringify([VALID_MANIFEST])],
    ['根是字符串', JSON.stringify('acme')],
    ['根是 null', 'null'],
  ])('%s → invalid-json', (_label, text) => {
    expect(parseProviderManifest(text)).toEqual({ ok: false, reason: 'invalid-json' });
  });

  it('未知根字段整条拒绝（含 catalog preset 合法但 manifest 关死的字段）', () => {
    for (const extra of [{ regionHint: 'cn' }, { brandAsset: 'x.svg' }, { anything: 1 }]) {
      const result = parseProviderManifest(manifestText((m) => Object.assign(m, extra)));
      expect(result).toEqual({ ok: false, reason: 'unknown-root-field' });
    }
  });

  it.each([
    ['缺 id', (m: Record<string, unknown>) => delete m.id],
    ['id 非 slug', (m: Record<string, unknown>) => (m.id = 'Acme Gateway!')],
    ['id 超长', (m: Record<string, unknown>) => (m.id = 'a'.repeat(65))],
  ])('%s → invalid-id', (_label, mutate) => {
    expect(parseProviderManifest(manifestText(mutate))).toEqual({
      ok: false,
      reason: 'invalid-id',
    });
  });

  it.each([
    ['缺 name', (m: Record<string, unknown>) => delete m.name],
    ['name 空白', (m: Record<string, unknown>) => (m.name = '   ')],
    ['name 超长', (m: Record<string, unknown>) => (m.name = 'a'.repeat(101))],
    ['nameEn 空串', (m: Record<string, unknown>) => (m.nameEn = '')],
  ])('%s → invalid-name', (_label, mutate) => {
    expect(parseProviderManifest(manifestText(mutate))).toEqual({
      ok: false,
      reason: 'invalid-name',
    });
  });

  it.each([
    ['docsUrl 非 https', 'http://gateway.example.com/docs'],
    ['docsUrl 带凭证', 'https://user:pass@gateway.example.com/docs'],
    ['docsUrl 非 URL', 'not-a-url'],
  ])('%s → invalid-docs-url', (_label, docsUrl) => {
    expect(parseProviderManifest(manifestText((m) => (m.docsUrl = docsUrl)))).toEqual({
      ok: false,
      reason: 'invalid-docs-url',
    });
  });

  it('authMethod=none（免鉴权网关）v1 拒绝', () => {
    expect(parseProviderManifest(manifestText((m) => (m.authMethod = 'none')))).toEqual({
      ok: false,
      reason: 'invalid-auth-method',
    });
  });
});

describe('parseProviderManifest — runtimes 拒绝', () => {
  it.each([
    ['缺 runtimes', (m: Record<string, unknown>) => delete m.runtimes],
    ['runtimes 为空对象', (m: Record<string, unknown>) => (m.runtimes = {})],
    ['runtimes 是数组', (m: Record<string, unknown>) => (m.runtimes = [])],
    [
      '未知 runtime key',
      (m: Record<string, unknown>) =>
        ((m.runtimes as RuntimeRecord)['not-an-agent'] = {
          baseUrl: 'https://gateway.example.com',
          models: [],
        }),
    ],
    [
      'claude-code 配 openai-chat（isValidPreset 同款规则）',
      (m: Record<string, unknown>) =>
        ((m.runtimes as RuntimeRecord)['claude-code'].wireProtocol = 'openai-chat'),
    ],
  ])('%s → invalid-runtimes', (_label, mutate) => {
    expect(parseProviderManifest(manifestText(mutate))).toEqual({
      ok: false,
      reason: 'invalid-runtimes',
    });
  });

  it('v1 关死的 runtime 字段出现即整条拒绝', () => {
    const forbidden: [string, unknown][] = [
      ['headers', { 'X-Custom': 'v' }],
      ['requestPath', '/custom/v1/messages'],
      ['modelDiscovery', []],
      ['baseUrlEditable', true],
      ['piCatalogProviderId', 'acme'],
    ];
    for (const [key, value] of forbidden) {
      const result = parseProviderManifest(
        manifestText((m) => ((m.runtimes as RuntimeRecord)['claude-code'][key] = value)),
      );
      expect(result).toEqual({ ok: false, reason: 'forbidden-runtime-field' });
    }
  });

  it('其余未知 runtime 字段 → unknown-runtime-field', () => {
    const result = parseProviderManifest(
      manifestText((m) => ((m.runtimes as RuntimeRecord)['claude-code'].extra = 1)),
    );
    expect(result).toEqual({ ok: false, reason: 'unknown-runtime-field' });
  });

  it.each([
    ['baseUrl http', (rt: Record<string, unknown>) => (rt.baseUrl = 'http://gateway.example.com')],
    [
      'baseUrl 带凭证',
      (rt: Record<string, unknown>) => (rt.baseUrl = 'https://u:p@gateway.example.com'),
    ],
    [
      'baseUrl 带 query（?key= 凭证走私通道）',
      (rt: Record<string, unknown>) => (rt.baseUrl = 'https://gateway.example.com?key=secret'),
    ],
    [
      'baseUrl 带 hash',
      (rt: Record<string, unknown>) => (rt.baseUrl = 'https://gateway.example.com#x'),
    ],
    ['baseUrl 非 URL', (rt: Record<string, unknown>) => (rt.baseUrl = 'gateway.example.com')],
    [
      'modelsUrl 带 query',
      (rt: Record<string, unknown>) =>
        (rt.modelsUrl = 'https://gateway.example.com/v1/models?key=secret'),
    ],
    [
      'modelsUrl 非 https',
      (rt: Record<string, unknown>) => (rt.modelsUrl = 'http://gateway.example.com/v1/models'),
    ],
  ])('%s → invalid-endpoint', (_label, mutate) => {
    const result = parseProviderManifest(
      manifestText((m) => mutate((m.runtimes as RuntimeRecord)['claude-code'])),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-endpoint' });
  });

  it.each([
    ['models 缺失', (rt: Record<string, unknown>) => delete rt.models],
    ['models 非数组', (rt: Record<string, unknown>) => (rt.models = {})],
    ['模型缺 name', (rt: Record<string, unknown>) => (rt.models = [{ id: 'm' }])],
    ['模型 id 空串', (rt: Record<string, unknown>) => (rt.models = [{ id: '', name: 'M' }])],
    [
      '模型 id 重复',
      (rt: Record<string, unknown>) =>
        (rt.models = [
          { id: 'm', name: 'M' },
          { id: 'm', name: 'M2' },
        ]),
    ],
    [
      '模型带未白名单字段（reasoning 等策展元数据 v1 不收）',
      (rt: Record<string, unknown>) => (rt.models = [{ id: 'm', name: 'M', reasoning: true }]),
    ],
    [
      '模型带 route',
      (rt: Record<string, unknown>) =>
        (rt.models = [{ id: 'm', name: 'M', route: { baseUrl: 'https://x' } }]),
    ],
    [
      'contextWindow 非正数',
      (rt: Record<string, unknown>) => (rt.models = [{ id: 'm', name: 'M', contextWindow: -1 }]),
    ],
    [
      '模型数超上限',
      (rt: Record<string, unknown>) =>
        (rt.models = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, name: `M${i}` }))),
    ],
  ])('%s → invalid-models', (_label, mutate) => {
    const result = parseProviderManifest(
      manifestText((m) => mutate((m.runtimes as RuntimeRecord)['claude-code'])),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-models' });
  });
});
