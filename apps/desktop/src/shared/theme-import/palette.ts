/**
 * 色板 → Cindy token 模板（纯函数）。
 *
 * ## 这份模板不是新设计,是把仓库里已有的人工映射抽出来
 *
 * `renderer/themes/builtin/` 下 7 个社区主题(one-dark-pro / github-dark /
 * eclipse / material-ocean-hc / monokai-pro / atom-one-light / solarized-light)
 * 都是人工从 VSCode 主题移植的,它们 `colors` 的 key 集合**逐字相同**(108 个
 * token = 35 个 Tier1 slot + 73 个 alias / singleton),值全部由同一组 13 个色板
 * 常量派生。本文件就是那套派生规则的代码化:
 *
 *   - 5 个 dark 主题逐 key 一致(唯一例外:github-dark 把 4 个 on-accent 前景
 *     从 surface 改成纯白,属人工微调)
 *   - 2 个 light 主题逐 key 一致
 *   - light 与 dark 的差异共 22 处,逐条写在下面的 `pick()` 调用里
 *
 * ## 为什么用 allow-list
 *
 * 模板产出这 108 个 builtin 基础 key，并为不受约束的外部色板追加 2 个 Switch
 * 安全 key（源主题提供 Markdown 色时再追加 `md-h1-fg`…`md-h6-fg` / `md-strong-fg`）。
 * 这 7 个主题都没有 override `--login-*`、品牌红、
 * `--destructive`、`--warning-accent`、`--status-bar-accent`、`--focus-ring`、
 * `--diff-*`(DESIGN.md §10 / §16 的语义豁免族),照抄它们的 key 列表就自动守住了
 * 豁免边界——比"先大量产出再过滤"安全。`protected-tokens.ts` 只作为回归断言的
 * 第二道闸。
 */

import {
  compositeOver,
  contrastRatio,
  mix,
  relativeLuminance,
  toHex,
  toHslTriplet,
  toRgbaString,
  type Rgb,
} from './color';
import { UnsupportedThemePaletteError } from './errors';

export type ThemeTypeName = 'light' | 'dark';

/** 13 个色板角色——与既有 builtin 主题头部的常量一一对应。 */
export interface ThemePalette {
  /** 页面主背景（VSCode `editor.background` / Obsidian `--background-primary`）。 */
  surface: Rgb;
  /** Card / 弹窗抬起一层（`sideBar.background` / `--background-secondary`）。 */
  elevated: Rgb;
  /** light 专用的"更沉一档"卡片层；dark 主题传 elevated 同值即可。 */
  elevatedSoft: Rgb;
  /** hover 背景（`list.hoverBackground` / `--background-modifier-hover`）。 */
  hover: Rgb;
  /** chip / pill / 选中行背景。 */
  chip: Rgb;
  /** 1px 分界（`panel.border` / `--background-modifier-border`）。 */
  border: Rgb;
  textPrimary: Rgb;
  textSecondary: Rgb;
  textTertiary: Rgb;
  textDisabled: Rgb;
  accentPrimary: Rgb;
  /** accent 提亮档（dark 主题的链接色 / info 色）。 */
  accentSoft: Rgb;
  /** accent 压暗档（pressed；light 主题的链接色也走这档的 primary/deep 组合）。 */
  accentDeep: Rgb;
  /** light 主题可选：CREATE AGENT 卡片 / 输入框底色压暗一档（如 Solarized base2）。
   *  不传时与 surface 同值（chat-input-bg / quick-card / control / segment 底）；
   *  icon 圆底、hover、pressed 的取值见下方收敛规则，均不随 inputBg 变化。 */
  inputBg?: Rgb;
}

/** Markdown 标题 / 加粗色——源主题提供时才产出对应 token（Obsidian `--hN-color`）。 */
export interface MarkdownPalette {
  /** h1…h6，缺省项传 null / undefined。 */
  headings?: Array<Rgb | null | undefined>;
  strong?: Rgb | null;
}

const MARKDOWN_HEADING_TOKENS = [
  'md-h1-fg',
  'md-h2-fg',
  'md-h3-fg',
  'md-h4-fg',
  'md-h5-fg',
  'md-h6-fg',
] as const;

/**
 * 模板产出的 108 个 builtin 基础 token，加 2 个导入主题专用的 Switch 安全 token。
 * 导出供测试断言 allow-list 边界，以及供 importer 统计命中数量。
 */
export const TEMPLATE_TOKEN_IDS: readonly string[] = [
  // ── Tier1 语义 slot(35) ──
  'surface',
  'surface-hsl',
  'surface-elevated',
  'surface-elevated-soft',
  'surface-card-ivory',
  'surface-chip',
  'surface-chip-alt',
  'surface-hover',
  'surface-hover-soft',
  'surface-hover-hsl',
  'surface-on-card',
  'border-default',
  'border-default-hsl',
  'border-shadcn-hsl',
  'border-transparent-mixed',
  'text-primary',
  'text-primary-on-dark',
  'text-primary-emphasis',
  'text-primary-inv',
  'text-primary-body-strong',
  'text-primary-hsl',
  'text-secondary',
  'text-secondary-cross',
  'text-secondary-mid',
  'text-tertiary',
  'text-tertiary-stone',
  'text-tertiary-mid',
  'text-tertiary-hsl',
  'text-disabled',
  'text-disabled-tertiary',
  'accent-cta-bg',
  'accent-cta-bg-pure',
  'accent-emphasis',
  'accent-soft',
  'accent-hover',
  'accent-pure-cta-fg',
  'status-badge-fg',
  // ── alias / singleton(56) ──
  'accent',
  'agent-actions-rail',
  'ask-checkbox-border',
  'background',
  'chat-input-chip-border',
  'chat-input-text',
  'color-primary',
  'confirm-bg',
  'confirm-btn-primary-bg',
  'confirm-btn-primary-text',
  'confirm-btn-secondary-border',
  'confirm-btn-secondary-hover',
  'confirm-btn-secondary-text',
  'confirm-title',
  'create-agent-control-bg',
  'create-agent-control-bg-hover',
  'create-agent-control-bg-pressed',
  'create-agent-control-border',
  'create-agent-control-icon',
  'create-agent-control-text',
  'create-agent-quick-card-bg',
  'create-agent-quick-card-bg-hover',
  'create-agent-quick-card-border',
  'create-agent-quick-card-icon',
  'create-agent-quick-card-icon-bg',
  'create-agent-quick-card-text',
  'create-agent-segment-inactive-text',
  'create-agent-segment-track-bg',
  'drop-overlay-bg',
  'file-chip-bg',
  'file-remove-bg',
  'info-700',
  'model-trigger-hover',
  'msg-link',
  'msg-scrollbar-hover',
  'muted',
  'muted-foreground',
  'perm-allow-btn-bg',
  'perm-allow-btn-text',
  'perm-allow-kbd-bg',
  'perm-allow-kbd-border',
  'perm-code-bg',
  'perm-item-selected-bg',
  'plan-outline-active-bg',
  'plan-toolbar-btn-hover-bg',
  'popover',
  'primary-foreground',
  'search-match-fg',
  'secondary',
  'send-btn-bg',
  'send-btn-icon',
  'settings-btn-primary-text',
  'settings-btn-secondary-hover-bg',
  'text-placeholder',
  'settings-integration-avatar-bg',
  'settings-logout-bg',
  'settings-menu-bg-hover',
  'settings-menu-bg-selected',
  'settings-source-link',
  'settings-theme-auto-dark',
  'switch-thumb-off',
  'switch-track-off',
  'sidebar-action-icon',
  'sidebar-item-active',
  'splash-bg',
  'splash-text',
  'splash-text-destructive',
  'splash-text-muted',
  'titlebar-icon',
  'tooltip-bg',
  'tooltip-text',
  'update-btn-border',
  'update-btn-text',
];

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
// 3:1 是非文字组件的合规底线；自动派生多留 0.2，避免表面微调或 hex 量化后掉线。
const UNCHECKED_SWITCH_DERIVATION_TARGET = 3.2;
const RGB_SEARCH_STEPS = 255;

function minimumContrast(color: Rgb, against: readonly Rgb[]): number {
  return Math.min(...against.map((other) => contrastRatio(color, other)));
}

/**
 * 外部主题的 muted/comment 色不受 Cindy 约束，不能直接拿来当关闭态轨道。
 * 保留已经合格的源色；否则分别向黑、白搜索首个合格的整数 RGB 色，并选择
 * 改动更小的一侧。整数步进与最终 hex 精度一致，也避免多背景约束下的非单调误判。
 */
export function deriveUncheckedSwitchTrack(preferred: Rgb, against: readonly Rgb[]): Rgb {
  if (minimumContrast(preferred, against) >= UNCHECKED_SWITCH_DERIVATION_TARGET) return preferred;

  let best: { color: Rgb; distance: number; contrast: number } | null = null;
  for (const target of [BLACK, WHITE]) {
    for (let step = 1; step <= RGB_SEARCH_STEPS; step += 1) {
      const candidate = mix(preferred, target, step / RGB_SEARCH_STEPS);
      const candidateContrast = minimumContrast(candidate, against);
      if (candidateContrast < UNCHECKED_SWITCH_DERIVATION_TARGET) continue;

      const distance = (candidate.r - preferred.r) ** 2
        + (candidate.g - preferred.g) ** 2
        + (candidate.b - preferred.b) ** 2;
      if (
        best === null
        || distance < best.distance
        || (distance === best.distance && candidateContrast > best.contrast)
      ) {
        best = { color: candidate, distance, contrast: candidateContrast };
      }
      break;
    }
  }

  if (best) return best.color;
  throw new UnsupportedThemePaletteError(
    'Unable to derive unchecked Switch colors with 3.2:1 contrast',
  );
}

// 「允许」按钮键帽（Kbd onSolid）：主人 2026-11-27 裁决，与内置主题同一规则。
const ALLOW_KBD_TARGET = 4;
/** Kbd onSolid 整体 70% 不透明（components/ui/kbd.tsx），对比度按实际绘制计算。 */
const ALLOW_KBD_OPACITY = 0.7;
const ALLOW_KBD_BORDER_EXTRA = 0.12;

/** 键帽文字对键帽底的实际对比度：键帽底 = 叠层合成到按钮底，再与文字一起按 70% 合成到按钮底。 */
export function allowKbdContrast(button: Rgb, text: Rgb, overlay: Rgb, alpha: number): number {
  const cap = compositeOver(overlay, alpha, button);
  return contrastRatio(
    compositeOver(text, ALLOW_KBD_OPACITY, button),
    compositeOver(cap, ALLOW_KBD_OPACITY, button),
  );
}

/**
 * 派生「允许」按钮键帽的底 / 描边（半透明叠层）。
 * 1. 先按 cindy 方向往按钮文字色叠：深字叠黑 8%（描边 20%），浅字叠白 16%（描边 30%）。
 * 2. 不到 4:1 就往反方向叠，透明度从 10% 起每档 +10%，取第一个到 4:1 的；描边 = 底 + 12%。
 * 3. 反方向加到 100% 仍不到 4:1 时，在所有候选里取对比度最高的一档（不报错）。
 * 内置 6 套彩色允许按钮主题（atom-one-light 等）的值就是这条规则的结果，由 golden 测试对照。
 */
export function deriveAllowKbd(button: Rgb, text: Rgb): { bg: string; border: string } {
  const lightText = relativeLuminance(text) > relativeLuminance(button);
  const toward = lightText
    ? { color: WHITE, bg: 0.16, border: 0.3 }
    : { color: BLACK, bg: 0.08, border: 0.2 };
  const away = lightText ? BLACK : WHITE;
  const format = (color: Rgb, bg: number, border: number) => ({
    bg: `rgba(${color.r}, ${color.g}, ${color.b}, ${bg.toFixed(2)})`,
    border: `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(1, border).toFixed(2)})`,
  });

  const towardContrast = allowKbdContrast(button, text, toward.color, toward.bg);
  const towardValue = format(toward.color, toward.bg, toward.border);
  if (towardContrast >= ALLOW_KBD_TARGET) return towardValue;

  let best = { contrast: towardContrast, value: towardValue };
  for (let step = 1; step <= 10; step += 1) {
    const alpha = step / 10;
    const contrast = allowKbdContrast(button, text, away, alpha);
    const value = format(away, alpha, alpha + ALLOW_KBD_BORDER_EXTRA);
    if (contrast >= ALLOW_KBD_TARGET) return value;
    if (contrast > best.contrast) best = { contrast, value };
  }
  return best.value;
}

/**
 * 把色板展开成 Cindy token map。`type` 决定 22 处 light / dark 分支——取值依据
 * 全部来自既有 builtin 主题的实测对照,不是自由发挥。
 */
export function buildThemeColorsFromPalette(
  palette: ThemePalette,
  type: ThemeTypeName,
  markdown?: MarkdownPalette,
): Record<string, string> {
  const dark = type === 'dark';
  const pick = <T>(darkValue: T, lightValue: T): T => (dark ? darkValue : lightValue);

  const surface = toHex(palette.surface);
  const elevated = toHex(palette.elevated);
  const elevatedSoft = toHex(palette.elevatedSoft);
  const hover = toHex(palette.hover);
  const chip = toHex(palette.chip);
  const border = toHex(palette.border);
  const textPrimary = toHex(palette.textPrimary);
  const textSecondary = toHex(palette.textSecondary);
  const textTertiary = toHex(palette.textTertiary);
  const textDisabled = toHex(palette.textDisabled);
  const accentPrimary = toHex(palette.accentPrimary);
  const accentSoft = toHex(palette.accentSoft);
  const accentDeep = toHex(palette.accentDeep);

  const surfaceHsl = toHslTriplet(palette.surface);
  const elevatedHsl = toHslTriplet(palette.elevated);
  const hoverHsl = toHslTriplet(palette.hover);
  const chipHsl = toHslTriplet(palette.chip);
  const borderHsl = toHslTriplet(palette.border);
  const textPrimaryHsl = toHslTriplet(palette.textPrimary);
  const textSecondaryHsl = toHslTriplet(palette.textSecondary);
  const textTertiaryHsl = toHslTriplet(palette.textTertiary);

  /** accent 底上的前景：优先沿用既有主题的模式惯例（dark=surface, light=white），
   *  但若对比度不足 3:1 则按实际对比度选黑/白。阈值与既有 builtin 主题行为一致
   *  （它们在 3:1–4.5:1 区间也使用 white）。 */
  const defaultOnAccent = pick(palette.surface, WHITE);
  const MIN_CONTRAST = 3;
  const onAccentRgb = contrastRatio(palette.accentPrimary, defaultOnAccent) >= MIN_CONTRAST
    ? defaultOnAccent
    : (contrastRatio(palette.accentPrimary, WHITE) >= contrastRatio(palette.accentPrimary, BLACK)
      ? WHITE : BLACK);
  const onAccent = toHex(onAccentRgb);
  /** 「允许」按钮（accentPrimary 底 + onAccent 字）上的键帽。 */
  const allowKbd = deriveAllowKbd(palette.accentPrimary, onAccentRgb);
  /** dark 用 accent 提亮档做链接/info,light 用压暗档才够对比度。 */
  const accentReadable = pick(accentSoft, accentDeep);
  /** 链接色:dark 提亮档,light 直接用 primary。 */
  const linkColor = pick(accentSoft, accentPrimary);
  /** 弱化前景:dark 用 disabled 档,light 用 tertiary(浅底上 disabled 太淡)。 */
  const mutedIcon = pick(textDisabled, textTertiary);
  /** CREATE AGENT / 输入框底色：light 可用 inputBg 压暗一档（Solarized 惯例）。 */
  const inputBg = toHex(palette.inputBg ?? palette.surface);
  /** CREATE AGENT hover / icon 圆底 / pressed 收敛规则：
   *  card hover 提亮到「lift 档」（light 传了与 surface 不同的 inputBg，如 Solarized
   *  base2 卡片，则 lift 到 surface，否则用通用 hover）；icon 圆底取「比 hover 卡片
   *  更深一档」的层——lift 主题用 chip（压在提亮卡片上），其余 dark 用 border、
   *  其余 light 用 chip——保证三态可分。pressed 恒 pick(chip, hover)。 */
  const liftsOffSurface = palette.inputBg !== undefined
    && toHex(palette.inputBg).toLowerCase() !== toHex(palette.surface).toLowerCase();
  const quickHover = toHex(liftsOffSurface ? palette.surface : palette.hover);
  const quickIconBg = liftsOffSurface
    ? toHex(palette.surface)
    : pick(toHex(palette.border), toHex(palette.chip));
  const switchThumbOffRgb = pick(palette.surface, palette.elevated);
  const switchTrackOff = toHex(deriveUncheckedSwitchTrack(palette.textSecondary, [
    palette.surface,
    palette.elevated,
    palette.hover,
    switchThumbOffRgb,
  ]));
  const switchThumbOff = toHex(switchThumbOffRgb);

  const colors: Record<string, string> = {
    // ── Tier1 语义 slot ──
    surface,
    'surface-hsl': surfaceHsl,
    'surface-elevated': elevated,
    'surface-elevated-soft': pick(elevated, elevatedSoft),
    'surface-card-ivory': elevated,
    'surface-chip': chip,
    'surface-chip-alt': pick(chip, elevatedSoft),
    'surface-hover': hover,
    'surface-hover-soft': pick(hover, surface),
    'surface-hover-hsl': hoverHsl,
    'surface-on-card': pick(surface, elevated),
    'border-default': border,
    'border-default-hsl': borderHsl,
    'border-shadcn-hsl': borderHsl,
    'border-transparent-mixed': pick(border, 'transparent'),
    'text-primary': textPrimary,
    'text-primary-on-dark': textPrimary,
    'text-primary-emphasis': textPrimary,
    'text-primary-inv': textPrimary,
    'text-primary-body-strong': textPrimary,
    'text-primary-hsl': textPrimaryHsl,
    'text-secondary': textSecondary,
    'text-secondary-cross': textSecondary,
    'text-secondary-mid': textSecondary,
    'text-tertiary': textTertiary,
    'text-tertiary-stone': textTertiary,
    'text-tertiary-mid': textTertiary,
    'text-tertiary-hsl': textTertiaryHsl,
    'text-disabled': textDisabled,
    'text-disabled-tertiary': textDisabled,
    'accent-cta-bg': accentPrimary,
    'accent-cta-bg-pure': accentPrimary,
    'accent-emphasis': accentPrimary,
    'accent-soft': pick(accentSoft, accentDeep),
    'accent-hover': accentDeep,
    'accent-pure-cta-fg': onAccent,
    'status-badge-fg': '#1F1F1F',

    // ── alias / singleton ──
    accent: hoverHsl,
    'agent-actions-rail': border,
    'ask-checkbox-border': mutedIcon,
    background: surfaceHsl,
    'chat-input-chip-border': border,
    'chat-input-text': textPrimary,
    'color-primary': textPrimary,
    'confirm-bg': elevated,
    'confirm-btn-primary-bg': accentPrimary,
    'confirm-btn-primary-text': onAccent,
    'confirm-btn-secondary-border': border,
    // 叠层方向随模式反转(深底叠白 / 浅底叠黑),无法用单值表达。
    'confirm-btn-secondary-hover': pick(
      'rgba(255, 255, 255, 0.06)',
      'rgba(0, 0, 0, 0.06)',
    ),
    'confirm-btn-secondary-text': textPrimary,
    'confirm-title': textPrimary,
    'create-agent-control-bg': inputBg,
    'create-agent-control-bg-hover': quickHover,
    'create-agent-control-bg-pressed': pick(chip, hover),
    'create-agent-control-border': border,
    'create-agent-control-icon': textPrimary,
    'create-agent-control-text': textPrimary,
    'create-agent-quick-card-bg': inputBg,
    'create-agent-quick-card-bg-hover': quickHover,
    'create-agent-quick-card-border': border,
    'create-agent-quick-card-icon': textPrimary,
    'create-agent-quick-card-icon-bg': quickIconBg,
    'create-agent-quick-card-text': textPrimary,
    'create-agent-segment-inactive-text': pick(textTertiary, textSecondary),
    'create-agent-segment-track-bg': inputBg,
    'drop-overlay-bg': toRgbaString(palette.accentPrimary, 0.1),
    'file-chip-bg': pick(border, chip),
    'file-remove-bg': mutedIcon,
    'info-700': accentReadable,
    'model-trigger-hover': hover,
    'msg-link': linkColor,
    'msg-scrollbar-hover': mutedIcon,
    muted: chipHsl,
    'muted-foreground': textSecondaryHsl,
    'perm-allow-btn-bg': accentPrimary,
    'perm-allow-btn-text': onAccent,
    'perm-allow-kbd-bg': allowKbd.bg,
    'perm-allow-kbd-border': allowKbd.border,
    'perm-code-bg': pick(surface, elevatedSoft),
    'perm-item-selected-bg': chip,
    'plan-outline-active-bg': chip,
    'plan-toolbar-btn-hover-bg': hover,
    popover: elevatedHsl,
    'primary-foreground': pick(surfaceHsl, '0 0% 100%'),
    'search-match-fg': textPrimaryHsl,
    secondary: pick(elevatedHsl, chipHsl),
    // send 底用反相中性而非 accent:共享 send token 还渲染 10-12px 文本
    // (VoiceInputOverlay / SessionHandoffCard),accent 底
    // 配白/黑字难稳定过 4.5:1 小字线,反相中性双模式均满足。
    'send-btn-bg': pick(textPrimary, surface),
    'send-btn-icon': pick(surface, textPrimary),
    'settings-btn-primary-text': onAccent,
    'settings-btn-secondary-hover-bg': hover,
    // placeholder 必须"读着像空",两个模式都取比 tertiary 更淡的 disabled 档。
    'text-placeholder': textDisabled,
    'settings-integration-avatar-bg': chip,
    'settings-logout-bg': chip,
    'settings-menu-bg-hover': hover,
    'settings-menu-bg-selected': chip,
    'settings-source-link': linkColor,
    'settings-theme-auto-dark': surface,
    'switch-thumb-off': switchThumbOff,
    'switch-track-off': switchTrackOff,
    'sidebar-action-icon': textTertiaryHsl,
    'sidebar-item-active': chipHsl,
    'splash-bg': surfaceHsl,
    'splash-text': textSecondaryHsl,
    'splash-text-destructive': textPrimaryHsl,
    'splash-text-muted': textTertiaryHsl,
    'titlebar-icon': textSecondaryHsl,
    // tooltip 在 light 下反色(深底浅字),dark 下同底色。
    'tooltip-bg': pick(surface, textPrimary),
    'tooltip-text': pick(textPrimary, surface),
    'update-btn-border': accentPrimary,
    'update-btn-text': accentPrimary,
  };

  MARKDOWN_HEADING_TOKENS.forEach((token, index) => {
    const value = markdown?.headings?.[index];
    if (value) colors[token] = toHex(value);
  });
  if (markdown?.strong) colors['md-strong-fg'] = toHex(markdown.strong);

  return colors;
}
