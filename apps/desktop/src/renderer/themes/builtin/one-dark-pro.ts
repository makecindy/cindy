import type { Theme } from '../types';

/*
 * One Dark Pro — VSCode 经典暗色主题,签名是温和的蓝灰底 (#282c34) +
 * 标志性蓝色 accent (#61afef,即 OneDark 的 function 色)。色板取自
 * https://github.com/Binaryify/OneDark-Pro 的官方 OneDark-Pro.json。
 *
 * 层级:
 *   SURFACE  #282c34  editor.background       (主背景)
 *   ELEVATED #21252b  sideBar.background      (侧栏/卡片更深一档)
 *   HOVER    #2c313a  list.hoverBackground    (悬停/选中)
 *   CHIP     #2c313a  同上,chip 复用 hover 层
 *   BORDER   #3e4452  panel.border            (描边)
 *
 * 文本层:
 *   PRIMARY   #abb2bf editor.foreground
 *   SECONDARY #7f848e comments
 *   TERTIARY  #5c6370 mid
 *   DISABLED  #495162 lineNumber.foreground
 */
const BLUE_PRIMARY = '#61afef';
const BLUE_SOFT = '#82c0ff';
const BLUE_DEEP = '#3d7ec8';

const SURFACE_BG = '#282c34';
const ELEVATED_BG = '#21252b';
const HOVER_BG = '#2c313a';
const CHIP_BG = '#2c313a';
const BORDER_BG = '#3e4452';
const SURFACE_BG_HSL = '220 13% 18%';
const ELEVATED_BG_HSL = '220 13% 15%';
const HOVER_BG_HSL = '220 14% 20%';
const CHIP_BG_HSL = '220 14% 20%';
const BORDER_BG_HSL = '220 14% 28%';

const TEXT_PRIMARY = '#abb2bf';
const TEXT_SECONDARY = '#7f848e';
const TEXT_TERTIARY = '#5c6370';
const TEXT_DISABLED = '#495162';
const TEXT_PRIMARY_HSL = '219 14% 71%';
const TEXT_SECONDARY_HSL = '220 6% 53%';
const TEXT_TERTIARY_HSL = '220 9% 40%';

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
  'accent-pure-cta-fg': SURFACE_BG,
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
  'confirm-btn-primary-text': SURFACE_BG,
  'confirm-btn-secondary-border': BORDER_BG,
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.06)',
  'confirm-btn-secondary-text': TEXT_PRIMARY,
  'confirm-title': TEXT_PRIMARY,
  'drop-overlay-bg': 'rgba(97, 175, 239, 0.1)',
  'file-chip-bg': BORDER_BG,
  'file-remove-bg': TEXT_DISABLED,
  'info-700': BLUE_SOFT,
  'model-trigger-hover': HOVER_BG,
  'msg-link': BLUE_SOFT,
  'msg-scrollbar-hover': TEXT_DISABLED,
  muted: CHIP_BG_HSL,
  'muted-foreground': TEXT_SECONDARY_HSL,
  'perm-allow-btn-bg': BLUE_PRIMARY,
  'perm-allow-btn-text': SURFACE_BG,
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
  'settings-btn-primary-text': SURFACE_BG,
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

export const oneDarkPro: Theme = {
  id: 'one-dark-pro',
  name: 'One Dark Pro',
  type: 'dark',
  colors: {
    ...slotOverrides,
    ...singletonOverrides,
  },
};
