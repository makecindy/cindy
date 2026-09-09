import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  classifyColor,
  classifySnapshot,
  PROTECTED_IDS,
  SEMANTIC_EXEMPTION_IDS,
  stableStringify,
  type ClassificationCategory,
} from '../classify.ts';
import { buildShadowLayerFiles } from '../generate.ts';
import {
  assertClassificationCoversSnapshot,
  assertProtectedNotSemantic,
  assertSemanticExemptionsRegistered,
} from '../guards.ts';
import { RUNTIME_DERIVED_BUTTON_STATE_IDS } from '../component-roles.ts';
import {
  classificationPath,
  componentPath,
  findRepoRoot,
  referencePath,
  semanticPath,
} from '../paths.ts';
import { readSnapshot } from '../snapshot.ts';

describe('DS-3 · 分类登记', () => {
  const repoRoot = findRepoRoot();
  const snapshot = readSnapshot(repoRoot);
  const generated = classifySnapshot(snapshot.colors, snapshot.source);
  const onDisk = JSON.parse(readFileSync(classificationPath(repoRoot), 'utf8'));

  it('覆盖冻结快照全部 id，计数等于 fixture.count，四类互斥完备', () => {
    expect(snapshot.colors.length).toBe(snapshot.count);
    assertClassificationCoversSnapshot(generated, snapshot);
    expect(generated.snapshotCount).toBe(snapshot.count);
    const sum = Object.values(generated.categories).reduce((a, b) => a + b, 0);
    expect(sum).toBe(snapshot.count);
  });

  it('两次生成字节一致', () => {
    const first = stableStringify(classifySnapshot(snapshot.colors, snapshot.source));
    const second = stableStringify(classifySnapshot(snapshot.colors, snapshot.source));
    expect(first).toBe(second);
    expect(stableStringify(onDisk)).toBe(first);
  });

  it('磁盘上的影子层与内存生成字节一致', () => {
    const built = buildShadowLayerFiles(repoRoot);
    expect(built.files).toEqual([
      { path: classificationPath(repoRoot), body: stableStringify(generated) },
      { path: referencePath(repoRoot), body: stableStringify(built.layers.reference) },
      { path: semanticPath(repoRoot), body: stableStringify(built.layers.semantic) },
      { path: componentPath(repoRoot), body: stableStringify(built.layers.component) },
    ]);
    for (const file of built.files) {
      expect(readFileSync(file.path, 'utf8')).toBe(file.body);
    }
  });

  it('生成物 JSON 检出行尾固定 LF（.gitattributes 已钉 eol=lf，Windows autocrlf 不会转 CRLF）', () => {
    // CI 实锤（2026-09-02 Windows unit tests 红）：core.autocrlf=true 的检出把
    // 生成物 JSON 转成 CRLF 后，上一条「磁盘 = 内存生成」字节一致守卫假红。
    // 修复 = .gitattributes 给 packages/design-tokens/src/**/*.json 钉 eol=lf
    // （drizzle migration .sql 同款先例）。本测试钉住该契约：一旦有人删掉
    // .gitattributes 规则，这里用 git check-attr 直接红灯，不再等 Windows CI。
    for (const relPath of [
      'packages/design-tokens/src/classification.json',
      'packages/design-tokens/src/reference/color.json',
      'packages/design-tokens/src/semantic/color.json',
      'packages/design-tokens/src/component/color.json',
    ]) {
      const attrs = execFileSync(
        'git',
        ['check-attr', 'eol', '--', relPath],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim();
      expect(attrs, `${relPath} 应被 .gitattributes 钉 eol=lf，实际: ${attrs}`).toBe(
        `${relPath}: eol: lf`,
      );
    }
  });

  it('DS-4 运行期派生的 Button 状态值只登记不建模（治理合同 §3.4）', () => {
    // 这五个是 color-mix 派生值：暗色下 surface-hover 与 surface-chip 同值，
    // alias 会让悬停不可见，所以只能派生。派生值不进 DTCG，但必须留登记，
    // 防止日后被悄悄改成不跟主题的字面量。
    for (const id of RUNTIME_DERIVED_BUTTON_STATE_IDS) {
      const entry = generated.entries.find((item) => item.id === id);
      expect(entry, `${id} 未出现在分类登记`).toBeTruthy();
      expect(entry?.category, id).toBe('runtime-derived-or-protected');
      expect(entry?.destination, id).toBe('register-only');
      expect(entry?.modeledAsSemantic, id).toBe(false);
    }
  });

  it('加严保护值标记 protected，Tier-1 照常建模、Tier-3 只登记', () => {
    assertProtectedNotSemantic(generated);
    for (const id of Object.keys(PROTECTED_IDS)) {
      const entry = generated.entries.find((item) => item.id === id);
      expect(entry?.protected).toBeTruthy();
      if (PROTECTED_IDS[id].mode === 'register-only') {
        // Tier-3 singleton：只登记、不建模（治理合同 §3.2「保留原位」）。
        expect(entry?.category).toBe('runtime-derived-or-protected');
        expect(entry?.modeledAsSemantic).toBe(false);
      } else {
        // Tier-1 slot：照常 semantic 建模 + protected 元数据（治理合同
        // §3.2「名称与用途延续」；保护限制改值，不禁止迁移——review P2 实锤：
        // 旧统一 register-only 分支让 text-secondary 从 semantic 消失，
        // DS-8 无法从新真相源生成它）。
        expect(entry?.modeledAsSemantic).toBe(true);
        expect(entry?.category).not.toBe('runtime-derived-or-protected');
      }
    }
  });

  it('语义豁免色照常建模并携带 exemption 元数据（review P2 补洞）', () => {
    // DESIGN.md §10 theme-invariant 豁免族（destructive / error-* / warning-* /
    // focus-ring*）与 PROTECTED_IDS 不同：照常 semantic 建模，但外部主题
    // 不可覆盖。DS-8 生成主题入口时靠 exemption 元数据区分可覆写 semantic
    // 与必须保留原值的豁免族——缺标记时生成端无法区分（review P2 实锤）。
    assertSemanticExemptionsRegistered(generated);
    for (const id of Object.keys(SEMANTIC_EXEMPTION_IDS)) {
      const entry = generated.entries.find((item) => item.id === id);
      expect(entry?.modeledAsSemantic, `${id} 应保持 semantic 建模`).toBe(true);
      expect(entry?.exemption?.family, `${id} 应带 exemption 元数据`).toBe(
        'semantic-exemption',
      );
      expect(entry?.protected, `${id} 不应同时是 protected（那是「只登记不建模」）`).toBeFalsy();
    }
    // 反证：普通可覆写 semantic（如 surface）不带豁免标记。
    const surface = generated.entries.find((item) => item.id === 'surface');
    expect(surface?.exemption).toBeUndefined();
  });

  it('独立 oracle：分类类别必须与快照值实际形态语义一致，不能只看 id 后缀', () => {
    // 独立于被测实现复刻分类语义口径（刻意不复用 classify.ts 的
    // classifyValue / isLiteralKind，改用自己的正则判定，分类规则变更时
    // 必须与本测试同步更新）：
    //   protected 且 register-only（Tier-3）→ runtime-derived-or-protected；
    //   protected 且 semantic-modeled（Tier-1）→ 按值形态正常分类；
    //   -hsl 后缀且双模式都是 hsl-triplet → hsl-triplet；
    //   双 alias → alias；双字面量 → literal；其余一律 runtime-derived。
    const TRIPLET_VALUE_RE = /^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;
    const ALIAS_VALUE_RE = /^(?:hsl\()?var\(--[a-z0-9-]+\)\)?$/;
    const HEX_VALUE_RE = /^#([0-9a-fA-F]{3,8})$/;
    const RGB_VALUE_RE = /^rgba?\(/;
    const HSL_FN_VALUE_RE = /^hsla?\(/;

    const isAlias = (value: string | null) =>
      value != null && ALIAS_VALUE_RE.test(value.trim());
    const isTriplet = (value: string | null) =>
      value != null && TRIPLET_VALUE_RE.test(value.trim());
    const isLiteral = (value: string | null) => {
      if (value == null) return false;
      const text = value.trim();
      return (
        HEX_VALUE_RE.test(text) ||
        RGB_VALUE_RE.test(text) ||
        HSL_FN_VALUE_RE.test(text) ||
        text === 'transparent' ||
        isTriplet(value)
      );
    };

    const expected = new Map<string, ClassificationCategory>();
    for (const color of snapshot.colors) {
      let category: ClassificationCategory;
      const protectedRule = PROTECTED_IDS[color.id];
      if (protectedRule && protectedRule.mode === 'register-only') {
        // Tier-3 singleton：只登记（治理合同 §3.2「保留原位」）。
        category = 'runtime-derived-or-protected';
      } else if (
        color.id.endsWith('-hsl') &&
        isTriplet(color.light) &&
        isTriplet(color.dark)
      ) {
        category = 'hsl-triplet';
      } else if (isAlias(color.light) && isAlias(color.dark)) {
        category = 'alias';
      } else if (isLiteral(color.light) && isLiteral(color.dark)) {
        // Tier-1 semantic-modeled 的保护值（text-secondary 等）按值形态
        // 正常分类（literal），不因 protected 标记改变 category。
        category = 'literal';
      } else {
        category = 'runtime-derived-or-protected';
      }
      expected.set(color.id, category);
    }
    for (const entry of generated.entries) {
      expect(
        entry.category,
        `id=${entry.id} category=${entry.category} 与独立判定 ${expected.get(entry.id)} 不一致`,
      ).toBe(expected.get(entry.id));
    }
  });

  it('反证：-hsl 后缀但值非 triplet 的合成条目不许被分进 hsl-triplet', () => {
    // 旧实现只看 -hsl 后缀就归 hsl-triplet；现在必须按双模式实际值判定。
    const hslSuffixedButLiteral = classifyColor({
      id: 'something-hsl',
      light: '#000000',
      dark: '#ffffff',
    });
    expect(hslSuffixedButLiteral.category).toBe('literal');
    const hslSuffixedButAlias = classifyColor({
      id: 'something-hsl',
      light: 'var(--surface)',
      dark: 'var(--surface)',
    });
    expect(hslSuffixedButAlias.category).toBe('alias');
    const hslSuffixedButSingleMode = classifyColor({
      id: 'something-hsl',
      light: '60 12.5% 97%',
      dark: '#ffffff',
    });
    expect(hslSuffixedButSingleMode.category).toBe('literal');
    // 真实快照中全部 -hsl id 确实双模式都是 triplet（登记与现状一致）
    const realHslIds = snapshot.colors.filter((color) => color.id.endsWith('-hsl'));
    expect(realHslIds.length).toBeGreaterThan(0);
    for (const color of realHslIds) {
      expect(color.light).toMatch(/^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/);
      expect(color.dark).toMatch(/^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/);
    }
  });
});
