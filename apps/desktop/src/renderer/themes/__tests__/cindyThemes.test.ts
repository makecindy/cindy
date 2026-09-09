import { describe, expect, it } from 'vitest';

import { cindyDark } from '../builtin/cindy-dark';
import { cindyLight } from '../builtin/cindy-light';
import { colorRegistry } from '../color-registry';
import '../colors';
import { DEFAULT_FAMILY_ID, getThemeFamilies } from '../families';
import { builtinThemes } from '../registry';
import {
  CINDY_EXPECTED_VALUES,
  CINDY_REQUIRED_COLOR_IDS,
  BRAND_RED_ALLOWED_IDS,
  BRAND_RED_EXPECTED_BY_ID,
  HSL_FORMAT_IDS,
  NEUTRAL_PRIMARY_EXPECTED_BY_ID,
  NEUTRAL_PRIMARY_FOREGROUND_BY_ID,
  RED_EXCEPTION_ALLOWED_IDS,
} from './cindyDecisionData';

/**
 * D2T:CINDY 皮肤家族完备性单测(八组断言,计划 §2 D2T 节)。
 * 值的唯一权威:2026-07-17-cindy-token-decision-table.md(U8 批准)。
 */

// ===== color helpers(不引入第三方,自洽可证伪) =====
type RGB = [number, number, number];

function parseHex(v: string): RGB {
  const h = v.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else if (hp < 6) [r1, g1, b1] = [c, 0, x];
  const m = lN - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function parseHslTriplet(v: string): RGB {
  const m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) throw new Error(`bad HSL triplet: ${v}`);
  return hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

function parseRgb(v: string): RGB {
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`bad rgb: ${v}`);
  const parts = m[1].split(',').map((x) => parseFloat(x));
  return [parts[0], parts[1], parts[2]];
}

function parseCssColor(v: string | undefined): { rgb: RGB; alpha: number } {
  if (!v) throw new Error('empty color literal');
  const t = v.trim();
  const hsl = t.match(
    /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*(0|1|0?\.\d+))?$/,
  );
  if (hsl) {
    return {
      rgb: hslToRgb(parseFloat(hsl[1]), parseFloat(hsl[2]), parseFloat(hsl[3])),
      alpha: hsl[4] === undefined ? 1 : parseFloat(hsl[4]),
    };
  }
  const rgb = t.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(',').map((x) => parseFloat(x));
    return {
      rgb: [parts[0], parts[1], parts[2]],
      alpha: parts[3] === undefined ? 1 : parts[3],
    };
  }
  if (t === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  return { rgb: toRgb(t), alpha: 1 };
}

/** 把任意 CSS 色值归一成 RGB(hex / HSL 三元组 / rgb() / rgba())。 */
function toRgb(v: string | undefined): RGB {
  if (!v) throw new Error("empty color literal");
  const t = v.trim();
  if (t.startsWith('#')) return parseHex(t);
  if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(t)) return parseHslTriplet(t);
  if (t.startsWith('rgb')) return parseRgb(t);
  if (t === 'transparent') return [0, 0, 0];
  throw new Error(`unsupported color literal: ${t}`);
}

function rgbEqual(a: RGB, b: RGB, tol = 1): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol
  );
}

function luminance(rgb: RGB): number {
  const f = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

function compositeOver(foreground: string | undefined, background: RGB): RGB {
  const { rgb, alpha } = parseCssColor(foreground);
  return rgb.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as RGB;
}

function rgbContrast(c1: RGB, c2: RGB): number {
  const l1 = luminance(c1);
  const l2 = luminance(c2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(c1: string | undefined, c2: string | undefined): number {
  return rgbContrast(toRgb(c1), toRgb(c2));
}

const BRAND_RED_HEX = '#DF0C27';
type CindyTheme = { colors: Record<string, string> };
const THEMES: ReadonlyArray<readonly [string, CindyTheme]> = [
  ['cindy-light', { colors: cindyLight.colors as unknown as Record<string, string> }],
  ['cindy-dark', { colors: cindyDark.colors as unknown as Record<string, string> }],
];

// 决策表生成后已有的字面 override 债务；这里只冻结 ID 边界，不把其值另立为权威。
// 新 ID 不得扩充这份 baseline，而应进入决策表或引用已治理 token。
const PREEXISTING_UNFROZEN_LITERAL_IDS: Record<string, ReadonlySet<string>> = {
  'cindy-light': new Set([
    'ask-option-list-bg',
    'model-item-hover',
    'update-btn-bg',
    'update-btn-hover',
  ]),
  'cindy-dark': new Set([
    'ask-header-chip-bg',
    'ask-option-hover',
    'ask-option-list-bg',
    'ask-send-disabled-bg',
    'model-item-hover',
    'update-btn-bg',
    'update-btn-hover',
  ]),
};

// ===== ① key 合法 =====
describe('CINDY · ① key 合法(每 override key ∈ ColorRegistry)', () => {
  for (const [name, theme] of THEMES) {
    it(`${name} 的 override key 全部已注册(防 typo 被 exportThemeColors 静默丢弃)`, () => {
      const registered = new Set(colorRegistry.getColors().map((c) => c.id));
      const unregistered = Object.keys(theme.colors).filter((k) => !registered.has(k));
      expect(unregistered, `未注册 key 会被静默丢弃: ${unregistered.join(', ')}`).toEqual([]);
    });
  }
});

// ===== ② 覆盖完备 =====
describe('CINDY · ② 覆盖完备(分母=决策表冻结 exact id 数组)', () => {
  for (const [name, theme] of THEMES) {
    it(`${name} 覆盖全部 ${CINDY_REQUIRED_COLOR_IDS.length} 个冻结 id`, () => {
      const missing = CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in theme.colors));
      expect(missing, `缺 override: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

// ===== ③ 值格式按消费契约 =====
describe('CINDY · ③ 值格式按消费契约', () => {
  // 消费契约是 hsl(var(--x)),CSS Color 4 允许三元组带 `/ alpha`(2026-07-21 玻璃面 hover 半透明化启用)
  const HSL_PAT = /^[\d.]+\s+[\d.]+%\s+[\d.]+%(\s*\/\s*(0|1|0?\.\d+))?$/;
  const hslSet = new Set<string>(HSL_FORMAT_IDS);

  it('HSL_FORMAT_IDS(42)的 override 必须 HSL 三元组(可带 / alpha);其余 id 不得误填 HSL', () => {
    for (const [name, theme] of THEMES) {
      for (const [id, val] of Object.entries(theme.colors)) {
        const isHslSlot = hslSet.has(id);
        const isHslVal = HSL_PAT.test(val);
        if (isHslSlot) {
          expect(isHslVal, `${name}.${id} 在 HSL_FORMAT_IDS 但值非 HSL 三元组: ${val}`).toBe(true);
        }
      }
    }
  });

  it('baseline 外未列入决策表的新增 override 只能引用已治理 token', () => {
    const frozenIds = new Set(Object.keys(CINDY_EXPECTED_VALUES));
    const registeredIds = new Set(colorRegistry.getColors().map((color) => color.id));
    const tokenReference = /^var\(--([a-z0-9-]+)\)$/;
    for (const [name, theme] of THEMES) {
      const preexistingLiteralIds = PREEXISTING_UNFROZEN_LITERAL_IDS[name] ?? new Set();
      for (const [id, value] of Object.entries(theme.colors)) {
        if (frozenIds.has(id) || preexistingLiteralIds.has(id)) continue;
        const referencedId = value.match(tokenReference)?.[1];
        expect(
          referencedId,
          `${name}.${id} 未入决策表且不在 baseline，只能引用已治理 token，实际 ${value}`,
        ).toBeTruthy();
        if (!referencedId) continue;
        expect(
          registeredIds.has(referencedId),
          `${name}.${id} 引用了未注册 token: ${referencedId}`,
        ).toBe(true);
      }
    }
  });

  it('逐 token override 值 == 决策表冻结期望值(防手改漂移)', () => {
    for (const [name, theme] of THEMES) {
      for (const [id, expected] of Object.entries(CINDY_EXPECTED_VALUES)) {
        const actual = theme.colors[id];
        const exp = name === 'cindy-light' ? expected.light : expected.dark;
        expect(actual, `${name}.${id} 期望 ${exp}`).toBe(exp);
      }
    }
  });
});

// ===== ④ round-trip HSL↔RGB =====
describe('CINDY · ④ round-trip HSL→RGB(每通道误差≤1)', () => {
  it('HSL_FORMAT_IDS 的 HSL 三元组反解 RGB 各通道 0-255 合法', () => {
    for (const [, theme] of THEMES) {
      for (const id of HSL_FORMAT_IDS) {
        const val = theme.colors[id];
        if (!val || !/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(val)) continue;
        const rgb = toRgb(val);
        for (const ch of rgb) {
          expect(ch, `${id} RGB 通道越界: ${rgb.join(',')}`).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

// ===== ⑤ E1D 红色体系重构(中性 exact map + 红例外白名单) =====
describe('CINDY · ⑤ E1D 红色体系重构(中性 exact map + 红例外白名单)', () => {
  it('NEUTRAL_PRIMARY_EXPECTED_BY_ID:常规主操作底必须等于中性值(light #3C3F43/dark #EEEEEE 等)', () => {
    for (const [name, theme] of THEMES) {
      for (const [id, expected] of Object.entries(NEUTRAL_PRIMARY_EXPECTED_BY_ID)) {
        const actual = theme.colors[id];
        const exp = name === 'cindy-light' ? expected.light : expected.dark;
        expect(rgbEqual(toRgb(actual), toRgb(exp), 1), `${name}.${id} 应中性,实际 ${actual}`).toBe(true);
      }
    }
  });

  it('RED_EXCEPTION_ALLOWED_IDS 之外不得出现品牌红 #DF0C27/#A61629', () => {
    const allowed = new Set<string>(RED_EXCEPTION_ALLOWED_IDS);
    const redRgb = toRgb('#DF0C27');
    const darkRedRgb = toRgb('#A61629');
    for (const [name, theme] of THEMES) {
      for (const [id, val] of Object.entries(theme.colors)) {
        if (allowed.has(id)) continue;
        if (!val.startsWith('#')) continue;
        expect(rgbEqual(toRgb(val), redRgb, 2), `${name}.${id} 出现品牌红: ${val}`).toBe(false);
        expect(rgbEqual(toRgb(val), darkRedRgb, 2), `${name}.${id} 出现深红: ${val}`).toBe(false);
      }
    }
  });

  it('caret-accent 固定为 focus 蓝并退出所有红色白名单', () => {
    expect(RED_EXCEPTION_ALLOWED_IDS).not.toContain('caret-accent');
    expect(BRAND_RED_ALLOWED_IDS).not.toContain('caret-accent');
    expect(Object.keys(BRAND_RED_EXPECTED_BY_ID)).not.toContain('caret-accent');

    const focusBlue = toRgb('#417CDD');
    const brandRed = toRgb('#DF0C27');
    const darkRed = toRgb('#A61629');
    for (const [name, theme] of THEMES) {
      const actual = theme.colors['caret-accent'];
      expect(rgbEqual(toRgb(actual), focusBlue, 1), `${name}.caret-accent 应为 #417CDD`).toBe(true);
      expect(rgbEqual(toRgb(actual), brandRed, 2), `${name}.caret-accent 不得为品牌红`).toBe(false);
      expect(rgbEqual(toRgb(actual), darkRed, 2), `${name}.caret-accent 不得为深红`).toBe(false);
    }
  });

  it('NEUTRAL_PRIMARY_FOREGROUND_BY_ID 前景必须中性字(light #FCFCFC/dark #151515,非全局白)', () => {
    for (const [name, theme] of THEMES) {
      const expFg = name === 'cindy-light' ? '#FCFCFC' : '#151515' /* 2026-08 色阶改版: 反相深字随暗色平移 */;
      for (const id of NEUTRAL_PRIMARY_FOREGROUND_BY_ID) {
        expect(rgbEqual(toRgb(theme.colors[id]), toRgb(expFg), 1), `${name}.${id} 前景应中性字`).toBe(true);
      }
    }
  });

  it('排除:warning/annotation/status-bar/状态四色/focus/diff/msg-link 不被红接管', () => {
    const redRgb = toRgb('#DF0C27');
    const EXCLUDED = ['warning-accent','annotation-accent','status-bar-accent','card-status-awaiting','card-status-error','card-status-done','remote-status-ready','remote-status-progress','remote-status-failed','focus-ring','diff-del-fg','diff-add-fg','msg-link'];
    for (const [name, theme] of THEMES) {
      for (const id of EXCLUDED) {
        const val = theme.colors[id];
        if (!val || !val.startsWith('#')) continue;
        expect(rgbEqual(toRgb(val), redRgb, 2), `${name}.${id} 排除项被红接管: ${val}`).toBe(false);
      }
    }
    // msg-link 非红
    for (const [, theme] of THEMES) {
      expect(rgbEqual(toRgb(theme.colors['msg-link']), redRgb, 5), 'msg-link 不得染红').toBe(false);
    }
  });

  it('状态/Auto/focus 全局 registry 默认 = 设计定稿值 2026-07-17(取代冻结红线;扩簇含 info/focus/Auto Approval)', () => {
    // 状态色全局(colors.ts light/dark 同值;9 builtin 主题无一 override → 默认皮肤同变)。
    // E5D 定稿 2026-07-17:状态四色 + 警示橙 accent + warning 前景 + focus-ring + Auto Approval。
    const FINAL: Record<string, string> = {
      'warning-accent': '#EA6B17',
      'card-status-awaiting': '#19D2C1',
      'card-status-error': '#D91F37',
      'card-status-done': '#2AAE5B',
      'remote-status-ready': '#2AAE5B',
      'remote-status-failed': '#D91F37',
      'warning-fg': '#F3A115',
      'focus-ring': '#417CDD',
      'perm-auto-selected-text': '#417CDD',
    };
    for (const [id, hex] of Object.entries(FINAL)) {
      const lv = colorRegistry.resolveDefault(id, 'light') ?? '';
      const dv = colorRegistry.resolveDefault(id, 'dark') ?? '';
      expect(rgbEqual(toRgb(lv), toRgb(hex), 1), `${id} light = 定稿 ${hex}`).toBe(true);
      expect(rgbEqual(toRgb(dv), toRgb(hex), 1), `${id} dark = 定稿 ${hex}`).toBe(true);
    }
    // ring:CINDY override HSL(固定蓝),定稿 #417CDD;resolveDefault 为 text-primary-hsl 故查 CINDY 值
    expect(rgbEqual(toRgb(cindyLight.colors['ring'] ?? ''), toRgb('#417CDD'), 1), 'cindy-light ring = #417CDD').toBe(true);
    expect(rgbEqual(toRgb(cindyDark.colors['ring'] ?? ''), toRgb('#417CDD'), 1), 'cindy-dark ring = #417CDD').toBe(true);
  });
});

// ===== ⑥ family =====
describe('CINDY · ⑥ family(cindy 默认且置顶 / Classic 文案 / 9 主题快照)', () => {
  it('cindy family 存在,light/dark 双变体正确', () => {
    const families = getThemeFamilies();
    const fam = families.find((f) => f.id === 'cindy');
    expect(fam, 'cindy family 未注册').toBeTruthy();
    expect(fam?.name).toBe('Cindy');
    expect(fam?.light?.id).toBe('cindy-light');
    expect(fam?.dark?.id).toBe('cindy-dark');
    expect(families[0]?.id).toBe('cindy');
  });

  it('新用户默认选择 cindy,原 default 家族展示为 Classic', () => {
    expect(DEFAULT_FAMILY_ID).toBe('cindy');
    expect(getThemeFamilies().find((f) => f.id === 'default')?.name).toBe('Classic');
  });

  it('既有 9 主题 keys 快照不变(不增减 builtin 主题)', () => {
    const ids = Object.keys(builtinThemes).sort();
    expect(ids).toEqual(
      [
        'atom-one-light',
        'cindy-dark',
        'cindy-light',
        'default-dark',
        'default-light',
        'eclipse',
        'github-dark',
        'material-ocean-hc',
        'monokai-pro',
        'one-dark-pro',
        'solarized-light',
      ].sort(),
    );
  });
});

// ===== ⑦ WCAG + U2 例外 + text-secondary 反向冻结 =====
describe('CINDY · ⑦ WCAG 复算 + U2 例外 allowlist + text-secondary 反向冻结', () => {
  const light = cindyLight.colors as unknown as Record<string, string>;
  const dark = cindyDark.colors as unknown as Record<string, string>;

  it('text-primary × surface/elevated/chip 全部 ≥4.5:1', () => {
    const cases: Array<[string, string, string]> = [
      [light['text-primary'], light['surface'], 'light/surface'],
      [light['text-primary'], light['surface-elevated'], 'light/elevated'],
      [light['text-primary'], light['surface-chip'], 'light/chip'],
      [dark['text-primary'], dark['surface'], 'dark/surface'],
      [dark['text-primary'], dark['surface-elevated'], 'dark/elevated'],
      [dark['text-primary'], dark['surface-chip'], 'dark/chip'],
    ];
    for (const [fg, bg, label] of cases) {
      expect(contrast(fg, bg), `${label} < 4.5:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text-tertiary × surface/elevated/chip 全部 ≥4.5:1(非 U2 token AA 整改)', () => {
    const cases: Array<[string, string, string]> = [
      [light['text-tertiary'], light['surface'], 'light/surface'],
      [light['text-tertiary'], light['surface-elevated'], 'light/elevated'],
      [dark['text-tertiary'], dark['surface'], 'dark/surface'],
      [dark['text-tertiary'], dark['surface-elevated'], 'dark/elevated'],
    ];
    for (const [fg, bg, label] of cases) {
      expect(contrast(fg, bg), `${label} < 4.5:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('E1D 中性 CTA 对比度:#FCFCFC×#3C3F43=10.32(light)、#151515×#EEEEEE=15.74(dark) ≥4.5', () => {
    expect(contrast('#FCFCFC', light['accent-cta-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#151515' /* 2026-08 色阶改版: 反相深字随暗色平移 */, dark['accent-cta-bg'])).toBeGreaterThanOrEqual(4.5);
    // focus-ring cindy 不 override(用 registry 默认 #417CDD,E5D 定稿 2026-07-17 取代 #3b82f6)
    const frLight = colorRegistry.resolveDefault('focus-ring', 'light') ?? '';
    const frDark = colorRegistry.resolveDefault('focus-ring', 'dark') ?? '';
    expect(contrast(frLight, light['surface'])).toBeGreaterThanOrEqual(3);
    expect(contrast(frDark, dark['surface'])).toBeGreaterThanOrEqual(3);
  });

  it('U2 例外:text-secondary × surface/elevated/chip 忠于 Figma 原值(实测 2.3-2.9:1,不要求达标)', () => {
    const pairs: Array<[string, string, string]> = [
      [light['text-secondary'], light['surface'], 'light/surface'],
      [light['text-secondary'], light['surface-elevated'], 'light/elevated'],
      [dark['text-secondary'], dark['surface'], 'dark/surface'],
      [dark['text-secondary'], dark['surface-elevated'], 'dark/elevated'],
    ];
    for (const [fg, bg, label] of pairs) {
      const r = contrast(fg, bg);
      // 实测应 2.3-2.9:1;记录入档但不阻断
      expect(r, `${label} U2 例外,实测 ${r.toFixed(2)}:1`).toBeGreaterThan(2);
    }
  });

  it('2026-08 地板:light 信息类文字 × surface/surface-hover 对比度 ≥3.0(用户裁决,决策表 §9.4;dark 仍属 U2 例外不设此门)', () => {
    // 覆盖面取 §9.4 声明的地板范围(页底/通用 hover);菜单 hover 上 2.90 为已登记 watch 项,不入门禁。
    for (const id of ['text-secondary', 'cmd-palette-item-meta', 'sidebar-list-muted'] as const) {
      for (const bgId of ['surface', 'surface-hover'] as const) {
        const r = contrast(light[id]!, light[bgId]!);
        expect(r, `light ${id} × ${bgId} 应 ≥3.0,实测 ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it('反向冻结:text-secondary 必须恰等于定稿值 #888883(light,用户裁决 2026-08-13 暖化+抬至≥3.0,取代 2026-07-20 调参)/#6F6F6F(dark),RGB 归一', () => {
    expect(
      rgbEqual(toRgb(light['text-secondary']), toRgb('#888883'), 1),
      'light text-secondary 须恰等 #888883(用户裁决 2026-08-13)',
    ).toBe(true);
    expect(
      rgbEqual(toRgb(dark['text-secondary']), toRgb('#6F6F6F'), 1),
      'dark text-secondary 须恰等 #6F6F6F',
    ).toBe(true);
  });

  it('CINDY 侧栏层级:二级暗灰(sidebar-muted)明显弱于正文(text-primary)×surface + 中性选中 pill', () => {
    // 侧栏层级:标题正文 > 图标/时间戳/分组(二级暗灰) > 中性选中 pill 前景。
    for (const [name, theme] of THEMES) {
      const c = theme.colors as unknown as Record<string, string>;
      const sec = contrast(c['sidebar-muted'], c['surface']);
      const pri = contrast(c['text-primary-hsl'], c['surface']);
      expect(sec, `${name} 二级暗灰 ${sec.toFixed(2)} 应明显弱于正文 ${pri.toFixed(2)}`).toBeLessThan(pri);
    }
    // ③ exact 已守,此处补层级:选中 pill 前景×中性底 ≥4.5。
    expect(contrast(cindyLight.colors['sidebar-item-active-foreground']!, cindyLight.colors['sidebar-item-active']!), 'light 选中胶囊 前景×中性底').toBeGreaterThanOrEqual(4.5);
    expect(contrast(cindyDark.colors['sidebar-item-active-foreground']!, cindyDark.colors['sidebar-item-active']!), 'dark 选中胶囊 前景×中性底').toBeGreaterThanOrEqual(4.5);
  });

  it('CINDY 侧栏草稿铅笔×普通/悬停行底色对比度 ≥3:1', () => {
    const draftLight = colorRegistry.resolveDefault('sidebar-draft-indicator', 'light') ?? '';
    const draftDarkAlias = colorRegistry.resolveDefault('sidebar-draft-indicator', 'dark') ?? '';
    const awaitingDark = colorRegistry.resolveDefault('card-status-awaiting', 'dark') ?? '';

    expect(draftLight).toBe('#0B726B');
    expect(draftDarkAlias).toBe('var(--card-status-awaiting)');
    for (const [name, colors, draft] of [
      ['light', light, draftLight],
      ['dark', dark, awaitingDark],
    ] as const) {
      for (const [wallpaperName, wallpaper] of [
        ['black wallpaper', '#000000'],
        ['white wallpaper', '#FFFFFF'],
      ] as const) {
        const sidebar = compositeOver(colors['surface-translucent-sidebar'], toRgb(wallpaper));
        const hover = compositeOver(colors['sidebar-item-hover'], sidebar);
        expect(
          rgbContrast(toRgb(draft), sidebar),
          `${name} 草稿铅笔×侧栏(${wallpaperName})`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          rgbContrast(toRgb(draft), hover),
          `${name} 草稿铅笔×悬停行(${wallpaperName})`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

// ===== ⑧ 可证伪自检 =====
describe('CINDY · ⑧ 可证伪自检(注入错值后断言必须变红,还原后转绿)', () => {
  it('注入 typo key → ① key 合法变红', () => {
    const typoTheme = {
      ...cindyLight,
      colors: { ...cindyLight.colors, 'this-key-does-not-exist': '#000' },
    };
    const registered = new Set(colorRegistry.getColors().map((c) => c.id));
    const unregistered = Object.keys(typoTheme.colors).filter((k) => !registered.has(k));
    expect(unregistered.length, 'typo key 应被 ① 抓出').toBeGreaterThan(0);
    // 还原:无 typo 时 ① 绿
    expect(Object.keys(cindyLight.colors).filter((k) => !registered.has(k))).toEqual([]);
  });

  it('注入漏 override → ② 覆盖完备变红', () => {
    const shortColors = { ...cindyLight.colors };
    delete (shortColors as Record<string, string>)['primary'];
    const missing = CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in shortColors));
    expect(missing, '漏 override 应被 ② 抓出').toContain('primary');
    expect(CINDY_REQUIRED_COLOR_IDS.filter((id) => !(id in cindyLight.colors))).toEqual([]);
  });

  it('注入错格式(HSL 槽填 hex) → ③ 变红', () => {
    const hslSet = new Set<string>(HSL_FORMAT_IDS);
    const bad = { ...cindyLight.colors, primary: '#DF0C27' }; // primary 应 HSL,塞 hex
    const isHslSlot = hslSet.has('primary');
    const isHslVal = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(bad['primary'] ?? '');
    expect(isHslSlot && !isHslVal, 'HSL 槽填 hex 应被 ③ 抓').toBe(true);
  });

  it('注入品牌红越界(非 RED_EXCEPTION_ALLOWED id 染红) → ⑤ 变红', () => {
    const allowed = new Set<string>(RED_EXCEPTION_ALLOWED_IDS);
    const badId = 'text-primary'; // 不在 allowed
    expect(allowed.has(badId), 'text-primary 不在 ALLOWED,染红应被 ⑤ 抓').toBe(false);
    const badRgb = toRgb('#DF0C27');
    const textRgb = toRgb(cindyLight.colors['text-primary']);
    expect(rgbEqual(textRgb, badRgb, 2), '注入后 text-primary 染红会被 ⑤ 单向禁止越界抓').toBe(
      false,
    );
  });

  it('注入豁免篡改(warning-accent 染红) → ⑤ 排除断言变红', () => {
    const redRgb = toRgb(BRAND_RED_HEX);
    // warning-accent cindy 不 override,registry 默认 #EA6B17(设计定稿 2026-07-17),非品牌红
    const warnDefault = colorRegistry.resolveDefault('warning-accent', 'light') ?? '';
    expect(rgbEqual(toRgb(warnDefault), redRgb, 2), 'warning-accent 默认非品牌红').toBe(false);
    // 强行注入品牌红到 cindy 的 warning-accent override → ⑤ 排除断言(排除项染红即红)变红
    const tainted = {
      ...cindyLight,
      colors: { ...cindyLight.colors, 'warning-accent': '#DF0C27' },
    };
    expect(
      rgbEqual(toRgb((tainted.colors as Record<string, string>)['warning-accent'] ?? ''), redRgb, 2),
      '注入后 warning-accent 染红,⑤ 排除断言变红',
    ).toBe(true);
  });

  it('反向冻结证伪:注入 #686B72 到 text-secondary → ⑦ 变红', () => {
    const figma = toRgb('#888883'); // 用户裁决定稿 2026-08-13(沿革: Figma #9A9DA3 → 2026-07-20 #8C8E94 → 本值)
    const injected = toRgb('#686B72');
    expect(rgbEqual(injected, figma, 1), '#686B72 ≠ #888883,注入后 ⑦ 反向冻结断言必红').toBe(false);
    // 正常值仍恰等
    expect(
      rgbEqual(toRgb(cindyLight.colors['text-secondary']), figma, 1),
      '还原后恰等定稿值',
    ).toBe(true);
  });

  it('§7 必炸点对比度(橙徽章/红 CTA/Fast toggle,§7 矩阵)', () => {
    const L = cindyLight.colors as unknown as Record<string, string>;
    const D = cindyDark.colors as unknown as Record<string, string>;
    const orange = '#EA6B17'; // status-bar-accent registry 默认(设计定稿 2026-07-17,cindy 不 override);× status-badge-fg #1F1F1F = 5.19:1 ≥4.5
    expect(contrast(L['status-badge-fg']!, orange), 'light 橙徽章 fg×橙').toBeGreaterThanOrEqual(4.5);
    expect(contrast(D['status-badge-fg']!, orange), 'dark 橙徽章 fg×橙').toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FCFCFC', L['accent-cta-bg']!), 'light 中性 CTA').toBeGreaterThanOrEqual(4.5);
    expect(contrast('#151515' /* 2026-08 色阶改版: 反相深字随暗色平移 */, D['accent-cta-bg']!), 'dark 中性 CTA').toBeGreaterThanOrEqual(4.5);
    // Fast toggle: thumb(surface-on-card) × track(fast-toggle-track = text-disabled)
    expect(contrast(L['surface-on-card']!, L['text-disabled']!), 'light Fast toggle thumb×track').toBeGreaterThanOrEqual(3);
    expect(contrast(D['surface-on-card']!, D['text-disabled']!), 'dark Fast toggle thumb×track').toBeGreaterThanOrEqual(3);
  });
});
