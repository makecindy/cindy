import type { Theme } from '../types';

/*
 * GitHub Dark — Primer/github-vscode-theme 暗色变体。signature 色:
 *   canvas.default #0d1117 (主背景)
 *   canvas.subtle  #161b22 (elevated)
 *   border.default #30363d
 *   fg.default     #e6edf3
 *   accent.fg      #2f81f7 (Primer blue)
 * 色板取自 https://github.com/primer/github-vscode-theme + @primer/primitives
 * 的 dark scale。
 */
const BLUE_PRIMARY = '#2f81f7';
const BLUE_SOFT = '#79c0ff';
const BLUE_DEEP = '#1f6feb';

const SURFACE_BG = '#0d1117';
const ELEVATED_BG = '#161b22';
const HOVER_BG = '#1c2128';
const CHIP_BG = '#21262d';
const BORDER_BG = '#30363d';
const SURFACE_BG_HSL = '220 13% 7%';
const ELEVATED_BG_HSL = '215 21% 11%';
const HOVER_BG_HSL = '215 16% 13%';
const CHIP_BG_HSL = '213 14% 15%';
const BORDER_BG_HSL = '213 12% 21%';

const TEXT_PRIMARY = '#e6edf3';
const TEXT_SECONDARY = '#7d8590';
const TEXT_TERTIARY = '#6e7681';
const TEXT_DISABLED = '#484f58';
const TEXT_PRIMARY_HSL = '213 31% 93%';
const TEXT_SECONDARY_HSL = '215 9% 53%';
const TEXT_TERTIARY_HSL = '215 8% 47%';

const slotOverrides = {
  surface: SURFACE_BG,
  'surface-hsl': SURFACE_BG_HSL,
  'surface-elevated': ELEVATED_BG,
  'surface-elevated-soft': ELEVATED_BG,
  'surface-card-ivory': ELEVATED_BG,
  'surface-chip': CHIP_BG,
  'surface-chip-alt': CHIP_BG,
  'surface-hover': HOVER_BG,
  'surface-hover-soft': HOVER_BG,
  'surface-hover-hsl': HOVER_BG_HSL,
  'surface-on-card': SURFACE_BG,
  'border-default': BORDER_BG,
  'border-default-hsl': BORDER_BG_HSL,
  'border-shadcn-hsl': BORDER_BG_HSL,
  'border-transparent-mixed': BORDER_BG,
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
  'accent-soft': BLUE_SOFT,
  'accent-hover': BLUE_DEEP,
  'accent-pure-cta-fg': '#ffffff',
  'switch-track-on': BLUE_PRIMARY,
  'status-badge-fg': '#1F1F1F',
} as const;

const singletonOverrides = {
  accent: HOVER_BG_HSL,
  'agent-actions-rail': BORDER_BG,
  'ask-checkbox-border': TEXT_DISABLED,
  background: SURFACE_BG_HSL,
  // CREATE AGENT 卡片 / 顶部 pill / 分段开关 + composer pill(#607):
  // 卡片底与 surface 同值收敛(模板惯例),icon 圆底用 CHIP,send 走 tier1 反相 CTA。
  'create-agent-control-bg': SURFACE_BG,
  'create-agent-control-bg-hover': HOVER_BG,
  'create-agent-control-bg-pressed': CHIP_BG,
  'create-agent-control-border': BORDER_BG,
  'create-agent-control-icon': TEXT_PRIMARY,
  'create-agent-control-text': TEXT_PRIMARY,
  'create-agent-quick-card-bg': SURFACE_BG,
  'create-agent-quick-card-bg-hover': HOVER_BG,
  'create-agent-quick-card-border': BORDER_BG,
  'create-agent-quick-card-icon': TEXT_PRIMARY,
  'create-agent-quick-card-icon-bg': BORDER_BG,
  'create-agent-quick-card-text': TEXT_PRIMARY,
  'create-agent-segment-inactive-text': TEXT_TERTIARY,
  'create-agent-segment-track-bg': SURFACE_BG,
  'send-btn-bg': TEXT_PRIMARY,
  'send-btn-icon': SURFACE_BG,
  'chat-input-chip-border': BORDER_BG,
  'chat-input-text': TEXT_PRIMARY,
  'color-primary': TEXT_PRIMARY,
  'confirm-bg': ELEVATED_BG,
  'confirm-btn-primary-bg': BLUE_PRIMARY,
  'confirm-btn-primary-text': '#ffffff',
  'confirm-btn-secondary-border': BORDER_BG,
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.06)',
  'confirm-btn-secondary-text': TEXT_PRIMARY,
  'confirm-title': TEXT_PRIMARY,
  'drop-overlay-bg': 'rgba(47, 129, 247, 0.1)',
  'file-chip-bg': BORDER_BG,
  'file-remove-bg': TEXT_DISABLED,
  'info-700': BLUE_SOFT,
  'model-trigger-hover': HOVER_BG,
  'msg-link': BLUE_SOFT,
  'msg-scrollbar-hover': TEXT_DISABLED,
  muted: CHIP_BG_HSL,
  'muted-foreground': TEXT_SECONDARY_HSL,
  'perm-allow-btn-bg': BLUE_PRIMARY,
  'perm-allow-btn-text': '#ffffff',
  'perm-allow-kbd-bg': CHIP_BG,
  'perm-allow-kbd-border': BORDER_BG,
  'perm-code-bg': SURFACE_BG,
  'perm-item-selected-bg': CHIP_BG,
  'plan-outline-active-bg': CHIP_BG,
  'plan-toolbar-btn-hover-bg': HOVER_BG,
  popover: ELEVATED_BG_HSL,
  'primary-foreground': SURFACE_BG_HSL,
  'search-match-fg': TEXT_PRIMARY_HSL,
  secondary: ELEVATED_BG_HSL,
  'settings-btn-primary-text': '#ffffff',
  'settings-btn-secondary-hover-bg': HOVER_BG,
  'text-placeholder': TEXT_DISABLED,
  'settings-integration-avatar-bg': CHIP_BG,
  'settings-logout-bg': CHIP_BG,
  'settings-menu-bg-hover': HOVER_BG,
  'settings-menu-bg-selected': CHIP_BG,
  'settings-source-link': BLUE_SOFT,
  'settings-theme-auto-dark': SURFACE_BG,
  'sidebar-action-icon': TEXT_TERTIARY_HSL,
  'sidebar-item-active': CHIP_BG_HSL,
  'splash-bg': SURFACE_BG_HSL,
  'splash-text': TEXT_SECONDARY_HSL,
  'splash-text-destructive': TEXT_PRIMARY_HSL,
  'splash-text-muted': TEXT_TERTIARY_HSL,
  'titlebar-icon': TEXT_SECONDARY_HSL,
  'tooltip-bg': SURFACE_BG,
  'tooltip-text': TEXT_PRIMARY,
  'update-btn-border': BLUE_PRIMARY,
  'update-btn-text': BLUE_PRIMARY,
} as const;

export const githubDark: Theme = {
  id: 'github-dark',
  name: 'GitHub Dark',
  type: 'dark',
  colors: {
    ...slotOverrides,
    ...singletonOverrides,
  },
};
