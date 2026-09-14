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
// 既有分组/对比度/否决依据：docs/design-rules/design-decision-log.md
// 「2026-09-11 DS-8 内置主题依据迁移」→ one-dark-pro（生成区外保留）。
// BEGIN GENERATED DS-8: theme
const GENERATED_OVERRIDES = {
  "surface": "#282c34",
  "surface-hsl": "220 13% 18%",
  "surface-elevated": "#21252b",
  "surface-elevated-soft": "#21252b",
  "surface-card-ivory": "#21252b",
  "surface-chip": "#2c313a",
  "surface-chip-alt": "#2c313a",
  "surface-hover": "#2c313a",
  "surface-hover-soft": "#2c313a",
  "surface-hover-hsl": "220 14% 20%",
  "surface-on-card": "#282c34",
  "border-default": "#3e4452",
  "border-default-hsl": "220 14% 28%",
  "border-shadcn-hsl": "220 14% 28%",
  "border-transparent-mixed": "#3e4452",
  "text-primary": "#abb2bf",
  "text-primary-on-dark": "#abb2bf",
  "text-primary-emphasis": "#abb2bf",
  "text-primary-inv": "#abb2bf",
  "text-primary-body-strong": "#abb2bf",
  "text-primary-hsl": "219 14% 71%",
  "text-secondary": "#7f848e",
  "text-secondary-cross": "#7f848e",
  "text-secondary-mid": "#7f848e",
  "text-tertiary": "#5c6370",
  "text-tertiary-stone": "#5c6370",
  "text-tertiary-mid": "#5c6370",
  "text-tertiary-hsl": "220 9% 40%",
  "text-disabled": "#495162",
  "text-disabled-tertiary": "#495162",
  "accent-cta-bg": "#61afef",
  "accent-cta-bg-pure": "#61afef",
  "accent-emphasis": "#61afef",
  "accent-soft": "#82c0ff",
  "accent-hover": "#3d7ec8",
  "accent-pure-cta-fg": "#282c34",
  "switch-track-on": "#61afef",
  "accent": "220 14% 20%",
  "agent-actions-rail": "#3e4452",
  "ask-checkbox-border": "#495162",
  "background": "220 13% 18%",
  "create-agent-control-bg": "#282c34",
  "create-agent-control-bg-hover": "#2c313a",
  "create-agent-control-bg-pressed": "#2c313a",
  "create-agent-control-border": "#3e4452",
  "create-agent-control-icon": "#abb2bf",
  "create-agent-control-text": "#abb2bf",
  "create-agent-quick-card-bg": "#282c34",
  "create-agent-quick-card-bg-hover": "#2c313a",
  "create-agent-quick-card-border": "#3e4452",
  "create-agent-quick-card-icon": "#abb2bf",
  "create-agent-quick-card-icon-bg": "#3e4452",
  "create-agent-quick-card-text": "#abb2bf",
  "create-agent-segment-inactive-text": "#5c6370",
  "create-agent-segment-track-bg": "#282c34",
  "send-btn-bg": "#abb2bf",
  "send-btn-icon": "#282c34",
  "chat-input-chip-border": "#3e4452",
  "chat-input-text": "#abb2bf",
  "color-primary": "#abb2bf",
  "confirm-bg": "#21252b",
  "confirm-btn-primary-bg": "#61afef",
  "confirm-btn-primary-text": "#282c34",
  "confirm-btn-secondary-border": "#3e4452",
  "confirm-btn-secondary-hover": "rgba(255, 255, 255, 0.06)",
  "confirm-btn-secondary-text": "#abb2bf",
  "confirm-title": "#abb2bf",
  "drop-overlay-bg": "rgba(97, 175, 239, 0.1)",
  "file-chip-bg": "#3e4452",
  "file-remove-bg": "#495162",
  "info-700": "#82c0ff",
  "model-trigger-hover": "#2c313a",
  "msg-link": "#82c0ff",
  "msg-scrollbar-hover": "#495162",
  "muted": "220 14% 20%",
  "muted-foreground": "220 6% 53%",
  "perm-allow-btn-bg": "#61afef",
  "perm-allow-btn-text": "#282c34",
  "perm-allow-kbd-bg": "#2c313a",
  "perm-allow-kbd-border": "#3e4452",
  "perm-code-bg": "#282c34",
  "perm-item-selected-bg": "#2c313a",
  "plan-outline-active-bg": "#2c313a",
  "plan-toolbar-btn-hover-bg": "#2c313a",
  "popover": "220 13% 15%",
  "primary-foreground": "220 13% 18%",
  "search-match-fg": "219 14% 71%",
  "secondary": "220 13% 15%",
  "settings-btn-primary-text": "#282c34",
  "settings-btn-secondary-hover-bg": "#2c313a",
  "text-placeholder": "#495162",
  "settings-integration-avatar-bg": "#2c313a",
  "settings-logout-bg": "#2c313a",
  "settings-menu-bg-hover": "#2c313a",
  "settings-menu-bg-selected": "#2c313a",
  "settings-source-link": "#82c0ff",
  "settings-theme-auto-dark": "#282c34",
  "sidebar-action-icon": "220 9% 40%",
  "sidebar-item-active": "220 14% 20%",
  "splash-bg": "220 13% 18%",
  "splash-text": "220 6% 53%",
  "splash-text-destructive": "219 14% 71%",
  "splash-text-muted": "220 9% 40%",
  "titlebar-icon": "220 6% 53%",
  "tooltip-bg": "#282c34",
  "tooltip-text": "#abb2bf",
  "update-btn-border": "#61afef",
  "update-btn-text": "#61afef",
} as const;
// END GENERATED DS-8: theme



export const oneDarkPro: Theme = {
  id: 'one-dark-pro',
  name: 'One Dark Pro',
  type: 'dark',
  colors: GENERATED_OVERRIDES,
};
