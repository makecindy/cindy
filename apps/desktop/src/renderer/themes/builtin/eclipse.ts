import type { Theme } from '../types';

/*
 * Eclipse — neutral charcoal surface (#0d1117) + vibrant teal accent (#0CD2A5).
 * 单一品牌色 (teal) 配中性炭灰底,让 accent 在中性背景上最大化跳出。
 *
 * Anchor 常量名(SURFACE_NAVY / BOARD_NAVY 等)是历史命名,语义上现在就是
 * "charcoal 三层",保留名字避免大面积 rename;值已经迁过(2026-05-28 从
 * 冷紫 navy 切到中性炭灰)。
 */
const TEAL_PRIMARY = '#0CD2A5';
const TEAL_SOFT = '#5eead4';
const TEAL_DEEP = '#0f8a73';

const SURFACE_NAVY = '#0d1117';
const CARD_NAVY = '#161b22';
const BOARD_NAVY = '#30363d';
const HOVER_NAVY = '#1c2128';
const CHIP_NAVY = '#262c36';
const SURFACE_NAVY_HSL = '220 12% 7%';
const CARD_NAVY_HSL = '213 16% 11%';
const BOARD_NAVY_HSL = '215 12% 21%';
const HOVER_NAVY_HSL = '213 16% 14%';
const CHIP_NAVY_HSL = '215 16% 18%';

const TEXT_PRIMARY = '#e6e6e6';
const TEXT_SECONDARY = '#9ca3af';
const TEXT_TERTIARY = '#6b7280';
const TEXT_DISABLED = '#4b5563';
const TEXT_PRIMARY_HSL = '0 0% 90%';
const TEXT_SECONDARY_HSL = '220 9% 65%';
const TEXT_TERTIARY_HSL = '220 9% 46%';

const slotOverrides = {
  surface: SURFACE_NAVY,
  'surface-hsl': SURFACE_NAVY_HSL,
  'surface-elevated': CARD_NAVY,
  'surface-elevated-soft': CARD_NAVY,
  'surface-card-ivory': CARD_NAVY,
  'surface-chip': CHIP_NAVY,
  'surface-chip-alt': CHIP_NAVY,
  'surface-hover': HOVER_NAVY,
  'surface-hover-soft': HOVER_NAVY,
  'surface-hover-hsl': HOVER_NAVY_HSL,
  'surface-on-card': SURFACE_NAVY,
  'border-default': BOARD_NAVY,
  'border-default-hsl': BOARD_NAVY_HSL,
  'border-shadcn-hsl': BOARD_NAVY_HSL,
  'border-transparent-mixed': BOARD_NAVY,
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
  'accent-cta-bg': TEAL_PRIMARY,
  'accent-cta-bg-pure': TEAL_PRIMARY,
  'accent-emphasis': TEAL_PRIMARY,
  'accent-soft': TEAL_SOFT,
  'accent-hover': TEAL_DEEP,
  'accent-pure-cta-fg': SURFACE_NAVY,
  'switch-track-on': TEAL_PRIMARY,
} as const;

const singletonOverrides = {
  accent: HOVER_NAVY_HSL,
  'agent-actions-rail': BOARD_NAVY,
  'ask-checkbox-border': TEXT_DISABLED,
  background: SURFACE_NAVY_HSL,
  // CREATE AGENT 卡片 / 顶部 pill / 分段开关 + composer pill(#607):
  // 卡片底与 surface 同值收敛(模板惯例),icon 圆底用 CHIP,send 走 tier1 反相 CTA。
  'create-agent-control-bg': SURFACE_NAVY,
  'create-agent-control-bg-hover': HOVER_NAVY,
  'create-agent-control-bg-pressed': CHIP_NAVY,
  'create-agent-control-border': BOARD_NAVY,
  'create-agent-control-icon': TEXT_PRIMARY,
  'create-agent-control-text': TEXT_PRIMARY,
  'create-agent-quick-card-bg': SURFACE_NAVY,
  'create-agent-quick-card-bg-hover': HOVER_NAVY,
  'create-agent-quick-card-border': BOARD_NAVY,
  'create-agent-quick-card-icon': TEXT_PRIMARY,
  'create-agent-quick-card-icon-bg': BOARD_NAVY,
  'create-agent-quick-card-text': TEXT_PRIMARY,
  'create-agent-segment-inactive-text': TEXT_TERTIARY,
  'create-agent-segment-track-bg': SURFACE_NAVY,
  'send-btn-bg': TEXT_PRIMARY,
  'send-btn-icon': SURFACE_NAVY,
  'chat-input-chip-border': BOARD_NAVY,
  'chat-input-text': TEXT_PRIMARY,
  'color-primary': TEXT_PRIMARY,
  'confirm-bg': CARD_NAVY,
  'confirm-btn-primary-bg': TEAL_PRIMARY,
  'confirm-btn-primary-text': SURFACE_NAVY,
  'confirm-btn-secondary-border': BOARD_NAVY,
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.06)',
  'confirm-btn-secondary-text': TEXT_PRIMARY,
  'confirm-title': TEXT_PRIMARY,
  'drop-overlay-bg': 'rgba(12, 210, 165, 0.1)',
  'file-chip-bg': BOARD_NAVY,
  'file-remove-bg': TEXT_DISABLED,
  'info-700': TEAL_SOFT,
  'model-trigger-hover': HOVER_NAVY,
  'msg-link': TEAL_SOFT,
  'msg-scrollbar-hover': TEXT_DISABLED,
  muted: CHIP_NAVY_HSL,
  'muted-foreground': TEXT_SECONDARY_HSL,
  'perm-allow-btn-bg': TEAL_PRIMARY,
  'perm-allow-btn-text': SURFACE_NAVY,
  'perm-allow-kbd-bg': CHIP_NAVY,
  'perm-allow-kbd-border': BOARD_NAVY,
  'perm-code-bg': SURFACE_NAVY,
  'perm-item-selected-bg': CHIP_NAVY,
  'plan-outline-active-bg': CHIP_NAVY,
  'plan-toolbar-btn-hover-bg': HOVER_NAVY,
  popover: CARD_NAVY_HSL,
  'primary-foreground': SURFACE_NAVY_HSL,
  'search-match-fg': TEXT_PRIMARY_HSL,
  secondary: CARD_NAVY_HSL,
  'settings-btn-primary-text': SURFACE_NAVY,
  'settings-btn-secondary-hover-bg': HOVER_NAVY,
  'text-placeholder': TEXT_DISABLED,
  'settings-integration-avatar-bg': CHIP_NAVY,
  'settings-logout-bg': CHIP_NAVY,
  'settings-menu-bg-hover': HOVER_NAVY,
  'settings-menu-bg-selected': CHIP_NAVY,
  'settings-source-link': TEAL_SOFT,
  'settings-theme-auto-dark': SURFACE_NAVY,
  'sidebar-action-icon': TEXT_TERTIARY_HSL,
  'sidebar-item-active': CHIP_NAVY_HSL,
  'splash-bg': SURFACE_NAVY_HSL,
  'splash-text': TEXT_SECONDARY_HSL,
  'splash-text-destructive': TEXT_PRIMARY_HSL,
  'splash-text-muted': TEXT_TERTIARY_HSL,
  'titlebar-icon': TEXT_SECONDARY_HSL,
  'tooltip-bg': SURFACE_NAVY,
  'tooltip-text': TEXT_PRIMARY,
  'update-btn-border': TEAL_PRIMARY,
  'update-btn-text': TEAL_PRIMARY,
} as const;

export const eclipse: Theme = {
  id: 'eclipse',
  name: 'Eclipse',
  type: 'dark',
  colors: {
    ...slotOverrides,
    ...singletonOverrides,
  },
};
