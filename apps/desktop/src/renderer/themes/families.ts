import { atomOneLight } from './builtin/atom-one-light';
import { defaultDark } from './builtin/default-dark';
import { defaultLight } from './builtin/default-light';
import { eclipse } from './builtin/eclipse';
import { githubDark } from './builtin/github-dark';
import { materialOceanHC } from './builtin/material-ocean-hc';
import { monokaiPro } from './builtin/monokai-pro';
import { oneDarkPro } from './builtin/one-dark-pro';
import { solarizedLight } from './builtin/solarized-light';
import { cindyDark } from './builtin/cindy-dark';
import { cindyLight } from './builtin/cindy-light';
import { LOCAL_THEME_SUFFIX } from '../../shared/local-themes';
import { getLocalThemes } from './local-themes';
import type { Theme, ThemeType } from './types';

/**
 * 一个家族下面最多两个变体 (light + dark)。设置 UI 让用户选家族,然后按
 * 当前显示模式落到对应变体;若家族在当前模式下没变体,fallback 到另一个
 * 并由 UI 显示提示文案 ("xx 主题没有提供浅色方案")。
 */
export interface ThemeFamily {
  id: string;
  name: string;
  light: Theme | null;
  dark: Theme | null;
}

export const DEFAULT_FAMILY_ID = 'cindy';

// 顺序就是设置 dropdown 的显示顺序:Cindy 作为新用户默认主题置顶,
// 之后按 light→dark 双变体优先, 再列 dark-only 家族。
const BUILTIN_FAMILIES: ThemeFamily[] = [
  {
    id: 'cindy',
    name: 'Cindy',
    light: cindyLight,
    dark: cindyDark,
  },
  { id: 'default', name: 'Classic', light: defaultLight, dark: defaultDark },
  { id: 'atom-one', name: 'Atom One', light: atomOneLight, dark: oneDarkPro },
  { id: 'solarized-light', name: 'Solarized Light', light: solarizedLight, dark: null },
  { id: 'eclipse', name: 'Eclipse', light: null, dark: eclipse },
  { id: 'monokai-pro', name: 'Monokai Pro', light: null, dark: monokaiPro },
  { id: 'github', name: 'GitHub', light: null, dark: githubDark },
  {
    id: 'material-ocean-hc',
    name: 'Material Ocean High Contrast',
    light: null,
    dark: materialOceanHC,
  },
];

/**
 * 本地主题 → 家族。
 *
 * 默认每个 JSON 各自成家族（family id = theme.id，已带 `-local` 后缀）。声明了
 * `family` 的文件按该键分组，让一次导入产出的 light + dark 合成一个可跟随模式
 * 切换的主题。分组键同样补 `-local` 后缀：设置页用 `isLocalThemeId(family.id)`
 * 决定「本地」badge 与刷新后的重选，且能避免用户写的 family 名撞上 builtin
 * 家族 id（如 `github`）把内置主题遮蔽掉。
 *
 * 无 `family` 字段的老主题走的还是 `theme.id` 这条路径，家族 id 与行为逐字不变，
 * 已持久化的 lightThemeId / darkThemeId 不会失效。
 */
function buildLocalFamilies(): ThemeFamily[] {
  const families: ThemeFamily[] = [];
  const byKey = new Map<string, ThemeFamily>();
  for (const theme of getLocalThemes()) {
    const key = theme.family ? `${theme.family}${LOCAL_THEME_SUFFIX}` : theme.id;
    const existing = byKey.get(key);
    if (existing) {
      // 同 family 同 type 撞车时保留先出现的（loader 按文件名排序，结果确定）。
      if (theme.type === 'light') existing.light ??= theme;
      else existing.dark ??= theme;
      continue;
    }
    const family: ThemeFamily = {
      id: key,
      name: theme.name,
      light: theme.type === 'light' ? theme : null,
      dark: theme.type === 'dark' ? theme : null,
    };
    byKey.set(key, family);
    families.push(family);
  }
  return families;
}

export function getThemeFamilies(): ThemeFamily[] {
  return [...BUILTIN_FAMILIES, ...buildLocalFamilies()];
}

export function getFamily(id: string): ThemeFamily {
  const family = getThemeFamilies().find((entry) => entry.id === id) ?? null;
  if (!family) {
    throw new Error(`Unknown theme family '${id}'.`);
  }
  return family;
}

export function tryGetFamily(id: string | null | undefined): ThemeFamily | null {
  if (!id) return null;
  return getThemeFamilies().find((family) => family.id === id) ?? null;
}

/** 给一个 theme id, 查它属于哪个家族。迁移老存档专用。 */
export function findFamilyByThemeId(themeId: string | null | undefined): ThemeFamily | null {
  if (!themeId) return null;
  return getThemeFamilies().find((family) =>
    family.light?.id === themeId || family.dark?.id === themeId) ?? null;
}

export interface ResolvedFamilyVariant {
  theme: Theme;
  /** 用户请求的 type, 但家族没提供, 已 fallback 到另一个 type 时为 true */
  fallback: boolean;
  /** 用户请求的 type (而非实际渲染的 type) */
  requestedType: ThemeType;
}

export function resolveFamilyVariant(
  familyId: string,
  requestedType: ThemeType,
): ResolvedFamilyVariant {
  const family = getFamily(familyId);
  const preferred = family[requestedType];
  if (preferred) {
    return { theme: preferred, fallback: false, requestedType };
  }
  const other: ThemeType = requestedType === 'light' ? 'dark' : 'light';
  const fallback = family[other];
  if (!fallback) {
    throw new Error(`Theme family '${familyId}' has no variants.`);
  }
  return { theme: fallback, fallback: true, requestedType };
}
