import type { Theme } from '../types';

/*
 * Atom One Light — VSCode 经典亮色主题,签名是温柔的 off-white 底 (#FAFAFA) +
 * 函数蓝 accent (#4078F2)。色板取自
 * https://github.com/akamud/vscode-theme-onelight 的官方 OneLight.json。
 *
 * 这是项目里第一个非默认 light 主题,所有 light 默认值已经接近 Atom One Light,
 * 主要差异在 accent (默认是近黑灰,这里换成蓝色) 和 surface (默认 #f8f8f6
 * 偏暖,这里换成 #FAFAFA 偏中性)。
 */
const BLUE_PRIMARY = '#4078F2';
const BLUE_DEEP = '#2050c0';

const SURFACE_BG = '#FAFAFA';
const ELEVATED_BG = '#FFFFFF';
const ELEVATED_SOFT_BG = '#EAEAEB';
const HOVER_BG = '#E4E4E5';
const CHIP_BG = '#EAEAEB';
const BORDER_BG = '#D4D4D5';
const SURFACE_BG_HSL = '0 0% 98%';
const ELEVATED_BG_HSL = '0 0% 100%';
const HOVER_BG_HSL = '240 2% 89%';
const CHIP_BG_HSL = '240 2% 92%';
const BORDER_BG_HSL = '240 2% 83%';

const TEXT_PRIMARY = '#383A42';
const TEXT_SECONDARY = '#696c77';
const TEXT_TERTIARY = '#A0A1A7';
const TEXT_DISABLED = '#C8C8C9';
const TEXT_PRIMARY_HSL = '224 8% 24%';
const TEXT_SECONDARY_HSL = '220 6% 44%';
const TEXT_TERTIARY_HSL = '228 4% 64%';

const slotOverrides = {
  surface: SURFACE_BG,
  'surface-hsl': SURFACE_BG_HSL,
  'surface-elevated': ELEVATED_BG,
  'surface-elevated-soft': ELEVATED_SOFT_BG,
  'surface-card-ivory': ELEVATED_BG,
  'surface-chip': CHIP_BG,
  'surface-chip-alt': ELEVATED_SOFT_BG,
  'surface-hover': HOVER_BG,
  'surface-hover-soft': SURFACE_BG,
  'surface-hover-hsl': HOVER_BG_HSL,
  'surface-on-card': ELEVATED_BG,
  'border-default': BORDER_BG,
  'border-default-hsl': BORDER_BG_HSL,
  'border-shadcn-hsl': BORDER_BG_HSL,
  'border-transparent-mixed': 'transparent',
  'text-primary': TEXT_PRIMARY,
  'text-primary-on-dark': TEXT_PRIMARY,
  'text-primary-emphasis': TEXT_PRIMARY,
  'text-primary-inv': TEXT_PRIMARY,
  'text-primary-body-strong': TEXT_PRIMARY,
  'text-primary-hsl': TEXT_PRIMARY_HSL,
  'text-secondary': TEXT_SECONDARY,
  'text-secondary-cross': TEXT_SECONDARY,
  'text-secondary-mid': TEXT_SECONDARY,
  'text-tertiary': TEXT_TERTIARY,
  'text-tertiary-stone': TEXT_TERTIARY,
  'text-tertiary-mid': TEXT_TERTIARY,
  'text-tertiary-hsl': TEXT_TERTIARY_HSL,
  'text-disabled': TEXT_DISABLED,
  'text-disabled-tertiary': TEXT_DISABLED,
  'accent-cta-bg': BLUE_PRIMARY,
  'accent-cta-bg-pure': BLUE_PRIMARY,
  'accent-emphasis': BLUE_PRIMARY,
  'accent-soft': BLUE_DEEP,
  'accent-hover': BLUE_DEEP,
  'accent-pure-cta-fg': '#FFFFFF',
} as const;

const singletonOverrides = {
  accent: HOVER_BG_HSL,
  'agent-actions-rail': BORDER_BG,
  'ask-checkbox-border': TEXT_TERTIARY,
  background: SURFACE_BG_HSL,
  // CREATE AGENT 卡片 / 顶部 pill / 分段开关 + composer pill(#607):
  // 卡片底与 surface 同值收敛(模板惯例),icon 圆底用 CHIP,send 走 tier1 反相 CTA。
  'create-agent-control-bg': SURFACE_BG,
  'create-agent-control-bg-hover': HOVER_BG,
  'create-agent-control-bg-pressed': HOVER_BG,
  'create-agent-control-border': BORDER_BG,
  'create-agent-control-icon': TEXT_PRIMARY,
  'create-agent-control-text': TEXT_PRIMARY,
  'create-agent-quick-card-bg': SURFACE_BG,
  'create-agent-quick-card-bg-hover': HOVER_BG,
  'create-agent-quick-card-border': BORDER_BG,
  'create-agent-quick-card-icon': TEXT_PRIMARY,
  'create-agent-quick-card-icon-bg': CHIP_BG,
  'create-agent-quick-card-text': TEXT_PRIMARY,
  'create-agent-segment-inactive-text': TEXT_SECONDARY,
  'create-agent-segment-track-bg': SURFACE_BG,
  'send-btn-bg': SURFACE_BG,
  'send-btn-icon': TEXT_PRIMARY,
  'chat-input-chip-border': BORDER_BG,
  'chat-input-text': TEXT_PRIMARY,
  'color-primary': TEXT_PRIMARY,
  'confirm-bg': ELEVATED_BG,
  'confirm-btn-primary-bg': BLUE_PRIMARY,
  'confirm-btn-primary-text': '#FFFFFF',
  'confirm-btn-secondary-border': BORDER_BG,
  'confirm-btn-secondary-hover': 'rgba(0, 0, 0, 0.06)',
  'confirm-btn-secondary-text': TEXT_PRIMARY,
  'confirm-title': TEXT_PRIMARY,
  'drop-overlay-bg': 'rgba(64, 120, 242, 0.1)',
  'file-chip-bg': CHIP_BG,
  'file-remove-bg': TEXT_TERTIARY,
  'info-700': BLUE_DEEP,
  'model-trigger-hover': HOVER_BG,
  'msg-link': BLUE_PRIMARY,
  'msg-scrollbar-hover': TEXT_TERTIARY,
  muted: CHIP_BG_HSL,
  'muted-foreground': TEXT_SECONDARY_HSL,
  'perm-allow-btn-bg': BLUE_PRIMARY,
  'perm-allow-btn-text': '#FFFFFF',
  'perm-allow-kbd-bg': CHIP_BG,
  'perm-allow-kbd-border': BORDER_BG,
  'perm-code-bg': ELEVATED_SOFT_BG,
  'perm-item-selected-bg': CHIP_BG,
  'plan-outline-active-bg': CHIP_BG,
  'plan-toolbar-btn-hover-bg': HOVER_BG,
  popover: ELEVATED_BG_HSL,
  'primary-foreground': '0 0% 100%',
  'search-match-fg': TEXT_PRIMARY_HSL,
  secondary: CHIP_BG_HSL,
  'settings-btn-primary-text': '#FFFFFF',
  'settings-btn-secondary-hover-bg': HOVER_BG,
  // 用 disabled(比 tertiary 更淡)而非 tertiary:亮色背景下 tertiary≈2.6:1,
  // 命中 docs/design-rules/cindy-design-system.md §4 禁用 Silver 的对比度,placeholder 需更淡才"读着像空"。
  'text-placeholder': TEXT_DISABLED,
  'settings-integration-avatar-bg': CHIP_BG,
  'settings-logout-bg': CHIP_BG,
  'settings-menu-bg-hover': HOVER_BG,
  'settings-menu-bg-selected': CHIP_BG,
  'settings-source-link': BLUE_PRIMARY,
  'settings-theme-auto-dark': SURFACE_BG,
  'sidebar-action-icon': TEXT_TERTIARY_HSL,
  'sidebar-item-active': CHIP_BG_HSL,
  'splash-bg': SURFACE_BG_HSL,
  'splash-text': TEXT_SECONDARY_HSL,
  'splash-text-destructive': TEXT_PRIMARY_HSL,
  'splash-text-muted': TEXT_TERTIARY_HSL,
  'titlebar-icon': TEXT_SECONDARY_HSL,
  'tooltip-bg': TEXT_PRIMARY,
  'tooltip-text': SURFACE_BG,
  'update-btn-border': BLUE_PRIMARY,
  'update-btn-text': BLUE_PRIMARY,
} as const;

export const atomOneLight: Theme = {
  id: 'atom-one-light',
  name: 'Atom One Light',
  type: 'light',
  colors: {
    ...slotOverrides,
    ...singletonOverrides,
  },
};
