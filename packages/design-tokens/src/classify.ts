import type { SnapshotColor } from './snapshot.ts';
import { SEMANTIC_ROLE_IDS } from './semantic-roles.ts';

export const CLASSIFICATION_CATEGORIES = [
  'literal',
  'alias',
  'hsl-triplet',
  'runtime-derived-or-protected',
] as const;

export type ClassificationCategory = (typeof CLASSIFICATION_CATEGORIES)[number];

export type ClassificationDestination =
  | 'reference-candidate'
  | 'semantic-or-component-candidate'
  | 'hsl-pair'
  | 'register-only';

export interface ProtectedRule {
  family: 'cindy-skin-family' | 'u2-secondary-info' | 'annotation-accent';
  owner: string;
  rule: string;
  /**
   * semantic-modeled：Tier-1 semantic slot（治理合同 §3.2「名称与用途延续」）
   * ——照常 semantic 建模 + 保留 protected 元数据；保护限制的是改值须经
   * 裁决，不是禁止迁移（review P2 实锤：U2 的 text-secondary 被统一
   * register-only 分支移出 semantic，DS-8 将无法从新真相源生成它）。
   * register-only：Tier-3 singleton（治理合同 §3.2「protected 角色或保留
   * 原位，逐项裁决，默认不动」）——本 PR 未裁决进 semantic，只登记。
   */
  mode: 'semantic-modeled' | 'register-only';
}

export interface ExemptionRule {
  family: 'semantic-exemption';
  owner: string;
  rule: string;
}

export interface ClassificationEntry {
  id: string;
  category: ClassificationCategory;
  destination: ClassificationDestination;
  lightKind: ValueKind;
  darkKind: ValueKind;
  aliasOf?: { light: string | null; dark: string | null };
  hslPairOf?: string;
  protected?: ProtectedRule;
  /** 语义豁免色（DESIGN.md §10 theme-invariant 族）：照常 semantic 建模，但带豁免元数据——外部主题不可覆盖，DS-8 生成主题入口时据此与可覆写 semantic 区分。 */
  exemption?: ExemptionRule;
  modeledAsSemantic: boolean;
}

export interface ClassificationDocument {
  source: string;
  generatedBy: 'packages/design-tokens/src/classify.ts';
  snapshotCount: number;
  categories: Record<ClassificationCategory, number>;
  entries: ClassificationEntry[];
}

export type ValueKind =
  | 'null'
  | 'alias'
  | 'hex'
  | 'rgb'
  | 'hsl-function'
  | 'hsl-triplet'
  | 'transparent'
  | 'css-keyword'
  | 'color-mix'
  | 'shadow'
  | 'non-color'
  | 'mixed';

const VAR_RE = /^(?:hsl\()?var\(--([a-z0-9-]+)\)\)?$/;
const HEX_RE = /^#([0-9a-fA-F]{3,8})$/;
const RGB_RE = /^rgba?\(/;
const HSL_FN_RE = /^hsla?\(/;
const TRIPLET_RE = /^-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;
const LENGTH_RE = /^\d+(?:\.\d+)?(?:px|rem|ms|em)$/;
const NUMBER_RE = /^\d+(?:\.\d+)?$/;

/**
 * 加严保护值：治理合同 §1.1 / DESIGN.md §15。
 * 两种 mode（治理合同 §3.2 的 Tier-1/Tier-3 分野）：
 *  - semantic-modeled——Tier-1 slot（text-secondary / text-secondary-cross）：
 *    照常 semantic 建模 + protected 元数据。U2 保护限制的是改值须裁决，
 *    不是禁止迁移；「名称与用途延续」要求 DS-8 能从新真相源生成它们。
 *  - register-only——Tier-3 singleton（annotation-accent / login-brand-*）：
 *    只登记、不建模（治理合同「保留原位，逐项裁决，默认不动」）。
 * CINDY 皮肤族在默认 ColorRegistry 里只有登录品牌红两项（其余皮肤值在
 * cindy-light/dark 主题 override，不在本快照）。
 */
export const PROTECTED_IDS: Readonly<Record<string, ProtectedRule>> = {
  'annotation-accent': {
    family: 'annotation-accent',
    owner: 'DESIGN.md §15.4',
    rule: '图片标注烧录墨色，exempt, do not change',
    mode: 'register-only',
  },
  'text-secondary': {
    family: 'u2-secondary-info',
    owner: 'DESIGN.md §15.5',
    rule: 'U2 二级信息色，never darken unilaterally',
    mode: 'semantic-modeled',
  },
  'text-secondary-cross': {
    family: 'u2-secondary-info',
    owner: 'DESIGN.md §15.5',
    rule: 'U2 二级信息色，never darken unilaterally',
    mode: 'semantic-modeled',
  },
  'login-brand-accent': {
    family: 'cindy-skin-family',
    owner: 'DESIGN.md §15.1',
    rule: 'CINDY 皮肤族品牌红，实现期零裁量',
    mode: 'register-only',
  },
  'login-brand-accent-pressed': {
    family: 'cindy-skin-family',
    owner: 'DESIGN.md §15.1',
    rule: 'CINDY 皮肤族品牌红（pressed），实现期零裁量',
    mode: 'register-only',
  },
};

/**
 * 语义豁免色（DESIGN.md §10 Semantic Exemption Colors，theme-invariant）：
 * 与 PROTECTED_IDS 的区别——豁免色**照常进 semantic 建模**（消费方按语义
 * 角色引用），但外部主题不可覆盖、跨主题恒定。治理合同 §3.2 要求 Tier-3
 * 豁免色作为 semantic 中的 protected 角色迁移；这里用独立的 exemption
 * 标记承载（不塞 PROTECTED_IDS——那个的语义是「只登记不建模」，会被
 * assertProtectedNotSemantic 拒进 semantic）。DS-8 生成主题入口时据此
 * 区分「可覆写 semantic」与「必须保留原值的豁免族」。
 * 只登记已进首批 semantic 角色（SEMANTIC_ROLES）的豁免色；DESIGN.md §10
 * 豁免表其余未建模项（diff-*、login-error-fg 等）进 shadow 层时再登记。
 */
export const SEMANTIC_EXEMPTION_IDS: Readonly<Record<string, ExemptionRule>> = {
  destructive: {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'error-flat': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'error-bg': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'error-border': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'error-fg': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'error-fg-strong': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'warning-accent': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'warning-fg': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'warning-bg-soft': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'focus-ring': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
  'focus-ring-soft': {
    family: 'semantic-exemption',
    owner: 'DESIGN.md §10',
    rule: 'theme-invariant 语义豁免色（Tier-3 singleton），外部主题不覆盖',
  },
};

export function parseAliasTarget(value: string | null): string | null {
  if (value == null) return null;
  const match = VAR_RE.exec(value.trim());
  return match ? match[1] : null;
}

export function classifyValue(value: string | null): ValueKind {
  if (value == null) return 'null';
  const text = value.trim();
  if (text.startsWith('color-mix(')) return 'color-mix';
  if (parseAliasTarget(text)) return 'alias';
  if (text === 'transparent') return 'transparent';
  if (text === 'inherit' || text === 'none' || text === 'currentColor') {
    return 'css-keyword';
  }
  if (HEX_RE.test(text)) return 'hex';
  if (RGB_RE.test(text)) return 'rgb';
  if (HSL_FN_RE.test(text)) return 'hsl-function';
  if (TRIPLET_RE.test(text)) return 'hsl-triplet';
  if (LENGTH_RE.test(text) || NUMBER_RE.test(text) || text.startsWith('cubic-bezier')) {
    return 'non-color';
  }
  if (/\brgba?\(/.test(text)) return 'shadow';
  return 'mixed';
}

export function isLiteralKind(kind: ValueKind): boolean {
  return (
    kind === 'hex' ||
    kind === 'rgb' ||
    kind === 'hsl-function' ||
    kind === 'hsl-triplet' ||
    kind === 'transparent'
  );
}

export function classifyColor(entry: SnapshotColor): ClassificationEntry {
  const lightKind = classifyValue(entry.light);
  const darkKind = classifyValue(entry.dark);
  const protectedRule = PROTECTED_IDS[entry.id];
  // 豁免色照常建模（category / destination 走正常分支），只附加豁免元数据。
  const exemptionRule = SEMANTIC_EXEMPTION_IDS[entry.id];

  if (protectedRule) {
    // register-only（Tier-3 singleton）：只登记、不建模，维持既有行为。
    if (protectedRule.mode === 'register-only') {
      return {
        id: entry.id,
        category: 'runtime-derived-or-protected',
        destination: 'register-only',
        lightKind,
        darkKind,
        protected: protectedRule,
        modeledAsSemantic: false,
      };
    }
    // semantic-modeled（Tier-1 slot）：照常走值形态分类（命名与用途延续），
    // 保留 protected 元数据、强制进 semantic——保护限制改值，不禁止迁移。
    return {
      id: entry.id,
      category: isLiteralKind(lightKind) && isLiteralKind(darkKind)
        ? 'literal'
        : lightKind === 'alias' && darkKind === 'alias'
          ? 'alias'
          : 'runtime-derived-or-protected',
      destination: isLiteralKind(lightKind) && isLiteralKind(darkKind)
        ? 'reference-candidate'
        : lightKind === 'alias' && darkKind === 'alias'
          ? 'semantic-or-component-candidate'
          : 'register-only',
      lightKind,
      darkKind,
      aliasOf: lightKind === 'alias' && darkKind === 'alias'
        ? { light: parseAliasTarget(entry.light), dark: parseAliasTarget(entry.dark) }
        : undefined,
      protected: protectedRule,
      modeledAsSemantic: true,
    };
  }

  // -hsl 后缀只是命名约定，不能单独作为判据：双模式必须真的都是 hsl-triplet
  // 值（形如 `60 12.5% 97%`）。后缀命中但值不是 triplet 的条目按实际值形态
  // 落入 alias / literal / runtime-derived 分支，不许冒充 hsl-pair。
  if (
    entry.id.endsWith('-hsl') &&
    lightKind === 'hsl-triplet' &&
    darkKind === 'hsl-triplet'
  ) {
    return {
      id: entry.id,
      category: 'hsl-triplet',
      destination: 'hsl-pair',
      lightKind,
      darkKind,
      hslPairOf: entry.id.slice(0, -'-hsl'.length),
      ...(exemptionRule ? { exemption: exemptionRule } : {}),
      modeledAsSemantic: SEMANTIC_ROLE_IDS.has(entry.id),
    };
  }

  if (lightKind === 'alias' && darkKind === 'alias') {
    return {
      id: entry.id,
      category: 'alias',
      destination: 'semantic-or-component-candidate',
      lightKind,
      darkKind,
      aliasOf: {
        light: parseAliasTarget(entry.light),
        dark: parseAliasTarget(entry.dark),
      },
      ...(exemptionRule ? { exemption: exemptionRule } : {}),
      modeledAsSemantic: SEMANTIC_ROLE_IDS.has(entry.id),
    };
  }

  if (isLiteralKind(lightKind) && isLiteralKind(darkKind)) {
    return {
      id: entry.id,
      category: 'literal',
      destination: 'reference-candidate',
      lightKind,
      darkKind,
      ...(exemptionRule ? { exemption: exemptionRule } : {}),
      modeledAsSemantic: SEMANTIC_ROLE_IDS.has(entry.id),
    };
  }

  return {
    id: entry.id,
    category: 'runtime-derived-or-protected',
    destination: 'register-only',
    lightKind,
    darkKind,
    modeledAsSemantic: false,
  };
}

export function classifySnapshot(
  colors: readonly SnapshotColor[],
  source: string,
): ClassificationDocument {
  const entries = colors.map(classifyColor);
  const categories = {
    literal: 0,
    alias: 0,
    'hsl-triplet': 0,
    'runtime-derived-or-protected': 0,
  } satisfies Record<ClassificationCategory, number>;
  for (const entry of entries) {
    categories[entry.category] += 1;
  }
  return {
    source,
    generatedBy: 'packages/design-tokens/src/classify.ts',
    snapshotCount: colors.length,
    categories,
    entries,
  };
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
