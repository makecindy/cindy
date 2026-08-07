import { describe, expect, it } from 'vitest';

import {
  GHOST_CARD_ACTION_ID_RE,
  GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
  GHOST_CINDY_EMBED_MAX_TEXTS,
  GHOST_SLOTS,
  deriveGhostSessionContext,
  diffGhostPermissionItems,
  ghostContentKeys,
  ghostExternalLinkUrls,
  ghostLocalePathFor,
  ghostNetworkHostMatches,
  ghostPanelKind,
  ghostPermissionBaselineKey,
  ghostPreviewUrlAllowed,
  parseGhostNodeChildToHostMessage,
  ghostPartition,
  ghostPermissionItems,
  ghostWebviewEntryPaths,
  isGhostCallToolName,
  isValidGhostId,
  isOfficialGhostId,
  isValidGhostNetworkHostPattern,
  layoutWithGhostPanel,
  unreviewedGhostPermissionItems,
  parseGhostPartition,
  resolveGhostManifestLocale,
  validateGhostManifest,
  validateGhostManifestLocaleResource,
  withGhostResolvedLocale,
  type GhostManifest,
} from '../ghost';
import { createDefaultLayout, type SplitNode } from '../layoutTree';

/** 一份全绿的清单基底(意识唯一形态:芯片,2026-07-12 单形态定案),单点破坏它来测各字段规则。 */
function goodManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { title: 'Hello', html: 'panel.html', minWidth: 240, defaultFraction: 0.18 },
  };
}

/** 一份全绿的芯片型清单基底。 */
function goodChipManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'hello-chip',
    name: 'Hello 芯片',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel', 'model'],
    panel: { title: 'Hello 芯片', html: 'panel.html', minWidth: 240 },
  };
}

describe('ghost · ghost_call 工具名匹配(Claude / Codex 双形态)', () => {
  it('认 Claude Code 形态 mcp__<server>__ghost_call(含旧 server 名)', () => {
    expect(isGhostCallToolName('mcp__cindy__ghost_call')).toBe(true);
    expect(isGhostCallToolName('mcp__cindy_ghosts__ghost_call')).toBe(true);
  });

  it('认 Codex translator 形态 mcp:<server>:ghost_call(含旧 server 名)——漏了会让 Codex 会话退化成通用 MCP 行', () => {
    expect(isGhostCallToolName('mcp:cindy:ghost_call')).toBe(true);
    expect(isGhostCallToolName('mcp:cindy_ghosts:ghost_call')).toBe(true);
  });

  it('不误伤其它工具名', () => {
    expect(isGhostCallToolName('mcp__cindy__ghost_list')).toBe(false);
    expect(isGhostCallToolName('mcp:cindy:ghost_list')).toBe(false);
    expect(isGhostCallToolName('ghost_call')).toBe(false);
    expect(isGhostCallToolName(undefined)).toBe(false);
    expect(isGhostCallToolName(null)).toBe(false);
  });
});

describe('ghost · id 规则', () => {
  it('合法:小写字母/数字/连字符,1–32 位', () => {
    for (const id of ['a', 'hello', 'hello-world', 'a1-b2', 'x'.repeat(32)]) {
      expect(isValidGhostId(id), id).toBe(true);
    }
  });

  it('非法:大写/下划线/路径字符/连字符开头/超长/非字符串', () => {
    for (const id of ['Hello', 'a_b', '../evil', 'a/b', 'a\\b', '-abc', '', 'x'.repeat(33), 42, null]) {
      expect(isValidGhostId(id), String(id)).toBe(false);
    }
  });

  it('panelKind 前缀拼接', () => {
    expect(ghostPanelKind('hello')).toBe('ghost:hello');
  });

  it('内容清单:面板/代码/能力槽按序列出,panel 槽不重复', () => {
    const base = validateGhostManifest(goodManifest());
    expect(base.ok && ghostContentKeys(base.manifest)).toEqual(['panel', 'code']);
    const chip = validateGhostManifest(goodChipManifest());
    expect(chip.ok && ghostContentKeys(chip.manifest)).toEqual(['panel', 'code', 'slotCindy']);
    const noPanel: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete noPanel.panel;
    const bare = validateGhostManifest(noPanel);
    expect(bare.ok && ghostContentKeys(bare.manifest)).toEqual(['code', 'slotTool']);
  });

  it('沙箱分区名:拼接与解析互逆,非意识分区/非法 id 解析为 null', () => {
    expect(ghostPartition('art')).toBe('cindy-ghost-art');
    expect(parseGhostPartition('cindy-ghost-art')).toBe('art');
    expect(parseGhostPartition('persist:xdmaker-browser-app')).toBeNull();
    expect(parseGhostPartition('cindy-ghost-')).toBeNull();
    expect(parseGhostPartition('cindy-ghost-BAD_ID')).toBeNull();
    expect(parseGhostPartition(undefined)).toBeNull();
  });
});

describe('ghost · 清单校验', () => {
  it('全字段合法清单通过,并按已知字段收窄输出', () => {
    const v = validateGhostManifest({ ...goodManifest(), unknownField: 'ignored' });
    expect(v.ok).toBe(true);
    const manifest = (v as { ok: true; manifest: GhostManifest }).manifest;
    expect(manifest).toEqual(goodManifest()); // 未知字段被丢弃
  });

  it('panel 可省略(slots 不含 panel 时)', () => {
    const raw: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete raw.panel;
    const v = validateGhostManifest(raw);
    expect(v.ok).toBe(true);
    expect((v as { ok: true; manifest: GhostManifest }).manifest.panel).toBeUndefined();
  });

  it('非对象 / schemaVersion 不是 2 → 拒绝(v1 声明型已移除)', () => {
    expect(validateGhostManifest(null).ok).toBe(false);
    expect(validateGhostManifest([]).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), schemaVersion: 1 }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), schemaVersion: 3 }).ok).toBe(false);
  });

  it('id / name / version 的边界', () => {
    expect(validateGhostManifest({ ...goodManifest(), id: 'Bad_Id' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), name: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), name: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), version: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), version: 'v'.repeat(33) }).ok).toBe(false);
  });

  it('kind 可省略:缺省归一化为 chip(2026-07-12 晚定案,单形态后纯冗余)', () => {
    const m = goodManifest();
    delete m.kind;
    const v = validateGhostManifest(m);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.kind).toBe('chip');
  });

  it('kind 只认 chip;declaration 已移除(2026-07-12 单形态定案)', () => {
    expect(validateGhostManifest({ ...goodManifest(), kind: 'plugin' }).ok).toBe(false);
    // v2 清单标 kind: declaration → 拒,错误话术点明形态已移除
    const declV2 = validateGhostManifest({ ...goodManifest(), kind: 'declaration' });
    expect(declV2.ok).toBe(false);
    expect(!declV2.ok && declV2.reason).toContain('chip');
    // 完整的老声明型清单(v1 + declaration + 静态 body 面板)→ 拒
    const legacy = validateGhostManifest({
      schemaVersion: 1,
      id: 'legacy',
      name: '老声明型',
      version: '1.0.0',
      kind: 'declaration',
      panel: { title: '静态面板', body: '一段文字' },
    });
    expect(legacy.ok).toBe(false);
  });

  it('panel 字段边界:html 必填、title 长度、minWidth/defaultFraction 数值范围', () => {
    const withPanel = (panel: Record<string, unknown>) =>
      validateGhostManifest({ ...goodManifest(), panel: { html: 'panel.html', ...panel } });
    expect(validateGhostManifest({ ...goodManifest(), panel: 'not-object' }).ok).toBe(false);
    // html 必填(declaration 时代的静态 body 面板已随单形态定案移除)
    expect(validateGhostManifest({ ...goodManifest(), panel: { title: 'X' } }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), panel: { title: 'X', body: '正文' } }).ok).toBe(false);
    expect(withPanel({ title: '' }).ok).toBe(false);
    expect(withPanel({ title: 'x'.repeat(65) }).ok).toBe(false);
    expect(withPanel({ minWidth: 119 }).ok).toBe(false);
    expect(withPanel({ minWidth: 1201 }).ok).toBe(false);
    expect(withPanel({ minWidth: Number.NaN }).ok).toBe(false);
    expect(withPanel({ defaultFraction: 0.04 }).ok).toBe(false);
    expect(withPanel({ defaultFraction: 0.81 }).ok).toBe(false);
    // 边界值本身合法
    expect(withPanel({ minWidth: 120, defaultFraction: 0.05 }).ok).toBe(true);
    expect(withPanel({ minWidth: 1200, defaultFraction: 0.8 }).ok).toBe(true);
    // 只有 html 的 panel 合法(其余字段可选)
    expect(withPanel({}).ok).toBe(true);
  });

  it('panel.systemButtons:标准头系统按钮开关 —— 布尔白名单键,tab 形态拒装', () => {
    const withPanel = (panel: Record<string, unknown>) =>
      validateGhostManifest({ ...goodManifest(), panel: { html: 'panel.html', ...panel } });
    // 合法:关掉 maximize / detach / 空对象(= 全默认) / 显式 true / 双键并存
    const off = withPanel({ systemButtons: { maximize: false } });
    expect(off.ok && (off as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons).toEqual({
      maximize: false,
    });
    const detachOff = withPanel({ systemButtons: { detach: false } });
    expect(
      detachOff.ok && (detachOff as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons,
    ).toEqual({ detach: false });
    const bothOff = withPanel({ systemButtons: { maximize: false, detach: false } });
    expect(
      bothOff.ok && (bothOff as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons,
    ).toEqual({ maximize: false, detach: false });
    const minimizeOff = withPanel({ systemButtons: { minimize: false } });
    expect(
      minimizeOff.ok &&
        (minimizeOff as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons,
    ).toEqual({ minimize: false });
    const allOff = withPanel({ systemButtons: { maximize: false, detach: false, minimize: false } });
    expect(
      allOff.ok && (allOff as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons,
    ).toEqual({ maximize: false, detach: false, minimize: false });
    expect(withPanel({ systemButtons: {} }).ok).toBe(true);
    expect(withPanel({ systemButtons: { maximize: true, detach: true } }).ok).toBe(true);
    // 非对象 / 未知键 / 非布尔值:收词明确拒绝(规则 9)
    expect(withPanel({ systemButtons: 'off' }).ok).toBe(false);
    expect(withPanel({ systemButtons: { refresh: false } }).ok).toBe(false);
    expect(withPanel({ systemButtons: { maximize: 'no' } }).ok).toBe(false);
    expect(withPanel({ systemButtons: { detach: 0 } }).ok).toBe(false);
    expect(withPanel({ systemButtons: { minimize: 0 } }).ok).toBe(false);
    expect(withPanel({ position: 'tab', systemButtons: { minimize: false } }).ok).toBe(false);
    // 页签形态没有标准头:声明即拒(与 minWidth/defaultFraction 同款语义)
    expect(withPanel({ position: 'tab', systemButtons: { maximize: false } }).ok).toBe(false);
    // 缺省(不声明)不产出字段
    const plain = withPanel({});
    expect(
      plain.ok && (plain as { ok: true; manifest: GhostManifest }).manifest.panel?.systemButtons,
    ).toBeUndefined();
  });

  it('author:可选展示名,1–64 字符,原样输出', () => {
    const base = validateGhostManifest({ ...goodManifest(), author: 'Lizi' });
    expect(base.ok && (base as { ok: true; manifest: GhostManifest }).manifest.author).toBe('Lizi');
    const chip = validateGhostManifest({ ...goodChipManifest(), author: 'Lizi' });
    expect(chip.ok && (chip as { ok: true; manifest: GhostManifest }).manifest.author).toBe('Lizi');
    expect(validateGhostManifest({ ...goodManifest(), author: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: '  ' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodManifest(), author: 42 }).ok).toBe(false);
  });

  it('locales 只接受宿主四种语言、安全 JSON 路径且必须提供英文', () => {
    const valid = validateGhostManifest({
      ...goodManifest(),
      locales: {
        en: 'locales/en.json',
        'zh-CN': 'locales/zh-CN.json',
        ja: 'locales/ja.json',
        ko: 'locales/ko.json',
      },
    });
    expect(valid.ok).toBe(true);
    expect(valid.ok && valid.manifest.locales?.en).toBe('locales/en.json');

    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { 'zh-CN': 'locales/zh-CN.json' },
    }).ok).toBe(false);
    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { en: '../en.json' },
    }).ok).toBe(false);
    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { en: 'locales/en.json', fr: 'locales/fr.json' },
    }).ok).toBe(false);
    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { en: 'locales/en.json', ja: 'locales/en.json' },
    }).ok).toBe(false);
    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { en: 'locales/en.json', ja: 'Locales/EN.json' },
    }).ok).toBe(false);
    expect(validateGhostManifest({
      ...goodManifest(),
      locales: { en: 'GHOST.JSON' },
    }).ok).toBe(false);
  });

  it('locale 选择完全跟随宿主，插件不支持或宿主值未知时固定回退英文', () => {
    const parsed = validateGhostManifest({
      ...goodManifest(),
      locales: { en: 'locales/en.json', ja: 'locales/ja.json' },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(ghostLocalePathFor(parsed.manifest, 'ja')).toBe('locales/ja.json');
    expect(ghostLocalePathFor(parsed.manifest, 'zh-CN')).toBe('locales/en.json');
    expect(ghostLocalePathFor(parsed.manifest, 'fr-FR')).toBe('locales/en.json');
    expect(withGhostResolvedLocale(parsed.manifest, 'ko').resolvedLocale).toBe('ko');
    expect(withGhostResolvedLocale(parsed.manifest, 'fr-FR').resolvedLocale).toBe('en');
  });

  it('locale 资源按稳定 tool name 合并;翻译可部分提供、缺译回退原文,错位仍拒', () => {
    const parsed = validateGhostManifest({
      schemaVersion: 2,
      id: 'localized',
      name: 'Base',
      description: 'Base description',
      whenToUse: 'Base routing',
      version: '1.0.0',
      entry: 'main.js',
      slots: ['tool'],
      tools: [
        {
          name: 'alpha',
          description: 'Base alpha',
          parameters: {
            type: 'object',
            title: 'Base arguments',
            properties: {
              query: {
                type: 'string',
                title: 'Base query',
                description: 'Base query description',
              },
              mode: {
                oneOf: [
                  { const: 'fast', title: 'Base fast mode' },
                  { const: 'safe', title: 'Base safe mode' },
                ],
              },
            },
          },
        },
        { name: 'beta', description: 'Base beta' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resource = validateGhostManifestLocaleResource({
      name: 'Localized',
      description: 'Localized description',
      whenToUse: 'Localized routing',
      tools: {
        beta: { description: 'Localized beta' },
        alpha: {
          description: 'Localized alpha',
          parameters: {
            '': { title: 'Localized arguments' },
            '/properties/query': {
              title: 'Localized query',
              description: 'Localized query description',
            },
            '/properties/mode/oneOf/0': { title: 'Localized fast mode' },
            '/properties/mode/oneOf/1': { title: 'Localized safe mode' },
          },
        },
      },
    }, parsed.manifest);
    expect(resource.ok).toBe(true);
    if (!resource.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, resource.resource)).toMatchObject({
      name: 'Localized',
      description: 'Localized description',
      whenToUse: 'Localized routing',
      tools: [
        {
          name: 'alpha',
          description: 'Localized alpha',
          parameters: {
            title: 'Localized arguments',
            properties: {
              query: {
                title: 'Localized query',
                description: 'Localized query description',
              },
              mode: {
                oneOf: [
                  { title: 'Localized fast mode' },
                  { title: 'Localized safe mode' },
                ],
              },
            },
          },
        },
        { name: 'beta', description: 'Localized beta' },
      ],
    });
    // 部分翻译是合法状态:只翻 alpha 的 description(不翻参数、不翻 beta),
    // 缺失条目解析时回退原文。
    const partial = validateGhostManifestLocaleResource({
      name: 'Partial',
      tools: { alpha: { description: 'Only alpha' } },
    }, parsed.manifest);
    expect(partial.ok, JSON.stringify(partial)).toBe(true);
    if (!partial.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, partial.resource)).toMatchObject({
      name: 'Partial',
      description: 'Base description',
      whenToUse: 'Base routing',
      tools: [
        {
          name: 'alpha',
          description: 'Only alpha',
          parameters: {
            title: 'Base arguments',
            properties: { query: { title: 'Base query', description: 'Base query description' } },
          },
        },
        { name: 'beta', description: 'Base beta' },
      ],
    });
    // 连 name 都可以省:空对象 locale 合法,解析后与原 manifest 恒等。
    const empty = validateGhostManifestLocaleResource({}, parsed.manifest);
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, empty.resource)).toMatchObject({
      name: 'Base',
      tools: [{ name: 'alpha', description: 'Base alpha' }, { name: 'beta', description: 'Base beta' }],
    });
    // 参数翻译允许只覆盖部分 pointer,未覆盖的回退。
    const partialParams = validateGhostManifestLocaleResource({
      tools: {
        alpha: {
          description: 'Localized alpha',
          parameters: { '/properties/query': { title: 'Localized query', description: 'Localized query description' } },
        },
      },
    }, parsed.manifest);
    expect(partialParams.ok, JSON.stringify(partialParams)).toBe(true);
    if (!partialParams.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, partialParams.resource)).toMatchObject({
      tools: [
        {
          name: 'alpha',
          parameters: {
            title: 'Base arguments',
            properties: { query: { title: 'Localized query', description: 'Localized query description' } },
          },
        },
        { name: 'beta', description: 'Base beta' },
      ],
    });
    // 翻译错位仍是硬错误:未知工具 / 未知 pointer / 未知字段 / 提供了条目却缺 description。
    expect(validateGhostManifestLocaleResource({
      tools: { gamma: { description: 'No such tool' } },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      tools: { alpha: { description: 'x', parameters: { '/properties/nope': { title: 'x' } } } },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      tools: { beta: { description: 'x', parameters: { '': { title: 'x' } } } },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      tools: { alpha: {} },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      description: 'x',
      whenToUse: 'x',
      extra: 'x',
    }, parsed.manifest).ok).toBe(false);
  });

  it('locale 资源覆盖宿主持有的面板、凭证、连接与 setup 标签;标签可部分提供', () => {
    const parsed = validateGhostManifest({
      schemaVersion: 2,
      id: 'localized-labels',
      name: 'Base',
      version: '1.0.0',
      entry: 'main.js',
      settingsHtml: 'settings.html',
      slots: ['panel', 'network', 'node'],
      panel: { title: 'Base panel', html: 'panel.html' },
      network: {
        hosts: ['api.example.com'],
        secrets: [{
          key: 'api_key',
          label: 'Base API key',
          hint: 'Base secret hint',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        }],
        connections: [{
          key: 'instance',
          label: 'Base instance',
          hint: 'Base connection hint',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        }],
      },
      node: {
        entry: 'node/worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [{
          key: 'worker_key',
          label: 'Base worker key',
          hint: 'Base worker hint',
          methods: ['run'],
        }],
      },
      setup: {
        requires: [{ anyOf: [{ kv: 'default_repo', label: 'Base repository' }] }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resource = validateGhostManifestLocaleResource({
      name: 'Localized',
      panel: { title: 'Localized panel' },
      network: {
        secrets: {
          api_key: { label: 'Localized API key', hint: 'Localized secret hint' },
        },
        connections: {
          instance: { label: 'Localized instance', hint: 'Localized connection hint' },
        },
      },
      node: {
        secretBindings: {
          worker_key: { label: 'Localized worker key', hint: 'Localized worker hint' },
        },
      },
      setup: {
        kv: {
          default_repo: { label: 'Localized repository' },
        },
      },
    }, parsed.manifest);
    expect(resource.ok).toBe(true);
    if (!resource.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, resource.resource)).toMatchObject({
      panel: { title: 'Localized panel' },
      network: {
        secrets: [{
          key: 'api_key',
          label: 'Localized API key',
          hint: 'Localized secret hint',
        }],
        connections: [{
          key: 'instance',
          label: 'Localized instance',
          hint: 'Localized connection hint',
        }],
      },
      node: {
        secretBindings: [{
          key: 'worker_key',
          label: 'Localized worker key',
          hint: 'Localized worker hint',
        }],
      },
      setup: {
        requires: [{
          anyOf: [{ kind: 'kv', key: 'default_repo', label: 'Localized repository' }],
        }],
      },
    });
    // 只翻面板标题、不翻凭证/连接/kv 也合法,缺失标签回退原文。
    const panelOnly = validateGhostManifestLocaleResource({
      name: 'Partial labels',
      panel: { title: 'Localized panel' },
    }, parsed.manifest);
    expect(panelOnly.ok, JSON.stringify(panelOnly)).toBe(true);
    if (!panelOnly.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, panelOnly.resource)).toMatchObject({
      panel: { title: 'Localized panel' },
      network: {
        secrets: [{ key: 'api_key', label: 'Base API key', hint: 'Base secret hint' }],
        connections: [{ key: 'instance', label: 'Base instance' }],
      },
      node: { secretBindings: [{ key: 'worker_key', label: 'Base worker key' }] },
      setup: { requires: [{ anyOf: [{ kind: 'kv', key: 'default_repo', label: 'Base repository' }] }] },
    });
    // 提供的标签条目 label 必填、hint 可省(缺 hint 回退原文);未知 key 仍拒。
    const labelNoHint = validateGhostManifestLocaleResource({
      network: { secrets: { api_key: { label: 'Localized API key' } } },
    }, parsed.manifest);
    expect(labelNoHint.ok, JSON.stringify(labelNoHint)).toBe(true);
    if (!labelNoHint.ok) return;
    expect(resolveGhostManifestLocale(parsed.manifest, labelNoHint.resource)).toMatchObject({
      network: {
        secrets: [{ key: 'api_key', label: 'Localized API key', hint: 'Base secret hint' }],
      },
    });
    expect(validateGhostManifestLocaleResource({
      network: { secrets: { nope: { label: 'x' } } },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      network: { secrets: { api_key: { hint: 'hint without label' } } },
    }, parsed.manifest).ok).toBe(false);
    expect(validateGhostManifestLocaleResource({
      setup: { kv: { default_repo: { label: 'x', hint: 'kv 未声明 hint' } } },
    }, parsed.manifest).ok).toBe(false);
  });

  it('locale 外部 key 累加器使用无原型字典，JSON 自有 __proto__ 属性不会丢失', () => {
    const manifest: GhostManifest = {
      schemaVersion: 2,
      id: 'defensive-locale',
      name: 'Defensive locale',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
      setup: {
        requires: [{ anyOf: [{ kind: 'kv', key: '__proto__', label: 'Base label' }] }],
      },
    };
    const rawLocale = JSON.parse('{"setup":{"kv":{"__proto__":{"label":"Localized label"}}}}');
    const resource = validateGhostManifestLocaleResource(rawLocale, manifest);
    expect(resource.ok).toBe(true);
    if (!resource.ok) return;
    expect(Object.getPrototypeOf(resource.resource.setup?.kv)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(resource.resource.setup?.kv, '__proto__')).toBe(true);
    expect(resolveGhostManifestLocale(manifest, resource.resource).setup?.requires[0]?.anyOf[0]).toEqual({
      kind: 'kv',
      key: '__proto__',
      label: 'Localized label',
    });
  });

  it('icon:可选包内相对路径,扩展名白名单;非法路径/扩展名 → 拒', () => {
    const base = validateGhostManifest({ ...goodManifest(), icon: 'assets/icon.png' });
    expect(base.ok && (base as { ok: true; manifest: GhostManifest }).manifest.icon).toBe('assets/icon.png');
    const chip = validateGhostManifest({ ...goodChipManifest(), icon: 'icon.webp' });
    expect(chip.ok && (chip as { ok: true; manifest: GhostManifest }).manifest.icon).toBe('icon.webp');
    // 大小写不敏感的扩展名
    expect(validateGhostManifest({ ...goodManifest(), icon: 'ICON.PNG' }).ok).toBe(true);
    for (const icon of ['../evil.png', '/abs.png', 'a\\b.png', 'icon.svg', 'icon.js', 'icon', 42]) {
      expect(validateGhostManifest({ ...goodManifest(), icon }).ok, String(icon)).toBe(false);
    }
  });
});

describe('ghost · 芯片型清单(schemaVersion 2)', () => {
  it('全字段合法芯片清单通过', () => {
    const v = validateGhostManifest(goodChipManifest());
    expect(v.ok).toBe(true);
    const manifest = (v as { ok: true; manifest: GhostManifest }).manifest;
    expect(manifest.kind).toBe('chip');
    expect(manifest.entry).toBe('main.js');
    expect(manifest.slots).toEqual(['panel', 'cindy']); // 'model' 旧名归一化
    expect(manifest.panel?.html).toBe('panel.html');
  });

  it('entry 必填且必须是安全相对路径', () => {
    const without = goodChipManifest();
    delete without.entry;
    expect(validateGhostManifest(without).ok).toBe(false);
    for (const entry of ['../evil.js', '/abs.js', 'a\\b.js', 'a//b.js', '.env', 'C:/x.js']) {
      expect(validateGhostManifest({ ...goodChipManifest(), entry }).ok, entry).toBe(false);
    }
    expect(validateGhostManifest({ ...goodChipManifest(), entry: 'src/main.js' }).ok).toBe(true);
  });

  it('slots 必填非空、只认已知卡槽、不许重复', () => {
    expect(validateGhostManifest({ ...goodChipManifest(), slots: undefined }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: [] }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'filesystem'] }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['model', 'model'] }).ok).toBe(false);
    const noPanel = goodChipManifest();
    noPanel.slots = ['subscribe', 'tool', 'card', 'model'];
    noPanel.tools = [{ name: 'do_thing', description: '做点事' }];
    delete noPanel.panel;
    expect(validateGhostManifest(noPanel).ok).toBe(true);
  });

  it('agent 槽默认只允许真人点击；background 是单独的高风险加档', () => {
    const userActionOnly = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
    });
    expect(userActionOnly.ok).toBe(true);
    if (!userActionOnly.ok) return;
    expect(userActionOnly.manifest.agent).toBeUndefined();
    expect(ghostContentKeys(userActionOnly.manifest)).toContain('slotAgent');
    expect(ghostPermissionItems(userActionOnly.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'agent:user-action',
          kind: 'agent',
          labelKey: 'agentUserAction',
          detailKey: 'agentUserActionDetail',
        }),
      ]),
    );

    const background = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
      agent: { background: true },
    });
    expect(background.ok).toBe(true);
    if (!background.ok) return;
    expect(background.manifest.agent).toEqual({ background: true });
    expect(ghostPermissionItems(background.manifest).map((item) => item.key)).toEqual(
      expect.arrayContaining(['agent:user-action', 'agent:background']),
    );

    const diff = diffGhostPermissionItems(userActionOnly.manifest, background.manifest);
    expect(diff.added.map((item) => item.key)).toEqual(['agent:background']);
    expect(diff.removed).toHaveLength(0);
  });

  it('agent.schedule 加档:单列一档权限,可与 background / errand 并存(2026-08-04)', () => {
    const sched = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
      agent: { schedule: true },
    });
    expect(sched.ok).toBe(true);
    if (!sched.ok) return;
    expect(sched.manifest.agent).toEqual({ schedule: true });
    expect(ghostPermissionItems(sched.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'agent:schedule',
          kind: 'agent',
          labelKey: 'agentSchedule',
          detailKey: 'agentScheduleDetail',
        }),
      ]),
    );

    const all = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
      agent: { background: true, errand: true, schedule: true },
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.manifest.agent).toEqual({ background: true, errand: true, schedule: true });

    // 扩权复核必须看得见它:只加 schedule 的更新,added 恰好是这一项。
    const userActionOnly = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
    });
    expect(userActionOnly.ok).toBe(true);
    if (!userActionOnly.ok) return;
    const diff = diffGhostPermissionItems(userActionOnly.manifest, sched.manifest);
    expect(diff.added.map((item) => item.key)).toEqual(['agent:schedule']);
    expect(diff.removed).toHaveLength(0);

    // schedule: false 且其余非 true = 详单没意义,拒(应省略字段)。
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { schedule: false },
      }).ok,
    ).toBe(false);
    // schedule 非布尔 → 拒。
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { schedule: 'yes' },
      }).ok,
    ).toBe(false);
  });

  it('存量兼容红线:不声明 agent.schedule 的清单,权限项与内容键逐字不变', () => {
    // 这条钉的是仓规红线(plugin-security-and-authoring.md §5):用户升级客户端后
    // 什么都不做,已装插件必须照旧可用 —— 不能因为新增了 schedule 加档,就让任何
    // 老清单多出/少掉一项权限或内容键(那会触发扩权复核、要求用户重新确认)。
    for (const agentNeeds of [undefined, { background: true }, { errand: true }]) {
      const result = validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        ...(agentNeeds ? { agent: agentNeeds } : {}),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const keys = ghostPermissionItems(result.manifest).map((item) => item.key);
      expect(keys).not.toContain('agent:schedule');
      expect(ghostContentKeys(result.manifest)).not.toContain('slotSchedule');
    }
  });

  it('agent 详单必须与槽成对，且只接受 background / errand / schedule 三项加档', () => {
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        agent: { background: true },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { background: false },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: 'background',
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { background: true, command: 'hidden' },
      }).ok,
    ).toBe(false);
  });

  it('agent.errand 派活加档:单列高风险权限,可与 background 并存(2026-07-31)', () => {
    const errand = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
      agent: { errand: true },
    });
    expect(errand.ok).toBe(true);
    if (!errand.ok) return;
    expect(errand.manifest.agent).toEqual({ errand: true });
    expect(ghostPermissionItems(errand.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'agent:errand',
          kind: 'agent',
          labelKey: 'agentErrand',
          detailKey: 'agentErrandDetail',
        }),
      ]),
    );

    const both = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'agent'],
      agent: { background: true, errand: true },
    });
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.manifest.agent).toEqual({ background: true, errand: true });
    expect(ghostPermissionItems(both.manifest).map((item) => item.key)).toEqual(
      expect.arrayContaining(['agent:user-action', 'agent:background', 'agent:errand']),
    );

    // errand: false 与 background 双双非 true = 详单没意义,拒(应省略字段)。
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { errand: false },
      }).ok,
    ).toBe(false);
    // errand 非布尔 → 拒。
    expect(
      validateGhostManifest({
        ...goodChipManifest(),
        slots: ['panel', 'agent'],
        agent: { errand: 'yes' },
      }).ok,
    ).toBe(false);
  });

  it('node 槽只允许包内入口与固定 stdio 协议，并如实生成高风险权限项', () => {
    const raw = {
      ...goodChipManifest(),
      slots: ['panel', 'node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'mcp-stdio',
        lifecycle: 'resident',
      },
    };
    const result = validateGhostManifest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.node).toEqual(raw.node);
    expect(ghostContentKeys(result.manifest)).toContain('slotNode');
    expect(ghostPermissionItems(result.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'node:execute', kind: 'node', labelKey: 'nodeMcp' }),
        expect.objectContaining({ key: 'node:resident', kind: 'node', labelKey: 'nodeResident' }),
      ]),
    );
  });

  it('node 清单拒绝任意命令字段、越界配置和槽/详单不成对', () => {
    const withNode = (node: unknown, slots: string[] = ['panel', 'node']) =>
      validateGhostManifest({ ...goodChipManifest(), slots, node });
    expect(withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio' }).ok).toBe(true);
    expect(withNode({ entry: '../a.cjs', protocol: 'json-rpc-stdio' }).ok).toBe(false);
    expect(withNode({ entry: 'node/a.txt', protocol: 'json-rpc-stdio' }).ok).toBe(false);
    expect(withNode({ entry: 'node/a.mjs', protocol: 'json-rpc-stdio' }).ok).toBe(false);
    expect(withNode({ entry: 'node/a.cjs', protocol: 'stdio' }).ok).toBe(false);
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio', command: 'node' }).ok,
    ).toBe(false);
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio', args: ['--x'] }).ok,
    ).toBe(false);
    expect(
      withNode({
        entry: 'node/a.cjs',
        protocol: 'json-rpc-stdio',
        lifecycle: 'resident',
        idleTimeoutSeconds: 60,
      }).ok,
    ).toBe(false);
    expect(withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio' }, ['panel']).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'node'] }).ok).toBe(false);
  });

  it('node.secretBindings 逐方法声明保险库凭证并生成单独权限项', () => {
    const result = validateGhostManifest({
      ...goodChipManifest(),
      settingsHtml: 'settings.html',
      slots: ['panel', 'node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_code',
            label: '邮箱授权码',
            methods: ['account/connect', 'mail/action'],
            url: 'https://mail.example.com/settings',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.node?.secretBindings).toEqual([
      {
        key: 'mail_code',
        label: '邮箱授权码',
        methods: ['account/connect', 'mail/action'],
        url: 'https://mail.example.com/settings',
      },
    ]);
    expect(ghostPermissionItems(result.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining('node:secret:mail_code'),
          kind: 'node',
          labelKey: 'nodeSecret',
          labelArgs: { name: '邮箱授权码' },
        }),
      ]),
    );

    const reordered = validateGhostManifest({
      ...goodChipManifest(),
      settingsHtml: 'settings.html',
      slots: ['panel', 'node'],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_code',
            label: '邮箱授权码',
            methods: ['mail/action', 'account/connect'],
            url: 'https://mail.example.com/settings',
          },
        ],
      },
    });
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    const permission = ghostPermissionItems(result.manifest).find((item) =>
      item.key.startsWith('node:secret:mail_code:'),
    );
    const reorderedPermission = ghostPermissionItems(reordered.manifest).find((item) =>
      item.key.startsWith('node:secret:mail_code:'),
    );
    expect(reorderedPermission?.key).toBe(permission?.key);
    expect(reorderedPermission?.detail).toBe('mail/action\naccount/connect');

    expect(ghostExternalLinkUrls(result.manifest)).toContain('https://mail.example.com/settings');
  });

  it('node.secretBindings 缺设置页、坏方法/入口、重复键或与 network 凭证撞名均拒', () => {
    const base = {
      ...goodChipManifest(),
      settingsHtml: 'settings.html',
      slots: ['panel', 'node'],
      node: {
        entry: 'node/worker.cjs',
        entries: ['node/secondary.cjs'],
        protocol: 'json-rpc-stdio',
      },
    };
    const binding = { key: 'mail_code', label: '邮箱授权码', methods: ['mail/action'] };
    expect(
      validateGhostManifest({
        ...base,
        settingsHtml: undefined,
        node: { ...base.node, secretBindings: [binding] },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [{ ...binding, methods: ['bad method'] }] },
      }).ok,
    ).toBe(false);
    for (const method of ['initialize', 'notifications/initialized']) {
      expect(
        validateGhostManifest({
          ...base,
          node: {
            ...base.node,
            protocol: 'mcp-stdio',
            secretBindings: [{ ...binding, methods: [method] }],
          },
        }).ok,
      ).toBe(false);
    }
    expect(
      validateGhostManifest({
        ...base,
        node: {
          ...base.node,
          protocol: 'json-rpc-stdio',
          secretBindings: [{ ...binding, methods: ['initialize'] }],
        },
      }).ok,
    ).toBe(true);
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [{ ...binding, entry: 'node/other.cjs' }] },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [binding, binding] },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...base,
        slots: ['panel', 'node', 'network'],
        node: { ...base.node, secretBindings: [binding] },
        network: {
          hosts: ['api.example.com'],
          secrets: [
            {
              key: 'mail_code',
              label: '重复',
              inject: { header: 'Authorization', format: 'Bearer {value}' },
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it('工具声明(卡槽②)与 tool 槽成对;名/描述/条数校验', () => {
    const withTools = (slots: string[], tools: unknown) =>
      validateGhostManifest({ ...goodChipManifest(), slots, tools });
    // 成对:有 tool 槽必须有 tools,反之亦然
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'tool'] }).ok).toBe(false);
    expect(withTools(['panel'], [{ name: 'x', description: 'y' }]).ok).toBe(false);
    // 合法
    expect(withTools(['panel', 'tool'], [{ name: 'gen_image', description: '生成图片' }]).ok).toBe(true);
    // 名字非法 / 重名 / 描述空 / 超 16 条
    expect(withTools(['panel', 'tool'], [{ name: 'Bad', description: 'y' }]).ok).toBe(false);
    expect(
      withTools(['panel', 'tool'], [
        { name: 'a', description: 'y' },
        { name: 'a', description: 'z' },
      ]).ok,
    ).toBe(false);
    expect(withTools(['panel', 'tool'], [{ name: 'a', description: '' }]).ok).toBe(false);
    expect(
      withTools(
        ['panel', 'tool'],
        Array.from({ length: 17 }, (_, i) => ({ name: `t${i}`, description: 'y' })),
      ).ok,
    ).toBe(false);
  });

  it('@ 资源入口只可引用一个已声明工具，并按已知字段收窄', () => {
    const base = {
      ...goodChipManifest(),
      slots: ['panel', 'tool'],
      tools: [{ name: 'search_issues', description: '只读搜索议题' }],
    };
    const valid = validateGhostManifest({
      ...base,
      atResourceProvider: { tool: 'search_issues' },
    });
    expect(valid.ok).toBe(true);

    const missing = validateGhostManifest({
      ...base,
      atResourceProvider: { tool: 'missing' },
    });
    const extraField = validateGhostManifest({
      ...base,
      atResourceProvider: { tool: 'search_issues', label: 'Issues' },
    });
    expect(missing.ok).toBe(true);
    expect(extraField.ok).toBe(true);
  });

  it('忽略旧 manifest 中无效的同名未知字段', () => {
    const base = {
      ...goodChipManifest(),
      slots: ['panel', 'tool'],
      tools: [{ name: 'search_issues', description: '只读搜索议题' }],
    };
    for (const legacyValue of [
      null,
      true,
      'legacy',
      [],
      {},
      { label: 'Issues' },
    ]) {
      const result = validateGhostManifest({
        ...base,
        atResourceProvider: legacyValue,
      });
      expect(result.ok, JSON.stringify(legacyValue)).toBe(true);
    }
  });

  it('@ 资源入口复用 tool 槽，不新增硬白名单 slot', () => {
    expect(GHOST_SLOTS).not.toContain('at-resource');
    expect(validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'tool', 'at-resource'],
      tools: [{ name: 'search_issues', description: '只读搜索议题' }],
      atResourceProvider: { tool: 'search_issues' },
    }).ok).toBe(false);
  });

  it('@ 资源入口复用原工具执行权，但作为新增调用入口单独披露', () => {
    const raw = {
      ...goodChipManifest(),
      slots: ['panel', 'tool'],
      tools: [{ name: 'search_issues', description: '只读搜索议题' }],
    };
    const before = validateGhostManifest(raw);
    const after = validateGhostManifest({
      ...raw,
      atResourceProvider: { tool: 'search_issues' },
    });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(ghostPermissionBaselineKey(after.manifest)).toBe(
      ghostPermissionBaselineKey(before.manifest),
    );
    expect(diffGhostPermissionItems(before.manifest, after.manifest).added).toEqual([]);
  });

  it('会进入 locale 对象索引的清单 key 统一拒绝对象保留键名', () => {
    const reservedKeys = ['__proto__', 'constructor', 'prototype'];
    const withoutPanel = (manifest: Record<string, unknown>) => {
      const result = { ...manifest };
      delete result.panel;
      return result;
    };

    for (const key of reservedKeys) {
      expect(validateGhostManifest(withoutPanel({
        ...goodManifest(),
        slots: ['tool'],
        tools: [{ name: key, description: 'Reserved tool' }],
      })).ok, `tool ${key}`).toBe(false);

      expect(validateGhostManifest({
        ...goodManifest(),
        settingsHtml: 'settings.html',
        slots: ['panel', 'network'],
        network: {
          hosts: ['api.example.com'],
          secrets: [{
            key,
            label: 'Reserved secret',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          }],
        },
      }).ok, `network secret ${key}`).toBe(false);

      expect(validateGhostManifest({
        ...goodManifest(),
        settingsHtml: 'settings.html',
        slots: ['panel', 'network'],
        network: {
          hosts: [],
          connections: [{
            key,
            label: 'Reserved connection',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          }],
        },
      }).ok, `network connection ${key}`).toBe(false);

      expect(validateGhostManifest({
        ...goodManifest(),
        settingsHtml: 'settings.html',
        slots: ['panel', 'node'],
        node: {
          entry: 'node/worker.cjs',
          protocol: 'json-rpc-stdio',
          secretBindings: [{ key, label: 'Reserved node secret', methods: ['run'] }],
        },
      }).ok, `node secret ${key}`).toBe(false);

      expect(validateGhostManifest(JSON.parse(JSON.stringify({
        ...goodManifest(),
        settingsHtml: 'settings.html',
        setup: {
          requires: [{ anyOf: [{ kv: key, label: 'Reserved setup value' }] }],
        },
      }))).ok, `setup kv ${key}`).toBe(false);
    }
  });

  it('panel.html 与 panel 槽必须成对出现', () => {
    // 有 html 无 panel 槽
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['model'] }).ok).toBe(false);
    // 有 panel 槽无 html
    const noHtml = goodChipManifest();
    (noHtml.panel as Record<string, unknown>).html = undefined;
    delete (noHtml.panel as Record<string, unknown>).html;
    expect(validateGhostManifest(noHtml).ok).toBe(false);
  });

  it('显式指令 command:字符规则 + 必须有工具可干活', () => {
    const chipWithTool = () => ({
      ...goodChipManifest(),
      slots: ['panel', 'tool'],
      tools: [{ name: 'gen_image', description: '生成图片' }],
    });
    expect(validateGhostManifest({ ...chipWithTool(), command: '画图' }).ok).toBe(true);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'draw' }).ok).toBe(true);
    expect(validateGhostManifest({ ...chipWithTool(), command: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'a b' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'a/b' }).ok).toBe(false);
    expect(validateGhostManifest({ ...chipWithTool(), command: 'x'.repeat(33) }).ok).toBe(false);
    // 没有工具的指令无事可做
    expect(validateGhostManifest({ ...goodChipManifest(), command: '画图' }).ok).toBe(false);
  });

  it('settingsHtml 可选,给了必须是安全相对路径', () => {
    expect(validateGhostManifest({ ...goodChipManifest(), settingsHtml: 'settings.html' }).ok).toBe(true);
    expect(validateGhostManifest({ ...goodChipManifest(), settingsHtml: '../s.html' }).ok).toBe(false);
  });
});

describe('ghost · layoutWithGhostPanel(装入即停靠)', () => {
  const manifest = (): GhostManifest => ({
    schemaVersion: 2,
    id: 'hello',
    name: 'Hello 意识',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { html: 'panel.html', minWidth: 240, defaultFraction: 0.18 },
  });

  it('新装缺省 position:停在主聊天窗左侧(right 退役,2026-07-25 定案)', () => {
    const next = layoutWithGhostPanel(createDefaultLayout(), manifest());
    expect(next).not.toBeNull();
    const split = next!.content as SplitNode;
    expect(split.children.map((c) => (c.node.type === 'pane' ? c.node.panelKind : '?'))).toEqual([
      'ghost:hello',
      'chat-main',
      'right-tabs',
    ]);
    const pane = split.children[0];
    expect(pane.fraction).toBeCloseTo(0.18, 5);
    expect(pane.node.type === 'pane' && pane.node.minWidth).toBe(240);
    // 全体份额仍归一
    expect(split.children.reduce((s, c) => s + c.fraction, 0)).toBeCloseTo(1, 5);
  });

  it("position: 'left' → 停在主聊天窗左侧(chat-main 之前)", () => {
    const m = manifest();
    m.panel!.position = 'left';
    const next = layoutWithGhostPanel(createDefaultLayout(), m);
    const split = next!.content as SplitNode;
    expect(split.children.map((c) => (c.node.type === 'pane' ? c.node.panelKind : '?'))).toEqual([
      'ghost:hello',
      'chat-main',
      'right-tabs',
    ]);
  });

  it('重装:树上已有同 kind 的 pane → 返回 null(位置记忆保留,原位复活)', () => {
    const first = layoutWithGhostPanel(createDefaultLayout(), manifest());
    expect(layoutWithGhostPanel(first!, manifest())).toBeNull();
  });

  it('没声明面板的意识 → null,树不动', () => {
    const m = manifest();
    delete m.panel;
    expect(layoutWithGhostPanel(createDefaultLayout(), m)).toBeNull();
  });

  it('清单未给 defaultFraction → 默认 0.2', () => {
    const m = manifest();
    delete m.panel!.defaultFraction;
    const next = layoutWithGhostPanel(createDefaultLayout(), m);
    // 缺省 position=left,面板在 chat-main 之前(下标 0)。
    expect((next!.content as SplitNode).children[0].fraction).toBeCloseTo(0.2, 5);
  });

  it("position: 'tab' → null,不进布局树(页签形态由右侧栏承载)", () => {
    const m = manifest();
    m.panel = { html: 'panel.html', position: 'tab' };
    expect(layoutWithGhostPanel(createDefaultLayout(), m)).toBeNull();
  });
});

describe('ghost · keywords(语义触发扩展词表)', () => {
  function chipWithKeywords(keywords: unknown): Record<string, unknown> {
    return {
      ...goodChipManifest(),
      slots: ['tool', 'panel'],
      tools: [{ name: 'gen_image', description: '生成图片' }],
      keywords,
    };
  }

  it('合法词表通过,重复词(大小写折叠)静默去重', () => {
    const v = validateGhostManifest(chipWithKeywords(['插画', '配图', 'Draw', 'draw ']));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (v.ok) expect(v.manifest.keywords).toEqual(['插画', '配图', 'Draw']);
  });

  it('单字词 / 超长词 / 空数组 / 超过 8 个 → 拒', () => {
    expect(validateGhostManifest(chipWithKeywords(['画'])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords(['x'.repeat(25)])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords([])).ok).toBe(false);
    expect(validateGhostManifest(chipWithKeywords(Array(9).fill('插画'))).ok).toBe(false);
  });

  it('没 tools 光有 keywords → 拒', () => {
    const m = chipWithKeywords(['插画']);
    delete m.tools;
    m.slots = ['panel'];
    expect(validateGhostManifest(m).ok).toBe(false);
  });
});

describe('ghost · cindy 能力详单校验(字段旧名 model 别名兼容)', () => {
  function chipWithModel(model: unknown): Record<string, unknown> {
    return { ...goodChipManifest(), model };
  }

  it('合法详单:类目 image + 动作 generate/edit', () => {
    const v = validateGhostManifest(chipWithModel({ image: ['generate', 'edit'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.cindy).toEqual({ image: ['generate', 'edit'] });
  });

  it('有槽无详单允许装入(老包兼容,运行时零能力)', () => {
    const v = validateGhostManifest(goodChipManifest());
    expect(v.ok).toBe(true);
    expect(v.ok && v.manifest.cindy).toBeUndefined();
  });

  it('有详单但 slots 没有 model → 拒', () => {
    const m = chipWithModel({ image: ['generate'] });
    m.slots = ['panel'];
    const v = validateGhostManifest(m);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toContain('cindy');
  });

  it('未知类目 / 未知动作 / 空数组 / 空对象 / 重复动作 / 非对象 → 拒', () => {
    for (const bad of [
      { text: ['complete'] },
      { image: ['upscale'] },
      { image: [] },
      {},
      { image: ['generate', 'generate'] },
      'image',
      { media: ['upload'] }, // media 类目只有 deposit
      { media: [] },
      { search: ['deep'] },
      { search: [] },
    ]) {
      const v = validateGhostManifest(chipWithModel(bad));
      expect(v.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // #784:media 类目落位必须独立成键——曾经的 `else cindy.video = …` 兜底
  // 分支会把新类目的动作静默塞进 video,校验层还照样放行。
  it('media 类目落进 cindy.media,不串到 video', () => {
    const v = validateGhostManifest(chipWithModel({ media: ['deposit'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.cindy).toEqual({ media: ['deposit'] });
    expect(v.ok && v.manifest.cindy?.video).toBeUndefined();
  });

  it('三类目可同时声明', () => {
    const v = validateGhostManifest(
      chipWithModel({ image: ['generate', 'edit'], video: ['edit'], media: ['deposit'] }),
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.cindy).toEqual({
      image: ['generate', 'edit'],
      video: ['edit'],
      media: ['deposit'],
    });
  });

  // 2026-07-31 快问快答:text 类目独立落位(同 #784 的落位纪律),权限清单
  // 单独成行(cindy:text.oneshot,带固定说明)。
  it('text 类目落进 cindy.text,并生成 cindy:text.oneshot 权限行', () => {
    const v = validateGhostManifest(chipWithModel({ text: ['oneshot'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.cindy).toEqual({ text: ['oneshot'] });
    expect(v.manifest.cindy?.image).toBeUndefined();
    expect(v.manifest.cindy?.video).toBeUndefined();
    expect(ghostPermissionItems(v.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'cindy:text.oneshot',
          kind: 'cindy',
          labelKey: 'cindyTextOneshot',
          detailKey: 'cindyTextOneshotDetail',
        }),
      ]),
    );
  });

  // 2026-08-04 文本转向量:embed 类目独立落位(同 #784 的落位纪律),权限清单
  // 单独成行,说明里插值单次条数上限(常量单源,四份 locale 自动跟随)。
  it('embed 类目落进 cindy.embed,并生成带条数上限的 cindy:embed.text 权限行', () => {
    const v = validateGhostManifest(chipWithModel({ embed: ['text'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.cindy).toEqual({ embed: ['text'] });
    expect(v.manifest.cindy?.text).toBeUndefined();
    expect(v.manifest.cindy?.image).toBeUndefined();
    expect(ghostPermissionItems(v.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'cindy:embed.text',
          kind: 'cindy',
          labelKey: 'cindyEmbedText',
          detailKey: 'cindyEmbedTextDetail',
          detailArgs: { max: String(GHOST_CINDY_EMBED_MAX_TEXTS) },
        }),
      ]),
    );
  });

  it('embed 类目未知动作 / 空数组 → 拒', () => {
    expect(validateGhostManifest(chipWithModel({ embed: ['image'] })).ok).toBe(false);
    expect(validateGhostManifest(chipWithModel({ embed: ['vector'] })).ok).toBe(false);
    expect(validateGhostManifest(chipWithModel({ embed: [] })).ok).toBe(false);
  });

  it('text 类目未知动作 / 空数组 → 拒;五类目可同时声明', () => {
    expect(validateGhostManifest(chipWithModel({ text: ['complete'] })).ok).toBe(false);
    expect(validateGhostManifest(chipWithModel({ text: [] })).ok).toBe(false);
    const v = validateGhostManifest(
      chipWithModel({
        image: ['generate'],
        video: ['edit'],
        media: ['deposit'],
        text: ['oneshot'],
        embed: ['text'],
      }),
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.cindy).toEqual({
      image: ['generate'],
      video: ['edit'],
      media: ['deposit'],
      text: ['oneshot'],
      embed: ['text'],
    });
  });

  it('search 类目落进 cindy.search，并生成独立的 Web Search 权限行', () => {
    const manifest = chipWithModel({ search: ['web'] });
    manifest.slots = ['panel', 'cindy', 'tool'];
    manifest.tools = [{ name: 'research', description: '查询资料' }];
    const v = validateGhostManifest(manifest);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.cindy).toEqual({ search: ['web'] });
    expect(ghostPermissionItems(v.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'cindy:search.web',
          kind: 'cindy',
          labelKey: 'cindySearchWeb',
          detailKey: 'cindySearchWebDetail',
        }),
      ]),
    );
  });

  // 2026-08-05:oneshotModel 快问快答偏好模型(标量意图键,不是类目;
  // 必须与 text.oneshot 成对;权限行说明换带模型版本,装入即知情)。
  it('oneshotModel 合法声明:落 cindy.oneshotModel,权限行说明带模型', () => {
    const v = validateGhostManifest(chipWithModel({ text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.cindy).toEqual({ text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' });
    expect(ghostPermissionItems(v.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'cindy:text.oneshot',
          detailKey: 'cindyTextOneshotModelDetail',
          detailArgs: { model: 'codex/gpt-5.5' },
        }),
      ]),
    );
  });

  it('search.web 缺少 tool 槽或工具声明时拒装', () => {
    const withoutTool = validateGhostManifest(chipWithModel({ search: ['web'] }));
    expect(withoutTool.ok).toBe(false);
    expect(!withoutTool.ok && withoutTool.reason).toContain('tool');
  });

  it('oneshotModel 形态非法 / 无 text.oneshot 本体单挂 → 拒', () => {
    for (const bad of [
      { text: ['oneshot'], oneshotModel: '' },
      { text: ['oneshot'], oneshotModel: '   ' },
      { text: ['oneshot'], oneshotModel: 42 },
      { text: ['oneshot'], oneshotModel: 'x'.repeat(129) },
      { oneshotModel: 'codex/gpt-5.5' },
      { image: ['generate'], oneshotModel: 'gpt-5.5' },
    ]) {
      const v = validateGhostManifest(chipWithModel(bad));
      expect(v.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // 2026-08-05 review:权限指纹必须含 detailKey/detailArgs——同一 key 的固定说明
  // 随声明变(新增/改/删 oneshotModel),只看 key+detail 会把变化漏判成"权限面
  // 没变",更新时用户看不到重新确认。
  it('oneshotModel 新增/变更/移除都算权限面变化(diff/基线/未审三条路径)', () => {
    const plain = validateGhostManifest(chipWithModel({ text: ['oneshot'] }));
    const declared = validateGhostManifest(chipWithModel({ text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' }));
    const declared2 = validateGhostManifest(chipWithModel({ text: ['oneshot'], oneshotModel: 'gpt-5.5' }));
    if (!plain.ok || !declared.ok || !declared2.ok) throw new Error('fixture 应合法');

    // 新增声明:diff 标 added+removed(key 同、说明变),基线不同,未审列出。
    const addDiff = diffGhostPermissionItems(plain.manifest, declared.manifest);
    expect(addDiff.added.map((i) => i.key)).toEqual(['cindy:text.oneshot']);
    expect(addDiff.removed.map((i) => i.key)).toEqual(['cindy:text.oneshot']);
    expect(ghostPermissionBaselineKey(plain.manifest)).not.toBe(ghostPermissionBaselineKey(declared.manifest));
    expect(
      unreviewedGhostPermissionItems(plain.manifest, plain.manifest, declared.manifest).map((i) => i.key),
    ).toEqual(['cindy:text.oneshot']);

    // 改模型:同样算变化。
    expect(diffGhostPermissionItems(declared.manifest, declared2.manifest).added.map((i) => i.key)).toEqual([
      'cindy:text.oneshot',
    ]);

    // 移除声明:同样算变化。
    expect(diffGhostPermissionItems(declared.manifest, plain.manifest).added.map((i) => i.key)).toEqual([
      'cindy:text.oneshot',
    ]);

    // 声明原样:三条路径都认为无变化。
    const same = validateGhostManifest(chipWithModel({ text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' }));
    if (!same.ok) throw new Error('fixture 应合法');
    expect(diffGhostPermissionItems(declared.manifest, same.manifest).added).toEqual([]);
    expect(ghostPermissionBaselineKey(declared.manifest)).toBe(ghostPermissionBaselineKey(same.manifest));
    expect(unreviewedGhostPermissionItems(declared.manifest, declared.manifest, same.manifest)).toEqual([]);
  });
});

describe('ghost · model → cindy 旧名兼容(2026-07-11 更名)', () => {
  it("slots 里的 'model' 与字段 model 都归一化为 cindy(老包不消失)", () => {
    const v = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'model'],
      model: { image: ['generate'] },
    });
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.manifest.slots).toEqual(['panel', 'cindy']);
    expect(v.ok && v.manifest.cindy).toEqual({ image: ['generate'] });
    expect(v.ok && (v.manifest as unknown as Record<string, unknown>).model).toBeUndefined();
  });

  it("新旧名并存时以 cindy 为准;'model' 与 'cindy' 同列 slots 视为重复", () => {
    const both = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'cindy'],
      cindy: { image: ['generate', 'edit'] },
      model: { image: ['generate'] },
    });
    expect(both.ok && both.manifest.cindy).toEqual({ image: ['generate', 'edit'] });

    const dup = validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'model', 'cindy'] });
    expect(dup.ok).toBe(false);
  });
});

describe('ghost · subscribe 订阅详单校验(卡槽①,2026-07-12)', () => {
  const withSub = (subscribe: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'subscribe'],
    subscribe,
    ...extra,
  });

  it('topics 合法值放行并归一化进清单', () => {
    const r = validateGhostManifest(withSub({ topics: ['turn', 'session', 'activity'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.subscribe).toEqual({ topics: ['turn', 'session', 'activity'] });
  });

  it('hooks 必须搭配 launch:"resident",否则拒装', () => {
    const noResident = validateGhostManifest(withSub({ hooks: ['will-user-message'] }));
    expect(noResident.ok).toBe(false);
    if (!noResident.ok) expect(noResident.reason).toContain('resident');

    const ok = validateGhostManifest(
      withSub({ hooks: ['will-user-message'] }, { launch: 'resident' }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.subscribe).toEqual({ hooks: ['will-user-message'] });
  });

  it('未知主题/钩子/空对象/空数组/无槽有详单一律拒', () => {
    expect(validateGhostManifest(withSub({ topics: ['messages'] })).ok).toBe(false);
    expect(validateGhostManifest(withSub({ hooks: ['will-tool-call'] }, { launch: 'resident' })).ok).toBe(false);
    expect(validateGhostManifest(withSub({})).ok).toBe(false);
    expect(validateGhostManifest(withSub({ topics: [] })).ok).toBe(false);
    expect(validateGhostManifest(withSub({ topics: ['turn', 'turn'] })).ok).toBe(false);
    expect(
      validateGhostManifest({ ...goodManifest(), subscribe: { topics: ['turn'] } }).ok,
    ).toBe(false); // slots 没含 subscribe
  });

  it('有槽无详单允许装入(零事件,老包语义)', () => {
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'subscribe'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.subscribe).toBeUndefined();
  });

  it('权限清单两档:hooks 排最顶加重,topics 常规位;无详单不列', () => {
    const both = validateGhostManifest(
      withSub({ topics: ['turn'], hooks: ['will-user-message'] }, { launch: 'resident' }),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      const items = ghostPermissionItems(both.manifest);
      expect(items[0]).toMatchObject({ key: 'subscribe:hooks', labelKey: 'subscribeHooks' });
      expect(items.some((i) => i.key === 'subscribe:topics')).toBe(true);
    }
    const bare = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'subscribe'] });
    if (bare.ok) {
      expect(ghostPermissionItems(bare.manifest).some((i) => i.kind === 'subscribe')).toBe(false);
    }
  });

  it('activity 单列一项权限,从 turn 加订阅 activity 计入扩张;turn/session 清单逐字不变', () => {
    const turnOnly = validateGhostManifest(withSub({ topics: ['turn'] }));
    const withActivity = validateGhostManifest(withSub({ topics: ['turn', 'activity'] }));
    const turnAndSession = validateGhostManifest(withSub({ topics: ['turn', 'session'] }));
    expect(turnOnly.ok && withActivity.ok && turnAndSession.ok).toBe(true);
    if (!turnOnly.ok || !withActivity.ok || !turnAndSession.ok) return;

    // activity 是独立一项(带自己的 label/detail),不并进固定的 subscribe:topics。
    expect(ghostPermissionItems(withActivity.manifest).map((i) => i.key)).toContain(
      'subscribe:topics:activity',
    );
    expect(
      ghostPermissionItems(withActivity.manifest).find((i) => i.key === 'subscribe:topics:activity'),
    ).toMatchObject({ labelKey: 'subscribeActivity', detailKey: 'subscribeActivityDetail' });

    // 存量插件更新时新增 activity 必须被权限扩张检测抓到(plugin-market 要求复核)。
    const added = diffGhostPermissionItems(turnOnly.manifest, withActivity.manifest).added;
    expect(added.map((i) => i.key)).toEqual(['subscribe:topics:activity']);

    // 只动 turn / session 的存量插件权限清单不 churn(批准状态不受影响)。
    expect(diffGhostPermissionItems(turnOnly.manifest, turnAndSession.manifest).added).toEqual([]);
    expect(ghostPermissionItems(turnAndSession.manifest).filter((i) => i.kind === 'subscribe')).toEqual(
      ghostPermissionItems(turnOnly.manifest).filter((i) => i.kind === 'subscribe'),
    );

    // 取消订阅 activity 应报为 removed。
    expect(
      diffGhostPermissionItems(withActivity.manifest, turnOnly.manifest).removed.map((i) => i.key),
    ).toEqual(['subscribe:topics:activity']);
  });

  it('纯 activity 订阅不显示 turn/session 那行:确认框不凭空多报能力', () => {
    const activityOnly = validateGhostManifest(withSub({ topics: ['activity'] }));
    expect(activityOnly.ok).toBe(true);
    if (!activityOnly.ok) return;
    const keys = ghostPermissionItems(activityOnly.manifest)
      .filter((i) => i.kind === 'subscribe')
      .map((i) => i.key);
    // 网关不会给它投 turn / session,所以固定的 subscribe:topics 一行不该出现。
    expect(keys).toEqual(['subscribe:topics:activity']);
  });

  it('订阅 session 或 turn 任一都产出旧 subscribe:topics(存量批准状态不 churn)', () => {
    for (const topics of [['turn'], ['session'], ['turn', 'session'], ['session', 'activity']]) {
      const v = validateGhostManifest(withSub({ topics }));
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(ghostPermissionItems(v.manifest).map((i) => i.key)).toContain('subscribe:topics');
    }
  });

  it('will-assistant-message:出口钩子合法(继承 resident 要求),单列一档权限行', () => {
    const noResident = validateGhostManifest(withSub({ hooks: ['will-assistant-message'] }));
    expect(noResident.ok).toBe(false); // resident 要求 key 在 hooks 非空,自动覆盖新钩子

    const both = validateGhostManifest(
      withSub(
        { hooks: ['will-user-message', 'will-assistant-message'] },
        { launch: 'resident' },
      ),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      const items = ghostPermissionItems(both.manifest);
      // 两个钩点各一行,都在最顶(拦截最重),入口在出口之前。
      expect(items[0]).toMatchObject({ key: 'subscribe:hooks', labelKey: 'subscribeHooks' });
      expect(items[1]).toMatchObject({
        key: 'subscribe:hooks:assistant',
        labelKey: 'subscribeAssistantReply',
      });
    }
    // 只声明出口钩子:只出该行,不误带入口行。
    const outOnly = validateGhostManifest(
      withSub({ hooks: ['will-assistant-message'] }, { launch: 'resident' }),
    );
    if (outOnly.ok) {
      const items = ghostPermissionItems(outOnly.manifest);
      expect(items.some((i) => i.key === 'subscribe:hooks:assistant')).toBe(true);
      expect(items.some((i) => i.key === 'subscribe:hooks')).toBe(false);
    }
  });
});

describe('ghost · description(自我介绍)', () => {
  it('可选携带,原样输出;超长/空串/非字符串拒', () => {
    const base = validateGhostManifest({ ...goodManifest(), description: '画图小助手' });
    expect(base.ok && base.manifest.description).toBe('画图小助手');
    const chip = validateGhostManifest({ ...goodChipManifest(), description: '画图小助手' });
    expect(chip.ok && chip.manifest.description).toBe('画图小助手');

    for (const bad of ['', '  ', 'x'.repeat(301), 42]) {
      expect(validateGhostManifest({ ...goodManifest(), description: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('ghost · panel.position 校验', () => {
  it('left 通过;right 退役兼容归一化为 left;top/bottom 收词但明确拒绝;野值拒', () => {
    const withPos = (position: unknown) => ({
      ...goodManifest(),
      panel: { title: 'Hello', html: 'panel.html', position },
    });
    const left = validateGhostManifest(withPos('left'));
    expect(left.ok && left.manifest.panel?.position).toBe('left');
    // 旧包兼容:right 不拒装(已装插件每次启动重过校验),归一化为 left。
    const right = validateGhostManifest(withPos('right'));
    expect(right.ok && right.manifest.panel?.position).toBe('left');

    for (const pending of ['top', 'bottom']) {
      const v = validateGhostManifest(withPos(pending));
      expect(v.ok).toBe(false);
      expect(!v.ok && v.reason).toContain('暂未支持');
    }
    expect(validateGhostManifest(withPos('center')).ok).toBe(false);
  });

  it("'tab'(右侧栏页签)通过;tab 时 minWidth/defaultFraction 收词明确拒绝", () => {
    const tab = validateGhostManifest({
      ...goodManifest(),
      panel: { title: 'Hello', html: 'panel.html', position: 'tab' },
    });
    expect(tab.ok && tab.manifest.panel?.position).toBe('tab');

    // 页签没有拖缝宽度语义:带停靠专属字段必须明确拒绝,不静默忽略(规则 9)。
    for (const extra of [{ minWidth: 240 }, { defaultFraction: 0.2 }, { minWidth: 240, defaultFraction: 0.2 }]) {
      const v = validateGhostManifest({
        ...goodManifest(),
        panel: { title: 'Hello', html: 'panel.html', position: 'tab', ...extra },
      });
      expect(v.ok, JSON.stringify(extra)).toBe(false);
      expect(!v.ok && v.reason).toContain('仅停靠形态');
    }
  });
});

describe('ghost · whenToUse(语义召回线索)', () => {
  it('可带并原样输出;超长/空串拒', () => {
    const chip = validateGhostManifest({ ...goodChipManifest(), whenToUse: '需要出图时找我' });
    expect(chip.ok && chip.manifest.whenToUse).toBe('需要出图时找我');
    expect(validateGhostManifest({ ...goodChipManifest(), whenToUse: '' }).ok).toBe(false);
    expect(validateGhostManifest({ ...goodChipManifest(), whenToUse: 'x'.repeat(301) }).ok).toBe(false);
  });
});

describe('ghost · cindy 详单 video 类目', () => {
  const withCindy = (cindy: unknown): Record<string, unknown> => ({
    ...goodChipManifest(),
    slots: ['panel', 'cindy'],
    cindy,
  });

  it('video 类目合法收入;image/video 可并存', () => {
    const v = validateGhostManifest(withCindy({ video: ['generate', 'edit'] }));
    expect(v.ok && v.manifest.cindy?.video).toEqual(['generate', 'edit']);
    const both = validateGhostManifest(withCindy({ image: ['generate'], video: ['generate'] }));
    expect(both.ok && both.manifest.cindy?.image).toEqual(['generate']);
    expect(both.ok && both.manifest.cindy?.video).toEqual(['generate']);
  });

  it('video 未知动作 / 空数组 / 重复动作 → 拒;错误话术带类目名', () => {
    const bad = validateGhostManifest(withCindy({ video: ['transcode'] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain('video');
    expect(validateGhostManifest(withCindy({ video: [] })).ok).toBe(false);
    expect(validateGhostManifest(withCindy({ video: ['generate', 'generate'] })).ok).toBe(false);
  });

  it('未知类目报错列出全部支持类目(image / video / media)', () => {
    const bad = validateGhostManifest(withCindy({ audio: ['generate'] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain('video');
    expect(!bad.ok && bad.reason).toContain('media');
  });

  // #784:寄存是唯一"不花钱就写用户媒体库"的能力,确认框必须单独列一行,
  // 并带上主机固定说明(内含字节上限,由常量插值,不在 locale 里写死数字)。
  it('权限清单推导:media.deposit 单独成行且带上限说明', () => {
    const v = validateGhostManifest(withCindy({ media: ['deposit'] }));
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    const items = ghostPermissionItems(v.manifest).filter((i) => i.kind === 'cindy');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'cindy:media.deposit',
      labelKey: 'cindyMediaDeposit',
      detailKey: 'cindyMediaDepositDetail',
    });
    // 数字与单位都从常量算出来(locale 里只有 {{quota}} 占位):反解回字节
    // 必须等于常量本身 —— 上限调成 GB 量级时,写死 "MB" 的文案就是错的。
    const quota = items[0].detailArgs?.quota ?? '';
    expect(quota).toMatch(/^\d+ (MB|GB)$/);
    const [amount, unit] = quota.split(' ');
    expect(Number(amount) * 1024 * 1024 * (unit === 'GB' ? 1024 : 1)).toBe(
      GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
    );
  });

  it('权限清单推导:video 详单产出对应权限项(确认框自动吃到)', () => {
    const v = validateGhostManifest(withCindy({ image: ['generate'], video: ['generate', 'edit'] }));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const keys = ghostPermissionItems(v.manifest).filter((i) => i.kind === 'cindy').map((i) => i.key);
    expect(keys).toEqual(['cindy:image.generate', 'cindy:video.generate', 'cindy:video.edit']);
    const labels = ghostPermissionItems(v.manifest).filter((i) => i.kind === 'cindy').map((i) => i.labelKey);
    expect(labels).toContain('cindyVideoGenerate');
    expect(labels).toContain('cindyVideoEdit');
  });

});

describe('ghost · 逐项权限清单', () => {
  /** 全能力芯片清单:cindy 两动作 + 两工具 + 指令 + 左停面板。 */
  const fullChip = (): GhostManifest => ({
    schemaVersion: 2,
    id: 'art-like',
    name: '画图',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel', 'cindy', 'tool'],
    cindy: { image: ['generate', 'edit'] },
    tools: [
      { name: 'gen_image', description: '出图' },
      { name: 'edit_image', description: '改图' },
    ],
    command: '画图',
    panel: { title: '画廊', html: 'panel.html', position: 'left' },
  });

  it('推导顺序与内容:cindy → 工具 → 指令 → 面板 → 代码', () => {
    const items = ghostPermissionItems(fullChip());
    expect(items.map((i) => i.key)).toEqual([
      'cindy:image.generate',
      'cindy:image.edit',
      'tool:gen_image',
      'tool:edit_image',
      'command:画图',
      'panel:left',
      'code',
    ]);
    const tool = items.find((i) => i.key === 'tool:gen_image');
    expect(tool).toMatchObject({ kind: 'tool', labelKey: 'tool', labelArgs: { name: 'gen_image' }, detail: '出图' });
    const panel = items.find((i) => i.kind === 'panel');
    expect(panel).toMatchObject({ labelKey: 'panelLeft', labelArgs: { title: '画廊' } });
    expect(items.find((i) => i.kind === 'code')).toMatchObject({ detailKey: 'codeDetail' });
  });

  it('缺省推导:面板缺 position 记 right、缺 title 用意识名;有槽无详单 = 零 cindy 项', () => {
    const plain: GhostManifest = {
      schemaVersion: 2,
      id: 'plain',
      name: '说明书',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['panel'],
      panel: { html: 'panel.html' },
    };
    const items = ghostPermissionItems(plain);
    expect(items.map((i) => i.key)).toEqual(['panel:left', 'code']);
    expect(items[0]).toMatchObject({ labelKey: 'panelLeft', labelArgs: { title: '说明书' } });

    // 页签形态在确认框同样逐项如实展示(labelKey 独立成 panelTab)。
    const tabbed = ghostPermissionItems({ ...plain, panel: { html: 'panel.html', position: 'tab' } });
    expect(tabbed.map((i) => i.key)).toEqual(['panel:tab', 'code']);
    expect(tabbed[0]).toMatchObject({ labelKey: 'panelTab', labelArgs: { title: '说明书' } });

    const chipNoNeeds: GhostManifest = {
      schemaVersion: 2,
      id: 'c',
      name: 'C',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['cindy', 'tool'],
      tools: [{ name: 't', description: 'd' }],
    };
    expect(ghostPermissionItems(chipNoNeeds).filter((i) => i.kind === 'cindy')).toEqual([]);
  });

  it('diff:新增/移除按稳定 key 对齐,面板换边 = 移除+新增,unchanged 取新版条目', () => {
    const prev = fullChip();
    const next: GhostManifest = {
      ...fullChip(),
      version: '2.0.0',
      cindy: { image: ['generate'] }, // 移除 edit
      tools: [...(fullChip().tools ?? []), { name: 'style_image', description: '风格化' }], // 新增工具
      panel: { title: '画廊', html: 'panel.html', position: 'tab' }, // 换形态(right 已退役)
    };
    const diff = diffGhostPermissionItems(prev, next);
    expect(diff.added.map((i) => i.key).sort()).toEqual(['panel:tab', 'tool:style_image']);
    expect(diff.removed.map((i) => i.key).sort()).toEqual(['cindy:image.edit', 'panel:left']);
    expect(diff.unchanged.map((i) => i.key)).toEqual([
      'cindy:image.generate',
      'tool:gen_image',
      'tool:edit_image',
      'command:画图',
      'code',
    ]);
  });

  it('diff:完全一致 → added/removed 皆空', () => {
    const d = diffGhostPermissionItems(fullChip(), { ...fullChip(), version: '1.0.1' });
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.unchanged.length).toBe(7);
  });
});

describe('ghost · setup 就绪声明校验(使用前置检查,2026-07-21)', () => {
  /** 带凭证 / 连接 / 设置页的全绿基底,单点破坏它来测 setup 规则。 */
  function setupBase(): Record<string, unknown> {
    return {
      schemaVersion: 2,
      id: 'setup-demo',
      name: 'Setup Demo',
      version: '1.0.0',
      entry: 'main.js',
      slots: ['tool', 'network'],
      tools: [{ name: 'do_it', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [
          { key: 'api_key_a', label: 'Key A', inject: { header: 'Authorization', format: 'Bearer {value}' } },
          { key: 'api_key_b', label: 'Key B', inject: { header: 'Authorization', format: 'Bearer {value}' } },
          { key: 'mail_ident', label: '登录身份', source: 'login-email', inject: { header: 'X-User', format: '{value}' } },
        ],
        connections: [
          { key: 'inst_conn', label: '实例连接', inject: { header: 'PRIVATE-TOKEN', format: '{value}' } },
        ],
      },
    };
  }

  it('合法声明(字符串引用 + kv 对象混合)归一化为结构化条目', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: {
        requires: [
          { anyOf: ['secret:api_key_a', 'secret:api_key_b'] },
          { anyOf: ['connection:inst_conn', { kv: 'default_repo', label: '默认仓库' }] },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.setup).toEqual({
      requires: [
        { anyOf: [{ kind: 'secret', key: 'api_key_a' }, { kind: 'secret', key: 'api_key_b' }] },
        { anyOf: [{ kind: 'connection', key: 'inst_conn' }, { kind: 'kv', key: 'default_repo', label: '默认仓库' }] },
      ],
    });
  });

  it('不声明 setup 时清单不带该字段(缺省走宿主启发式)', () => {
    const result = validateGhostManifest(setupBase());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('setup' in result.manifest).toBe(false);
  });

  it('引用未声明的凭证拒装', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: ['secret:nope'] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('未声明的凭证');
  });

  it('引用未声明的连接拒装', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: ['connection:nope'] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('未声明的连接');
  });

  it('引用 login-email 源凭证拒装(恒就绪,无配置动作可引导)', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: ['secret:mail_ident'] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('login-email');
  });

  it('kv 条目缺 label 拒装(弹窗要有名字可展示)', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: [{ kv: 'default_repo' }] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('label');
  });

  it('kv 条目不允许写成字符串引用(必须对象形态带 label)', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: ['kv:default_repo'] }] },
    });
    expect(result.ok).toBe(false);
  });

  it('kv 引用要求 settingsHtml(没有设置页没人填参数)', () => {
    const base = setupBase();
    delete base.settingsHtml;
    delete base.network; // user 凭证自身也要求 settingsHtml,先摘掉隔离变量
    (base.slots as string[]).splice((base.slots as string[]).indexOf('network'), 1);
    const result = validateGhostManifest({
      ...base,
      setup: { requires: [{ anyOf: [{ kv: 'default_repo', label: '默认仓库' }] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('settingsHtml');
  });

  it('无 network 的意识可以声明纯 kv 需求(带设置页)', () => {
    const base = setupBase();
    delete base.network;
    (base.slots as string[]).splice((base.slots as string[]).indexOf('network'), 1);
    const result = validateGhostManifest({
      ...base,
      setup: { requires: [{ anyOf: [{ kv: 'default_repo', label: '默认仓库' }] }] },
    });
    expect(result.ok).toBe(true);
  });

  it('同组重复条目拒装', () => {
    const result = validateGhostManifest({
      ...setupBase(),
      setup: { requires: [{ anyOf: ['secret:api_key_a', 'secret:api_key_a'] }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('重复');
  });

  it('requires 空数组 = 显式 opt-out(合法,恒就绪声明);空组仍拒装', () => {
    const optOut = validateGhostManifest({ ...setupBase(), setup: { requires: [] } });
    expect(optOut.ok).toBe(true);
    if (optOut.ok) expect(optOut.manifest.setup).toEqual({ requires: [] });
    expect(validateGhostManifest({ ...setupBase(), setup: { requires: [{ anyOf: [] }] } }).ok).toBe(false);
  });
});

describe('ghost · launch 启动模式(2026-07-12)', () => {
  it('缺省合法:不写 launch → 清单不含该字段(运行时按 on-demand 处理)', () => {
    const v = validateGhostManifest(goodManifest());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.manifest.launch).toBeUndefined();
  });

  it('两个合法值原样收入', () => {
    for (const launch of ['on-demand', 'resident'] as const) {
      const v = validateGhostManifest({ ...goodManifest(), launch });
      expect(v.ok, launch).toBe(true);
      if (v.ok) expect(v.manifest.launch).toBe(launch);
    }
  });

  it('未知值拒绝(不静默降级,规则 9)', () => {
    for (const launch of ['always', 'RESIDENT', 42, null, {}]) {
      const v = validateGhostManifest({ ...goodManifest(), launch });
      expect(v.ok, String(launch)).toBe(false);
      if (!v.ok) expect(v.reason).toContain('launch');
    }
  });

  it('resident → 权限清单多一行"常驻运行"(排在可执行代码之前);on-demand 不列', () => {
    const base = validateGhostManifest(goodManifest());
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(ghostPermissionItems(base.manifest).map((i) => i.key)).not.toContain('resident');

    const res = validateGhostManifest({ ...goodManifest(), launch: 'resident' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const keys = ghostPermissionItems(res.manifest).map((i) => i.key);
    expect(keys.indexOf('resident')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('resident')).toBeLessThan(keys.indexOf('code'));
  });
});

describe('ghost · 官方保留 id 前缀(cindy-)', () => {
  it('isOfficialGhostId:cindy- 前缀命中,其它不命中', () => {
    expect(isOfficialGhostId('cindy-web-search')).toBe(true);
    expect(isOfficialGhostId('cindy-art')).toBe(true);
    // 前缀必须完整命中:cindyart 无连字符、my-cindy- 前缀不在最左都不算官方。
    expect(isOfficialGhostId('cindyart')).toBe(false);
    expect(isOfficialGhostId('my-cindy-tool')).toBe(false);
    expect(isOfficialGhostId('web-search')).toBe(false);
  });
});

describe('ghost · network 域名条目格式与匹配', () => {
  it('合法条目:小写域名至少两段,通配只允许最左一段', () => {
    for (const p of ['api.example.com', 'example.com', '*.weather.com', 'a-b.c1.io']) {
      expect(isValidGhostNetworkHostPattern(p), p).toBe(true);
    }
  });

  it('非法条目:裸 TLD/单段/IP/端口/路径/协议/大写/中缀通配', () => {
    for (const p of [
      'com', '*.com', 'localhost', '127.0.0.1', 'api.example.com:8080',
      'api.example.com/v1', 'https://api.example.com', 'API.Example.com',
      'a.*.example.com', 'api.*.com', '', 42, null, '-bad.example.com',
    ]) {
      expect(isValidGhostNetworkHostPattern(p), String(p)).toBe(false);
    }
  });

  it('匹配语义:精确逐字;通配只命中子域不命中裸域', () => {
    expect(ghostNetworkHostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('api.example.com', 'evil-api.example.com')).toBe(false);
    expect(ghostNetworkHostMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(ghostNetworkHostMatches('*.example.com', 'example.com')).toBe(false);
    // 后缀伪装:evilexample.com 不该命中 *.example.com
    expect(ghostNetworkHostMatches('*.example.com', 'evilexample.com')).toBe(false);
  });
});

describe('ghost · network 详单校验', () => {
  const withNet = (network: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'network'],
    // user 凭证一律意识收单(2026-07-13 宿主凭证渲染退役),声明 user 凭证
    // 必须带 settingsHtml——secrets 用例默认给上,免逐个重复;extra 可覆盖。
    settingsHtml: 'settings.html',
    network,
    ...extra,
  });
  const goodSecret = () => ({
    key: 'api_token',
    label: 'Example API Token',
    hint: '在 example.com/settings 生成',
    inject: { header: 'Authorization', format: 'Bearer {value}' },
  });

  it('hosts 合法放行并归一化(小写化/去首尾空白)', () => {
    const r = validateGhostManifest(withNet({ hosts: [' API.Search.Brave.com ', '*.tavily.com'] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.network).toEqual({ hosts: ['api.search.brave.com', '*.tavily.com'] });
  });

  it('hosts 缺失/空/超上限/重复/非法条目一律拒', () => {
    expect(validateGhostManifest(withNet({})).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: [] })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.com`) })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: ['a.example.com', 'A.Example.com'] })).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: ['localhost'] })).ok).toBe(false);
  });

  it('成对约束:有详单必有槽;有槽无详单允许装入(零能力)', () => {
    expect(validateGhostManifest({ ...goodManifest(), network: { hosts: ['api.example.com'] } }).ok).toBe(false);
    const bare = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'network'] });
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.manifest.network).toBeUndefined();
  });

  it('secrets:合法声明放行,inject 绑定归一化进清单', () => {
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [goodSecret()] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.network?.secrets?.[0]).toEqual(goodSecret());
    }
  });

  it('secrets.url:https 控制台地址放行;http/内嵌凭证/非法地址拒', () => {
    const withUrl = (url: unknown) =>
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), url }] });
    const ok = validateGhostManifest(withUrl('https://example.com/settings/keys'));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.manifest.network?.secrets?.[0]?.url).toBe('https://example.com/settings/keys');
    for (const bad of ['http://example.com/keys', 'https://user:pw@example.com/', 'not-a-url', '', 42]) {
      expect(validateGhostManifest(withUrl(bad)).ok, String(bad)).toBe(false);
    }
  });

  it('secrets.source:login-email 收入清单;user 归一化省略;野值拒;login-email 带 url 拒', () => {
    const withSource = (secret: Record<string, unknown>) =>
      validateGhostManifest(withNet({ hosts: ['api.example.com'], secrets: [secret] }));

    // login-email:原样收入(设置页据此只读展示登录邮箱)。
    const identity = withSource({
      key: 'pages_token',
      label: 'Pages 身份',
      source: 'login-email',
      inject: { header: 'X-Pages-Token', format: 'pages_{value}' },
    });
    expect(identity.ok).toBe(true);
    if (identity.ok) expect(identity.manifest.network?.secrets?.[0]?.source).toBe('login-email');

    // 'user' 与缺省同义:归一化后不落清单(权限 diff 不 churn)。
    const explicit = withSource({ ...goodSecret(), source: 'user' });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.manifest.network?.secrets?.[0]?.source).toBeUndefined();

    for (const bad of ['email', 'host-email', '', 42, {}]) {
      expect(withSource({ ...goodSecret(), source: bad }).ok, String(bad)).toBe(false);
    }
    // login-email 没有"前往控制台"可去,声明 url 是清单自相矛盾。
    expect(
      withSource({
        ...goodSecret(),
        source: 'login-email',
        url: 'https://example.com/console',
      }).ok,
    ).toBe(false);
    // login-email + exchange 组合被禁:登录邮箱不外送交换端点。
    expect(
      withSource({
        ...goodSecret(),
        source: 'login-email',
        exchange: {
          url: 'https://api.example.com/token',
          bodyFormat: '{"sub":"{value}"}',
          tokenPath: 'session',
        },
      }).ok,
    ).toBe(false);
  });

  it('secrets.source:login-feishu-token 已退役:一律拒装(存量清单由播种器覆盖自愈)', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['open.feishu.cn'],
        secrets: [
          {
            key: 'feishu_uat',
            label: '飞书登录身份',
            source: 'login-feishu-token',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('source');
  });

  it('权限清单:login-email 凭证用"将使用登录邮箱"分档文案,key 与 user 凭证同构', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        secrets: [
          goodSecret(),
          {
            key: 'pages_token',
            label: 'Pages 身份',
            source: 'login-email',
            inject: { header: 'X-Pages-Token', format: 'pages_{value}' },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    const userItem = items.find((i) => i.key === 'network:secret:api_token');
    expect(userItem?.labelKey).toBe('networkSecret');
    expect(userItem?.detailKey).toBe('networkSecretGhostInputDetail');
    const identityItem = items.find((i) => i.key === 'network:secret:pages_token');
    expect(identityItem?.labelKey).toBe('networkSecretIdentity');
    expect(identityItem?.detailKey).toBe('networkSecretIdentityDetail');
  });

  it('secrets:key 格式/重复、label 缺失、inject 缺失/坏 header/坏 format 一律拒', () => {
    const bads: Array<Record<string, unknown>> = [
      { ...goodSecret(), key: 'Bad-Key' },
      { ...goodSecret(), key: '_x' },
      { ...goodSecret(), label: '' },
      { key: 'a', label: 'A' }, // 无 inject
      { ...goodSecret(), inject: { header: 'Host', format: '{value}' } }, // 协议关键头
      { ...goodSecret(), inject: { header: 'Cookie', format: '{value}' } },
      { ...goodSecret(), inject: { header: 'Content-Type', format: '{value}' } }, // 上传通道 boundary 依赖,禁占用
      { ...goodSecret(), inject: { header: 'X Token', format: '{value}' } }, // 头名带空格
      { ...goodSecret(), inject: { header: 'Authorization', format: 'Bearer' } }, // 无占位
      { ...goodSecret(), inject: { header: 'Authorization', format: '{value}{value}' } }, // 双占位
    ];
    for (const s of bads) {
      const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], secrets: [s] }));
      expect(r.ok, JSON.stringify(s)).toBe(false);
    }
    const dup = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [goodSecret(), goodSecret()] }),
    );
    expect(dup.ok).toBe(false);
  });

  it('secrets.inject.hosts 必须是 hosts 声明条目的子集(逐字)', () => {
    const ok = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com', 'api.tavily.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.brave.com'] } }],
      }),
    );
    expect(ok.ok).toBe(true);

    const outside = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.other.com'] } }],
      }),
    );
    expect(outside.ok).toBe(false);
    // 子域字符串 ≠ 声明的通配条目本身:必须逐字取声明条目
    const literal = validateGhostManifest(
      withNet({
        hosts: ['*.tavily.com'],
        secrets: [{ ...goodSecret(), inject: { header: 'X-Token', format: '{value}', hosts: ['api.tavily.com'] } }],
      }),
    );
    expect(literal.ok).toBe(false);
  });

  it('secrets.exchange:合法二段式声明放行并归一化(含缺省字段省略)', () => {
    const exchange = {
      url: 'https://api.example.com/api/v1/state/token',
      bodyFormat: '{"id":"","sub":"{value}","name":""}',
      tokenPath: 'session',
    };
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange }] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.network?.secrets?.[0]?.exchange).toEqual(exchange);

    const full = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        secrets: [{
          ...goodSecret(),
          exchange: {
            ...exchange,
            contentType: 'application/x-www-form-urlencoded',
            tokenPath: 'data.token',
            ttlSeconds: 86400,
          },
        }],
      }),
    );
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.manifest.network?.secrets?.[0]?.exchange?.contentType).toBe('application/x-www-form-urlencoded');
      expect(full.manifest.network?.secrets?.[0]?.exchange?.ttlSeconds).toBe(86400);
    }
  });

  it('secrets.exchange:坏 url/域名出白名单/坏模板/坏 contentType/坏 tokenPath/坏 ttl 一律拒', () => {
    const good = {
      url: 'https://api.example.com/token',
      bodyFormat: '{"sub":"{value}"}',
      tokenPath: 'session',
    };
    const bads: Array<Record<string, unknown>> = [
      { ...good, url: 'http://api.example.com/token' }, // 非 https
      { ...good, url: 'https://api.example.com:8443/token' }, // 非默认端口
      { ...good, url: 'https://user:pw@api.example.com/token' }, // 内嵌凭证
      { ...good, url: 'https://api.other.com/token' }, // 域名不在白名单
      { ...good, bodyFormat: '{"sub":"key"}' }, // 无 {value} 占位
      { ...good, bodyFormat: '{value}{value}' }, // 双占位
      { ...good, contentType: 'text/plain' }, // contentType 不在白名单
      { ...good, tokenPath: '' },
      { ...good, tokenPath: 'a..b' }, // 空段
      { ...good, tokenPath: 'a[0].b' }, // 数组下标不支持
      { ...good, ttlSeconds: 30 }, // 低于下限
      { ...good, ttlSeconds: 90 * 24 * 3600 }, // 超上限
      { ...good, ttlSeconds: 3600.5 }, // 非整数
    ];
    for (const exchange of bads) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange }] }),
      );
      expect(r.ok, JSON.stringify(exchange)).toBe(false);
    }
    // exchange 非对象也拒
    const notObj = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [{ ...goodSecret(), exchange: 'yes' }] }),
    );
    expect(notObj.ok).toBe(false);
  });

  it('权限清单:域名与凭证逐条列(在工具之前),code 说明换 network 分档版', () => {
    const r = validateGhostManifest(
      withNet({
        hosts: ['api.brave.com', '*.tavily.com'],
        secrets: [goodSecret()],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    const keys = items.map((i) => i.key);
    expect(keys).toContain('network:host:api.brave.com');
    expect(keys).toContain('network:host:*.tavily.com');
    expect(keys).toContain('network:secret:api_token');
    const secretItem = items.find((i) => i.key === 'network:secret:api_token');
    expect(secretItem).toMatchObject({ kind: 'network', labelKey: 'networkSecret', labelArgs: { name: 'Example API Token' } });
    const code = items.find((i) => i.key === 'code');
    expect(code?.detailKey).toBe('codeDetailNetwork');
    // 无 network 槽的意识维持原说明
    const plain = validateGhostManifest(goodManifest());
    if (plain.ok) {
      expect(ghostPermissionItems(plain.manifest).find((i) => i.key === 'code')?.detailKey).toBe('codeDetail');
    }
  });

  it('内容清单含 slotNetwork;更新 diff 能对出新增域名', () => {
    const v1 = validateGhostManifest(withNet({ hosts: ['api.brave.com'] }));
    const v2 = validateGhostManifest(withNet({ hosts: ['api.brave.com', 'evil.example.com'] }));
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(ghostContentKeys(v2.manifest)).toContain('slotNetwork');
    const diff = diffGhostPermissionItems(v1.manifest, v2.manifest);
    expect(diff.added.map((i) => i.key)).toContain('network:host:evil.example.com');
    expect(diff.removed).toHaveLength(0);
  });

  it('notify 槽过校验;内容清单含 slotNotify、权限清单出 notify 条目(带主机说明)', () => {
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'notify'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ghostContentKeys(r.manifest)).toContain('slotNotify');
    const item = ghostPermissionItems(r.manifest).find((i) => i.key === 'notify');
    expect(item).toMatchObject({ kind: 'notify', labelKey: 'notify', detailKey: 'notifyDetail' });
    // 没声明 notify.badge 的老包不该凭空多出未读角标权限。
    expect(ghostPermissionItems(r.manifest).map((i) => i.key)).not.toContain('badge');
  });

  it('badge 槽出**独立**权限条目 —— 老包加这一档必须触发扩权重新确认', () => {
    const before = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'notify'] });
    const after = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'notify', 'badge'] });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(ghostPermissionItems(after.manifest).find((i) => i.key === 'badge')).toMatchObject({
      kind: 'notify',
      labelKey: 'badge',
      detailKey: 'badgeDetail',
    });
    // 关键回归:并进既有 notify key 会让 added 为空,扩权确认框永远不弹
    // (与 subscribe 的 activity topic 同一先例)。
    const diff = diffGhostPermissionItems(before.manifest, after.manifest);
    expect(diff.added.map((i) => i.key)).toEqual(['badge']);
    expect(diff.removed).toHaveLength(0);
  });

  it('badge 与 notify 槽并列:不要 toast 也能要绿点(最小必要权限)', () => {
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'badge'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = ghostPermissionItems(r.manifest).map((i) => i.key);
    expect(keys).toContain('badge');
    expect(keys).not.toContain('notify');
  });

  it('存量兼容(红线):老包里任何形态的 notify 顶层字段都照旧被忽略,不影响装入', () => {
    // `notify` 顶层字段从头到尾就没被登记过,校验器「宽进严出」直接忽略。
    // 现在角标改由 `badge` **卡槽**声明,这个字段更是彻底不参与解释——
    // 老包里写成什么形态都装得进来,也不会因此白拿角标能力。
    for (const shape of [true, 'badge', ['badge'], { badge: true }, { sound: true }, {}]) {
      const r = validateGhostManifest({ ...goodManifest(), slots: ['panel'], notify: shape });
      expect(r.ok, `notify: ${JSON.stringify(shape)} 不该被判 invalid`).toBe(true);
      // **关键**:哪怕老包恰好写成 { badge: true } 且有 panel,也不得凭空获得能力
      // ——它没有经过任何安装/更新确认(codex review P1)。
      if (r.ok) expect(ghostPermissionItems(r.manifest).map((i) => i.key)).not.toContain('badge');
    }
  });

  it('badge 槽是**可证明**的新声明:老包不可能带它(未知槽名一律拒装)', () => {
    // slots 是硬白名单,当年装老包的客户端遇到未登记的 'badge' 会直接拒绝整份清单。
    // 所以「清单里有 badge 槽」⇒「这份清单是本能力上线之后写的」,严格校验才安全。
    const r = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'not-a-real-slot'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未知卡槽');
  });

  it('来源投影丢掉 badge 槽时,包里的 badge 必须被识别成「未审权限」', () => {
    // 场景:服务端市场那份平行校验器不认识 `badge` 槽(它连 `confirm` 都还没有),
    // 投影出的 manifest 少了这一档 → 确认框漏列;而下载的 .cindy 包里 ghost.json
    // 原样带着。装入出口就是拿这个 diff 拦下的(codex review P1)。
    const reviewed = validateGhostManifest({ ...goodManifest(), slots: ['panel'] });
    const packed = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'badge'] });
    expect(reviewed.ok && packed.ok).toBe(true);
    if (!reviewed.ok || !packed.ok) return;
    const unreviewed = diffGhostPermissionItems(reviewed.manifest, packed.manifest).added;
    expect(unreviewed.map((i) => i.key)).toEqual(['badge']);
    // 反向:两份一致时不得误报,否则正常安装会被闸门全拦死。
    expect(diffGhostPermissionItems(packed.manifest, packed.manifest).added).toHaveLength(0);
  });

  it('badge 槽与 panel 严格成对:声明了槽却没有面板一律拒装', () => {
    // 这里可以放心用严格拒绝:带 badge 槽的清单必然是本能力上线之后写的,
    // 不存在"拒了会让存量插件消失"的问题(见上一条的可证明性)。
    const noPanel = validateGhostManifest({
      ...goodManifest(),
      slots: ['tool', 'badge'],
      panel: undefined,
      tools: [{ name: 'ping', description: 'ping' }],
    });
    expect(noPanel.ok).toBe(false);
    if (!noPanel.ok) expect(noPanel.reason).toContain('panel');

    // 有面板就通过,并落成权限项。
    const ok = validateGhostManifest({ ...goodManifest(), slots: ['panel', 'badge'] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ghostPermissionItems(ok.manifest).map((i) => i.key)).toContain('badge');
  });
});

describe('ghost · network 多连接声明(connections)', () => {
  // connections 的收单入口是意识 settingsHtml(地址与 token 都由它收),
  // 基底默认带上;extra 可覆盖(测"缺 settingsHtml 拒"时显式抹掉)。
  const withNet = (network: unknown, extra: Record<string, unknown> = {}) => ({
    ...goodManifest(),
    slots: ['panel', 'network'],
    settingsHtml: 'settings.html',
    network,
    ...extra,
  });
  const goodConn = () => ({
    key: 'gitlab',
    label: 'GitLab 实例',
    hint: '填实例域名与 Personal Access Token',
    inject: { header: 'Private-Token', format: '{value}' },
    maxConnections: 4,
  });

  it('合法声明放行并归一化(hint/maxConnections 透传;未声明的可选字段不落清单)', () => {
    const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], connections: [goodConn()] }));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.network?.connections).toEqual([
      {
        key: 'gitlab',
        label: 'GitLab 实例',
        hint: '填实例域名与 Personal Access Token',
        inject: { header: 'Private-Token', format: '{value}' },
        maxConnections: 4,
      },
    ]);
    // 可选字段缺省不落清单(权限 diff 不 churn)。
    const minimal = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [{ key: 'gl', label: 'GL', inject: { header: 'X-T', format: '{value}' } }] }),
    );
    expect(minimal.ok).toBe(true);
    if (!minimal.ok) return;
    const decl = minimal.manifest.network?.connections?.[0];
    expect(decl && 'hint' in decl).toBe(false);
    expect(decl && 'maxConnections' in decl).toBe(false);
  });

  it('connections 在场时 hosts 可缺省/空数组(归一化为 []);无 connections 时 hosts 仍必填', () => {
    const noHosts = validateGhostManifest(withNet({ connections: [goodConn()] }));
    expect(noHosts.ok, noHosts.ok ? '' : noHosts.reason).toBe(true);
    if (noHosts.ok) expect(noHosts.manifest.network?.hosts).toEqual([]);
    const emptyHosts = validateGhostManifest(withNet({ hosts: [], connections: [goodConn()] }));
    expect(emptyHosts.ok).toBe(true);
    // 双双缺席仍拒(既有回归):静态域名与动态连接至少有其一。
    expect(validateGhostManifest(withNet({})).ok).toBe(false);
    expect(validateGhostManifest(withNet({ hosts: [] })).ok).toBe(false);
  });

  it('声明了 connections 必须同时声明 settingsHtml(没人收地址和 token)', () => {
    const r = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [goodConn()] }, { settingsHtml: undefined }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('settingsHtml');
  });

  it('key 撞 secrets 的 key / connections 内重复 key 一律拒', () => {
    const secret = {
      key: 'gitlab',
      label: 'Token',
      inject: { header: 'Authorization', format: 'Bearer {value}' },
    };
    const clash = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], secrets: [secret], connections: [goodConn()] }),
    );
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.reason).toContain('撞名');
    const dup = validateGhostManifest(
      withNet({ hosts: ['api.example.com'], connections: [goodConn(), goodConn()] }),
    );
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.reason).toContain('重复');
  });

  it('inject.hosts 禁止声明(注入范围恒等于连接自身地址);header/format 规则同 secrets', () => {
    const withHosts = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        connections: [{ ...goodConn(), inject: { header: 'X-T', format: '{value}', hosts: ['api.example.com'] } }],
      }),
    );
    expect(withHosts.ok).toBe(false);
    expect(!withHosts.ok && withHosts.reason).toContain('inject.hosts');
    // 协议关键头拒;format 必须恰含一个 {value}。
    expect(
      validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), inject: { header: 'Cookie', format: '{value}' } }] }),
      ).ok,
    ).toBe(false);
    expect(
      validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), inject: { header: 'X-T', format: 'no-placeholder' } }] }),
      ).ok,
    ).toBe(false);
  });

  it('声明超 2 条 / maxConnections 越界 / key 形状非法一律拒', () => {
    const three = validateGhostManifest(
      withNet({
        hosts: ['api.example.com'],
        connections: [
          { ...goodConn(), key: 'a1' },
          { ...goodConn(), key: 'b2' },
          { ...goodConn(), key: 'c3' },
        ],
      }),
    );
    expect(three.ok).toBe(false);
    for (const bad of [0, 9, 1.5, '4', Number.NaN]) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), maxConnections: bad }] }),
      );
      expect(r.ok, String(bad)).toBe(false);
    }
    for (const badKey of ['Gitlab', '1gl', 'gl-b', 'x'.repeat(33), '']) {
      const r = validateGhostManifest(
        withNet({ hosts: ['api.example.com'], connections: [{ ...goodConn(), key: badKey }] }),
      );
      expect(r.ok, badKey).toBe(false);
    }
  });

  it('权限清单:每条连接声明生成一条 networkConnections 条目(带 label 与主机说明)', () => {
    const r = validateGhostManifest(withNet({ hosts: ['api.example.com'], connections: [goodConn()] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = ghostPermissionItems(r.manifest).find((i) => i.key === 'connections:gitlab');
    expect(item).toMatchObject({
      kind: 'network',
      labelKey: 'networkConnections',
      labelArgs: { label: 'GitLab 实例' },
      detailKey: 'networkConnectionsDetail',
    });
  });
});

describe('ghost · 交互卡 action id 形状(v2)', () => {
  it('放行含 :: 的 mivo customId 与普通 id;拒空/超长/非法字符/带引号', () => {
    // mivo 真实 customId 形态必须过——正则漏收 `:` 会让整排按钮被净化器丢。
    for (const ok of [
      'MJ::JOB::upsample::1::0f3a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
      'NANOBANANA::image::imgPrompt::0::6a546d8ddb8533fb8eea063f',
      'reroll',
      'U1',
      'a_b-c:d',
      'x'.repeat(128),
    ]) {
      expect(GHOST_CARD_ACTION_ID_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'x'.repeat(129),
      'has space',
      'quote"inside',
      "quote'inside",
      'semi;colon',
      'angle<br>',
      '中文动作',
    ]) {
      expect(GHOST_CARD_ACTION_ID_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('ghost · settingsHtml 自绘设置区 + settingsHeight', () => {
  it('settingsHtml 合法相对路径通过并透传;非法路径拒', () => {
    const ok = validateGhostManifest({ ...goodManifest(), settingsHtml: 'ui/settings.html' });
    expect(ok.ok && ok.manifest.settingsHtml).toBe('ui/settings.html');
    for (const bad of ['../evil.html', '/abs.html', 'a\b.html', '']) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: bad });
      expect(r.ok, bad).toBe(false);
    }
  });

  it('settingsHeight:160/800 边界过,159/801/NaN/字符串拒,归一化透传', () => {
    for (const h of [160, 360, 800]) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html', settingsHeight: h });
      expect(r.ok && r.manifest.settingsHeight, String(h)).toBe(h);
    }
    for (const h of [159, 801, Number.NaN, Number.POSITIVE_INFINITY, '360', null]) {
      const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html', settingsHeight: h });
      expect(r.ok, String(h)).toBe(false);
    }
  });

  it('单独声明 settingsHeight(没有 settingsHtml)拒——没有界面就没有高度可言', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHeight: 360 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('settingsHeight');
  });

  it('未声明 settingsHeight 时归一化输出不带该字段', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(r.ok && 'settingsHeight' in r.manifest).toBe(false);
  });

  it('ghostWebviewEntryPaths:只 panel / 只 settings / 双声明 / 都无 / 同文件去重', () => {
    const both = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(both.ok && ghostWebviewEntryPaths(both.manifest)).toEqual(['/panel.html', '/settings.html']);

    const panelOnly = validateGhostManifest(goodManifest());
    expect(panelOnly.ok && ghostWebviewEntryPaths(panelOnly.manifest)).toEqual(['/panel.html']);

    const settingsOnly: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
      settingsHtml: 'settings.html',
    };
    delete settingsOnly.panel;
    const so = validateGhostManifest(settingsOnly);
    expect(so.ok && ghostWebviewEntryPaths(so.manifest)).toEqual(['/settings.html']);

    const none: Record<string, unknown> = {
      ...goodManifest(),
      slots: ['tool'],
      tools: [{ name: 'do_thing', description: '做点事' }],
    };
    delete none.panel;
    const n = validateGhostManifest(none);
    expect(n.ok && ghostWebviewEntryPaths(n.manifest)).toEqual([]);

    const same = validateGhostManifest({ ...goodManifest(), settingsHtml: 'panel.html' });
    expect(same.ok && ghostWebviewEntryPaths(same.manifest)).toEqual(['/panel.html']);
  });

  it('内容清单:声明 settingsHtml 的意识含 settingsUi,排在 panel 后 code 前', () => {
    const r = validateGhostManifest({ ...goodManifest(), settingsHtml: 'settings.html' });
    expect(r.ok && ghostContentKeys(r.manifest)).toEqual(['panel', 'settingsUi', 'code']);
  });
});

describe('ghost · user 凭证由 Host Setup 收单并保留 settingsHtml 管理入口', () => {
  function withSecret(secret: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return validateGhostManifest({
      ...goodManifest(),
      slots: ['panel', 'network'],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'api_key',
            label: 'API Key',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            ...secret,
          },
        ],
      },
      ...extra,
    });
  }

  it('user 凭证 + settingsHtml → 过;遗留 input:"ghost" 接受并忽略、归一化不落清单', () => {
    const plain = withSecret({}, { settingsHtml: 'settings.html' });
    expect(plain.ok, plain.ok ? '' : plain.reason).toBe(true);
    expect(plain.ok && 'input' in (plain.manifest.network?.secrets?.[0] ?? {})).toBe(false);

    const legacy = withSecret({ input: 'ghost' }, { settingsHtml: 'settings.html' });
    expect(legacy.ok, legacy.ok ? '' : legacy.reason).toBe(true);
    expect(legacy.ok && 'input' in (legacy.manifest.network?.secrets?.[0] ?? {})).toBe(false);
  });

  it('user 凭证没声明 settingsHtml → 拒(仍缺少长期管理/替换/清除入口)', () => {
    for (const secret of [{}, { input: 'ghost' }]) {
      const r = withSecret(secret);
      expect(r.ok, JSON.stringify(secret)).toBe(false);
      expect(!r.ok && r.reason).toContain('settingsHtml');
    }
  });

  it("input:'host' → 拒(旧 input 字段已退役);其它非法值同拒", () => {
    const host = withSecret({ input: 'host' }, { settingsHtml: 'settings.html' });
    expect(host.ok).toBe(false);
    expect(!host.ok && host.reason).toContain('退役');
    for (const bad of ['both', '', 42, null]) {
      const r = withSecret({ input: bad }, { settingsHtml: 'settings.html' });
      expect(r.ok, String(bad)).toBe(false);
    }
  });

  it("login-email 凭证无需 settingsHtml(没有收单动作);标注 input:'ghost' 仍拒", () => {
    const ok = withSecret({ source: 'login-email', hint: undefined, url: undefined });
    expect(ok.ok, ok.ok ? '' : ok.reason).toBe(true);

    const r = withSecret(
      { input: 'ghost', source: 'login-email', url: undefined },
      { settingsHtml: 'settings.html' },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('login-email');
  });
});

describe('ghost · 权限清单凭证分档(知情同意面不许说过头话)', () => {
  it('user 凭证 → networkSecretGhostInputDetail;login-email → identity 档', () => {
    const r = validateGhostManifest({
      ...goodManifest(),
      slots: ['panel', 'network'],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [
          { key: 'user_key', label: 'U', inject: { header: 'Authorization', format: 'Bearer {value}' } },
          { key: 'pages_token', label: 'P', source: 'login-email', inject: { header: 'X-Pages-Token', format: 'pages_{value}' } },
        ],
      },
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    expect(items.find((i) => i.key === 'network:secret:user_key')?.detailKey).toBe(
      'networkSecretGhostInputDetail',
    );
    expect(items.find((i) => i.key === 'network:secret:pages_token')?.detailKey).toBe(
      'networkSecretIdentityDetail',
    );
  });
});

describe('ghost · 2026-07-23 通用能力四件套(session-context / pick / preview / node 多入口)', () => {
  const nodeBase = {
    entry: 'node/worker.cjs',
    protocol: 'json-rpc-stdio',
  };
  const withNode = (node: unknown, slots: string[] = ['panel', 'node']) =>
    validateGhostManifest({ ...goodChipManifest(), slots, node });

  it('node.entries:合法申报被原样收录', () => {
    const r = withNode({ ...nodeBase, entries: ['node/build.cjs', 'node/sync.js'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.node?.entries).toEqual(['node/build.cjs', 'node/sync.js']);
  });

  it('node.entries:超条数/重复/撞主入口/撞浏览器 entry/非 CJS/越界路径 一律拒', () => {
    expect(withNode({ ...nodeBase, entries: [] }).ok).toBe(false);
    expect(
      withNode({ ...nodeBase, entries: ['a.cjs', 'b.cjs', 'c.cjs', 'd.cjs', 'e.cjs'] }).ok,
    ).toBe(false);
    expect(withNode({ ...nodeBase, entries: ['node/a.cjs', 'node/a.cjs'] }).ok).toBe(false);
    expect(withNode({ ...nodeBase, entries: ['node/worker.cjs'] }).ok).toBe(false);
    expect(withNode({ ...nodeBase, entries: ['main.js'] }).ok).toBe(false);
    expect(withNode({ ...nodeBase, entries: ['node/a.mjs'] }).ok).toBe(false);
    expect(withNode({ ...nodeBase, entries: ['../evil.cjs'] }).ok).toBe(false);
  });

  it('preview 槽与详单严格成对;hosts 语法同 network 白名单', () => {
    const base = goodChipManifest();
    // 有槽必有详单
    expect(validateGhostManifest({ ...base, slots: ['panel', 'preview'] }).ok).toBe(false);
    // 有详单必有槽
    expect(
      validateGhostManifest({ ...base, preview: { hosts: ['example.com'] } }).ok,
    ).toBe(false);
    const good = validateGhostManifest({
      ...base,
      slots: ['panel', 'preview'],
      preview: { hosts: ['*.example.dev', 'localhost'] },
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.manifest.preview?.hosts).toEqual(['*.example.dev', 'localhost']);
    // 非法模式 / 超条数 / 重复 / 自造字段
    const withPreview = (preview: unknown) =>
      validateGhostManifest({ ...base, slots: ['panel', 'preview'], preview });
    expect(withPreview({ hosts: [] }).ok).toBe(false);
    expect(withPreview({ hosts: ['UPPER.example.com'] }).ok).toBe(false);
    expect(withPreview({ hosts: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] }).ok).toBe(false);
    expect(withPreview({ hosts: ['a.example.com', 'a.example.com'] }).ok).toBe(false);
    expect(withPreview({ hosts: ['a.example.com'], extra: 1 }).ok).toBe(false);
  });

  it('session-context / pick / workspace 槽:纯槽声明即可装入,并生成对应权限项', () => {
    const r = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'session-context', 'pick', 'preview', 'workspace'],
      preview: { hosts: ['example.com'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ghostContentKeys(r.manifest)).toContain('slotWorkspace');
    const items = ghostPermissionItems(r.manifest);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'pick', kind: 'pick', labelKey: 'pick' }),
        expect.objectContaining({
          key: 'session-context',
          kind: 'session-context',
          labelKey: 'sessionContext',
        }),
        expect.objectContaining({
          key: 'preview',
          kind: 'preview',
          labelKey: 'preview',
          detail: 'example.com',
        }),
        expect.objectContaining({
          key: 'workspace',
          kind: 'workspace',
          labelKey: 'workspace',
          detailKey: 'workspaceDetail',
        }),
      ]),
    );
  });

  it('ghostPreviewUrlAllowed:https + 白名单命中放行;http 仅 loopback;凭证/越界/畸形拒', () => {
    const r = validateGhostManifest({
      ...goodChipManifest(),
      slots: ['panel', 'preview'],
      preview: { hosts: ['*.example.dev', 'localhost'] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.manifest;
    expect(ghostPreviewUrlAllowed(m, 'https://demo.example.dev/x?y=1')).toBe(true);
    expect(ghostPreviewUrlAllowed(m, 'http://localhost:5173/preview')).toBe(true);
    // http 非 loopback 域名拒(即便命中白名单模式)
    expect(ghostPreviewUrlAllowed(m, 'http://demo.example.dev/')).toBe(false);
    // 白名单外 / 多级子域越界(*. 只放一层由 ghostNetworkHostMatches 决定,这里至少验非白名单域)
    expect(ghostPreviewUrlAllowed(m, 'https://evil.com/')).toBe(false);
    // URL 内嵌凭证拒
    expect(ghostPreviewUrlAllowed(m, 'https://a:b@demo.example.dev/')).toBe(false);
    // 畸形 / 超长 / 空
    expect(ghostPreviewUrlAllowed(m, 'not-a-url')).toBe(false);
    expect(ghostPreviewUrlAllowed(m, '')).toBe(false);
    expect(ghostPreviewUrlAllowed(m, `https://demo.example.dev/${'x'.repeat(3000)}`)).toBe(false);
    // 未声明详单的清单恒拒
    const none = validateGhostManifest(goodChipManifest());
    expect(none.ok).toBe(true);
    if (none.ok) expect(ghostPreviewUrlAllowed(none.manifest, 'https://demo.example.dev/')).toBe(false);
  });

  it('deriveGhostSessionContext:证明不了本地就 fail closed', () => {
    // 无 sessionId 语境:回落 ALS workdir,恒不可当本地
    expect(deriveGhostSessionContext(null, '/als/dir', null)).toEqual({
      session_id: null,
      workdir: '/als/dir',
      workdir_is_local: false,
      workdir_is_read_only: true,
    });
    // 有 sessionId 但查无会话:同样不可当本地
    expect(deriveGhostSessionContext('s1', '/als/dir', null)).toEqual({
      session_id: 's1',
      workdir: '/als/dir',
      workdir_is_local: false,
      workdir_is_read_only: true,
    });
    // 本地会话:workdir 取会话真身,可当本地
    expect(
      deriveGhostSessionContext('s1', null, {
        workingDir: '/proj',
        remoteHostId: null,
        workdirIsReadOnly: false,
      }),
    ).toEqual({
      session_id: 's1',
      workdir: '/proj',
      workdir_is_local: true,
      workdir_is_read_only: false,
    });
    // 计划 / 只读会话:位置仍是本地,但插件不得修改 workdir
    expect(
      deriveGhostSessionContext('s1', null, {
        workingDir: '/proj',
        remoteHostId: null,
        workdirIsReadOnly: true,
      }),
    ).toEqual({
      session_id: 's1',
      workdir: '/proj',
      workdir_is_local: true,
      workdir_is_read_only: true,
    });
    // SSH 远程会话:路径给(远端事实),但绝不许当本地
    expect(
      deriveGhostSessionContext('s1', null, {
        workingDir: '/remote/proj',
        remoteHostId: 'h1',
        workdirIsReadOnly: false,
      }),
    ).toEqual({
      session_id: 's1',
      workdir: '/remote/proj',
      workdir_is_local: false,
      workdir_is_read_only: false,
    });
    // 会话存在但没 workdir:没有可当本地的对象
    expect(
      deriveGhostSessionContext('s1', null, {
        workingDir: null,
        remoteHostId: null,
        workdirIsReadOnly: false,
      }),
    ).toEqual({
      session_id: 's1',
      workdir: null,
      workdir_is_local: false,
      workdir_is_read_only: false,
    });
  });
});

describe('ghost · 宿主代启子进程(node.childSpawn,2026-07-23)', () => {
  const withNode = (node: unknown) =>
    validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'node'], node });

  it('childSpawn 布尔开关:合法收录;非布尔拒', () => {
    const good = withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio', childSpawn: true });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.manifest.node?.childSpawn).toBe(true);
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio', childSpawn: 'yes' }).ok,
    ).toBe(false);
  });

  it('childSpawn 开启时装入确认框单列一行(kind=node)', () => {
    const r = withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio', childSpawn: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ghostPermissionItems(r.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'node:child-spawn',
          kind: 'node',
          labelKey: 'nodeChildSpawn',
        }),
      ]),
    );
    // 不声明就没有这一行
    const off = withNode({ entry: 'node/a.cjs', protocol: 'json-rpc-stdio' });
    expect(off.ok).toBe(true);
    if (off.ok) {
      expect(
        ghostPermissionItems(off.manifest).some((i) => i.key === 'node:child-spawn'),
      ).toBe(false);
    }
  });

  it('parseGhostNodeChildToHostMessage:合法帧收,超限/畸形一律 null', () => {
    expect(
      parseGhostNodeChildToHostMessage({
        type: 'spawn-child',
        reqId: 'r1',
        entry: 'node/maker.cjs',
        args: ['__maker-proxy'],
      }),
    ).toEqual({ type: 'spawn-child', reqId: 'r1', entry: 'node/maker.cjs', args: ['__maker-proxy'] });
    expect(
      parseGhostNodeChildToHostMessage({ type: 'child-stdin', childId: 'c1', b64: 'aGk=' }),
    ).toEqual({ type: 'child-stdin', childId: 'c1', b64: 'aGk=' });
    expect(parseGhostNodeChildToHostMessage({ type: 'child-kill', childId: 'c1' })).toEqual({
      type: 'child-kill',
      childId: 'c1',
    });
    expect(parseGhostNodeChildToHostMessage({ type: 'child-stdin-end', childId: 'c1' })).toEqual({
      type: 'child-stdin-end',
      childId: 'c1',
    });
    // 畸形:类型不认 / id 形状不对 / args 超条数 / 单参超长 / b64 超帧
    expect(parseGhostNodeChildToHostMessage(null)).toBeNull();
    expect(parseGhostNodeChildToHostMessage({ type: 'evil' })).toBeNull();
    expect(
      parseGhostNodeChildToHostMessage({ type: 'child-kill', childId: 'bad id!' }),
    ).toBeNull();
    expect(
      parseGhostNodeChildToHostMessage({
        type: 'spawn-child',
        reqId: 'r1',
        entry: 'e.cjs',
        args: Array.from({ length: 17 }, () => 'x'),
      }),
    ).toBeNull();
    expect(
      parseGhostNodeChildToHostMessage({
        type: 'spawn-child',
        reqId: 'r1',
        entry: 'e.cjs',
        args: ['y'.repeat(2049)],
      }),
    ).toBeNull();
    expect(
      parseGhostNodeChildToHostMessage({
        type: 'child-stdin',
        childId: 'c1',
        b64: 'a'.repeat(1024 * 1024 + 1),
      }),
    ).toBeNull();
  });
});

describe('ghost · skill 槽(捆绑 Agent Skills,2026-07-25)', () => {
  const withSkill = (skill: unknown, slots: string[] = ['panel', 'skill']) =>
    validateGhostManifest({ ...goodChipManifest(), slots, skill });
  const goodItems = [
    { dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' },
  ];

  it('槽与详单严格成对;合法声明原样收录', () => {
    // 有槽必有详单
    expect(validateGhostManifest({ ...goodChipManifest(), slots: ['panel', 'skill'] }).ok).toBe(false);
    // 有详单必有槽
    expect(
      validateGhostManifest({ ...goodChipManifest(), skill: { items: goodItems } }).ok,
    ).toBe(false);
    const good = withSkill({ items: goodItems });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.manifest.skill?.items).toEqual(goodItems);
  });

  it('items 形状:空/超限/非对象/自造字段一律拒', () => {
    expect(withSkill({ items: [] }).ok).toBe(false);
    expect(withSkill({}).ok).toBe(false);
    expect(withSkill({ items: goodItems, extra: 1 }).ok).toBe(false);
    expect(withSkill({ items: ['skills/foo'] }).ok).toBe(false);
    expect(
      withSkill({ items: [{ ...goodItems[0], scope: 'global' }] }).ok,
    ).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => ({
      dir: `skills/s${i}`,
      name: `s${i}`,
      description: 'x',
    }));
    expect(withSkill({ items: five }).ok).toBe(false);
    // 恰好 4 条放行
    expect(withSkill({ items: five.slice(0, 4) }).ok).toBe(true);
  });

  it('dir:必须是包内安全相对路径', () => {
    const item = (dir: string) => withSkill({ items: [{ dir, name: 'foo', description: 'x' }] });
    expect(item('../evil').ok).toBe(false);
    expect(item('/abs/path').ok).toBe(false);
    expect(item('skills\\foo').ok).toBe(false);
    expect(item('skills/./foo').ok).toBe(false);
    expect(item('').ok).toBe(false);
    expect(item('skills/foo').ok).toBe(true);
  });

  it('name:小写字母数字单连字符分段;禁首尾/连续连字符(链接名 <id>--<name> 的无歧义前提)', () => {
    const named = (name: string) => withSkill({ items: [{ dir: 'skills/foo', name, description: 'x' }] });
    expect(named('foo-bar').ok).toBe(true);
    expect(named('foo2').ok).toBe(true);
    expect(named('Foo').ok).toBe(false);
    expect(named('-foo').ok).toBe(false);
    expect(named('foo-').ok).toBe(false);
    expect(named('foo--bar').ok).toBe(false);
    expect(named('').ok).toBe(false);
    expect(named('a'.repeat(65)).ok).toBe(false);
    expect(named('a'.repeat(64)).ok).toBe(true);
  });

  it('description:1–1024 非空;name/dir 大小写折叠去重', () => {
    const desc = (description: unknown) =>
      withSkill({ items: [{ dir: 'skills/foo', name: 'foo', description }] });
    expect(desc('').ok).toBe(false);
    expect(desc('   ').ok).toBe(false);
    expect(desc('x'.repeat(1025)).ok).toBe(false);
    expect(desc('x'.repeat(1024)).ok).toBe(true);
    expect(desc(42).ok).toBe(false);
    // 重复 name(等值)拒
    expect(
      withSkill({
        items: [
          { dir: 'skills/a', name: 'foo', description: 'x' },
          { dir: 'skills/b', name: 'foo', description: 'y' },
        ],
      }).ok,
    ).toBe(false);
    // 重复 dir 大小写折叠拒(win32 文件系统折叠大小写)
    expect(
      withSkill({
        items: [
          { dir: 'skills/A', name: 'foo', description: 'x' },
          { dir: 'skills/a', name: 'bar', description: 'y' },
        ],
      }).ok,
    ).toBe(false);
  });

  it('权限清单:逐技能置顶展示,key 稳定,detail = 声明的 description;详情页内容含 slotSkill', () => {
    const r = withSkill({
      items: [
        { dir: 'skills/alpha', name: 'alpha', description: '技能 A' },
        { dir: 'skills/beta', name: 'beta', description: '技能 B' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = ghostPermissionItems(r.manifest);
    // 置顶簇:两条 skill 项按声明顺序排在清单最前
    expect(items[0]).toMatchObject({
      key: 'skill:alpha',
      kind: 'skill',
      labelKey: 'skill',
      labelArgs: { name: 'alpha' },
      detailKey: 'skillDetail',
      detail: '技能 A',
    });
    expect(items[1]).toMatchObject({ key: 'skill:beta', detail: '技能 B' });
    expect(ghostContentKeys(r.manifest)).toContain('slotSkill');
  });

  it('更新 diff：技能增删可见,不变项不进 diff', () => {
    const v1 = withSkill({
      items: [{ dir: 'skills/alpha', name: 'alpha', description: '技能 A' }],
    });
    const v2 = withSkill({
      items: [
        { dir: 'skills/alpha', name: 'alpha', description: '技能 A' },
        { dir: 'skills/beta', name: 'beta', description: '技能 B' },
      ],
    });
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    const diff = diffGhostPermissionItems(v1.manifest, v2.manifest);
    expect(diff.added.map((i) => i.key)).toContain('skill:beta');
    expect(diff.removed.map((i) => i.key)).not.toContain('skill:alpha');
  });

  it('更新 diff：同名技能改 description 视为权限变更(added+removed)', () => {
    const v1 = withSkill({
      items: [{ dir: 'skills/alpha', name: 'alpha', description: '旧描述' }],
    });
    const v2 = withSkill({
      items: [{ dir: 'skills/alpha', name: 'alpha', description: '新描述' }],
    });
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    const diff = diffGhostPermissionItems(v1.manifest, v2.manifest);
    expect(diff.added.map((i) => i.key)).toContain('skill:alpha');
    expect(diff.removed.map((i) => i.key)).toContain('skill:alpha');
    expect(diff.unchanged.map((i) => i.key)).not.toContain('skill:alpha');
  });
});
