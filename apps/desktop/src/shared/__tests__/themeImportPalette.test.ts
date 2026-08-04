import { describe, expect, it } from 'vitest';

import { colorRegistry } from '../../renderer/themes/color-registry';
// import 触发整表 registerColor（照 themes/__tests__/tokenRegistry.test.ts 的做法）。
import '../../renderer/themes/colors';
import { atomOneLight } from '../../renderer/themes/builtin/atom-one-light';
import { githubDark } from '../../renderer/themes/builtin/github-dark';
import { oneDarkPro } from '../../renderer/themes/builtin/one-dark-pro';
import { solarizedLight } from '../../renderer/themes/builtin/solarized-light';
import {
  contrastRatio,
  parseCssColor,
  toHex,
  toHslTriplet,
  type Rgb,
} from '../theme-import/color';
import {
  buildThemeColorsFromPalette,
  TEMPLATE_TOKEN_IDS,
  type ThemePalette,
} from '../theme-import/palette';
import { isProtectedToken } from '../theme-import/protected-tokens';

/**
 * 模板 golden 对照。
 *
 * `palette.ts` 的模板是从 7 个人工移植的 builtin 社区主题里抽出来的,所以正确性
 * 就该用那些主题本身来证:把某个主题头部的手写色板常量喂进模板,输出必须重现该
 * 主题的 colors。
 *
 * 一处必要的放宽:`-hsl` 类 token 在手写主题里是**人工近似值**(实测
 * one-dark-pro 的 ELEVATED_BG_HSL 写 `220 13% 15%`,而 #21252b 精确换算是
 * `216 13% 15%`;github-dark 的 SURFACE_BG_HSL 更是从 one-dark-pro 复制后只改了
 * L)。转换器必须走精确换算(否则 hex 与 HSL 两种形态会表示不同颜色),因此 HSL
 * token 不与手写值比,而是断言"等于对应色板角色的精确换算"——这验证的是模板把
 * 正确的角色接到了正确的 token 上,强度不降。
 */

function rgb(hex: string): Rgb {
  const parsed = parseCssColor(hex);
  if (!parsed) throw new Error(`bad fixture hex: ${hex}`);
  return parsed;
}

const SWITCH_DERIVATION_TARGET = 3.2;

/** one-dark-pro.ts 头部的手写色板（dark 代表）。 */
const ONE_DARK_PRO_PALETTE: ThemePalette = {
  surface: rgb('#282c34'),
  elevated: rgb('#21252b'),
  elevatedSoft: rgb('#21252b'),
  hover: rgb('#2c313a'),
  chip: rgb('#2c313a'),
  border: rgb('#3e4452'),
  textPrimary: rgb('#abb2bf'),
  textSecondary: rgb('#7f848e'),
  textTertiary: rgb('#5c6370'),
  textDisabled: rgb('#495162'),
  accentPrimary: rgb('#61afef'),
  accentSoft: rgb('#82c0ff'),
  accentDeep: rgb('#3d7ec8'),
};

/** atom-one-light.ts 头部的手写色板（light 代表）。 */
const ATOM_ONE_LIGHT_PALETTE: ThemePalette = {
  surface: rgb('#FAFAFA'),
  elevated: rgb('#FFFFFF'),
  elevatedSoft: rgb('#EAEAEB'),
  hover: rgb('#E4E4E5'),
  chip: rgb('#EAEAEB'),
  border: rgb('#D4D4D5'),
  textPrimary: rgb('#383A42'),
  textSecondary: rgb('#696c77'),
  textTertiary: rgb('#A0A1A7'),
  textDisabled: rgb('#C8C8C9'),
  accentPrimary: rgb('#4078F2'),
  // atom-one-light 只声明了 PRIMARY 与 DEEP，soft 槽位用的也是 DEEP。
  accentSoft: rgb('#2050c0'),
  accentDeep: rgb('#2050c0'),
};

/** solarized-light.ts 头部的手写色板（light 第二例）。 */
const SOLARIZED_LIGHT_PALETTE: ThemePalette = {
  surface: rgb('#fdf6e3'),
  elevated: rgb('#eee8d5'),
  elevatedSoft: rgb('#eee8d5'),
  hover: rgb('#eee8d5'),
  chip: rgb('#eee8d5'),
  border: rgb('#e1dcc4'),
  textPrimary: rgb('#757575'),
  textSecondary: rgb('#828282'),
  textTertiary: rgb('#999999'),
  textDisabled: rgb('#bdbdbd'),
  accentPrimary: rgb('#859900'),
  accentSoft: rgb('#5e6a00'),
  accentDeep: rgb('#5e6a00'),
  // Solarized 惯例：卡片 / 输入框用 base2 压暗一档（solarized-light.ts 头部注释）。
  inputBg: rgb('#eee8d5'),
};

/** 值为 HSL 三元组的 token → 它应当换算自哪个色板角色（仅必填角色，可选的 inputBg 不在此列）。 */
type RequiredPaletteRole = {
  [K in keyof ThemePalette]-?: undefined extends ThemePalette[K] ? never : K;
}[keyof ThemePalette];
const HSL_TOKEN_ROLE: Record<string, RequiredPaletteRole> = {
  'surface-hsl': 'surface',
  'surface-hover-hsl': 'hover',
  'border-default-hsl': 'border',
  'border-shadcn-hsl': 'border',
  'text-primary-hsl': 'textPrimary',
  'text-tertiary-hsl': 'textTertiary',
  accent: 'hover',
  background: 'surface',
  muted: 'chip',
  'muted-foreground': 'textSecondary',
  popover: 'elevated',
  'search-match-fg': 'textPrimary',
  'sidebar-action-icon': 'textTertiary',
  'sidebar-item-active': 'chip',
  'splash-bg': 'surface',
  'splash-text': 'textSecondary',
  'splash-text-destructive': 'textPrimary',
  'splash-text-muted': 'textTertiary',
  'titlebar-icon': 'textSecondary',
};

/** light / dark 取值不同、且 light 侧是固定字面量的 HSL token。 */
const HSL_TOKEN_ROLE_BY_TYPE: Record<string, { dark: RequiredPaletteRole; light: RequiredPaletteRole }> = {
  'primary-foreground': { dark: 'surface', light: 'surface' },
  secondary: { dark: 'elevated', light: 'chip' },
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

describe('theme-import 模板 · key 集合与既有 builtin 主题一致', () => {
  it('TEMPLATE_TOKEN_IDS 覆盖 github-dark，并仅追加导入主题专用的 Switch token', () => {
    const builtinIds = Object.keys(githubDark.colors);
    expect(builtinIds.filter((id) => !TEMPLATE_TOKEN_IDS.includes(id))).toEqual([]);
    expect(TEMPLATE_TOKEN_IDS.filter((id) => !builtinIds.includes(id)).sort()).toEqual([
      'switch-thumb-off',
      'switch-track-off',
    ]);
  });

  it('模板 key 无重复', () => {
    expect(new Set(TEMPLATE_TOKEN_IDS).size).toBe(TEMPLATE_TOKEN_IDS.length);
  });

  it.each(['dark', 'light'] as const)('%s 模式输出的 key 就是模板清单', (type) => {
    const palette = type === 'dark' ? ONE_DARK_PRO_PALETTE : ATOM_ONE_LIGHT_PALETTE;
    const out = buildThemeColorsFromPalette(palette, type);
    expect(Object.keys(out).sort()).toEqual([...TEMPLATE_TOKEN_IDS].sort());
  });

  it('模板每个 token 都已在 colorRegistry 注册（防拼错成读不到值的幽灵 token）', () => {
    const unregistered = TEMPLATE_TOKEN_IDS.filter(
      (id) => colorRegistry.resolveDefault(id, 'light') === null
        && colorRegistry.resolveDefault(id, 'dark') === null,
    );
    expect(unregistered).toEqual([]);
  });

  it('模板不产出任何语义豁免族 token（登录/危险/警告/焦点/diff）', () => {
    expect(TEMPLATE_TOKEN_IDS.filter((id) => isProtectedToken(id))).toEqual([]);
  });
});

describe.each([
  [
    'light',
    {
      ...ATOM_ONE_LIGHT_PALETTE,
      surface: rgb('#ffffff'),
      elevated: rgb('#ffffff'),
      elevatedSoft: rgb('#fafafa'),
      hover: rgb('#f8f8f8'),
      chip: rgb('#f7f7f7'),
      border: rgb('#eeeeee'),
      textSecondary: rgb('#f0f0f0'),
    } satisfies ThemePalette,
  ],
  [
    'dark',
    {
      ...ONE_DARK_PRO_PALETTE,
      surface: rgb('#000000'),
      elevated: rgb('#050505'),
      elevatedSoft: rgb('#050505'),
      hover: rgb('#0a0a0a'),
      chip: rgb('#0c0c0c'),
      border: rgb('#111111'),
      textSecondary: rgb('#101010'),
    } satisfies ThemePalette,
  ],
] as const)('theme-import 模板 · %s 低对比度输入', (type, palette) => {
  it('为关闭态 Switch 派生带余量的轨道与滑块色', () => {
    const out = buildThemeColorsFromPalette(palette, type);
    const track = rgb(out['switch-track-off']);
    const thumb = rgb(out['switch-thumb-off']);

    expect(out['switch-track-off']).not.toBe(normalize(toHex(palette.textSecondary)));
    expect(contrastRatio(track, thumb), 'thumb x track')
      .toBeGreaterThanOrEqual(SWITCH_DERIVATION_TARGET);

    for (const surfaceId of [
      'surface',
      'surface-elevated',
      'surface-card-ivory',
      'surface-hover',
      'surface-hover-soft',
    ]) {
      expect(
        contrastRatio(track, rgb(out[surfaceId])),
        `track x ${surfaceId}`,
      ).toBeGreaterThanOrEqual(SWITCH_DERIVATION_TARGET);
    }
  });
});

describe.each([
  ['One Dark Pro', ONE_DARK_PRO_PALETTE, 'dark' as const, oneDarkPro],
  ['Atom One Light', ATOM_ONE_LIGHT_PALETTE, 'light' as const, atomOneLight],
  ['Solarized Light', SOLARIZED_LIGHT_PALETTE, 'light' as const, solarizedLight],
])('theme-import 模板 · golden 重现 %s', (_name, palette, type, expected) => {
  const built = buildThemeColorsFromPalette(palette, type);
  const expectedColors = expected.colors as Record<string, string>;

  it('非 HSL token 与手写主题逐字一致', () => {
    const mismatches: string[] = [];
    for (const id of TEMPLATE_TOKEN_IDS) {
      if (id in HSL_TOKEN_ROLE || id in HSL_TOKEN_ROLE_BY_TYPE) continue;
      const actual = built[id];
      const want = expectedColors[id];
      if (want === undefined) continue;
      if (normalize(actual) !== normalize(want)) {
        mismatches.push(`${id}: got ${actual}, want ${want}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('HSL token 精确换算自对应色板角色', () => {
    for (const [id, role] of Object.entries(HSL_TOKEN_ROLE)) {
      expect(built[id], id).toBe(toHslTriplet(palette[role]));
    }
    for (const [id, roles] of Object.entries(HSL_TOKEN_ROLE_BY_TYPE)) {
      if (id === 'primary-foreground' && type === 'light') {
        expect(built[id]).toBe('0 0% 100%');
        continue;
      }
      expect(built[id], id).toBe(toHslTriplet(palette[roles[type]]));
    }
  });
});

describe('theme-import 模板 · Markdown token 只在源主题提供时才产出', () => {
  it('不传 markdown 时不产出 md-* token', () => {
    const out = buildThemeColorsFromPalette(ONE_DARK_PRO_PALETTE, 'dark');
    expect(Object.keys(out).filter((id) => id.startsWith('md-'))).toEqual([]);
  });

  it('传入标题色与加粗色时逐项产出', () => {
    const out = buildThemeColorsFromPalette(ONE_DARK_PRO_PALETTE, 'dark', {
      headings: [rgb('#e06c75'), null, rgb('#61afef'), undefined, null, null],
      strong: rgb('#d19a66'),
    });
    expect(out['md-h1-fg']).toBe('#e06c75');
    expect(out['md-h2-fg']).toBeUndefined();
    expect(out['md-h3-fg']).toBe('#61afef');
    expect(out['md-h4-fg']).toBeUndefined();
    expect(out['md-strong-fg']).toBe('#d19a66');
  });
});
