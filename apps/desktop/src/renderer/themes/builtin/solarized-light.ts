import type { Theme } from '../types';

/*
 * Solarized Light — 温暖 ivory 底 (base3 #fdf6e3) + Solarized 官方 green accent
 * (#859900,8 个官方 accent 之一)。
 *
 * 文本色不用 Solarized 的 base00/base01 (H=194°,带青/teal 色相),改用纯中性
 * 灰阶 (H=0 / S=0%)。原因是在米黄底上,带青调的灰会被互补色对比拉偏,视觉
 * 上呈"绿灰";中性灰与 base3 配色温更协调、阅读不抢色。primary 刻意较淡,
 * secondary/tertiary 留出合理梯度避免过淡。
 */

// 保留官方鲜活感优先于 WCAG AA 数字合规:#859900 vs base3/white 对比度 ~3,
// 但 H=68 与中性灰 H=0 色相对比强,视觉区分度反而高于加深版。要强制合规改 #5e6a00。
const GREEN_PRIMARY = '#859900';
const GREEN_DEEP = '#5e6a00';

const SURFACE_BG = '#fdf6e3'; // base3
// ELEVATED (Card 层) 与 Chip 同色 = base2。Solarized 官方只有两档色板,
// docs/design-rules/cindy-design-system.md §2.54 也明文承认 Dark Mode 里 "Card layer color and chip color
// collapse to the same value — both represent one step lifted off Surface"
// 这里把同一惯例搬到 light 模式:Card 比 Surface 略深一档 (94% → 88% L,
// 差 6%) 产生"下沉式抬起"视觉,与 macOS 浅色模式 input 类似。
const CHIP_BG = '#eee8d5'; // base2 — Card / Chip / Hover / sidebar-active 同源
const ELEVATED_BG = CHIP_BG;
const ELEVATED_SOFT_BG = CHIP_BG;
const HOVER_BG = CHIP_BG;
const BORDER_BG = '#e1dcc4'; // base2 加深,1px 分界
const SURFACE_BG_HSL = '44 86% 94%';
const CHIP_BG_HSL = '46 42% 88%';
const ELEVATED_BG_HSL = CHIP_BG_HSL;
const HOVER_BG_HSL = CHIP_BG_HSL;
const BORDER_BG_HSL = '50 33% 82%';

const TEXT_PRIMARY = '#757575'; // 中性灰,正文,刻意比 default-light 淡
const TEXT_SECONDARY = '#828282'; // label / desc
const TEXT_TERTIARY = '#999999'; // meta / 弱化
const TEXT_DISABLED = '#bdbdbd';
const TEXT_PRIMARY_HSL = '0 0% 46%';
const TEXT_SECONDARY_HSL = '0 0% 51%';
const TEXT_TERTIARY_HSL = '0 0% 60%';

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
  'accent-cta-bg': GREEN_PRIMARY,
  'accent-cta-bg-pure': GREEN_PRIMARY,
  'accent-emphasis': GREEN_PRIMARY,
  'accent-soft': GREEN_DEEP,
  'accent-hover': GREEN_DEEP,
  'accent-pure-cta-fg': '#FFFFFF',
} as const;

const singletonOverrides = {
  accent: HOVER_BG_HSL,
  'agent-actions-rail': BORDER_BG,
  'ask-checkbox-border': TEXT_TERTIARY,
  background: SURFACE_BG_HSL,
  'chat-input-bg': CHIP_BG,
  // CREATE AGENT 快速开始卡片 / 顶部 pill / 分段开关(#607):
  // 卡片用 base2(CHIP)下沉式抬起,与 chat-input 同层;边框/文字走 tier1 同源常量。
  // hover 必须提亮到 base3(SURFACE):CHIP 与 HOVER 在本主题同值,沿用 HOVER 会让
  // 卡片 default/hover 同色、icon 圆底与卡片同色(codex P1 3671116833)。
  'create-agent-control-bg': CHIP_BG,
  'create-agent-control-bg-hover': SURFACE_BG,
  'create-agent-control-bg-pressed': HOVER_BG,
  'create-agent-control-border': BORDER_BG,
  'create-agent-control-icon': TEXT_PRIMARY,
  'create-agent-control-text': TEXT_PRIMARY,
  'create-agent-quick-card-bg': CHIP_BG,
  'create-agent-quick-card-bg-hover': SURFACE_BG,
  'create-agent-quick-card-border': BORDER_BG,
  'create-agent-quick-card-icon': TEXT_PRIMARY,
  // icon 圆底 resting 提到 base3(SURFACE) 与 base2 卡片区分;hover 时卡片升到
  // base3、圆底由模板规则落回 base2(CHIP),两态均可分(codex P1 3671457570)。
  'create-agent-quick-card-icon-bg': SURFACE_BG,
  // send 不用 accent(green) 底:共享 send token 还渲染 10-12px 文本
  // (VoiceInputOverlay / SessionHandoffCard),白字仅
  // 3.20:1,不达 DESIGN.md §10 小字 4.5:1;回退 registry 反相中性(codex P1
  // 3671457561),故本主题不覆盖 send-btn-*。
  'create-agent-quick-card-text': TEXT_PRIMARY,
  'create-agent-segment-inactive-text': TEXT_SECONDARY,
  'create-agent-segment-track-bg': CHIP_BG,
  'chat-input-chip-border': BORDER_BG,
  'chat-input-text': TEXT_PRIMARY,
  'color-primary': TEXT_PRIMARY,
  'confirm-bg': ELEVATED_BG,
  'confirm-btn-primary-bg': GREEN_PRIMARY,
  'confirm-btn-primary-text': '#FFFFFF',
  'confirm-btn-secondary-border': BORDER_BG,
  'confirm-btn-secondary-hover': 'rgba(0, 0, 0, 0.06)',
  'confirm-btn-secondary-text': TEXT_PRIMARY,
  'confirm-title': TEXT_PRIMARY,
  'drop-overlay-bg': 'rgba(133, 153, 0, 0.1)',
  'file-chip-bg': CHIP_BG,
  'file-remove-bg': TEXT_TERTIARY,
  'info-700': GREEN_DEEP,
  'model-trigger-hover': HOVER_BG,
  'msg-link': GREEN_PRIMARY,
  'msg-scrollbar-hover': TEXT_TERTIARY,
  'msg-user-bg': CHIP_BG,
  muted: CHIP_BG_HSL,
  'muted-foreground': TEXT_SECONDARY_HSL,
  'perm-auto-selected-text': GREEN_PRIMARY, // 自动审批的色相标识,与 bypass 橙拉开
  'perm-allow-btn-bg': GREEN_PRIMARY,
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
  // 用 disabled(比 tertiary 更淡)而非 tertiary:亮色背景下 tertiary 偏深,
  // 命中 docs/design-rules/cindy-design-system.md §4 禁用 Silver 的对比度,placeholder 需更淡才"读着像空"。
  'text-placeholder': TEXT_DISABLED,
  'settings-integration-avatar-bg': CHIP_BG,
  'settings-logout-bg': CHIP_BG,
  'settings-menu-bg-hover': HOVER_BG,
  'settings-menu-bg-selected': CHIP_BG,
  'settings-source-link': GREEN_PRIMARY,
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
  'update-btn-border': GREEN_PRIMARY,
  'update-btn-text': GREEN_PRIMARY,
} as const;

export const solarizedLight: Theme = {
  id: 'solarized-light',
  name: 'Solarized Light',
  type: 'light',
  colors: {
    ...slotOverrides,
    ...singletonOverrides,
  },
};
