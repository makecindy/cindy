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
 * 只登记、不进 semantic 映射。CINDY 皮肤族在默认 ColorRegistry 里
 * 只有登录品牌红两项（其余皮肤值在 cindy-light/dark 主题 override，不在本快照）。
 */
export const PROTECTED_IDS: Readonly<Record<string, ProtectedRule>> = {
  'annotation-accent': {
    family: 'annotation-accent',
    owner: 'DESIGN.md §15.4',
    rule: '图片标注烧录墨色，exempt, do not change',
  },
  'text-secondary': {
    family: 'u2-secondary-info',
    owner: 'DESIGN.md §15.5',
    rule: 'U2 二级信息色，never darken unilaterally',
  },
  'text-secondary-cross': {
    family: 'u2-secondary-info',
    owner: 'DESIGN.md §15.5',
    rule: 'U2 二级信息色，never darken unilaterally',
  },
  'login-brand-accent': {
    family: 'cindy-skin-family',
    owner: 'DESIGN.md §15.1',
    rule: 'CINDY 皮肤族品牌红，实现期零裁量',
  },
  'login-brand-accent-pressed': {
    family: 'cindy-skin-family',
    owner: 'DESIGN.md §15.1',
    rule: 'CINDY 皮肤族品牌红（pressed），实现期零裁量',
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

  if (protectedRule) {
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
