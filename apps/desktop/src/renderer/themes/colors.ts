import { registerColor } from './color-registry';
// BEGIN GENERATED DS-8: defaults
const GENERATED_DEFAULTS = {
  "surface": {
    "light": "#f8f8f6",
    "dark": "#1f1f1e"
  },
  "surface-hsl": {
    "light": "60 12.5% 97%",
    "dark": "60 2% 12%"
  },
  "surface-elevated": {
    "light": "#ffffff",
    "dark": "#2c2c2a"
  },
  "surface-elevated-soft": {
    "light": "#e5e5e5",
    "dark": "#2c2c2a"
  },
  "surface-card-ivory": {
    "light": "#faf9f5",
    "dark": "#2c2c2a"
  },
  "surface-chip": {
    "light": "#e5e5e5",
    "dark": "#3c3c3a"
  },
  "surface-chip-alt": {
    "light": "#e5e5e5",
    "dark": "#2c2c2a"
  },
  "surface-hover": {
    "light": "#e5e5e5",
    "dark": "#3c3c3a"
  },
  "surface-hover-soft": {
    "light": "#f8f8f6",
    "dark": "#3c3c3a"
  },
  "surface-hover-hsl": {
    "light": "0 0% 90%",
    "dark": "60 2% 17%"
  },
  "surface-on-card": {
    "light": "#ffffff",
    "dark": "#1f1f1e"
  },
  "panel-bg": {
    "light": "var(--surface)",
    "dark": "var(--surface)"
  },
  "md-table-bg": {
    "light": "rgba(236, 236, 234, 0.55)",
    "dark": "rgba(44, 44, 42, 0.55)"
  },
  "border-default": {
    "light": "#d7d7d4",
    "dark": "#3c3c3a"
  },
  "border-default-hsl": {
    "light": "60 3% 84%",
    "dark": "60 2% 23%"
  },
  "border-shadcn-hsl": {
    "light": "0 0% 90%",
    "dark": "30 4% 28%"
  },
  "border-transparent-mixed": {
    "light": "transparent",
    "dark": "#3c3c3a"
  },
  "board": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "text-primary": {
    "light": "#262626",
    "dark": "#d4d4d4"
  },
  "text-primary-on-dark": {
    "light": "#262626",
    "dark": "#ffffff"
  },
  "text-primary-emphasis": {
    "light": "#1a1a1a",
    "dark": "#d4d4d4"
  },
  "text-primary-inv": {
    "light": "#1a1a1a",
    "dark": "#ffffff"
  },
  "text-primary-body-strong": {
    "light": "#525252",
    "dark": "#d4d4d4"
  },
  "text-primary-hsl": {
    "light": "0 0% 9%",
    "dark": "0 0% 83%"
  },
  "text-secondary": {
    "light": "#737373",
    "dark": "#a3a3a3"
  },
  "text-secondary-cross": {
    "light": "#a3a3a3",
    "dark": "#a3a3a3"
  },
  "text-secondary-mid": {
    "light": "#525252",
    "dark": "#a3a3a3"
  },
  "text-tertiary": {
    "light": "#a3a3a3",
    "dark": "#737373"
  },
  "text-tertiary-stone": {
    "light": "#737373",
    "dark": "#737373"
  },
  "text-tertiary-mid": {
    "light": "#525252",
    "dark": "#737373"
  },
  "text-tertiary-hsl": {
    "light": "0 0% 45%",
    "dark": "0 0% 45%"
  },
  "text-disabled": {
    "light": "#d4d4d4",
    "dark": "#525252"
  },
  "text-disabled-tertiary": {
    "light": "#a3a3a3",
    "dark": "#737373"
  },
  "text-placeholder": {
    "light": "#c4c4c4",
    "dark": "#525252"
  },
  "accent-cta-bg": {
    "light": "#262626",
    "dark": "#ffffff"
  },
  "accent-cta-bg-pure": {
    "light": "#000000",
    "dark": "#ffffff"
  },
  "accent-emphasis": {
    "light": "#262626",
    "dark": "#d4d4d4"
  },
  "accent-soft": {
    "light": "#262626",
    "dark": "#ffffff"
  },
  "accent-hover": {
    "light": "#262626",
    "dark": "#e5e5e5"
  },
  "accent-pure-cta-fg": {
    "light": "#ffffff",
    "dark": "#000000"
  },
  "error-flat": {
    "light": "#ef4444",
    "dark": "#ef4444"
  },
  "warning-accent": {
    "light": "#EA6B17",
    "dark": "#EA6B17"
  },
  "process-agent-task-icon": {
    "light": "#2563EB",
    "dark": "#60A5FA"
  },
  "process-agent-service-icon": {
    "light": "#7C3AED",
    "dark": "#A78BFA"
  },
  "process-main-icon": {
    "light": "#DB2777",
    "dark": "#F472B6"
  },
  "process-renderer-icon": {
    "light": "#0891B2",
    "dark": "#22D3EE"
  },
  "process-gpu-icon": {
    "light": "#D97706",
    "dark": "#F59E0B"
  },
  "process-utility-icon": {
    "light": "#059669",
    "dark": "#34D399"
  },
  "usage-heatmap-high": {
    "light": "var(--process-agent-task-icon)",
    "dark": "var(--process-agent-task-icon)"
  },
  "usage-model-1": {
    "light": "#14B8A6",
    "dark": "#2DD4BF"
  },
  "usage-model-2": {
    "light": "#F43F5E",
    "dark": "#FB7185"
  },
  "usage-model-3": {
    "light": "#8B5CF6",
    "dark": "#A78BFA"
  },
  "usage-model-4": {
    "light": "#6366F1",
    "dark": "#818CF8"
  },
  "usage-model-5": {
    "light": "#F59E0B",
    "dark": "#FBBF24"
  },
  "background": {
    "light": "0 0% 100%",
    "dark": "60 3% 14%"
  },
  "foreground": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "muted": {
    "light": "0 0% 96%",
    "dark": "30 6% 20%"
  },
  "muted-foreground": {
    "light": "0 0% 45%",
    "dark": "24 5% 64%"
  },
  "border": {
    "light": "var(--border-shadcn-hsl)",
    "dark": "var(--border-shadcn-hsl)"
  },
  "input": {
    "light": "var(--border-shadcn-hsl)",
    "dark": "var(--border-shadcn-hsl)"
  },
  "switch-track-off": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "switch-thumb-off": {
    "light": "var(--surface-on-card)",
    "dark": "var(--surface-on-card)"
  },
  "switch-disabled-opacity": {
    "light": "0.3",
    "dark": "0.3"
  },
  "switch-disabled-thumb-opacity": {
    "light": "0.5",
    "dark": "0.5"
  },
  "switch-track-on": {
    "light": "hsl(var(--primary))",
    "dark": "hsl(var(--primary))"
  },
  "ring": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "primary": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "primary-foreground": {
    "light": "0 0% 98%",
    "dark": "60 3% 14%"
  },
  "secondary": {
    "light": "0 0% 96%",
    "dark": "30 6% 20%"
  },
  "secondary-foreground": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "accent": {
    "light": "0 0% 96%",
    "dark": "30 6% 20%"
  },
  "accent-foreground": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "popover": {
    "light": "0 0% 100%",
    "dark": "60 3% 15%"
  },
  "popover-foreground": {
    "light": "var(--text-primary-hsl)",
    "dark": "var(--text-primary-hsl)"
  },
  "radius": {
    "light": "0.5rem",
    "dark": null
  },
  "titlebar": {
    "light": "var(--surface-hsl)",
    "dark": "var(--surface-hsl)"
  },
  "titlebar-border": {
    "light": "var(--border-default-hsl)",
    "dark": "var(--border-default-hsl)"
  },
  "titlebar-icon": {
    "light": "0 0% 45%",
    "dark": "0 0% 63.92%"
  },
  "titlebar-button-hover": {
    "light": "var(--surface-hover-hsl)",
    "dark": "var(--surface-hover-hsl)"
  },
  "titlebar-control-hover": {
    "light": "var(--surface-hover-hsl)",
    "dark": "var(--surface-hover-hsl)"
  },
  "splash-bg": {
    "light": "60 12.45% 96.86%",
    "dark": "60 1.64% 11.96%"
  },
  "splash-text": {
    "light": "0 0% 45.1%",
    "dark": "0 0% 63.92%"
  },
  "splash-text-muted": {
    "light": "30 3.6% 62.55%",
    "dark": "30 2.78% 43.73%"
  },
  "splash-text-destructive": {
    "light": "0 0% 14.9%",
    "dark": "0 0% 100%"
  },
  "splash-fade-duration": {
    "light": "400ms",
    "dark": null
  },
  "splash-fade-easing": {
    "light": "cubic-bezier(0.4, 0, 1, 1)",
    "dark": null
  },
  "destructive": {
    "light": "0 84% 60%",
    "dark": "0 72% 63%"
  },
  "confirm-bg": {
    "light": "#fafafa",
    "dark": "#2c2c2a"
  },
  "confirm-title": {
    "light": "#171717",
    "dark": "#fafafa"
  },
  "confirm-desc": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "confirm-btn-primary-bg": {
    "light": "#171717",
    "dark": "#fafafa"
  },
  "confirm-btn-primary-text": {
    "light": "#fafafa",
    "dark": "#171717"
  },
  "confirm-btn-primary-hover": {
    "light": "var(--accent-hover)",
    "dark": "var(--accent-hover)"
  },
  "confirm-btn-secondary-text": {
    "light": "#262626",
    "dark": "#fafafa"
  },
  "confirm-btn-secondary-border": {
    "light": "#d4d4d4",
    "dark": "#3c3c3a"
  },
  "confirm-btn-secondary-hover": {
    "light": "rgba(0, 0, 0, 0.04)",
    "dark": "rgba(255, 255, 255, 0.06)"
  },
  "sidebar": {
    "light": "var(--surface-hsl)",
    "dark": "var(--surface-hsl)"
  },
  "sidebar-border": {
    "light": "var(--border-default-hsl)",
    "dark": "var(--border-default-hsl)"
  },
  "sidebar-item-hover": {
    "light": "var(--surface-hover-hsl)",
    "dark": "var(--surface-hover-hsl)"
  },
  "sidebar-item-active": {
    "light": "0 0% 90%",
    "dark": "60 2% 17%"
  },
  "sidebar-item-active-foreground": {
    "light": "var(--foreground)",
    "dark": "var(--foreground)"
  },
  "sidebar-item-active-border": {
    "light": "var(--sidebar-item-active)",
    "dark": "var(--sidebar-item-active)"
  },
  "sidebar-search-bg": {
    "light": "var(--surface-hsl)",
    "dark": "var(--surface-hsl)"
  },
  "sidebar-muted": {
    "light": "var(--text-tertiary-hsl)",
    "dark": "var(--text-tertiary-hsl)"
  },
  "sidebar-action-icon": {
    "light": "0 0% 64%",
    "dark": "0 0% 45%"
  },
  "search-match-bg": {
    "light": "53 100% 89%",
    "dark": "40 33% 16%"
  },
  "search-match-fg": {
    "light": "0 0% 15%",
    "dark": "0 0% 90%"
  },
  "update-btn-border": {
    "light": "#d4d4d4",
    "dark": "#3c3c3a"
  },
  "update-btn-text": {
    "light": "#404040",
    "dark": "#ffffff"
  },
  "update-btn-hover": {
    "light": "rgba(0, 0, 0, 0.04)",
    "dark": "rgba(255, 255, 255, 0.06)"
  },
  "update-btn-bg": {
    "light": "transparent",
    "dark": "transparent"
  },
  "content-area": {
    "light": "var(--surface-hsl)",
    "dark": "var(--surface-hsl)"
  },
  "welcome-text": {
    "light": "var(--text-tertiary-hsl)",
    "dark": "var(--text-tertiary-hsl)"
  },
  "login-bg-base": {
    "light": "#EDEDED",
    "dark": "#1F1F1E"
  },
  "login-panel-border": {
    "light": "#D4D4D4",
    "dark": "#434343"
  },
  "login-link-pressed": {
    "light": "#1A1818",
    "dark": "#C0BEBE"
  },
  "login-callback-card-bg": {
    "light": "#FBFBFB",
    "dark": "#312F2F"
  },
  "login-callback-card-border": {
    "light": "#D4D4D4",
    "dark": "#434343"
  },
  "login-callback-title": {
    "light": "#252222",
    "dark": "#D4D4D4"
  },
  "login-callback-body": {
    "light": "#6F6F6F",
    "dark": "#6F6F6F"
  },
  "login-callback-cta-bg": {
    "light": "#2A2828",
    "dark": "#EEEEEE"
  },
  "login-callback-cta-border": {
    "light": "#434343",
    "dark": "#FFFFFF"
  },
  "login-callback-cta-text": {
    "light": "#D4D4D4",
    "dark": "#2A2828"
  },
  "login-panel-bg": {
    "light": "#FBFBFB",
    "dark": "#312F2F"
  },
  "login-control-bg": {
    "light": "#EEEEEE",
    "dark": "#2C2A2A"
  },
  "login-action-control-bg": {
    "light": "#EEEEEE",
    "dark": "#2A2828"
  },
  "login-back-border": {
    "light": "#FFFFFF",
    "dark": "#434343"
  },
  "login-control-border": {
    "light": "#D4D4D4",
    "dark": "#434343"
  },
  "login-control-border-active": {
    "light": "#2A2828",
    "dark": "#EEEEEE"
  },
  "login-control-border-disabled": {
    "light": "#B4B4B4",
    "dark": "#B4B4B4"
  },
  "login-control-text": {
    "light": "#252222",
    "dark": "#EEEEEE"
  },
  "login-control-placeholder": {
    "light": "#D4D4D4",
    "dark": "#6F6F6F"
  },
  "login-title-text": {
    "light": "#252222",
    "dark": "#D4D4D4"
  },
  "login-secondary-text": {
    "light": "#6F6F6F",
    "dark": "#6F6F6F"
  },
  "login-primary-button-bg": {
    "light": "#2A2828",
    "dark": "#EEEEEE"
  },
  "login-primary-button-border": {
    "light": "#434343",
    "dark": "#FFFFFF"
  },
  "login-primary-button-text": {
    "light": "#D4D4D4",
    "dark": "#2A2828"
  },
  "login-disabled-button-overlay": {
    "light": "rgba(255, 255, 255, 0.7)",
    "dark": "rgba(255, 255, 255, 0.7)"
  },
  "login-disabled-button-bg": {
    "light": "#2A2828",
    "dark": "#2A2828"
  },
  "login-disabled-button-text": {
    "light": "#D4D4D4",
    "dark": "#D4D4D4"
  },
  "login-inverted-button-border": {
    "light": "#FFFFFF",
    "dark": "#FFFFFF"
  },
  "login-link-text": {
    "light": "#2A2828",
    "dark": "#EEEEEE"
  },
  "login-link-hover": {
    "light": "#4A4848",
    "dark": "#A8A8A8"
  },
  "login-error-fg": {
    "light": "#D91F37",
    "dark": "#D91F37"
  },
  "login-deletion-bubble-bg": {
    "light": "#FFFFFF",
    "dark": "#1F1F1E"
  },
  "login-deletion-bubble-border": {
    "light": "#D7D7D4",
    "dark": "#3C3C3A"
  },
  "login-splash-progress-track": {
    "light": "#D9D9D9",
    "dark": "#434343"
  },
  "login-splash-progress-fill": {
    "light": "#252222",
    "dark": "#D4D4D4"
  },
  "login-overlay-button-hover": {
    "light": "rgba(255, 255, 255, 0.08)",
    "dark": "rgba(0, 0, 0, 0.05)"
  },
  "login-overlay-button-pressed": {
    "light": "rgba(0, 0, 0, 0.5)",
    "dark": "rgba(0, 0, 0, 0.1)"
  },
  "login-overlay-back-hover": {
    "light": "rgba(255, 255, 255, 0.7)",
    "dark": "rgba(255, 255, 255, 0.08)"
  },
  "login-overlay-back-pressed": {
    "light": "rgba(0, 0, 0, 0.08)",
    "dark": "rgba(0, 0, 0, 0.08)"
  },
  "login-overlay-row-hover": {
    "light": "rgba(255, 255, 255, 0.08)",
    "dark": "rgba(255, 255, 255, 0.08)"
  },
  "login-overlay-row-pressed": {
    "light": "rgba(0, 0, 0, 0.08)",
    "dark": "rgba(0, 0, 0, 0.08)"
  },
  "login-overlay-input-hover": {
    "light": "rgba(0, 0, 0, 0.05)",
    "dark": "rgba(255, 255, 255, 0.05)"
  },
  "login-loading-ring-track": {
    "light": "rgba(42, 40, 40, 0.18)",
    "dark": "rgba(212, 212, 212, 0.18)"
  },
  "login-consent-radio-bg": {
    "light": "#F1F0F1",
    "dark": "#2A2828"
  },
  "login-consent-radio-border": {
    "light": "#434343",
    "dark": "#F1F0F1"
  },
  "login-consent-radio-checked-bg": {
    "light": "#2A2828",
    "dark": "#F1F0F1"
  },
  "login-consent-radio-check": {
    "light": "#FFFFFF",
    "dark": "#2A2828"
  },
  "login-consent-overlay": {
    "light": "rgba(0, 0, 0, 0.85)",
    "dark": "rgba(0, 0, 0, 0.85)"
  },
  "login-secondary-button-bg": {
    "light": "#EEEEEE",
    "dark": "#434141"
  },
  "login-secondary-button-border": {
    "light": "#FFFFFF",
    "dark": "#565454"
  },
  "login-secondary-button-text": {
    "light": "#2A2828",
    "dark": "#EEEEEE"
  },
  "login-overlay-secondary-hover": {
    "light": "rgba(255, 255, 255, 0.1)",
    "dark": "rgba(255, 255, 255, 0.08)"
  },
  "login-overlay-secondary-pressed": {
    "light": "rgba(0, 0, 0, 0.1)",
    "dark": "rgba(0, 0, 0, 0.2)"
  },
  "login-apple-circle-bg": {
    "light": "#000000",
    "dark": "#FFFFFF"
  },
  "lightbox-cta-bg": {
    "light": "var(--accent-cta-bg-pure)",
    "dark": "var(--accent-cta-bg-pure)"
  },
  "lightbox-cta-fg": {
    "light": "var(--accent-pure-cta-fg)",
    "dark": "var(--accent-pure-cta-fg)"
  },
  "lightbox-cta-hover": {
    "light": "var(--accent-hover)",
    "dark": "var(--accent-hover)"
  },
  "chat-input-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "chat-input-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "chat-input-border-focus": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "chat-input-text": {
    "light": "#000000",
    "dark": "#d4d4d4"
  },
  "chat-input-placeholder": {
    "light": "var(--text-placeholder)",
    "dark": "var(--text-placeholder)"
  },
  "file-chip-bg": {
    "light": "#a3a3a3",
    "dark": "#525252"
  },
  "drop-overlay-bg": {
    "light": "rgba(163, 163, 163, 0.08)",
    "dark": "rgba(115, 115, 115, 0.1)"
  },
  "drop-overlay-border": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "tooltip-bg": {
    "light": "#262626",
    "dark": "#1f1f1e"
  },
  "tooltip-text": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "file-remove-bg": {
    "light": "#525252",
    "dark": "#737373"
  },
  "file-badge-pdf": {
    "light": "#B23A26",
    "dark": "#B23A26"
  },
  "file-badge-doc": {
    "light": "#2C5CA8",
    "dark": "#2C5CA8"
  },
  "file-badge-sheet": {
    "light": "#2E7D4F",
    "dark": "#2E7D4F"
  },
  "file-badge-slide": {
    "light": "#A25A12",
    "dark": "#A25A12"
  },
  "file-badge-code": {
    "light": "#5B49A8",
    "dark": "#5B49A8"
  },
  "file-badge-fg": {
    "light": "#FFFFFF",
    "dark": "#FFFFFF"
  },
  "bot-avatar-red-bg": {
    "light": "#f7ded9",
    "dark": "#4a2e2a"
  },
  "bot-avatar-orange-bg": {
    "light": "#f9e3d2",
    "dark": "#4a3527"
  },
  "bot-avatar-amber-bg": {
    "light": "#f6ebcd",
    "dark": "#473a22"
  },
  "bot-avatar-green-bg": {
    "light": "#dceedd",
    "dark": "#26402a"
  },
  "bot-avatar-teal-bg": {
    "light": "#d6ebea",
    "dark": "#21403e"
  },
  "bot-avatar-blue-bg": {
    "light": "#dce6f5",
    "dark": "#263449"
  },
  "bot-avatar-violet-bg": {
    "light": "#e3ddf3",
    "dark": "#322b48"
  },
  "bot-avatar-pink-bg": {
    "light": "#f6deea",
    "dark": "#452b39"
  },
  "bot-avatar-graphite-bg": {
    "light": "#e5e5e5",
    "dark": "#3c3c3a"
  },
  "bot-unread-bg": {
    "light": "#417CDD",
    "dark": "#417CDD"
  },
  "bot-unread-fg": {
    "light": "#FFFFFF",
    "dark": "#FFFFFF"
  },
  "chat-input-chip-bg": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "chat-input-chip-border": {
    "light": "#d7d7d4",
    "dark": "#525250"
  },
  "chat-input-chip-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "chat-input-chip-icon": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "cmd-palette-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "cmd-palette-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "cmd-palette-item-hover": {
    "light": "var(--surface-hover)",
    "dark": "var(--surface-hover)"
  },
  "cmd-palette-item-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "cmd-palette-item-meta": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "cmd-palette-item-icon": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "cmd-palette-empty": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "cmd-palette-tooltip-body": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "send-btn-bg": {
    "light": "var(--accent-cta-bg)",
    "dark": "var(--accent-cta-bg)"
  },
  "send-btn-icon": {
    "light": "var(--surface-on-card)",
    "dark": "var(--surface-on-card)"
  },
  "send-btn-disabled-bg": {
    "light": "var(--surface-elevated-soft)",
    "dark": "var(--surface-elevated-soft)"
  },
  "send-btn-disabled-icon": {
    "light": "var(--text-disabled-tertiary)",
    "dark": "var(--text-disabled-tertiary)"
  },
  "send-btn-hover-bg": {
    "light": "var(--send-btn-bg)",
    "dark": "var(--send-btn-bg)"
  },
  "send-btn-pressed-bg": {
    "light": "var(--send-btn-bg)",
    "dark": "var(--send-btn-bg)"
  },
  "perm-code-bg": {
    "light": "#f5f5f5",
    "dark": "#1f1f1e"
  },
  "perm-code-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "perm-allow-btn-bg": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "perm-allow-btn-text": {
    "light": "#262626",
    "dark": "#262626"
  },
  "perm-allow-kbd-bg": {
    "light": "#f5f5f5",
    "dark": "#e5e5e5"
  },
  "perm-allow-kbd-border": {
    "light": "#d7d7d4",
    "dark": "#d7d7d4"
  },
  "model-trigger-hover": {
    "light": "#e5e5e5",
    "dark": "#2c2c2a"
  },
  "model-trigger-text": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "model-trigger-meta": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "model-trigger-arrow": {
    "light": "var(--text-secondary-cross)",
    "dark": "var(--text-secondary-cross)"
  },
  "thinking-body-text": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "model-dropdown-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "model-dropdown-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "model-item-hover": {
    "light": "var(--surface-hover)",
    "dark": "var(--surface-hover)"
  },
  "model-item-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "model-item-check": {
    "light": "var(--accent-cta-bg-pure)",
    "dark": "var(--accent-cta-bg-pure)"
  },
  "model-item-desc": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "model-section-label": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "favorite-star": {
    "light": "#d99a06",
    "dark": "#e8b425"
  },
  "effort-tier-minimal": {
    "light": "#2AAE5B",
    "dark": "#2AAE5B"
  },
  "effort-tier-low": {
    "light": "#2AAE5B",
    "dark": "#2AAE5B"
  },
  "effort-tier-medium": {
    "light": "#14B8A6",
    "dark": "#14B8A6"
  },
  "effort-tier-high": {
    "light": "#3B82F6",
    "dark": "#3B82F6"
  },
  "effort-tier-xhigh": {
    "light": "#4F46E5",
    "dark": "#4F46E5"
  },
  "effort-tier-max": {
    "light": "#8B5CF6",
    "dark": "#8B5CF6"
  },
  "effort-tier-ultra": {
    "light": "#8B5CF6",
    "dark": "#8B5CF6"
  },
  "price-tier-t1": {
    "light": "#2AAE5B",
    "dark": "#2AAE5B"
  },
  "price-tier-t2": {
    "light": "#B58A1F",
    "dark": "#B58A1F"
  },
  "price-tier-t3": {
    "light": "#C05353",
    "dark": "#C05353"
  },
  "fast-accent": {
    "light": "#3B9EFF",
    "dark": "#3B9EFF"
  },
  "engine-badge-cc": {
    "light": "#d97757",
    "dark": "#d97757"
  },
  "engine-badge-codex": {
    "light": "#7a9dff",
    "dark": "#7a9dff"
  },
  "engine-badge-pi": {
    "light": "#a78bfa",
    "dark": "#a78bfa"
  },
  "perm-item-selected-bg": {
    "light": "#f8f8f6",
    "dark": "#3c3c3a"
  },
  "perm-auto-selected-text": {
    "light": "#417CDD",
    "dark": "#417CDD"
  },
  "perm-bypass-selected-text": {
    "light": "var(--warning-accent)",
    "dark": "var(--warning-accent)"
  },
  "folder-picker-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "folder-picker-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "folder-item-hover": {
    "light": "var(--surface-hover)",
    "dark": "var(--surface-hover)"
  },
  "folder-item-name": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "folder-item-path": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "folder-item-icon": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "folder-label": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "folder-btn-bg": {
    "light": "var(--chat-input-bg)",
    "dark": "var(--chat-input-bg)"
  },
  "folder-btn-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "folder-btn-text": {
    "light": "var(--accent-soft)",
    "dark": "var(--accent-soft)"
  },
  "folder-btn-icon": {
    "light": "var(--accent-soft)",
    "dark": "var(--accent-soft)"
  },
  "workingdir-text": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "workingdir-icon": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "fast-toggle-off": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "fast-toggle-track": {
    "light": "var(--text-disabled)",
    "dark": "var(--text-disabled)"
  },
  "chat-placeholder-text": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "msg-user-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "msg-user-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-user-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "msg-assistant-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "msg-tool-text": {
    "light": "var(--text-secondary-mid)",
    "dark": "var(--text-secondary-mid)"
  },
  "msg-code-block-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "msg-code-block-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-code-inline-bg": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "msg-md-inline-code-bg": {
    "light": "rgba(175, 184, 193, 0.2)",
    "dark": "rgba(110, 118, 129, 0.22)"
  },
  "msg-table-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-table-header-bg": {
    "light": "var(--surface)",
    "dark": "var(--surface)"
  },
  "msg-blockquote-border": {
    "light": "var(--agent-actions-rail)",
    "dark": "var(--agent-actions-rail)"
  },
  "msg-blockquote-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "msg-hr-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-scrollbar": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-scrollbar-hover": {
    "light": "#b0b0ae",
    "dark": "#555553"
  },
  "msg-cursor": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "msg-link": {
    "light": "#2563eb",
    "dark": "#60a5fa"
  },
  "msg-tool-card-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "msg-tool-card-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "msg-tool-card-chevron": {
    "light": "var(--text-secondary-mid)",
    "dark": "var(--text-secondary-mid)"
  },
  "msg-tool-card-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "todo-bar-track": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "diff-del-fg": {
    "light": "#b31d28",
    "dark": "#ff7b72"
  },
  "diff-del-bg": {
    "light": "#ffeef0",
    "dark": "#67060c"
  },
  "diff-del-emphasis": {
    "light": "#ffd7d5",
    "dark": "rgba(248, 81, 73, 0.42)"
  },
  "diff-add-fg": {
    "light": "#22863a",
    "dark": "#7ee787"
  },
  "pr-open-on-light": {
    "light": "#2EA043",
    "dark": "#2EA043"
  },
  "pr-open-on-dark": {
    "light": "#3FB950",
    "dark": "#3FB950"
  },
  "diff-add-bg": {
    "light": "#f0fff4",
    "dark": "#033a16"
  },
  "diff-add-emphasis": {
    "light": "#acf2bd",
    "dark": "rgba(46, 160, 67, 0.42)"
  },
  "diff-line-num": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "info-700": {
    "light": "#1D4ED8",
    "dark": "#60a5fa"
  },
  "agent-actions-rail": {
    "light": "#DDD6CB",
    "dark": "#404040"
  },
  "quota-bar-fill": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "quota-bar-warn": {
    "light": "var(--warning-fg)",
    "dark": "var(--warning-fg)"
  },
  "quota-bar-crit": {
    "light": "var(--error-flat)",
    "dark": "var(--error-flat)"
  },
  "quota-bar-track": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "status-bar-accent": {
    "light": "var(--warning-accent)",
    "dark": "var(--warning-accent)"
  },
  "status-badge-fg": {
    "light": "var(--accent-pure-cta-fg)",
    "dark": "var(--accent-pure-cta-fg)"
  },
  "surface-translucent-sidebar": {
    "light": "var(--surface)",
    "dark": "var(--surface)"
  },
  "surface-translucent-main": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "surface-translucent-overlay": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "sidebar-search-input-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "composer-pill-bg": {
    "light": "#FCFCFC",
    "dark": "#393838"
  },
  "composer-pill-icon": {
    "light": "#3C3F43",
    "dark": "#D9D9D9"
  },
  "status-bar-meta": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "settings-bg": {
    "light": "var(--surface)",
    "dark": "var(--surface)"
  },
  "settings-divider": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-back-icon": {
    "light": "var(--text-tertiary-mid)",
    "dark": "var(--text-tertiary-mid)"
  },
  "settings-back-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-back-hover": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-menu-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-menu-text-selected": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-menu-bg-selected": {
    "light": "#e8e8e6",
    "dark": "#2c2c2a"
  },
  "settings-menu-border-selected": {
    "light": "var(--border-transparent-mixed)",
    "dark": "var(--border-transparent-mixed)"
  },
  "settings-menu-bg-hover": {
    "light": "#ececea",
    "dark": "#2c2c2a"
  },
  "settings-section-title": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-section-desc": {
    "light": "var(--text-tertiary-mid)",
    "dark": "var(--text-tertiary-mid)"
  },
  "settings-section-sublabel": {
    "light": "var(--text-tertiary-mid)",
    "dark": "var(--text-tertiary-mid)"
  },
  "settings-profile-card-bg": {
    "light": "var(--surface-card-ivory)",
    "dark": "var(--surface-card-ivory)"
  },
  "settings-profile-card-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-profile-avatar-bg": {
    "light": "var(--surface-chip-alt)",
    "dark": "var(--surface-chip-alt)"
  },
  "settings-profile-avatar-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-profile-name": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-input-bg": {
    "light": "var(--surface-card-ivory)",
    "dark": "var(--surface-card-ivory)"
  },
  "settings-input-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-input-border-focus": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "settings-input-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-input-placeholder": {
    "light": "var(--text-placeholder)",
    "dark": "var(--text-placeholder)"
  },
  "settings-eye-icon": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "settings-eye-icon-hover": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-trash-icon": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "settings-trash-icon-hover": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-source-meta": {
    "light": "var(--text-secondary-cross)",
    "dark": "var(--text-secondary-cross)"
  },
  "settings-source-link": {
    "light": "#262626",
    "dark": "#d4d4d4"
  },
  "settings-error-text": {
    "light": "var(--error-flat)",
    "dark": "var(--error-flat)"
  },
  "settings-badge-bg": {
    "light": "var(--surface-card-ivory)",
    "dark": "var(--surface-card-ivory)"
  },
  "settings-badge-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-badge-needs-config": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "settings-badge-saved": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "settings-badge-connected": {
    "light": "var(--card-status-done)",
    "dark": "var(--card-status-done)"
  },
  "settings-badge-connected-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-badge-error": {
    "light": "var(--error-flat)",
    "dark": "var(--error-flat)"
  },
  "settings-btn-primary-bg": {
    "light": "var(--accent-emphasis)",
    "dark": "var(--accent-emphasis)"
  },
  "settings-btn-primary-text": {
    "light": "#faf9f5",
    "dark": "#262626"
  },
  "settings-btn-primary-border": {
    "light": "var(--accent-emphasis)",
    "dark": "var(--accent-emphasis)"
  },
  "settings-btn-primary-hover-bg": {
    "light": "var(--accent-hover)",
    "dark": "var(--accent-hover)"
  },
  "settings-btn-secondary-bg": {
    "light": "var(--surface-chip-alt)",
    "dark": "var(--surface-chip-alt)"
  },
  "settings-btn-secondary-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-btn-secondary-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-btn-secondary-hover-bg": {
    "light": "#d7d7d4",
    "dark": "#3c3c3a"
  },
  "settings-theme-card-bg": {
    "light": "var(--surface-card-ivory)",
    "dark": "var(--surface-card-ivory)"
  },
  "settings-theme-card-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-theme-preview-bg": {
    "light": "var(--surface)",
    "dark": "var(--surface)"
  },
  "settings-theme-preview-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-theme-preview-border-active": {
    "light": "var(--accent-emphasis)",
    "dark": "var(--accent-emphasis)"
  },
  "settings-theme-icon": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "settings-theme-icon-active": {
    "light": "var(--accent-emphasis)",
    "dark": "var(--accent-emphasis)"
  },
  "settings-theme-label": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "settings-theme-label-active": {
    "light": "var(--accent-emphasis)",
    "dark": "var(--accent-emphasis)"
  },
  "settings-theme-auto-light": {
    "light": "#f8f8f6",
    "dark": "#f8f8f6"
  },
  "settings-theme-auto-dark": {
    "light": "#1f1f1e",
    "dark": "#1f1f1e"
  },
  "settings-logout-bg": {
    "light": "#faf9f5",
    "dark": "#2c2c2a"
  },
  "settings-logout-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "settings-logout-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-logout-icon": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-logout-hover-bg": {
    "light": "var(--surface-hover-soft)",
    "dark": "var(--surface-hover-soft)"
  },
  "settings-integration-avatar-bg": {
    "light": "#faf9f5",
    "dark": "#3c3c3a"
  },
  "settings-integration-avatar-border": {
    "light": "#e8e8e6",
    "dark": "rgba(255, 255, 255, 0.08)"
  },
  "settings-integration-avatar-icon": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "settings-integration-subtitle": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "settings-integration-warning": {
    "light": "var(--warning-accent)",
    "dark": "var(--warning-accent)"
  },
  "remote-status-ready": {
    "light": "#2AAE5B",
    "dark": "#2AAE5B"
  },
  "remote-status-progress": {
    "light": "#f59e0b",
    "dark": "#f59e0b"
  },
  "remote-status-failed": {
    "light": "#D91F37",
    "dark": "#D91F37"
  },
  "card-status-awaiting": {
    "light": "#19D2C1",
    "dark": "#19D2C1"
  },
  "sidebar-draft-indicator": {
    "light": "#0B726B",
    "dark": "var(--card-status-awaiting)"
  },
  "card-status-error": {
    "light": "#D91F37",
    "dark": "#D91F37"
  },
  "card-status-done": {
    "light": "#2AAE5B",
    "dark": "#2AAE5B"
  },
  "completion-badge-fg": {
    "light": "#1f1f1e",
    "dark": "#1f1f1e"
  },
  "remote-status-disconnected": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "ask-card-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "ask-card-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "ask-header-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "ask-page-text": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "ask-option-label": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "ask-option-desc": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "ask-option-custom": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "ask-option-divider": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "ask-option-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "ask-badge-bg": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "ask-badge-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "ask-header-chip-bg": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "ask-option-list-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "ask-input-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "ask-input-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "ask-input-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "ask-input-placeholder": {
    "light": "var(--text-placeholder)",
    "dark": "var(--text-placeholder)"
  },
  "ask-send-bg": {
    "light": "var(--accent-cta-bg)",
    "dark": "var(--accent-cta-bg)"
  },
  "ask-send-text": {
    "light": "var(--surface-on-card)",
    "dark": "var(--surface-on-card)"
  },
  "ask-send-disabled-bg": {
    "light": "var(--surface-elevated-soft)",
    "dark": "var(--surface-elevated-soft)"
  },
  "ask-send-disabled-text": {
    "light": "var(--text-disabled-tertiary)",
    "dark": "var(--text-disabled-tertiary)"
  },
  "ask-answered-text": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "ask-expired-text": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "ask-option-hover": {
    "light": "var(--surface-hover-soft)",
    "dark": "var(--surface-hover-soft)"
  },
  "ask-checkbox-border": {
    "light": "#525250",
    "dark": "#525250"
  },
  "ask-checkbox-checked-bg": {
    "light": "var(--accent-cta-bg)",
    "dark": "var(--accent-cta-bg)"
  },
  "ask-checkbox-checked-icon": {
    "light": "var(--surface-on-card)",
    "dark": "var(--surface-on-card)"
  },
  "plan-card-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "plan-card-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "plan-header-title": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-header-hint": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "plan-header-divider": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "plan-toolbar-btn-icon": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "plan-toolbar-btn-hover-bg": {
    "light": "#e8e8e5",
    "dark": "#3c3c3a"
  },
  "plan-outline-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "plan-outline-border": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "plan-outline-label": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "plan-outline-item-text": {
    "light": "var(--text-tertiary-stone)",
    "dark": "var(--text-tertiary-stone)"
  },
  "plan-outline-active-bg": {
    "light": "#e8e8e5",
    "dark": "#3c3c3a"
  },
  "plan-outline-active-text": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-content-bg": {
    "light": "var(--surface-elevated)",
    "dark": "var(--surface-elevated)"
  },
  "plan-content-section": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-content-body": {
    "light": "var(--text-primary-body-strong)",
    "dark": "var(--text-primary-body-strong)"
  },
  "plan-content-divider": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "plan-edit-body": {
    "light": "var(--text-primary-body-strong)",
    "dark": "var(--text-primary-body-strong)"
  },
  "plan-action-approve-text": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-action-approve-enter": {
    "light": "var(--text-secondary-cross)",
    "dark": "var(--text-secondary-cross)"
  },
  "plan-action-row-divider": {
    "light": "var(--border-default)",
    "dark": "var(--border-default)"
  },
  "plan-action-fb-icon": {
    "light": "var(--text-secondary-cross)",
    "dark": "var(--text-secondary-cross)"
  },
  "plan-action-fb-placeholder": {
    "light": "var(--text-placeholder)",
    "dark": "var(--text-placeholder)"
  },
  "plan-action-fb-text": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-action-row-hover-bg": {
    "light": "var(--surface-hover-soft)",
    "dark": "var(--surface-hover-soft)"
  },
  "plan-action-approve-icon-bg": {
    "light": "var(--warning-accent)",
    "dark": "var(--warning-accent)"
  },
  "plan-action-approve-icon-fg": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "plan-min-title": {
    "light": "var(--text-primary-emphasis)",
    "dark": "var(--text-primary-emphasis)"
  },
  "plan-min-icon": {
    "light": "var(--text-secondary-cross)",
    "dark": "var(--text-secondary-cross)"
  },
  "plan-bubble-badge-bg": {
    "light": "var(--surface-chip)",
    "dark": "var(--surface-chip)"
  },
  "plan-bubble-badge-text": {
    "light": "var(--text-primary)",
    "dark": "var(--text-primary)"
  },
  "plan-bubble-body-text": {
    "light": "var(--text-primary-body-strong)",
    "dark": "var(--text-primary-body-strong)"
  },
  "plan-bubble-summary-text": {
    "light": "var(--text-secondary)",
    "dark": "var(--text-secondary)"
  },
  "color-primary": {
    "light": "#171717",
    "dark": "#d4d4d4"
  },
  "color-neutral-300": {
    "light": "var(--text-disabled)",
    "dark": "var(--text-disabled)"
  },
  "color-neutral-400": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "color-error-600": {
    "light": "var(--error-flat)",
    "dark": "var(--error-flat)"
  },
  "color-error-700": {
    "light": "#dc2626",
    "dark": "#dc2626"
  },
  "focus-ring": {
    "light": "#417CDD",
    "dark": "#417CDD"
  },
  "focus-ring-soft": {
    "light": "rgba(65, 124, 221, 0.5)",
    "dark": "rgba(65, 124, 221, 0.5)"
  },
  "text-selection-bg": {
    "light": "var(--focus-ring-soft)",
    "dark": "var(--focus-ring-soft)"
  },
  "overlay-modal": {
    "light": "rgba(0, 0, 0, 0.5)",
    "dark": "rgba(0, 0, 0, 0.7)"
  },
  "overlay-lightbox": {
    "light": "rgba(0, 0, 0, 0.85)",
    "dark": "rgba(0, 0, 0, 0.85)"
  },
  "lightbox-toolbar-bg": {
    "light": "rgba(0, 0, 0, 0.6)",
    "dark": "rgba(0, 0, 0, 0.6)"
  },
  "lightbox-toolbar-border": {
    "light": "rgba(255, 255, 255, 0.2)",
    "dark": "rgba(255, 255, 255, 0.2)"
  },
  "lightbox-toolbar-fg": {
    "light": "rgba(255, 255, 255, 0.8)",
    "dark": "rgba(255, 255, 255, 0.8)"
  },
  "lightbox-toolbar-fg-hover": {
    "light": "#ffffff",
    "dark": "#ffffff"
  },
  "lightbox-toolbar-hover-bg": {
    "light": "rgba(255, 255, 255, 0.1)",
    "dark": "rgba(255, 255, 255, 0.1)"
  },
  "error-bg": {
    "light": "#fef2f2",
    "dark": "#3a2222"
  },
  "error-border": {
    "light": "rgba(220, 38, 38, 0.4)",
    "dark": "#7f1d1d"
  },
  "error-fg": {
    "light": "#dc2626",
    "dark": "#f87171"
  },
  "error-fg-strong": {
    "light": "#991b1b",
    "dark": "#fca5a5"
  },
  "warning-bg-soft": {
    "light": "rgba(234, 107, 23, 0.12)",
    "dark": "rgba(234, 107, 23, 0.18)"
  },
  "warning-fg": {
    "light": "#F3A115",
    "dark": "#F3A115"
  },
  "text-danger": {
    "light": "var(--error-fg)",
    "dark": "var(--error-fg)"
  },
  "danger-bg-soft": {
    "light": "var(--error-bg)",
    "dark": "var(--error-bg)"
  },
  "status-info": {
    "light": "var(--info-700)",
    "dark": "var(--info-700)"
  },
  "status-success": {
    "light": "#177C3C",
    "dark": "#2AAE5B"
  },
  "upgrade-banner-bg": {
    "light": "rgba(255, 102, 0, 0.10)",
    "dark": "rgba(255, 102, 0, 0.16)"
  },
  "upgrade-banner-border": {
    "light": "rgba(245, 158, 11, 0.45)",
    "dark": "rgba(245, 158, 11, 0.55)"
  },
  "upgrade-banner-fg": {
    "light": "#92400e",
    "dark": "#FBBF24"
  },
  "skillhub-review-pending-bg": {
    "light": "#fff7ed",
    "dark": "rgba(251, 146, 60, 0.14)"
  },
  "skillhub-review-pending-border": {
    "light": "#fed7aa",
    "dark": "rgba(251, 146, 60, 0.35)"
  },
  "skillhub-review-pending-fg": {
    "light": "#ea580c",
    "dark": "#fb923c"
  },
  "skillhub-review-quarantine-bg": {
    "light": "#fefce8",
    "dark": "rgba(250, 204, 21, 0.12)"
  },
  "skillhub-review-quarantine-border": {
    "light": "#fef08a",
    "dark": "rgba(250, 204, 21, 0.35)"
  },
  "skillhub-review-quarantine-fg": {
    "light": "#a16207",
    "dark": "#facc15"
  },
  "create-agent-control-bg": {
    "light": "#FCFCFC",
    "dark": "#393838"
  },
  "create-agent-control-bg-hover": {
    "light": "var(--surface-hover)",
    "dark": "#444242"
  },
  "create-agent-control-bg-pressed": {
    "light": "var(--surface-hover-soft)",
    "dark": "#504F4F"
  },
  "create-agent-control-border": {
    "light": "#DCDFE3",
    "dark": "#434343"
  },
  "create-agent-control-text": {
    "light": "#3C3F43",
    "dark": "#D4D4D4"
  },
  "create-agent-control-icon": {
    "light": "#3C3F43",
    "dark": "#D9D9D9"
  },
  "create-agent-segment-track-bg": {
    "light": "#EDEDED",
    "dark": "#2A2828"
  },
  "create-agent-segment-inactive-text": {
    "light": "#9A9DA3",
    "dark": "#6F6F6F"
  },
  "create-agent-send-bg": {
    "light": "#3C3F43",
    "dark": "#EEEEEE"
  },
  "create-agent-send-icon": {
    "light": "#FCFCFC",
    "dark": "#252222"
  },
  "create-agent-send-bg-hover": {
    "light": "#2E3237",
    "dark": "#E2E2E2"
  },
  "create-agent-send-bg-pressed": {
    "light": "#25282C",
    "dark": "#D4D4D4"
  },
  "create-agent-send-disabled-bg": {
    "light": "#EDEDED",
    "dark": "#444242"
  },
  "create-agent-send-disabled-icon": {
    "light": "#9A9DA3",
    "dark": "#585555"
  },
  "create-agent-focus-ring": {
    "light": "var(--text-tertiary)",
    "dark": "var(--text-tertiary)"
  },
  "create-agent-quick-card-bg": {
    "light": "#F8F8F8",
    "dark": "#312F2F"
  },
  "create-agent-quick-card-border": {
    "light": "#DCDFE3",
    "dark": "#434343"
  },
  "create-agent-quick-card-text": {
    "light": "#3C3F43",
    "dark": "#D4D4D4"
  },
  "create-agent-quick-card-icon-bg": {
    "light": "#EDEDED",
    "dark": "#2A2828"
  },
  "create-agent-quick-card-icon": {
    "light": "#3C3F43",
    "dark": "#D4D4D4"
  },
  "create-agent-quick-card-bg-hover": {
    "light": "#FCFCFC",
    "dark": "#3B3A3A"
  },
  "create-agent-avatar-ring": {
    "light": "rgba(255, 255, 255, 0.08)",
    "dark": "rgba(255, 255, 255, 0.08)"
  },
  "create-agent-avatar-glass-bg": {
    "light": "rgba(0, 0, 0, 0.004)",
    "dark": "rgba(0, 0, 0, 0.004)"
  },
  "create-agent-avatar-inner-ring-start": {
    "light": "rgba(255, 255, 255, 0.29)",
    "dark": "rgba(255, 255, 255, 0.29)"
  },
  "create-agent-avatar-inner-ring-end": {
    "light": "rgba(255, 255, 255, 0.24)",
    "dark": "rgba(255, 255, 255, 0.24)"
  },
  "sidebar-nav-text": {
    "light": "#3C3F43",
    "dark": "#D4D4D4"
  },
  "sidebar-list-muted": {
    "light": "#9A9DA3",
    "dark": "#6F6F6F"
  },
  "sidebar-user-card-bg": {
    "light": "rgba(255, 255, 255, 0.20)",
    "dark": "rgba(255, 255, 255, 0.05)"
  },
  "sidebar-user-card-bg-hover": {
    "light": "rgba(60, 63, 67, 0.06)",
    "dark": "rgba(255, 255, 255, 0.10)"
  },
  "sidebar-user-card-border": {
    "light": "rgba(60, 63, 67, 0.10)",
    "dark": "rgba(255, 255, 255, 0.13)"
  },
  "sidebar-user-card-text": {
    "light": "#3C3F43",
    "dark": "#D4D4D4"
  },
  "caret-accent": {
    "light": "var(--accent-cta-bg)",
    "dark": "var(--accent-cta-bg)"
  },
  "button-cta-hover": {
    "light": "var(--accent-hover)",
    "dark": "var(--accent-hover)"
  },
  "shadow-soft-panel": {
    "light": "0 4px 12px rgb(0 0 0 / 0.08)",
    "dark": "0 4px 12px rgb(0 0 0 / 0.3)"
  },
  "shadow-chip-raised": {
    "light": "0 1px 2px rgba(0, 0, 0, 0.12)",
    "dark": "0 1px 2px rgba(0, 0, 0, 0.4)"
  },
  "shadow-menu": {
    "light": "0 4px 16px rgba(0, 0, 0, 0.15)",
    "dark": "0 4px 16px rgba(0, 0, 0, 0.5)"
  },
  "confirm-shadow": {
    "light": "var(--shadow-soft-panel)",
    "dark": "var(--shadow-soft-panel)"
  },
  "cmd-palette-shadow": {
    "light": "var(--shadow-soft-panel)",
    "dark": "var(--shadow-soft-panel)"
  }
} as const;

export const EFFORT_TIER_COLORS = {
  minimal: GENERATED_DEFAULTS['effort-tier-minimal'].light,
  low: GENERATED_DEFAULTS['effort-tier-low'].light,
  medium: GENERATED_DEFAULTS['effort-tier-medium'].light,
  high: GENERATED_DEFAULTS['effort-tier-high'].light,
  xhigh: GENERATED_DEFAULTS['effort-tier-xhigh'].light,
  max: GENERATED_DEFAULTS['effort-tier-max'].light,
  ultra: GENERATED_DEFAULTS['effort-tier-ultra'].light,
} as const;

export const PRICE_TIER_COLORS = {
  t1: EFFORT_TIER_COLORS.low,
  t2: GENERATED_DEFAULTS['price-tier-t2'].light,
  t3: GENERATED_DEFAULTS['price-tier-t3'].light,
} as const;
// END GENERATED DS-8: defaults

/* === P3.2: Semantic slot tokens === */
registerColor('surface', GENERATED_DEFAULTS["surface"], 'Surface 页面背景 (hex 形式)');
registerColor('surface-hsl', GENERATED_DEFAULTS["surface-hsl"], 'Surface 页面背景 (HSL 形式)');
registerColor('surface-elevated', GENERATED_DEFAULTS["surface-elevated"], 'Card 抬一层 / 弹窗 / popover 背景');
registerColor('surface-elevated-soft', GENERATED_DEFAULTS["surface-elevated-soft"], 'Disabled / dimmed 卡片背景');
registerColor('surface-card-ivory', GENERATED_DEFAULTS["surface-card-ivory"], 'Settings 微暖 ivory Card');
registerColor('surface-chip', GENERATED_DEFAULTS["surface-chip"], 'Chip / pill / 选中行背景');
registerColor('surface-chip-alt', GENERATED_DEFAULTS["surface-chip-alt"], 'Chip 暗态塌缩到 Card 的变体');
registerColor('surface-hover', GENERATED_DEFAULTS["surface-hover"], '通用 hover 背景');
registerColor('surface-hover-soft', GENERATED_DEFAULTS["surface-hover-soft"], '柔和 hover 背景');
registerColor('surface-hover-hsl', GENERATED_DEFAULTS["surface-hover-hsl"], 'Hover 背景 HSL 形式');
registerColor('surface-on-card', GENERATED_DEFAULTS["surface-on-card"], 'CTA/checked icon 的深色前景');
// 历史幽灵 token 补注册:--panel-bg 被 9 处宿主组件裸引用(PanelChrome / TabBar
// / RightSidebarShell / ReviewTabBody / ghostPanels / RightSidebar / SidebarWindowLayout,
// 均 bg-[var(--panel-bg)] 无 fallback)但 colors.ts 从未注册,:root 读不到值 → 面板/
// 侧边栏头部背景失效。语义 = 面板背景 = surface(与 ghostPanelTheme.ts 沙箱 body
// fallback var(--panel-bg, var(--surface)) 兜底一致),故 alias 到 --surface,
// 注册后宿主消费点显式取到 surface 值。
registerColor('panel-bg', GENERATED_DEFAULTS["panel-bg"], '面板 / 侧边栏 / 工具面板头部背景(历史幽灵 token 补注册,alias 到 surface)');
registerColor('md-table-bg', GENERATED_DEFAULTS["md-table-bg"], 'Markdown 编辑器表格行 / 表头半透明背景');
// ── Markdown 正文语义色(标题 h1-h6 + 加粗)──
// 默认值刻意是 `inherit` 而不是 var(--text-primary):这些元素在引入 token 之前
// 的颜色就是从容器继承来的(baseComponents 只给字号字重,不给 color)。若默认改成
// 具体色槽,tool card / secondary 文字区里的 Markdown 标题与加粗会由弱化色变回
// 主色 —— 那才是真的改动现有观感。(blockquote 已不在此列:引用正文本身改为
// --text-primary,见 msg-blockquote-text。)`inherit` 让默认主题渲染结果逐
// 像素不变,同时给外部主题导入(VSCode markup.heading / Obsidian --hN-color)留出
// 可覆盖的槽位。详见 docs/design-rules/DESIGN.md §10「外部主题导入」。
registerColor('md-h1-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H1 文字色(默认继承容器文字色)');
registerColor('md-h2-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H2 文字色(默认继承容器文字色)');
registerColor('md-h3-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H3 文字色(默认继承容器文字色)');
registerColor('md-h4-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H4 文字色(默认继承容器文字色)');
registerColor('md-h5-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H5 文字色(默认继承容器文字色)');
registerColor('md-h6-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown H6 文字色(默认继承容器文字色)');
registerColor('md-strong-fg', {
  light: 'inherit',
  dark: 'inherit',
}, 'Markdown 加粗文字色(默认继承容器文字色)');
registerColor('border-default', GENERATED_DEFAULTS["border-default"], 'docs/design-rules/cindy-design-system.md Board 1px 边框');
registerColor('border-default-hsl', GENERATED_DEFAULTS["border-default-hsl"], 'Board HSL 形式');
registerColor('border-shadcn-hsl', GENERATED_DEFAULTS["border-shadcn-hsl"], 'shadcn input/border HSL');
registerColor('border-transparent-mixed', GENERATED_DEFAULTS["border-transparent-mixed"], 'Light transparent / dark board border');
// 历史幽灵 token 补注册:--board 被 RewindPreviewDialog 4 处 border-[var(--board)]
// 裸引用(无 fallback)但从未注册,边框读不到值。名字泛但消费点全是边框,语义 =
// 边框,alias 到 --border-default。
registerColor('board', GENERATED_DEFAULTS["board"], '通用边框(历史幽灵 token --board 补注册,alias 到 border-default)');
registerColor('text-primary', GENERATED_DEFAULTS["text-primary"], '主标题 / 主正文');
registerColor('text-primary-on-dark', GENERATED_DEFAULTS["text-primary-on-dark"], '深色按钮上的主前景');
registerColor('text-primary-emphasis', GENERATED_DEFAULTS["text-primary-emphasis"], '强调主文字');
registerColor('text-primary-inv', GENERATED_DEFAULTS["text-primary-inv"], '反相强调文字');
registerColor('text-primary-body-strong', GENERATED_DEFAULTS["text-primary-body-strong"], '加重正文');
registerColor('text-primary-hsl', GENERATED_DEFAULTS["text-primary-hsl"], 'Primary text HSL 形式');
registerColor('text-secondary', GENERATED_DEFAULTS["text-secondary"], 'Secondary 文字 / meta / icon');
registerColor('text-secondary-cross', GENERATED_DEFAULTS["text-secondary-cross"], '跨主题 secondary 文字');
registerColor('text-secondary-mid', GENERATED_DEFAULTS["text-secondary-mid"], '偏深 secondary 文字');
registerColor('text-tertiary', GENERATED_DEFAULTS["text-tertiary"], 'Tertiary / placeholder 文字');
registerColor('text-tertiary-stone', GENERATED_DEFAULTS["text-tertiary-stone"], 'Stone 跨主题三级文字');
registerColor('text-tertiary-mid', GENERATED_DEFAULTS["text-tertiary-mid"], 'Mid Gray 三级文字');
registerColor('text-tertiary-hsl', GENERATED_DEFAULTS["text-tertiary-hsl"], 'Sidebar / welcome muted HSL');
registerColor('text-disabled', GENERATED_DEFAULTS["text-disabled"], 'Disabled 文字 / failed dimmed');
registerColor('text-disabled-tertiary', GENERATED_DEFAULTS["text-disabled-tertiary"], 'Disabled tertiary 文字');
registerColor('text-placeholder', GENERATED_DEFAULTS["text-placeholder"], 'Placeholder 文字 — 必须读着像空(比 tertiary 更淡);统一 slot,各输入面 placeholder alias 均收口于此');
registerColor('accent-cta-bg', GENERATED_DEFAULTS["accent-cta-bg"], '反相 CTA 背景');
registerColor('accent-cta-bg-pure', GENERATED_DEFAULTS["accent-cta-bg-pure"], 'Pure CTA 背景');
registerColor('accent-emphasis', GENERATED_DEFAULTS["accent-emphasis"], '强调品牌前景 / ring');
registerColor('accent-soft', GENERATED_DEFAULTS["accent-soft"], 'Soft accent 前景');
registerColor('accent-hover', GENERATED_DEFAULTS["accent-hover"], 'CTA pressed / hover');
registerColor('accent-pure-cta-fg', GENERATED_DEFAULTS["accent-pure-cta-fg"], 'Pure CTA 文字');
registerColor('error-flat', GENERATED_DEFAULTS["error-flat"], '扁平 danger 前景');
registerColor('warning-accent', GENERATED_DEFAULTS["warning-accent"], 'Thinking orange / warning accent — running 状态色,设计定稿 2026-07-17(取代 #FF6600 冻结红线);全局同值,9 主题无 override 自动跟随');
// DESIGN.md §2 / §10 窄范围例外：仅资源用量表的 14px 进程类别 glyph 使用，
// 不表示健康/状态，也不得扩散到行背景、文字或其它进程 UI。
registerColor('process-agent-task-icon', GENERATED_DEFAULTS["process-agent-task-icon"], '资源用量表：任务 Agent 进程图标');
registerColor('process-agent-service-icon', GENERATED_DEFAULTS["process-agent-service-icon"], '资源用量表：Agent 控制面服务图标');
registerColor('process-main-icon', GENERATED_DEFAULTS["process-main-icon"], '资源用量表：主进程图标');
registerColor('process-renderer-icon', GENERATED_DEFAULTS["process-renderer-icon"], '资源用量表：界面进程图标');
registerColor('process-gpu-icon', GENERATED_DEFAULTS["process-gpu-icon"], '资源用量表：GPU 进程图标');
registerColor('process-utility-icon', GENERATED_DEFAULTS["process-utility-icon"], '资源用量表：Utility 服务进程图标');
// Usage History colors: owner-approved 2026-09-08 reference refinement.
// Chart-specific category hues; process/status colors and heatmap blue stay unchanged.
registerColor('usage-heatmap-high', GENERATED_DEFAULTS["usage-heatmap-high"], '用量历史图表：usage-heatmap-high（09-08 登记的配色引用）');
registerColor('usage-model-1', GENERATED_DEFAULTS["usage-model-1"], '用量历史图表：模型类别 1（09-08 参考图配色裁决）');
registerColor('usage-model-2', GENERATED_DEFAULTS["usage-model-2"], '用量历史图表：模型类别 2（09-08 参考图配色裁决）');
registerColor('usage-model-3', GENERATED_DEFAULTS["usage-model-3"], '用量历史图表：模型类别 3（09-08 参考图配色裁决）');
registerColor('usage-model-4', GENERATED_DEFAULTS["usage-model-4"], '用量历史图表：模型类别 4（09-08 参考图配色裁决）');
registerColor('usage-model-5', GENERATED_DEFAULTS["usage-model-5"], '用量历史图表：模型类别 5（09-08 参考图配色裁决）');

registerColor('shadow-soft-panel', GENERATED_DEFAULTS["shadow-soft-panel"], '中型弹层 shadow');
// Base
registerColor('background', GENERATED_DEFAULTS["background"], 'background');
registerColor('foreground', GENERATED_DEFAULTS["foreground"], 'foreground');
registerColor('muted', GENERATED_DEFAULTS["muted"], 'muted');
registerColor('muted-foreground', GENERATED_DEFAULTS["muted-foreground"], 'muted-foreground');
registerColor('border', GENERATED_DEFAULTS["border"], 'border');
registerColor('input', GENERATED_DEFAULTS["input"], 'input');
registerColor('switch-track-off', GENERATED_DEFAULTS["switch-track-off"], '共享 Switch 未选中轨道；跟随主题次要前景，与默认/悬停表面及滑块保持至少 3:1 非文字组件对比度，同时弱于开启态');
registerColor('switch-thumb-off', GENERATED_DEFAULTS["switch-thumb-off"], '共享 Switch 未选中滑块；跟随主题反相前景，与未选中轨道保持至少 3:1 非文字组件对比度');
registerColor('switch-disabled-opacity', GENERATED_DEFAULTS["switch-disabled-opacity"], '共享 Switch 禁用态整体不透明度(纯数值 token,非颜色);全局 0.3(用户裁决 2026-08-05,自出货值 0.5 调深),各皮肤仍可覆盖');
registerColor('switch-disabled-thumb-opacity', GENERATED_DEFAULTS["switch-disabled-thumb-opacity"], '共享 Switch 禁用态滑块自身不透明度(纯数值 token,叠加在整体不透明度之上);全局 0.5(用户裁决 2026-08-05)——禁用态滑块与轨道趋近、削掉立体感,「不可用」区别于「关」的关键');
registerColor('switch-track-on', GENERATED_DEFAULTS["switch-track-on"], '共享 Switch 开启态轨道;默认沿用 primary(不覆盖的主题外观不变),移植主题覆盖为各自主题色、CINDY 冻结于决策表;每个覆盖值须过 switchThemeContrast 的 ≥3:1 守卫(用户裁决 2026-08-05)');
registerColor('ring', GENERATED_DEFAULTS["ring"], 'ring');
registerColor('primary', GENERATED_DEFAULTS["primary"], 'primary');
registerColor('primary-foreground', GENERATED_DEFAULTS["primary-foreground"], 'primary-foreground');
registerColor('secondary', GENERATED_DEFAULTS["secondary"], 'secondary');
registerColor('secondary-foreground', GENERATED_DEFAULTS["secondary-foreground"], 'secondary-foreground');
registerColor('accent', GENERATED_DEFAULTS["accent"], 'accent');
registerColor('accent-foreground', GENERATED_DEFAULTS["accent-foreground"], 'accent-foreground');
registerColor('popover', GENERATED_DEFAULTS["popover"], 'popover');
registerColor('popover-foreground', GENERATED_DEFAULTS["popover-foreground"], 'popover-foreground');
registerColor('radius', GENERATED_DEFAULTS["radius"], 'radius Light only in source CSS; dark mode inherits the root value.');

// Titlebar — Ollama layer system (Light)
registerColor('titlebar', GENERATED_DEFAULTS["titlebar"], 'Light Surface #f8f8f6');
registerColor('titlebar-border', GENERATED_DEFAULTS["titlebar-border"], 'Light Board #d7d7d4');
registerColor('titlebar-icon', GENERATED_DEFAULTS["titlebar-icon"], 'Stone #737373');
registerColor('titlebar-button-hover', GENERATED_DEFAULTS["titlebar-button-hover"], 'Light Gray #e5e5e5');
registerColor('titlebar-control-hover', GENERATED_DEFAULTS["titlebar-control-hover"], 'Light Gray #e5e5e5');
registerColor('splash-bg', GENERATED_DEFAULTS["splash-bg"], 'Light Surface #f8f8f6 — docs/design-rules/cindy-design-system.md layer system (high-precision HSL for exact hex match)');
registerColor('splash-text', GENERATED_DEFAULTS["splash-text"], 'Stone #737373 — docs/design-rules/cindy-design-system.md secondary text');
registerColor('splash-text-muted', GENERATED_DEFAULTS["splash-text-muted"], 'Warm Gray #a39e98 — docs/design-rules/cindy-design-system.md muted text');
registerColor('splash-text-destructive', GENERATED_DEFAULTS["splash-text-destructive"], 'Near Black #262626 — docs/design-rules/cindy-design-system.md max emphasis (grayscale)');
registerColor('splash-fade-duration', GENERATED_DEFAULTS["splash-fade-duration"], 'Titlebar — Ollama layer system (Light) Light only in source CSS; dark mode inherits the root value.');
registerColor('splash-fade-easing', GENERATED_DEFAULTS["splash-fade-easing"], 'Titlebar — Ollama layer system (Light) Light only in source CSS; dark mode inherits the root value.');
registerColor('destructive', GENERATED_DEFAULTS["destructive"], 'Titlebar — Ollama layer system (Light)');

// confirm-dialog
registerColor('confirm-bg', GENERATED_DEFAULTS["confirm-bg"], 'confirm-dialog');
registerColor('confirm-shadow', GENERATED_DEFAULTS["confirm-shadow"], 'confirm-dialog');
registerColor('confirm-title', GENERATED_DEFAULTS["confirm-title"], 'confirm-dialog');
registerColor('confirm-desc', GENERATED_DEFAULTS["confirm-desc"], 'confirm-dialog');
registerColor('confirm-btn-primary-bg', GENERATED_DEFAULTS["confirm-btn-primary-bg"], 'confirm-dialog');
registerColor('confirm-btn-primary-text', GENERATED_DEFAULTS["confirm-btn-primary-text"], 'confirm-dialog');
registerColor('confirm-btn-primary-hover', GENERATED_DEFAULTS["confirm-btn-primary-hover"], 'confirm-dialog');
registerColor('confirm-btn-secondary-text', GENERATED_DEFAULTS["confirm-btn-secondary-text"], 'confirm-dialog');
registerColor('confirm-btn-secondary-border', GENERATED_DEFAULTS["confirm-btn-secondary-border"], 'confirm-dialog');
registerColor('confirm-btn-secondary-hover', GENERATED_DEFAULTS["confirm-btn-secondary-hover"], 'confirm-dialog');

// Sidebar — Ollama layer system (Light)
registerColor('sidebar', GENERATED_DEFAULTS["sidebar"], 'Light Surface #f8f8f6');
registerColor('sidebar-border', GENERATED_DEFAULTS["sidebar-border"], 'Light Board #d7d7d4');
registerColor('sidebar-item-hover', GENERATED_DEFAULTS["sidebar-item-hover"], 'Light Gray #e5e5e5');
registerColor('sidebar-item-active', GENERATED_DEFAULTS["sidebar-item-active"], 'Light Gray #e5e5e5 — selected pill');
registerColor('sidebar-item-active-foreground', GENERATED_DEFAULTS["sidebar-item-active-foreground"], 'Selected pill 文字/图标前景(default=foreground 正文;CINDY 2026-07-20 撤红后跟正文色)');
registerColor('sidebar-item-active-border', GENERATED_DEFAULTS["sidebar-item-active-border"], 'Selected pill 1px 描边(default=invisible 同 pill bg;CINDY 2026-07-20 撤红后跟中性边框)');
registerColor('sidebar-search-bg', GENERATED_DEFAULTS["sidebar-search-bg"], 'Light Surface');
registerColor('sidebar-muted', GENERATED_DEFAULTS["sidebar-muted"], 'Stone #737373');
registerColor('sidebar-action-icon', GENERATED_DEFAULTS["sidebar-action-icon"], 'Silver #a3a3a3 — hover action icons');
registerColor('search-match-bg', GENERATED_DEFAULTS["search-match-bg"], '#fff8c5 — Primer attention-muted');
registerColor('search-match-fg', GENERATED_DEFAULTS["search-match-fg"], 'Near-black #262626 — text inherit');

// UpdateBanner — Relaunch button (White Pill variant)
registerColor('update-btn-border', GENERATED_DEFAULTS["update-btn-border"], 'Border Light — per docs/design-rules/cindy-design-system.md White Pill');
registerColor('update-btn-text', GENERATED_DEFAULTS["update-btn-text"], 'Button Text Dark — per docs/design-rules/cindy-design-system.md White Pill');
registerColor('update-btn-hover', GENERATED_DEFAULTS["update-btn-hover"], 'Alpha-blended overlay — intentionally not an HSL token; needs transparency over variable backgrounds');
// Fill background for the relaunch pill. Default themes keep the classic
// transparent-outline White Pill (transparent → border+text define the shape);
// E1D neutral themes (cindy) override this to a solid fill so the on-fill text
// color (update-btn-text) has the intended contrast surface behind it. Non-HSL
// raw value on purpose (needs a real `transparent`, not an HSL triple).
registerColor('update-btn-bg', GENERATED_DEFAULTS["update-btn-bg"], 'Relaunch pill fill — transparent (outline) by default, solid in E1D neutral themes');

// Content area — Surface single-flat background per full-window rule
registerColor('content-area', GENERATED_DEFAULTS["content-area"], 'Light Surface #f8f8f6');

// Welcome text
registerColor('welcome-text', GENERATED_DEFAULTS["welcome-text"], 'Stone #737373');

// ── 旧 `login-*` 9 token 全族退役(PR5,SC-8,implementation-plan Step 6)──
// 原 login-bg/card-bg/card-border/divider/btn-bg/btn-text/btn-hover/help-text/
// error-text 均为 surface/accent/error 族纯 alias(light=dark=底层 token);消费者
// (McpServerDialog/CustomProviderDialog)已迁 var(--surface-elevated)/
// var(--border-default) 等底层 token,注册与消费双清零,由
// scripts/check-login-token-retirement.mjs 守护(无 allowlist 例外通道)。

// ── Login skin wave4 token 组(PR0a,implementation-plan Step 0 WHAT1)──
// 语义 = 跨主题恒定品牌豁免色(规则 16 豁免族):Cindy 品牌登录入口不随编辑器主题
// 染色,任何 builtin/扩展主题都不应 override 本组 token。
// 本组为现行登录 token(旧 `login-*` 9 token 已于 PR5 全族退役,见上方注释);
// 禁止撞名混义。参数权威:design.md §8(wave4)/figma-component-spec.md §10/
// token-decision-table.md(wave4 改判)。
//
// 底色:figma 帧 fill 标注 #F1F0F1,用户拍板 2026-07-22 改为固定 #EDEDED
// (= PR #104 白底机制在 cindy-light 下的实际渲染值)。2026-07-20 的
// 「消费 var(--surface)」改判作废——var(--surface) 随主题,cindy-dark 下取
// #2A2828,登录页背景变深且与 slogan #2A2828 同色隐形(沙盒手测 MT-1/2/5)。
registerColor('login-bg-base', GENERATED_DEFAULTS["login-bg-base"], 'Login — 画布底(亮色 #EDEDED / 暗色 #1F1F1E,figma 532:585 暗色帧实测;纯平,红渐变两层随 PR#104 拍板撤除,暗色沿用纯平口径)');
// 两层品牌红渐变(379:518 径向 / 379:520 线性,代码复现非资产)。图层 opacity
// 已合入色标 alpha(6%/5%)。CSS 取值为 figma 参数的最近似翻译;PR1 落码时以
// wave4 帧(368:1375)截图对照为准,允许微调本 token 值,名称与语义冻结。
// 双红渐变层已于 2026-07-22 用户拍板对齐 PR #104 撤除(背景纯平),token 保留作
// 主题 override 锚但值恒 none;实际不再渲染任何渐变(LoginBrandStage 已移除消费)。
registerColor('login-bg-gradient-radial', {
  light: 'none',
  dark: 'none',
}, 'Login — 红径向渐变层(撤 wave4 双红渐变→none,对齐 PR #104;token 保留作 override 锚)');
registerColor('login-bg-gradient-linear', {
  light: 'none',
  dark: 'none',
}, 'Login — 红线性渐变层(撤 wave4 双红渐变→none,对齐 PR #104;token 保留作 override 锚)');
// login-window-border-outer/inner 已随撤销登录窗口双描边(LoginWindowChrome,
// 对齐 PR #104:PR104 无窗框描边)删除,不再注册。
registerColor('login-panel-border', GENERATED_DEFAULTS["login-panel-border"], 'Login — 面板 1px inside 描边(亮色 #D4D4D4 / 暗色 #434343;DESIGN.md §16.1)');
// 品牌红 accent 族:wave4 改判后 #DF0C27 语义限定为 accent(区域徽标/字标
// 红元素等品牌点缀),禁止表达页面/画板背景——命名刻意不含 bg/background
// (token-decision-table.md 原案名 login-brand-bg 已随改判弃用)。
registerColor('login-brand-accent', {
  light: '#DF0C27',
  dark: '#DF0C27',
}, 'Login — 品牌红 accent(区域徽标/字标红元素;禁止用作页面背景,wave4 改判)');
registerColor('login-brand-accent-pressed', {
  light: '#A61629',
  dark: '#A61629',
}, 'Login — 品牌红 accent pressed/hover 深红(figma §1 Color System)');
// Text_link pressed(U-9 裁决 2026-07-20:default #2A2828 加深至 #1A1818,
// lead 受托定值;wave3 实测节点落地后以实测替换 token 值)。
registerColor('login-link-pressed', GENERATED_DEFAULTS["login-link-pressed"], 'Login — Text_link pressed 态(亮色 U-9 #1A1818 / 暗色 #C0BEBE 推导,待 Figma 精确)');
// ── 回调卡 component alias(PR3,LegacyMigrationDialog 消费——design §7.4 唯一
// App 内表情包例外,弹窗用回调卡形式)。参数权威:callback-pages-classification.md
// 「卡片共用参数」(figma §6.1:White #FBFBFB/#D4D4D4/#252222/#2A2828 CTA;
// Dark #312F2F/#434343/#D4D4D4/#EEEEEE CTA)。token-decision-table 决策为
// component alias 且「两套模式时可拆」——此处按 light/dark mode 拆分承载。
// 浏览器回调页本体不消费 renderer token(独立 HTML,同表决策用内联常量,见
// oauthResultPage.ts renderBrandLoginCallbackPage);本组仅供 App 内例外消费。
// 品牌豁免族:非默认主题不 override(与 wave4 组同口径)。
registerColor('login-callback-card-bg', GENERATED_DEFAULTS["login-callback-card-bg"], 'Login callback card — 卡底(White/Dark 卡,figma §6.1)');
registerColor('login-callback-card-border', GENERATED_DEFAULTS["login-callback-card-border"], 'Login callback card — 1px 卡描边');
registerColor('login-callback-title', GENERATED_DEFAULTS["login-callback-title"], 'Login callback card — 标题');
registerColor('login-callback-body', GENERATED_DEFAULTS["login-callback-body"], 'Login callback card — 副文案(两模式同值)');
registerColor('login-callback-cta-bg', GENERATED_DEFAULTS["login-callback-cta-bg"], 'Login callback card — CTA 底(反相)');
registerColor('login-callback-cta-border', GENERATED_DEFAULTS["login-callback-cta-border"], 'Login callback card — CTA 1px 描边');
registerColor('login-callback-cta-text', GENERATED_DEFAULTS["login-callback-cta-text"], 'Login callback card — CTA 文字(反相)');

// ── Login 组件色 alias(暗色实现 PR:light/dark 二态,DESIGN.md §16.1)──
// 语义 = 登录入口 100% 还原设计稿;随基础 light/dark 二态切换,不跟具体扩展主题
// (规则 16 豁免族:扩展主题不 override)。色值经 Figma 组件库 Dark symbol 核验。
// disabled 态两模式同构(深底#2A2828+白70%叠层+边#B4B4B4+字#D4D4D4 opacity0.8,不反相,§16.5)。
registerColor('login-panel-bg', GENERATED_DEFAULTS["login-panel-bg"], 'Login — 面板底(亮色 #FBFBFB / 暗色 #312F2F;DESIGN.md §16.1)');
registerColor('login-control-bg', GENERATED_DEFAULTS["login-control-bg"], 'Login — 输入框底(亮色 #EEEEEE / 暗色 #2C2A2A,figma Dark_normal 输入 symbol。暗色下与方式行/返回钮底分化,后者走 login-action-control-bg)');
registerColor('login-action-control-bg', GENERATED_DEFAULTS["login-action-control-bg"], 'Login — 方式行/返回钮底(亮色与输入框同 #EEEEEE;暗色 #2A2828 与输入框分化;figma 549:850/549:897,组件库更新 2026-07-23)');
registerColor('login-back-border', GENERATED_DEFAULTS["login-back-border"], 'Login — 返回钮描边(亮色白 / 暗色 #434343;figma 549:897。区域徽标白字仍走 login-inverted-button-border)');
registerColor('login-control-border', GENERATED_DEFAULTS["login-control-border"], 'Login — 控件 default 描边(亮色 #D4D4D4 / 暗色 #434343)');
registerColor('login-control-border-active', GENERATED_DEFAULTS["login-control-border-active"], 'Login — 控件 focus/filled 描边(亮色 #2A2828 / 暗色 #EEEEEE 反相)');
registerColor('login-control-border-disabled', GENERATED_DEFAULTS["login-control-border-disabled"], 'Login — disabled 控件描边(两模式同构,§16.5 disabled 特例)');
registerColor('login-control-text', GENERATED_DEFAULTS["login-control-text"], 'Login — 控件已填文本/标题(亮色 #252222 / 暗色 #EEEEEE)');
registerColor('login-control-placeholder', GENERATED_DEFAULTS["login-control-placeholder"], 'Login — 控件 placeholder/countdown(亮色 #D4D4D4 / 暗色 #6F6F6F;figma 539:754 dark_倒计时重发)');
registerColor('login-title-text', GENERATED_DEFAULTS["login-title-text"], 'Login — 面板标题 32 Bold(亮色 #252222 / 暗色 #D4D4D4)');
registerColor('login-secondary-text', GENERATED_DEFAULTS["login-secondary-text"], 'Login — 副标题/说明文字(两模式同值 #6F6F6F)');
registerColor('login-primary-button-bg', GENERATED_DEFAULTS["login-primary-button-bg"], 'Login — 主按钮/第三方圆钮底(亮色深 #2A2828 / 暗色白 #EEEEEE 反相;社交圆图标保品牌色)');
registerColor('login-primary-button-border', GENERATED_DEFAULTS["login-primary-button-border"], 'Login — 主按钮/圆钮描边(亮色 #434343 / 暗色 #FFFFFF)');
registerColor('login-primary-button-text', GENERATED_DEFAULTS["login-primary-button-text"], 'Login — 主按钮文字(亮色 #D4D4D4 / 暗色 #2A2828 反相)');
registerColor('login-disabled-button-overlay', GENERATED_DEFAULTS["login-disabled-button-overlay"], 'Login — disabled 按钮白 70% 叠层(两模式同构,§16.5 disabled 特例)');
registerColor('login-disabled-button-bg', GENERATED_DEFAULTS["login-disabled-button-bg"], 'Login — disabled 主按钮底(两模式同构深底;暗色不随 primary-button-bg 反相为白,figma white_button Disable)');
registerColor('login-disabled-button-text', GENERATED_DEFAULTS["login-disabled-button-text"], 'Login — disabled 主按钮文字(两模式同构,配合 opacity 0.8;figma white_button Disable)');
registerColor('login-inverted-button-border', GENERATED_DEFAULTS["login-inverted-button-border"], 'Login — 浅底钮白描边/区域徽标白字(两模式同值 #FFFFFF;推导,待 Figma 精确)');
registerColor('login-link-text', GENERATED_DEFAULTS["login-link-text"], 'Login — Text_link default 重发链接(亮色墨黑 #2A2828 / 暗色浅色 #EEEEEE 下划线;figma 539:752 dark_重新发送)');
registerColor('login-link-hover', GENERATED_DEFAULTS["login-link-hover"], 'Login — Text_link hover(亮色 #4A4848 / 暗色 #A8A8A8 推导,待 Figma;仅桌面 hover)');
registerColor('login-error-fg', GENERATED_DEFAULTS["login-error-fg"], 'Login — 错误文本/error 描边(语义豁免,跨模式不变 #D91F37)');
// 注销提示气泡底 + 描边(figma 678:1075「注销状态」组件集;用户拍板 2026-07-25 取
// 「agent 输入框底/描边、main 最深深色底」的**值**:#FFFFFF / #D7D7D4 / #1F1F1E)。
// 不用 alias(var(--chat-input-bg)/var(--chat-input-border)/var(--surface)):login skin
// 只分亮/暗、不随扩展主题——alias 会被扩展主题 override(cindy-dark 下 --surface 取
// #2A2828,气泡变浅且与 mobile 色板不一致),同 login-bg-base 上方注释的改判先例。
// 与 mobile loginPalettes.deletionBubbleBg/deletionBubbleBorder 逐值一致。
registerColor('login-deletion-bubble-bg', GENERATED_DEFAULTS["login-deletion-bubble-bg"], 'Login — 注销提示气泡底(figma 678:1075;固定值 #FFFFFF / #1F1F1E,取 agent 输入框底与最深深色底的值,不用 alias——login skin 不随扩展主题,与 mobile 逐值一致)');
registerColor('login-deletion-bubble-border', GENERATED_DEFAULTS["login-deletion-bubble-border"], 'Login — 注销提示气泡 1px 描边(figma 678:1075;固定值 #D7D7D4 / #3C3C3A,取 agent 输入框描边的值,不用 alias——同 bubble-bg 口径,与 mobile 逐值一致)');
// Splash 统一面板进度条(亮色 track #D9D9D9/fill #252222;暗色推导 track #434343/fill #D4D4D4,待 Figma 精确)。
registerColor('login-splash-progress-track', GENERATED_DEFAULTS["login-splash-progress-track"], 'Login splash — 进度条轨(亮色 #D9D9D9 / 暗色 #434343 推导,待 Figma)');
registerColor('login-splash-progress-fill', GENERATED_DEFAULTS["login-splash-progress-fill"], 'Login splash — 进度条填充(亮色 #252222 / 暗色 #D4D4D4 推导,待 Figma)');

// ── Login overlay 叠层 token(暗色实现 PR;hover/pressed 叠层 light/dark 二态,
// 组件 hardcode rgba → var(--login-overlay-*);DESIGN.md §16.5)──
// 暗色叠层方向反转(亮色深底叠白 / 暗色白底叠黑),无法用单一 token 值切换,故二态。
registerColor('login-overlay-button-hover', GENERATED_DEFAULTS["login-overlay-button-hover"], 'Login — 主按钮/圆钮 hover 叠层(亮色白8% / 暗色黑5%;figma §1.4)');
registerColor('login-overlay-button-pressed', GENERATED_DEFAULTS["login-overlay-button-pressed"], 'Login — 主按钮/圆钮 pressed 叠层(亮色黑50% / 暗色黑10%;figma §1.4;暗色 pressed 边 #E5E5E5 待组件层裁决)');
registerColor('login-overlay-back-hover', GENERATED_DEFAULTS["login-overlay-back-hover"], 'Login — 返回钮 hover 叠层(亮色白70% / 暗色白8% 变浅;figma 549:904)');
registerColor('login-overlay-back-pressed', GENERATED_DEFAULTS["login-overlay-back-pressed"], 'Login — 返回钮 pressed 叠层(两模式黑8%)');
registerColor('login-overlay-row-hover', GENERATED_DEFAULTS["login-overlay-row-hover"], 'Login — 方式行 hover 叠层(两模式白8% 变浅;figma 549:865)');
registerColor('login-overlay-row-pressed', GENERATED_DEFAULTS["login-overlay-row-pressed"], 'Login — 方式行 pressed 叠层(两模式黑8%)');
registerColor('login-overlay-input-hover', GENERATED_DEFAULTS["login-overlay-input-hover"], 'Login — 输入框 hover 叠层(亮色黑5% / 暗色白5% 推导,待 Figma)');
registerColor('login-loading-ring-track', GENERATED_DEFAULTS["login-loading-ring-track"], 'Login — loading 环轨(亮色深半透 / 暗色浅半透 推导,待 Figma)');

// ── Login 协议同意族(consent PR;figma wave5 radiobutton 600:627 四态 +
// 服务条款弹窗 602:822/602:1249 + 双色小按钮四母版 602:846/863/1297/1311)──
// 与 login-* 族同口径:随基础 light/dark 二态切换,扩展主题不 override。
// radio 选中态为对勾(非圆点),四态双模式反色,色值经 figma SVG 源码直读核对。
registerColor('login-consent-radio-bg', GENERATED_DEFAULTS["login-consent-radio-bg"], 'Login — 协议 radio 未选中圈底(figma white_normal 600:626 / Dark_normal 602:1091)');
registerColor('login-consent-radio-border', GENERATED_DEFAULTS["login-consent-radio-border"], 'Login — 协议 radio 未选中 2px 描边(双模式反色)');
registerColor('login-consent-radio-checked-bg', GENERATED_DEFAULTS["login-consent-radio-checked-bg"], 'Login — 协议 radio 选中圈底(figma white_highlight 600:628 / Dark_highlight 602:1093)');
registerColor('login-consent-radio-check', GENERATED_DEFAULTS["login-consent-radio-check"], 'Login — 协议 radio 选中对勾(亮色白勾 / 暗色墨勾)');
registerColor('login-consent-overlay', GENERATED_DEFAULTS["login-consent-overlay"], 'Login — 协议弹窗全屏遮罩(两模式同值黑 85%;figma 602:820/602:1248 实测)');
// 弹窗次级钮(「不同意」):亮模式浅底 light_button_Normal(602:863),暗模式
// Dark_button_Normal(602:1311,#434141 与面板 #312F2F/描边 #434343 均不同值)。
// 「同意」钮 = 强调钮,双模式恰与 login-primary-button-* 同值,直接复用不新增。
registerColor('login-secondary-button-bg', GENERATED_DEFAULTS["login-secondary-button-bg"], 'Login — 弹窗次级钮底(亮 #EEEEEE / 暗 #434141;figma 双色小按钮 wave5)');
registerColor('login-secondary-button-border', GENERATED_DEFAULTS["login-secondary-button-border"], 'Login — 弹窗次级钮 1px 描边(亮白 / 暗 #565454)');
registerColor('login-secondary-button-text', GENERATED_DEFAULTS["login-secondary-button-text"], 'Login — 弹窗次级钮文字(亮墨 / 暗浅,双模式反色)');
// wave5 hover/pressed 统一口径:hover = 底叠白(深底 8% / 浅底 10%);
// pressed = 叠黑(浅底钮 10% / Dark_button_Normal 20%)。次级钮亮浅暗深,
// 两模式叠层参数不同故二态注册(与 login-overlay-* 族同理)。
registerColor('login-overlay-secondary-hover', GENERATED_DEFAULTS["login-overlay-secondary-hover"], 'Login — 弹窗次级钮 hover 叠层(亮浅底白10% / 暗深底白8%;wave5 §11.1)');
registerColor('login-overlay-secondary-pressed', GENERATED_DEFAULTS["login-overlay-secondary-pressed"], 'Login — 弹窗次级钮 pressed 叠层(亮浅底黑10% / 暗 Dark_button_Normal 黑20%;wave5 §11.1)');

// Apple 登录圆钮(App Store Guideline 4 对齐,用户标准图 2026-07-24):亮色模式 =
// ADR Black button 配色(纯黑圆 + 白标),暗色模式 = ADR White button 配色
// (纯白圆 + 黑标),无描边。语义豁免:官方按钮配色,扩展主题不 override。
registerColor('login-apple-circle-bg', GENERATED_DEFAULTS["login-apple-circle-bg"], 'Login — Apple 圆钮底(ADR Black/White 官方按钮底色;亮黑圆白标/暗白圆黑标,无描边)');

registerColor('lightbox-cta-bg', GENERATED_DEFAULTS["lightbox-cta-bg"], 'Black Pill — Light');
registerColor('lightbox-cta-fg', GENERATED_DEFAULTS["lightbox-cta-fg"], 'Black Pill CTA foreground');
registerColor('lightbox-cta-hover', GENERATED_DEFAULTS["lightbox-cta-hover"], 'Near Black — pressed/hover');

// Chat input — Ollama layer system (Light)
registerColor('chat-input-bg', GENERATED_DEFAULTS["chat-input-bg"], 'Card — elevated input box on Surface');
registerColor('chat-input-border', GENERATED_DEFAULTS["chat-input-border"], 'Board — 1px outline');
registerColor('chat-input-border-focus', GENERATED_DEFAULTS["chat-input-border-focus"], 'Silver — focus hint, still grayscale');
registerColor('chat-input-placeholder-subtle', {
  light: 'color-mix(in srgb, var(--chat-input-placeholder) 40%, transparent)',
  dark: 'color-mix(in srgb, var(--chat-input-placeholder) 40%, transparent)',
}, 'Chat input placeholder at 40% opacity');
registerColor('chat-input-text', GENERATED_DEFAULTS["chat-input-text"], 'Pure Black — primary text');
registerColor('chat-input-placeholder', GENERATED_DEFAULTS["chat-input-placeholder"], 'Placeholder — 收口至 --text-placeholder slot');

// File attachment tokens (F-FI-3/4) — Light
registerColor('file-chip-bg', GENERATED_DEFAULTS["file-chip-bg"], 'Silver — non-image thumbnail bg');
registerColor('drop-overlay-bg', GENERATED_DEFAULTS["drop-overlay-bg"], 'chat-input-border-focus @ 8%');
registerColor('drop-overlay-border', GENERATED_DEFAULTS["drop-overlay-border"], 'chat-input-border-focus');
registerColor('tooltip-bg', GENERATED_DEFAULTS["tooltip-bg"], 'Near Black');
registerColor('tooltip-text', GENERATED_DEFAULTS["tooltip-text"], 'Pure White');
registerColor('file-remove-bg', GENERATED_DEFAULTS["file-remove-bg"], 'Mid Gray');
// 附件卡自绘文件图标的类型角标(§10 theme-invariant 例外族):颜色跟「这份文件是
// 什么」绑定,不随明暗翻转,两模式同值。取值都按白字 ≥4.5:1 选过(pdf 5.96 /
// doc 6.56 / sheet 5.05 / slide 5.24 / code 7.09),角标文字恒用 file-badge-fg。
registerColor('file-badge-pdf', GENERATED_DEFAULTS["file-badge-pdf"], '文件类型角标 — PDF(theme-invariant;× file-badge-fg = 5.96:1)');
registerColor('file-badge-doc', GENERATED_DEFAULTS["file-badge-doc"], '文件类型角标 — 文档(theme-invariant;× file-badge-fg = 6.56:1)');
registerColor('file-badge-sheet', GENERATED_DEFAULTS["file-badge-sheet"], '文件类型角标 — 表格(theme-invariant;× file-badge-fg = 5.05:1)');
registerColor('file-badge-slide', GENERATED_DEFAULTS["file-badge-slide"], '文件类型角标 — 幻灯片(theme-invariant;× file-badge-fg = 5.24:1)');
registerColor('file-badge-code', GENERATED_DEFAULTS["file-badge-code"], '文件类型角标 — 代码(theme-invariant;× file-badge-fg = 7.09:1)');
registerColor('file-badge-fg', GENERATED_DEFAULTS["file-badge-fg"], '文件类型角标前景 — 恒白(不能借 accent-pure-cta-fg:那个会在 Dark 翻成黑)');
// Bot 头像底色族(DESIGN.md §2 / §10 登记的窄作用域彩色例外,双模式各一档):
// 颜色跟「这是哪个 Bot」绑定,是身份识别线索而不是状态/健康信号 —— 与文件类型角标
// 同性质。Light 用柔和浅 tint、Dark 用同色相深 tint,两侧都保证 emoji 与首字母兜底
// (恒用 --text-primary)清晰可读:浅 tint × #262626 ≥ 10:1,深 tint × #d4d4d4 ≥ 7:1。
// 作用域严格限定为 Bot 头像填充,不得外溢到状态点、徽标、行背景或任何其它表面。
registerColor('bot-avatar-red-bg', GENERATED_DEFAULTS["bot-avatar-red-bg"], 'Bot 头像底色 — red(登记例外族)');
registerColor('bot-avatar-orange-bg', GENERATED_DEFAULTS["bot-avatar-orange-bg"], 'Bot 头像底色 — orange(登记例外族)');
registerColor('bot-avatar-amber-bg', GENERATED_DEFAULTS["bot-avatar-amber-bg"], 'Bot 头像底色 — amber(登记例外族)');
registerColor('bot-avatar-green-bg', GENERATED_DEFAULTS["bot-avatar-green-bg"], 'Bot 头像底色 — green(登记例外族)');
registerColor('bot-avatar-teal-bg', GENERATED_DEFAULTS["bot-avatar-teal-bg"], 'Bot 头像底色 — teal(登记例外族)');
registerColor('bot-avatar-blue-bg', GENERATED_DEFAULTS["bot-avatar-blue-bg"], 'Bot 头像底色 — blue(登记例外族)');
registerColor('bot-avatar-violet-bg', GENERATED_DEFAULTS["bot-avatar-violet-bg"], 'Bot 头像底色 — violet(登记例外族)');
registerColor('bot-avatar-pink-bg', GENERATED_DEFAULTS["bot-avatar-pink-bg"], 'Bot 头像底色 — pink(登记例外族)');
registerColor('bot-avatar-graphite-bg', GENERATED_DEFAULTS["bot-avatar-graphite-bg"], 'Bot 头像底色 — graphite 中性档(旧 graphite 数据映射到这里)');
// 伙伴列表未读徽标(DESIGN.md §10 登记的窄作用域例外,双模式同值):
// 「有新消息」在 IM 里是一个所有人都认得的蓝色药丸,不是一个反相的 CTA。反相白底
// 药丸落在浅灰选中态上会和选中态互相抢焦点 —— 一行里最亮的东西应该是「有几条没看」,
// 不是「你现在站在这一行」。值与 focus-ring / Auto Approval / Toast info 同族 #417CDD,
// 前景恒白(--accent-pure-cta-fg 在 Dark 会翻成黑,不能借)。
// 作用域严格限定为伙伴列表的未读徽标与待办点,不得外溢到别的徽标、状态点或表面。
registerColor('bot-unread-bg', GENERATED_DEFAULTS["bot-unread-bg"], '伙伴列表未读徽标底色 — IM 未读语义(登记例外,theme-invariant;× bot-unread-fg = 4.53:1)');
registerColor('bot-unread-fg', GENERATED_DEFAULTS["bot-unread-fg"], '伙伴列表未读徽标前景 — 恒白(不能借 accent-pure-cta-fg:那个会在 Dark 翻成黑)');
registerColor('chat-input-chip-bg', GENERATED_DEFAULTS["chat-input-chip-bg"], 'Light Gray — docs/design-rules/cindy-design-system.md Chip');
registerColor('chat-input-chip-border', GENERATED_DEFAULTS["chat-input-chip-border"], 'Board — 1px outline');
registerColor('chat-input-chip-text', GENERATED_DEFAULTS["chat-input-chip-text"], 'Near Black');
registerColor('chat-input-chip-icon', GENERATED_DEFAULTS["chat-input-chip-icon"], 'Near Black');

// Command Palette shared tokens — panel + tooltip (light)
registerColor('cmd-palette-bg', GENERATED_DEFAULTS["cmd-palette-bg"], 'Card');
registerColor('cmd-palette-border', GENERATED_DEFAULTS["cmd-palette-border"], 'Board');
registerColor('cmd-palette-shadow', GENERATED_DEFAULTS["cmd-palette-shadow"], 'Command Palette shared tokens — panel + tooltip (light)');
registerColor('cmd-palette-item-hover', GENERATED_DEFAULTS["cmd-palette-item-hover"], 'Light Gray');
registerColor('cmd-palette-item-text', GENERATED_DEFAULTS["cmd-palette-item-text"], 'Near Black');
registerColor('cmd-palette-item-meta', GENERATED_DEFAULTS["cmd-palette-item-meta"], 'Stone — source tag / path / Agent');
registerColor('cmd-palette-item-icon', GENERATED_DEFAULTS["cmd-palette-item-icon"], 'Stone');
registerColor('cmd-palette-empty', GENERATED_DEFAULTS["cmd-palette-empty"], 'Stone — "No matching commands"');
registerColor('cmd-palette-tooltip-body', GENERATED_DEFAULTS["cmd-palette-tooltip-body"], 'Stone — description body');

// Send button — grayscale pill
registerColor('send-btn-bg', GENERATED_DEFAULTS["send-btn-bg"], 'Near Black — per cc-agent-view spec');
registerColor('send-btn-icon', GENERATED_DEFAULTS["send-btn-icon"], 'Send button — grayscale pill');
registerColor('send-btn-disabled-bg', GENERATED_DEFAULTS["send-btn-disabled-bg"], 'Light Gray');
registerColor('send-btn-disabled-icon', GENERATED_DEFAULTS["send-btn-disabled-icon"], 'Silver');
registerColor('send-btn-hover-bg', GENERATED_DEFAULTS["send-btn-hover-bg"], 'Send button hover bg(default 同 bg,默认皮肤维持 opacity-85 hover;CINDY override 反相中性 hover #2E3237/#E2E2E2,E1D 纳入值表)');
registerColor('send-btn-pressed-bg', GENERATED_DEFAULTS["send-btn-pressed-bg"], 'Send button pressed bg(default 同 bg;CINDY override 反相中性 pressed #25282C/#D4D4D4,E1D 纳入值表)');

// Permission prompt (F-PERM-2)
registerColor('perm-code-bg', GENERATED_DEFAULTS["perm-code-bg"], 'Light code block bg');
registerColor('perm-code-border', GENERATED_DEFAULTS["perm-code-border"], 'Board — code block outline');
registerColor('perm-allow-btn-bg', GENERATED_DEFAULTS["perm-allow-btn-bg"], 'Allow once — white bg per ref');
registerColor('perm-allow-btn-text', GENERATED_DEFAULTS["perm-allow-btn-text"], 'Allow once — dark text');
registerColor('perm-allow-kbd-bg', GENERATED_DEFAULTS["perm-allow-kbd-bg"], 'Allow once kbd bg');
registerColor('perm-allow-kbd-border', GENERATED_DEFAULTS["perm-allow-kbd-border"], 'Allow once kbd border');

// Model selector
registerColor('model-trigger-hover', GENERATED_DEFAULTS["model-trigger-hover"], 'Light Gray — pill hover');
registerColor('model-trigger-text', GENERATED_DEFAULTS["model-trigger-text"], 'Stone — model name + effort name');
registerColor('model-trigger-meta', GENERATED_DEFAULTS["model-trigger-meta"], 'Silver — middle dot separator (·)');
registerColor('model-trigger-arrow', GENERATED_DEFAULTS["model-trigger-arrow"], 'Silver');
registerColor('thinking-body-text', GENERATED_DEFAULTS["thinking-body-text"], 'Silver — one tier below title');
registerColor('model-dropdown-bg', GENERATED_DEFAULTS["model-dropdown-bg"], 'Card');
registerColor('model-dropdown-border', GENERATED_DEFAULTS["model-dropdown-border"], 'Board');
registerColor('model-item-hover', GENERATED_DEFAULTS["model-item-hover"], 'Light Gray');
registerColor('model-item-text', GENERATED_DEFAULTS["model-item-text"], 'Near Black');
registerColor('model-item-check', GENERATED_DEFAULTS["model-item-check"], 'Pure Black');
registerColor('model-item-desc', GENERATED_DEFAULTS["model-item-desc"], 'Stone — model description');
registerColor('model-section-label', GENERATED_DEFAULTS["model-section-label"], 'Stone — "Effort" header');
// 统一模型选择器(model-selector-unified §1.3 / §1.5)
registerColor('favorite-star', GENERATED_DEFAULTS["favorite-star"], 'Gold — 收藏 ☆ 点亮态');
// 推理强度档位绝对色:同一档在 Light / Dark 下必须是同一个颜色(档色表达「这一档有多强」,
// 不表达界面明暗层次),故 light === dark。唯一编辑源是 packages/design-tokens/src/reference/color.json,
// 静态表生成到本文件 GENERATED 区;滑杆逐帧插值需要数值 hex,故以 TS 常量导出。
// effortTierColors.ts 只负责档位适配、插值与回退。
for (const [tier, hex] of Object.entries(EFFORT_TIER_COLORS)) {
  registerColor(`effort-tier-${tier}`, { light: hex, dark: hex }, `推理强度档位色 — ${tier}`);
}
// 价格档($ 串)三档色:同为跨主题固定功能色(价格档表达「贵不贵」,不随明暗主题变),
// 与 effort 同由 DTCG reference/color.json 生成到本文件 GENERATED 区。
for (const [tier, hex] of Object.entries(PRICE_TIER_COLORS)) {
  registerColor(`price-tier-${tier}`, { light: hex, dark: hex }, `价格档位色 — ${tier}`);
}
// Fast(插队加速)开启态的强调蓝 —— 与档位色 / 价格档色同一类**跨主题固定功能色**
// (DESIGN.md §10 语义豁免):它表达的是「这一格开着 Fast」这个功能态,不表达界面明暗层次,
// 两种模式给同一个值是**有意决策**,不是漏配 dark。配置浮层里的按钮底色由组件用 color-mix
// 从同一个 var 派生,不另存第二份数值。只在浮层内部用(外侧闪电保持中性色,规格 §1.3)。
registerColor('fast-accent', GENERATED_DEFAULTS["fast-accent"], 'Fast 开启态强调蓝(light/dark 同值,跨主题固定功能色)');
// 引擎徽标(badge 列表样式的行首 22px 标识)的品牌标识色 —— 与档位色 / 价格档色 /
// Fast 强调蓝同一类**跨主题固定功能色**(DESIGN.md §10 语义豁免):它表达的是「这一行
// 现在挂在哪个引擎上」这个身份,不表达界面明暗层次,**light / dark 同值是有意决策**,
// 不是漏配 dark —— 同一个引擎在两种主题下换个颜色,用户会以为自己换了引擎。
// 各自来源:
//   · cc    = Anthropic 陶土橙,与 ClaudeMark 的 brand variant 同一支色;
//   · codex = Codex 官方渐变的中段蓝(CodexMark brand 的 0.5 stop);
//   · pi    = 上游无官方品牌色,取一支与前两者可区分的紫(统一选择器设计稿 v7)。
// 徽标底色(14%)与描边(30%)由组件用 color-mix 从**同一个 var** 派生,PiMark 的
// currentColor 也接同一个 var —— TS 侧不再持有这三个 hex,不会出现「组件拿常量、
// 主题拿 token」两条路各画各的。
registerColor('engine-badge-cc', GENERATED_DEFAULTS["engine-badge-cc"], 'Claude Code 引擎徽标色 — Anthropic 陶土橙(light/dark 同值)');
registerColor('engine-badge-codex', GENERATED_DEFAULTS["engine-badge-codex"], 'Codex 引擎徽标色 — 官方渐变中段蓝(light/dark 同值)');
registerColor('engine-badge-pi', GENERATED_DEFAULTS["engine-badge-pi"], 'Pi 引擎徽标色 — 自选紫,上游无官方品牌色(light/dark 同值)');
// Permission selector
registerColor('perm-item-selected-bg', GENERATED_DEFAULTS["perm-item-selected-bg"], 'Warm White — selected item bg');

// Narrow scoped text hints: only selected risky permission modes use color.
registerColor('perm-auto-selected-text', GENERATED_DEFAULTS["perm-auto-selected-text"], 'Auto Approval accent(设计定稿 2026-07-17 #417CDD,light/dark 同值;原 light #000050/dark #00D9C5)');
registerColor('perm-bypass-selected-text', GENERATED_DEFAULTS["perm-bypass-selected-text"], 'Heart Orange');

// Folder picker
registerColor('folder-picker-bg', GENERATED_DEFAULTS["folder-picker-bg"], 'Card');
registerColor('folder-picker-border', GENERATED_DEFAULTS["folder-picker-border"], 'Board');
registerColor('folder-item-hover', GENERATED_DEFAULTS["folder-item-hover"], 'Light Gray — docs/design-rules/cindy-design-system.md Chip');
registerColor('folder-item-name', GENERATED_DEFAULTS["folder-item-name"], 'Near Black');
registerColor('folder-item-path', GENERATED_DEFAULTS["folder-item-path"], 'Stone');
registerColor('folder-item-icon', GENERATED_DEFAULTS["folder-item-icon"], 'Stone');
registerColor('folder-label', GENERATED_DEFAULTS["folder-label"], 'Stone — "Recent" label');
registerColor('folder-btn-bg', GENERATED_DEFAULTS["folder-btn-bg"], 'Match input box');
registerColor('folder-btn-border', GENERATED_DEFAULTS["folder-btn-border"], 'Board');
registerColor('folder-btn-text', GENERATED_DEFAULTS["folder-btn-text"], 'Near Black');
registerColor('folder-btn-icon', GENERATED_DEFAULTS["folder-btn-icon"], 'Near Black — per cc-agent-view spec');

// WorkingDir bar
registerColor('workingdir-text', GENERATED_DEFAULTS["workingdir-text"], 'Stone');
registerColor('workingdir-icon', GENERATED_DEFAULTS["workingdir-icon"], 'Stone');

// FastToggle (F1)
registerColor('fast-toggle-off', GENERATED_DEFAULTS["fast-toggle-off"], 'Stone — OFF icon/text');
registerColor('fast-toggle-track', GENERATED_DEFAULTS["fast-toggle-track"], 'Border Light — OFF switch track');

// Chat placeholder
registerColor('chat-placeholder-text', GENERATED_DEFAULTS["chat-placeholder-text"], 'Silver');

// Message stream (F-MSG-1/2/4)
registerColor('msg-user-bg', GENERATED_DEFAULTS["msg-user-bg"], 'Card');
registerColor('msg-user-border', GENERATED_DEFAULTS["msg-user-border"], 'Board');
registerColor('msg-user-text', GENERATED_DEFAULTS["msg-user-text"], 'Near Black');
registerColor('msg-assistant-text', GENERATED_DEFAULTS["msg-assistant-text"], 'Near Black');
registerColor('msg-tool-text', GENERATED_DEFAULTS["msg-tool-text"], 'Dark Gray — secondary');
registerColor('msg-code-block-bg', GENERATED_DEFAULTS["msg-code-block-bg"], 'Card');
registerColor('msg-code-block-border', GENERATED_DEFAULTS["msg-code-block-border"], 'Board');
// ⚠️ 名字叫 inline-code,实际语义已经是「chip / subtle hover 底」:除了可点的
// FileTargetChip,还有 13 处把它用作 hover:bg-(TextLightbox / AgentActionRow /
// ToolPayloadLightbox / ToolCallCard / ChatAudioCard)。**不要**为了调 markdown
// 行内 code 而改这里 —— 那会把那些交互反馈一起变淡。markdown 行内 code 用下面
// 单开的 msg-md-inline-code-bg。
registerColor('msg-code-inline-bg', GENERATED_DEFAULTS["msg-code-inline-bg"], 'Light Gray — chip / subtle hover 底(非 markdown 行内 code)');
// markdown 行内 code 底 —— 对齐 GitHub Primer 的 bgColor-neutral-muted。
// 半透明而非实色的两个理由:① 实色必然在某个容器底色上撞色隐形(移动端就撞过:
// 行内 code 底与消息卡片底逐字节相同 → 1.00:1,只剩圆角脏边),半透明的相对对比
// 与容器无关;② GitHub 这套值实测 light 仅 1.13:1,是「轻微的底色提示」而不是
// 色块,成段中文里嵌多个标识符也不会被切碎(12% 黑那版 1.31:1 就偏重了)。
// light / dark 刻意不同 alpha,但 dark **不照抄 GitHub 的 0.4**:
//   GitHub 原值合成后是 light 1.132:1 / dark 1.629:1 —— dark 的抬升是 light 的近 5 倍。
//   照抄到我们这儿(light 1.11~1.13 / dark 1.56~1.63,与 GitHub 逐值等观感)后,实机
//   目检的结论是深色模式明显偏重:两个模式不对称,深色下一段话里嵌几个标识符就被
//   切成一排色块。所以 dark 降到 0.22 → 1.26~1.28:1,回到「浅浅地看出有差别」。
//   light 保留 0.2:它已经是 1.11~1.13,再降就基本看不见了。
// 与可点 path chip 的区分:chip 用上面的实色 surface-chip(1.26:1)+ hover 变色 +
// cursor-pointer,本 token 只作静态提示 —— 两者数值接近,区分靠 hover 与指针形状。
//
// 与移动端刻意**不**同形态:移动端聊天流走 RN 嵌套 Text,只认 backgroundColor 不认
// borderRadius,淡底在那边只能是直角方块,所以它改用「零底色 + 文字压暗」
// (chatInlineCodeText)。本路径是 CSS,圆角淡底能真正实现,按 GitHub 原样保留。
registerColor('msg-md-inline-code-bg', GENERATED_DEFAULTS["msg-md-inline-code-bg"], 'GitHub Primer neutral-muted — markdown 行内 code 底(半透明,不随容器撞色;dark alpha 下调至 0.22)');
registerColor('msg-table-border', GENERATED_DEFAULTS["msg-table-border"], 'Board');
registerColor('msg-table-header-bg', GENERATED_DEFAULTS["msg-table-header-bg"], 'Surface');
// ── 引用块:正文主色 + 与全局 left rail 统一的竖线 ──
// 模型常用 `>` 承载本轮最该看的内容(引述的原始需求、报错原文、待确认结论),
// 弱化色让它在扫读时反而最先被跳过 —— 这是引用块唯一要修的问题,故正文改主色。
// 竖线刻意跟随 --agent-actions-rail(WorkGroupBlock / ThinkingCard /
// AgentTaskCard / AgentActionsBlock 都用它 + border-l-2):界面里「块引导竖线」
// 是一套统一的视觉语言,淡是它的设计意图,不是缺陷。引用块的识别由「内缩 +
// 这条 rail + 正文主色」共同承担,不靠加深竖线。
// 注:该 rail 对 surface 约 1.36:1(light)/ 1.64:1(dark),低于 WCAG 非文本
// 3:1 —— 这是全局既有设计语言的既定取舍,引用块与之统一优先;要调就整套 rail
// 一起调,不在引用块这里单独加深(否则引用块会比工具块更抢眼)。
registerColor('msg-blockquote-border', GENERATED_DEFAULTS["msg-blockquote-border"], 'Left rail — 与 agent actions / thinking 卡片竖线统一');
registerColor('msg-blockquote-text', GENERATED_DEFAULTS["msg-blockquote-text"], 'Near Black — 引用正文与正文同权重');
registerColor('msg-hr-border', GENERATED_DEFAULTS["msg-hr-border"], 'Board');
registerColor('msg-scrollbar', GENERATED_DEFAULTS["msg-scrollbar"], 'Board');
registerColor('msg-scrollbar-hover', GENERATED_DEFAULTS["msg-scrollbar-hover"], 'Board darker — scrollbar hover');
registerColor('msg-cursor', GENERATED_DEFAULTS["msg-cursor"], 'Near Black');
registerColor('msg-link', GENERATED_DEFAULTS["msg-link"], 'Blue 600 — clickable link');

// Tool Call Card (F-MSG-3)
registerColor('msg-tool-card-bg', GENERATED_DEFAULTS["msg-tool-card-bg"], 'Card');
registerColor('msg-tool-card-border', GENERATED_DEFAULTS["msg-tool-card-border"], 'Board');
registerColor('msg-tool-card-chevron', GENERATED_DEFAULTS["msg-tool-card-chevron"], 'Dark Gray — secondary');
registerColor('msg-tool-card-text', GENERATED_DEFAULTS["msg-tool-card-text"], 'Near Black');

// Todo Checklist Card
registerColor('todo-bar-track', GENERATED_DEFAULTS["todo-bar-track"], 'Progress bar track');
registerColor('diff-del-fg', GENERATED_DEFAULTS["diff-del-fg"], 'GitHub Diff Red (Light)');
registerColor('diff-del-bg', GENERATED_DEFAULTS["diff-del-bg"], 'GitHub Diff Red BG (Light)');
registerColor('diff-del-emphasis', GENERATED_DEFAULTS["diff-del-emphasis"], 'GitHub Diff Red inline emphasis');
registerColor('diff-add-fg', GENERATED_DEFAULTS["diff-add-fg"], 'GitHub Diff Green (Light)');
registerColor('pr-open-on-light', GENERATED_DEFAULTS["pr-open-on-light"], 'Sidebar PR open green on light surfaces (unselected Light / selected Dark pill)');
registerColor('pr-open-on-dark', GENERATED_DEFAULTS["pr-open-on-dark"], 'Sidebar PR open green on dark surfaces (unselected Dark / selected Light pill)');
registerColor('diff-add-bg', GENERATED_DEFAULTS["diff-add-bg"], 'GitHub Diff Green BG (Light)');
registerColor('diff-add-emphasis', GENERATED_DEFAULTS["diff-add-emphasis"], 'GitHub Diff Green inline emphasis');
registerColor('diff-line-num', GENERATED_DEFAULTS["diff-line-num"], 'Stone');
registerColor('info-700', GENERATED_DEFAULTS["info-700"], 'blue-700 — file/param highlight (Light)');
registerColor('agent-actions-rail', GENERATED_DEFAULTS["agent-actions-rail"], 'warm neutral — left rail (Light)');

// 图片标注(image-annotation):托盘缩略图"带标注"角标底色。语义豁免色——
// 必须与烧进图片位图的笔迹红(lightboxAnnotations.ANNOTATION_STROKE_COLOR
// #FF3B30)保持一致,笔迹是图片内容的一部分不随主题变,角标作为它的指示器
// 同样跨主题恒定;走 token 只为满足规则 16 的可寻址性,不期望被主题 override。
registerColor('annotation-accent', {
  light: '#FF3B30',
  dark: '#FF3B30',
}, 'Annotation Red — 与烧录笔迹同色,语义豁免');

// Claude 额度条只保留组件 alias；色值收敛到已批准的中性 / 告警语义槽，
// 让内置与导入主题都跟随同一语义，不再冻结一组独立暖色。
registerColor('quota-bar-fill', GENERATED_DEFAULTS["quota-bar-fill"], 'Claude 额度条正常填充(alias 到中性次要文字色)');
registerColor('quota-bar-warn', GENERATED_DEFAULTS["quota-bar-warn"], 'Claude 额度条警告填充(alias 到已批准 warning 前景)');
registerColor('quota-bar-crit', GENERATED_DEFAULTS["quota-bar-crit"], 'Claude 额度条临界填充(alias 到已批准 error 前景)');
registerColor('quota-bar-track', GENERATED_DEFAULTS["quota-bar-track"], 'Claude 额度条轨道(alias 到中性 chip 表面)');

// Running Status Bar (F-SDK-3)
registerColor('status-bar-accent', GENERATED_DEFAULTS["status-bar-accent"], 'Thinking Orange — docs/design-rules/cindy-design-system.md');
// 状态徽章前景(§7 必炸点):橙底(status-bar-accent #FF6600)深字。
// 此前橙徽章借用 accent-pure-cta-fg(白字)→ #FFFFFF×#FF6600=2.94:1 不达标;
// 拆独立 token 走深字(=text-primary/text-primary-inv),× status-bar-accent ≥4.5:1。
registerColor('status-badge-fg', GENERATED_DEFAULTS["status-badge-fg"], '状态徽章前景(§7 必炸点;default 镜像 accent-pure-cta-fg 保证既有 9 主题零变化,CINDY override #1F1F1F)');
// E4D 毛玻璃(R1 audit,用户裁决透壁纸 2026-07-17):半透明底色,仅 CINDY override 生效;
// default 不透明等价色(其他 family 行为零变化)。blur 在 CSS backdrop-filter(50px/6px)。
registerColor('surface-translucent-sidebar', GENERATED_DEFAULTS["surface-translucent-sidebar"], 'E4D 侧栏半透明底(default 等价 surface;CINDY override rgba #F6F6F6@90%/#120F0F@85% R1 模式1)');
registerColor('surface-translucent-main', GENERATED_DEFAULTS["surface-translucent-main"], 'E4D 主面板半透明底(default surface-elevated;CINDY override rgba #FFFFFF@93%/#120F0F@85% R1 模式2)');
registerColor('surface-translucent-overlay', GENERATED_DEFAULTS["surface-translucent-overlay"], 'E4D 浮层半透明底(default surface-elevated;CINDY override rgba #F6F6F6@90%/#252323@80% R1 模式3)');
// 玻璃侧栏上的搜索输入框底(2026-07-21 玻璃面 hover 半透明化配套):default 透传 surface-elevated
// 保证其余 9 主题零变化;CINDY override 半透明(light 白 55% 提亮成"可输入"字段感,dark 黑 25%
// 下陷字段感),方向与 sidebar-item-hover 的叠加方向相反,保证 hover 与输入框视觉可区分。
registerColor('sidebar-search-input-bg', GENERATED_DEFAULTS["sidebar-search-input-bg"], '玻璃侧栏搜索输入框底(default 等价 surface-elevated;CINDY override rgba 白@55%/黑@25%)');
registerColor('composer-pill-bg', GENERATED_DEFAULTS["composer-pill-bg"], 'E2 composer pill/圆钮底(输入条 pill/圆钮,比卡面浅一档刻意对比;lead Figma 实测 spec §2-3;取代错稿 glass-pill-bg)');
registerColor('composer-pill-icon', GENERATED_DEFAULTS["composer-pill-icon"], 'E2 composer pill 图标(light=text-primary #3C3F43;dark #D9D9D9;spec §2-3)');
registerColor('status-bar-meta', GENERATED_DEFAULTS["status-bar-meta"], 'Stone');

// Settings page — Ollama layer system (Light)
registerColor('settings-bg', GENERATED_DEFAULTS["settings-bg"], 'Surface');
registerColor('settings-divider', GENERATED_DEFAULTS["settings-divider"], 'Board — hairline');
registerColor('settings-back-icon', GENERATED_DEFAULTS["settings-back-icon"], 'Mid Gray — arrow glyph');
registerColor('settings-back-text', GENERATED_DEFAULTS["settings-back-text"], 'Near Black — "Settings" title');
registerColor('settings-back-hover', GENERATED_DEFAULTS["settings-back-hover"], 'Near Black — subtle hover');

// Settings - inner sidebar menu items
registerColor('settings-menu-text', GENERATED_DEFAULTS["settings-menu-text"], 'Near Black — unselected label (用户改稿 2026-07-21:与设置标题同色,不再用二级灰)');
registerColor('settings-menu-text-selected', GENERATED_DEFAULTS["settings-menu-text-selected"], 'Near Black — selected label');
registerColor('settings-menu-bg-selected', GENERATED_DEFAULTS["settings-menu-bg-selected"], 'Soft tint — selected pill');
registerColor('settings-menu-border-selected', GENERATED_DEFAULTS["settings-menu-border-selected"], 'Settings - inner sidebar menu items');
registerColor('settings-menu-bg-hover', GENERATED_DEFAULTS["settings-menu-bg-hover"], 'Subtle hover');
registerColor('settings-section-title', GENERATED_DEFAULTS["settings-section-title"], 'Near Black — section heading');
registerColor('settings-section-desc', GENERATED_DEFAULTS["settings-section-desc"], 'Mid Gray — description body');
registerColor('settings-section-sublabel', GENERATED_DEFAULTS["settings-section-sublabel"], 'Mid Gray — "Theme" sublabel');

// Settings - User card (elevated on Surface)
registerColor('settings-profile-card-bg', GENERATED_DEFAULTS["settings-profile-card-bg"], 'Card');
registerColor('settings-profile-card-border', GENERATED_DEFAULTS["settings-profile-card-border"], 'Board');
registerColor('settings-profile-avatar-bg', GENERATED_DEFAULTS["settings-profile-avatar-bg"], 'Light Gray chip');
registerColor('settings-profile-avatar-text', GENERATED_DEFAULTS["settings-profile-avatar-text"], 'Near Black');
registerColor('settings-profile-name', GENERATED_DEFAULTS["settings-profile-name"], 'Near Black');

// Settings - API Key input (pill input on Card)
registerColor('settings-input-bg', GENERATED_DEFAULTS["settings-input-bg"], 'Card');
registerColor('settings-input-border', GENERATED_DEFAULTS["settings-input-border"], 'Board');
registerColor('settings-input-border-focus', GENERATED_DEFAULTS["settings-input-border-focus"], 'Stone — focus hint');
registerColor('settings-input-text', GENERATED_DEFAULTS["settings-input-text"], 'Near Black');
registerColor('settings-input-placeholder', GENERATED_DEFAULTS["settings-input-placeholder"], 'Placeholder — 收口至 --text-placeholder slot');
registerColor('settings-eye-icon', GENERATED_DEFAULTS["settings-eye-icon"], 'Stone');
registerColor('settings-eye-icon-hover', GENERATED_DEFAULTS["settings-eye-icon-hover"], 'Near Black');
registerColor('settings-trash-icon', GENERATED_DEFAULTS["settings-trash-icon"], 'Stone — API Key clear button');
registerColor('settings-trash-icon-hover', GENERATED_DEFAULTS["settings-trash-icon-hover"], 'Near Black');
registerColor('settings-source-meta', GENERATED_DEFAULTS["settings-source-meta"], 'Silver — "Source: ..." meta');
registerColor('settings-source-link', GENERATED_DEFAULTS["settings-source-link"], 'Near Black — "Open Console" link');
registerColor('settings-error-text', GENERATED_DEFAULTS["settings-error-text"], 'Functional only');

// Settings - StatusBadge (pill on Card) — grayscale per-status ladder
registerColor('settings-badge-bg', GENERATED_DEFAULTS["settings-badge-bg"], 'Card');
registerColor('settings-badge-border', GENERATED_DEFAULTS["settings-badge-border"], 'Board');

// Per-status text/dot — Light ladder: Silver (weakest) → Stone → Pure Black (strongest)
registerColor('settings-badge-needs-config', GENERATED_DEFAULTS["settings-badge-needs-config"], 'Silver — de-emphasized "empty" state');
registerColor('settings-badge-saved', GENERATED_DEFAULTS["settings-badge-saved"], 'Stone — neutral default once persisted');
registerColor('settings-badge-connected', GENERATED_DEFAULTS["settings-badge-connected"], 'Done green — connected status indicator');
registerColor('settings-badge-connected-text', GENERATED_DEFAULTS["settings-badge-connected-text"], 'Near Black — connected badge text remains neutral');
registerColor('settings-badge-error', GENERATED_DEFAULTS["settings-badge-error"], 'Functional error only — grayscale exception');

// Settings - Primary button (Save) = Black Pill CTA
registerColor('settings-btn-primary-bg', GENERATED_DEFAULTS["settings-btn-primary-bg"], 'Near Black');
registerColor('settings-btn-primary-text', GENERATED_DEFAULTS["settings-btn-primary-text"], 'Surface ivory');
registerColor('settings-btn-primary-border', GENERATED_DEFAULTS["settings-btn-primary-border"], 'Settings - Primary button (Save) = Black Pill CTA');
registerColor('settings-btn-primary-hover-bg', GENERATED_DEFAULTS["settings-btn-primary-hover-bg"], 'Near Black');

// Settings - Secondary button (Test / Logout) = Gray Pill
registerColor('settings-btn-secondary-bg', GENERATED_DEFAULTS["settings-btn-secondary-bg"], 'Light Gray');
registerColor('settings-btn-secondary-text', GENERATED_DEFAULTS["settings-btn-secondary-text"], 'Near Black');
registerColor('settings-btn-secondary-border', GENERATED_DEFAULTS["settings-btn-secondary-border"], 'Board');
registerColor('settings-btn-secondary-hover-bg', GENERATED_DEFAULTS["settings-btn-secondary-hover-bg"], 'Board');

// Settings - Theme cards
registerColor('settings-theme-card-bg', GENERATED_DEFAULTS["settings-theme-card-bg"], 'Card');
registerColor('settings-theme-card-border', GENERATED_DEFAULTS["settings-theme-card-border"], 'Board');
registerColor('settings-social-card-pressed-bg', {
  light: 'color-mix(in srgb, var(--surface-hover) 88%, var(--text-primary) 12%)',
  dark: 'color-mix(in srgb, var(--surface-hover) 88%, var(--text-primary) 12%)',
}, 'Settings social card pressed background — visibly distinct from hover in every theme');
registerColor('settings-theme-preview-bg', GENERATED_DEFAULTS["settings-theme-preview-bg"], 'Surface — inside preview');
registerColor('settings-theme-preview-border', GENERATED_DEFAULTS["settings-theme-preview-border"], 'Board — unselected border');
registerColor('settings-theme-preview-border-active', GENERATED_DEFAULTS["settings-theme-preview-border-active"], 'Near Black — selected 2px ring');
registerColor('settings-theme-icon', GENERATED_DEFAULTS["settings-theme-icon"], 'Stone — unselected');
registerColor('settings-theme-icon-active', GENERATED_DEFAULTS["settings-theme-icon-active"], 'Near Black — selected');
registerColor('settings-theme-label', GENERATED_DEFAULTS["settings-theme-label"], 'Stone — unselected');
registerColor('settings-theme-label-active', GENERATED_DEFAULTS["settings-theme-label-active"], 'Near Black — selected');

// Auto preview gradient halves
registerColor('settings-theme-auto-light', GENERATED_DEFAULTS["settings-theme-auto-light"], 'Auto preview gradient halves');
registerColor('settings-theme-auto-dark', GENERATED_DEFAULTS["settings-theme-auto-dark"], 'Auto preview gradient halves');

// Settings - Logout button (Card surface pill)
registerColor('settings-logout-bg', GENERATED_DEFAULTS["settings-logout-bg"], 'Card');
registerColor('settings-logout-border', GENERATED_DEFAULTS["settings-logout-border"], 'Board');
registerColor('settings-logout-text', GENERATED_DEFAULTS["settings-logout-text"], 'Near Black');
registerColor('settings-logout-icon', GENERATED_DEFAULTS["settings-logout-icon"], 'Near Black');
registerColor('settings-logout-hover-bg', GENERATED_DEFAULTS["settings-logout-hover-bg"], 'Surface — gentle hover');

// Settings - Integrations row (Google + future providers)
registerColor('settings-integration-avatar-bg', GENERATED_DEFAULTS["settings-integration-avatar-bg"], 'Card on Card — neutral chip');
registerColor('settings-integration-avatar-border', GENERATED_DEFAULTS["settings-integration-avatar-border"], 'Hairline');
registerColor('settings-integration-avatar-icon', GENERATED_DEFAULTS["settings-integration-avatar-icon"], 'Mono Google G');
registerColor('settings-integration-subtitle', GENERATED_DEFAULTS["settings-integration-subtitle"], 'Stone — email / "Not connected"');
registerColor('settings-integration-warning', GENERATED_DEFAULTS["settings-integration-warning"], 'Thinking Orange — "Reconnect required" (docs/design-rules/cindy-design-system.md §2 sanctioned brand orange)');

// Remote SSH host status dot — semantic colors (sanctioned exception to the
// "no hue" rule for this widget specifically: user explicitly asked for
// 绿/橙/红/灰 status signaling, akin to focus-ring/error/warning豁免 in
// docs/design-rules/cindy-design-system.md §2). Hues are kept identical across light/dark — the dot is
// small enough that saturation issues don't arise; legibility comes from
// the dot's high-contrast position against surface, not from luminance.
registerColor('remote-status-ready', GENERATED_DEFAULTS["remote-status-ready"], 'Status — connected / ready (green)');
registerColor('remote-status-progress', GENERATED_DEFAULTS["remote-status-progress"], 'Status — connecting/authenticating/reconnecting (amber-500, 偏黄不容易在小圆点上被误读为红)');
registerColor('remote-status-failed', GENERATED_DEFAULTS["remote-status-failed"], 'Status — connect failed (red)');

// 会话状态点(AttentionDot / 列表行右槽 / 灵动岛)三态语义色 —— 同 remote-status 走
// docs/design-rules/cindy-design-system.md §2 "小状态点 hue 豁免":跨主题同色,靠位置高对比区分。
// 全端统一色表(与灵动岛 native 对齐):running=Thinking Orange(status-bar-accent)、
// awaiting=TapTap 蓝、error=红、完成未读=绿。
registerColor('card-status-awaiting', GENERATED_DEFAULTS["card-status-awaiting"], '状态点 — 待用户回复/选择 (设计定稿 2026-07-17 #19D2C1,取代 #00D9C5 冻结红线;light/dark 同值)');
registerColor('sidebar-draft-indicator', GENERATED_DEFAULTS["sidebar-draft-indicator"], '侧边栏草稿/暂停队列铅笔 — light 深青保证透明侧栏上的小图形对比度,dark 复用 awaiting 青色');
registerColor('card-status-error', GENERATED_DEFAULTS["card-status-error"], '状态点 — 任务出错 (设计定稿 2026-07-17 #D91F37,取代 #ef4444;状态族 error,非 error-flat 正文文案)');
registerColor('card-status-done', GENERATED_DEFAULTS["card-status-done"], '状态点 — 完成未读 (设计定稿 2026-07-17 #2AAE5B,取代 #22c55e;普通/定时任务完成统一,橙专职 running)');
registerColor('completion-badge-fg', GENERATED_DEFAULTS["completion-badge-fg"], '完成徽标(✓)前景 — 深墨前景压在 card-status-done 绿上,对比 5.29:1(白前景只有 2.88:1,不达 WCAG 1.4.11 非文字 3:1 门槛);light/dark 同值,与 surface-on-card 暗态的 checked icon 深前景惯例一致');
registerColor('remote-status-disconnected', GENERATED_DEFAULTS["remote-status-disconnected"], 'Status — never connected / manually disconnected (grey, neutral)');

// AskUserQuestion card (F7.3) — Light
registerColor('ask-card-bg', GENERATED_DEFAULTS["ask-card-bg"], 'Card');
registerColor('ask-card-border', GENERATED_DEFAULTS["ask-card-border"], 'Board');
registerColor('ask-header-text', GENERATED_DEFAULTS["ask-header-text"], 'Near Black');
registerColor('ask-page-text', GENERATED_DEFAULTS["ask-page-text"], 'Silver');
registerColor('ask-option-label', GENERATED_DEFAULTS["ask-option-label"], 'Near Black');
registerColor('ask-option-desc', GENERATED_DEFAULTS["ask-option-desc"], 'Stone');
registerColor('ask-option-custom', GENERATED_DEFAULTS["ask-option-custom"], 'Silver — "Type something else..."');
registerColor('ask-option-divider', GENERATED_DEFAULTS["ask-option-divider"], 'Board');
registerColor('ask-option-border', GENERATED_DEFAULTS["ask-option-border"], 'Board — options container outline');
registerColor('ask-badge-bg', GENERATED_DEFAULTS["ask-badge-bg"], 'Light Gray');
registerColor('ask-badge-text', GENERATED_DEFAULTS["ask-badge-text"], '主文字 — chip/角标文字随主题(勿接 on-dark 槽位,light 会白字压浅底)');
registerColor('ask-header-chip-bg', GENERATED_DEFAULTS["ask-header-chip-bg"], 'header chip 底 — 落在卡底上,与选项行上的序号角标(ask-badge-bg)分家,皮肤可各自调档');
registerColor('ask-option-list-bg', GENERATED_DEFAULTS["ask-option-list-bg"], '选项列表面 — 原透明露卡底在 dark 下成一坨深色(2026-07-23 用户实测),给独立列表面');
registerColor('ask-input-bg', GENERATED_DEFAULTS["ask-input-bg"], 'Card');
registerColor('ask-input-border', GENERATED_DEFAULTS["ask-input-border"], 'Board');
registerColor('ask-input-text', GENERATED_DEFAULTS["ask-input-text"], 'Near Black');
registerColor('ask-input-placeholder', GENERATED_DEFAULTS["ask-input-placeholder"], 'Placeholder — 收口至 --text-placeholder slot');
registerColor('ask-send-bg', GENERATED_DEFAULTS["ask-send-bg"], 'Near Black');
registerColor('ask-send-text', GENERATED_DEFAULTS["ask-send-text"], 'Pure White');
registerColor('ask-send-disabled-bg', GENERATED_DEFAULTS["ask-send-disabled-bg"], 'Light Gray');
registerColor('ask-send-disabled-text', GENERATED_DEFAULTS["ask-send-disabled-text"], 'Silver');
registerColor('ask-answered-text', GENERATED_DEFAULTS["ask-answered-text"], 'Stone');
registerColor('ask-expired-text', GENERATED_DEFAULTS["ask-expired-text"], 'Silver');
registerColor('ask-option-hover', GENERATED_DEFAULTS["ask-option-hover"], 'Surface — option hover');

// Checkbox — inverted/反色: Light mode = dark border unchecked, dark bg checked
registerColor('ask-checkbox-border', GENERATED_DEFAULTS["ask-checkbox-border"], 'Mid Gray — unchecked border');
registerColor('ask-checkbox-checked-bg', GENERATED_DEFAULTS["ask-checkbox-checked-bg"], 'Near Black — checked fill');
registerColor('ask-checkbox-checked-icon', GENERATED_DEFAULTS["ask-checkbox-checked-icon"], 'Pure White — checkmark');

// Plan Viewer / Plan Action cards (FP-5/FP-6) — Light
registerColor('plan-card-bg', GENERATED_DEFAULTS["plan-card-bg"], 'Card');
registerColor('plan-card-border', GENERATED_DEFAULTS["plan-card-border"], 'Board');
registerColor('plan-header-title', GENERATED_DEFAULTS["plan-header-title"], 'pen: title color');
registerColor('plan-header-hint', GENERATED_DEFAULTS["plan-header-hint"], 'Silver');
registerColor('plan-header-divider', GENERATED_DEFAULTS["plan-header-divider"], 'Board');
registerColor('plan-toolbar-btn-icon', GENERATED_DEFAULTS["plan-toolbar-btn-icon"], 'Stone');
registerColor('plan-toolbar-btn-hover-bg', GENERATED_DEFAULTS["plan-toolbar-btn-hover-bg"], 'Light Chip hover');
registerColor('plan-outline-bg', GENERATED_DEFAULTS["plan-outline-bg"], 'Card');
registerColor('plan-outline-border', GENERATED_DEFAULTS["plan-outline-border"], 'Board right divider');
registerColor('plan-outline-label', GENERATED_DEFAULTS["plan-outline-label"], 'Stone');
registerColor('plan-outline-item-text', GENERATED_DEFAULTS["plan-outline-item-text"], 'Stone');
registerColor('plan-outline-active-bg', GENERATED_DEFAULTS["plan-outline-active-bg"], 'pen: Light Chip');
registerColor('plan-outline-active-text', GENERATED_DEFAULTS["plan-outline-active-text"], 'Near Black');
registerColor('plan-content-bg', GENERATED_DEFAULTS["plan-content-bg"], 'Card');
registerColor('plan-content-section', GENERATED_DEFAULTS["plan-content-section"], 'Near Black heading');
registerColor('plan-content-body', GENERATED_DEFAULTS["plan-content-body"], 'Mid Gray body');
registerColor('plan-content-divider', GENERATED_DEFAULTS["plan-content-divider"], 'Board');
registerColor('plan-edit-body', GENERATED_DEFAULTS["plan-edit-body"], 'Mid Gray JetBrains Mono');

// Action card
registerColor('plan-action-approve-text', GENERATED_DEFAULTS["plan-action-approve-text"], 'Plan 操作卡强调主文字');
registerColor('plan-action-approve-enter', GENERATED_DEFAULTS["plan-action-approve-enter"], 'Silver');
registerColor('plan-action-row-divider', GENERATED_DEFAULTS["plan-action-row-divider"], 'Board');
registerColor('plan-action-fb-icon', GENERATED_DEFAULTS["plan-action-fb-icon"], 'Silver');
registerColor('plan-action-fb-placeholder', GENERATED_DEFAULTS["plan-action-fb-placeholder"], 'Placeholder — 收口至 --text-placeholder slot');
registerColor('plan-action-fb-text', GENERATED_DEFAULTS["plan-action-fb-text"], 'Plan 反馈输入强调主文字');
registerColor('plan-action-row-hover-bg', GENERATED_DEFAULTS["plan-action-row-hover-bg"], 'Surface hover');
registerColor('plan-action-approve-icon-bg', GENERATED_DEFAULTS["plan-action-approve-icon-bg"], 'Action card');
registerColor('plan-action-approve-icon-fg', GENERATED_DEFAULTS["plan-action-approve-icon-fg"], 'Action card');

// Minimized bar
registerColor('plan-min-title', GENERATED_DEFAULTS["plan-min-title"], 'Minimized bar');
registerColor('plan-min-icon', GENERATED_DEFAULTS["plan-min-icon"], 'Minimized bar');

// History bubbles (FP-8) — grayscale per docs/design-rules/cindy-design-system.md
registerColor('plan-bubble-badge-bg', GENERATED_DEFAULTS["plan-bubble-badge-bg"], 'Light Gray chip');
registerColor('plan-bubble-badge-text', GENERATED_DEFAULTS["plan-bubble-badge-text"], '主文字 — badge 文字随主题(勿接 on-dark 槽位)');
registerColor('plan-bubble-body-text', GENERATED_DEFAULTS["plan-bubble-body-text"], 'Mid Gray');
registerColor('plan-bubble-summary-text', GENERATED_DEFAULTS["plan-bubble-summary-text"], 'Stone');
registerColor('color-primary', GENERATED_DEFAULTS["color-primary"], '= foreground');
registerColor('color-neutral-300', GENERATED_DEFAULTS["color-neutral-300"], 'History bubbles (FP-8) — grayscale per docs/design-rules/cindy-design-system.md');
registerColor('color-neutral-400', GENERATED_DEFAULTS["color-neutral-400"], 'Silver');
registerColor('color-error-600', GENERATED_DEFAULTS["color-error-600"], 'Danger');
registerColor('color-error-700', GENERATED_DEFAULTS["color-error-700"], 'Danger hover');

/* === P3.1: focus / shadow / overlay / error / warning 语义槽 === */
registerColor('focus-ring', GENERATED_DEFAULTS["focus-ring"], 'Opaque a11y focus border(设计定稿 2026-07-17 #417CDD,取代 blue-500 #3b82f6)');
registerColor('focus-ring-soft', GENERATED_DEFAULTS["focus-ring-soft"], '50% alpha focus ring(随 focus-ring #417CDD,定稿 2026-07-17)— 替代 ring-[#xxx]/50 写法');
registerColor('text-selection-bg', GENERATED_DEFAULTS["text-selection-bg"], '文字选中背景(焦点离开宿主窗口时仍保持清晰可见)');
// 小胶囊(引擎选择、rail 格)的选中「浮起」阴影 —— 比 shadow-menu 轻一个量级:
// 26px 高的 chip 套 4px/16px 的菜单阴影会糊成一团灰。Dark 下加深,否则在深底上看不见。
registerColor('shadow-chip-raised', GENERATED_DEFAULTS["shadow-chip-raised"], '小胶囊选中态的浮起 shadow');
registerColor('shadow-menu', GENERATED_DEFAULTS["shadow-menu"], 'Dropdown / context menu / 中型悬浮卡 shadow');
registerColor('overlay-modal', GENERATED_DEFAULTS["overlay-modal"], '常规模态 backdrop');
registerColor('overlay-lightbox', GENERATED_DEFAULTS["overlay-lightbox"], '图片/视频/mermaid lightbox 深 backdrop');
// lightbox chrome(胶囊工具栏):浮在恒黑 backdrop 上,跨主题恒定,语义豁免类
// (同 overlay-lightbox);仍注册为 token 保留主题 override 能力(规则 16)。
registerColor('lightbox-toolbar-bg', GENERATED_DEFAULTS["lightbox-toolbar-bg"], 'lightbox 胶囊工具栏底色(恒黑 backdrop 上)');
registerColor('lightbox-toolbar-border', GENERATED_DEFAULTS["lightbox-toolbar-border"], 'lightbox 胶囊工具栏描边/分隔线');
registerColor('lightbox-toolbar-fg', GENERATED_DEFAULTS["lightbox-toolbar-fg"], 'lightbox 胶囊工具栏图标默认色(语义豁免,理由同 lightbox-toolbar-bg)');
registerColor('lightbox-toolbar-fg-hover', GENERATED_DEFAULTS["lightbox-toolbar-fg-hover"], 'lightbox 胶囊工具栏图标 hover 色(语义豁免,理由同上)');
registerColor('lightbox-toolbar-hover-bg', GENERATED_DEFAULTS["lightbox-toolbar-hover-bg"], 'lightbox 胶囊工具栏按钮 hover 背景(语义豁免,理由同上)');
registerColor('error-bg', GENERATED_DEFAULTS["error-bg"], '错误警告卡片背景');
registerColor('error-border', GENERATED_DEFAULTS["error-border"], '错误卡片边框');
registerColor('error-fg', GENERATED_DEFAULTS["error-fg"], '错误卡片正文/图标');
registerColor('error-fg-strong', GENERATED_DEFAULTS["error-fg-strong"], '错误卡片强调文字');
registerColor('warning-bg-soft', GENERATED_DEFAULTS["warning-bg-soft"], 'Warning alpha surface (FeishuConflictDialog 类警告 badge;alpha 随 warning-accent #EA6B17 同步重算 2026-07-17)');
registerColor('warning-fg', GENERATED_DEFAULTS["warning-fg"], '警示强调文字/图标(设计定稿 2026-07-17 #F3A115;与 Toast amber #F59E0B 解耦——Toast 维持 B 组现状,本 token 走定稿前景)');
// 伙伴(Bot)界面的状态语义四件套。
//
// 这四个 token 此前被 Bot 各面(设置页错误文案、自动化状态点、健康态勾、
// 委派进行中指示器)裸引用却从未注册,:root 读不到值 → `color` / `background-color`
// 声明在计算值阶段整条作废:错误文字继承成正文色(报错看着不像报错)、成功勾和
// 状态点直接没颜色。属于 tokenRegistry.test.ts 里写明的「幽灵 token」,按该文件
// 的规矩补注册,不在消费点撒 fallback。
//
// 三个走 alias:错误族直接复用既有 error-* 语义槽,info 复用 info-700
// 与任务状态的既有 fallback 同源,这样非默认
// 主题对 error-* / info-700 的 override 能自动流下来,不会有一族颜色脱队。
registerColor('text-danger', GENERATED_DEFAULTS["text-danger"], '伙伴界面 danger 前景 — alias 到 error-fg(错误文案 / 删除类动作 hover)');
registerColor('danger-bg-soft', GENERATED_DEFAULTS["danger-bg-soft"], '伙伴界面 danger 软背景 — alias 到 error-bg(危险区块底 / destructive 按钮 hover)');
registerColor('status-info', GENERATED_DEFAULTS["status-info"], '伙伴界面「进行中」状态色 — alias 到 info-700');
// success 不 alias 到状态点 card-status-done:那颗绿(#2AAE5B)是按**非文字** 3:1
// 选的,而本 token 同时被当正文色用(健康态标签、自动化「已启用」),压在 Light 的
// surface 上只有 2.56:1。故 Light 取同色相压深的 #177C3C(surface 4.69 /
// elevated 5.17 / chip 4.53,三种底都过 4.5),Dark 维持定稿 #2AAE5B(5.73~6.18)。
// 深浅两侧一深一浅的走法与 error-fg(#dc2626 / #f87171)一致。
registerColor('status-success', GENERATED_DEFAULTS["status-success"], '伙伴界面「成功 / 健康 / 已启用」状态色(Light 压深至文字可读档,Dark 用状态族定稿绿)');
// cc-mgr 远端升级 banner (UpgradeBanner.tsx) — amber warning 语义,跨主题统一、语义豁免
// (规则 15:warning/amber 在豁免范围,不被非默认主题 override,但仍走 token)。
registerColor('upgrade-banner-bg', GENERATED_DEFAULTS["upgrade-banner-bg"], 'cc-mgr 升级 banner 背景 (amber warning, 语义豁免)');
registerColor('upgrade-banner-border', GENERATED_DEFAULTS["upgrade-banner-border"], 'cc-mgr 升级 banner 边框 (amber warning, 语义豁免)');
registerColor('upgrade-banner-fg', GENERATED_DEFAULTS["upgrade-banner-fg"], 'cc-mgr 升级 banner 正文/图标/按钮 (amber warning, 语义豁免)');
// Skill Hub 审核状态 badge (publishedStatus.ts) — warning 语义豁免,跨主题统一。
// 机审中 (pending/scanning) 橙色 / 人工复核中 (quarantine) 黄色;审核未通过 (rejected) 复用 error-* token。
registerColor('skillhub-review-pending-bg', GENERATED_DEFAULTS["skillhub-review-pending-bg"], 'Skill Hub 机审中 badge 背景 (orange warning, 语义豁免)');
registerColor('skillhub-review-pending-border', GENERATED_DEFAULTS["skillhub-review-pending-border"], 'Skill Hub 机审中 badge 边框 (orange warning, 语义豁免)');
registerColor('skillhub-review-pending-fg', GENERATED_DEFAULTS["skillhub-review-pending-fg"], 'Skill Hub 机审中 badge 文字 (orange warning, 语义豁免)');
registerColor('skillhub-review-quarantine-bg', GENERATED_DEFAULTS["skillhub-review-quarantine-bg"], 'Skill Hub 人工复核中 badge 背景 (yellow warning, 语义豁免)');
registerColor('skillhub-review-quarantine-border', GENERATED_DEFAULTS["skillhub-review-quarantine-border"], 'Skill Hub 人工复核中 badge 边框 (yellow warning, 语义豁免)');
registerColor('skillhub-review-quarantine-fg', GENERATED_DEFAULTS["skillhub-review-quarantine-fg"], 'Skill Hub 人工复核中 badge 文字 (yellow warning, 语义豁免)');

// CREATE AGENT composer controls — Figma 185:1495 / 185:2724, E2-S 2026-07-17.
// These private tokens are exact light/dark values for the new-page solid
// composer controls. Do not reuse for the session-view glass composer pills.
registerColor('create-agent-control-bg', GENERATED_DEFAULTS["create-agent-control-bg"], 'CREATE AGENT pill / icon button background');
registerColor('create-agent-control-bg-hover', GENERATED_DEFAULTS["create-agent-control-bg-hover"], 'CREATE AGENT neutral hover background');
registerColor('create-agent-control-bg-pressed', GENERATED_DEFAULTS["create-agent-control-bg-pressed"], 'CREATE AGENT neutral pressed background');
registerColor('create-agent-control-border', GENERATED_DEFAULTS["create-agent-control-border"], 'CREATE AGENT pill / icon button border');
registerColor('create-agent-control-text', GENERATED_DEFAULTS["create-agent-control-text"], 'CREATE AGENT pill text');
registerColor('create-agent-control-icon', GENERATED_DEFAULTS["create-agent-control-icon"], 'CREATE AGENT icon / chevron');
registerColor('create-agent-segment-track-bg', GENERATED_DEFAULTS["create-agent-segment-track-bg"], 'CREATE AGENT Claude/Codex segmented track');
registerColor('create-agent-segment-inactive-text', GENERATED_DEFAULTS["create-agent-segment-inactive-text"], 'CREATE AGENT segmented inactive text');
registerColor('create-agent-send-bg', GENERATED_DEFAULTS["create-agent-send-bg"], 'CREATE AGENT send button inverse neutral bg');
registerColor('create-agent-send-icon', GENERATED_DEFAULTS["create-agent-send-icon"], 'CREATE AGENT send button inverse neutral icon');
registerColor('create-agent-send-bg-hover', GENERATED_DEFAULTS["create-agent-send-bg-hover"], 'CREATE AGENT send button neutral hover bg');
registerColor('create-agent-send-bg-pressed', GENERATED_DEFAULTS["create-agent-send-bg-pressed"], 'CREATE AGENT send button neutral pressed bg');
registerColor('create-agent-send-disabled-bg', GENERATED_DEFAULTS["create-agent-send-disabled-bg"], 'CREATE AGENT send button disabled bg');
registerColor('create-agent-send-disabled-icon', GENERATED_DEFAULTS["create-agent-send-disabled-icon"], 'CREATE AGENT send button disabled icon');
registerColor('create-agent-focus-ring', GENERATED_DEFAULTS["create-agent-focus-ring"], 'CREATE AGENT neutral focus border');
registerColor('create-agent-quick-card-bg', GENERATED_DEFAULTS["create-agent-quick-card-bg"], 'CREATE AGENT quick-start card background');
registerColor('create-agent-quick-card-border', GENERATED_DEFAULTS["create-agent-quick-card-border"], 'CREATE AGENT quick-start card border');
registerColor('create-agent-quick-card-text', GENERATED_DEFAULTS["create-agent-quick-card-text"], 'CREATE AGENT quick-start card text');
registerColor('create-agent-quick-card-icon-bg', GENERATED_DEFAULTS["create-agent-quick-card-icon-bg"], 'CREATE AGENT quick-start icon circle background');
registerColor('create-agent-quick-card-icon', GENERATED_DEFAULTS["create-agent-quick-card-icon"], 'CREATE AGENT quick-start icon');
registerColor('create-agent-quick-card-bg-hover', GENERATED_DEFAULTS["create-agent-quick-card-bg-hover"], 'CREATE AGENT quick-start card neutral hover background');
registerColor('create-agent-avatar-ring', GENERATED_DEFAULTS["create-agent-avatar-ring"], 'CREATE AGENT lockup avatar outer ring');
registerColor('create-agent-avatar-glass-bg', GENERATED_DEFAULTS["create-agent-avatar-glass-bg"], 'CREATE AGENT lockup avatar GLASS fill');
registerColor('create-agent-avatar-inner-ring-start', GENERATED_DEFAULTS["create-agent-avatar-inner-ring-start"], 'CREATE AGENT lockup avatar inner gradient ring start');
registerColor('create-agent-avatar-inner-ring-end', GENERATED_DEFAULTS["create-agent-avatar-inner-ring-end"], 'CREATE AGENT lockup avatar inner gradient ring end');
registerColor('sidebar-nav-text', GENERATED_DEFAULTS["sidebar-nav-text"], 'CINDY sidebar top nav icon / text');
registerColor('sidebar-list-muted', GENERATED_DEFAULTS["sidebar-list-muted"], 'CINDY sidebar section and project list muted text');
registerColor('sidebar-user-card-bg', GENERATED_DEFAULTS["sidebar-user-card-bg"], 'CINDY sidebar user capsule background');
registerColor('sidebar-user-card-bg-hover', GENERATED_DEFAULTS["sidebar-user-card-bg-hover"], 'CINDY sidebar user capsule hover background (light darkens on near-white sidebar, dark lightens)');
registerColor('sidebar-user-card-border', GENERATED_DEFAULTS["sidebar-user-card-border"], 'CINDY sidebar user capsule border');
registerColor('sidebar-user-card-text', GENERATED_DEFAULTS["sidebar-user-card-text"], 'CINDY sidebar user capsule text and icon');
registerColor('caret-accent', GENERATED_DEFAULTS["caret-accent"], 'Editable caret accent; CINDY overrides to focus blue #417CDD per user decision 2026-07-18(撤红改蓝)');

// DS-4 Button 状态矩阵（G2 hover 换色 / G3 pressed）。拍板人 = 用户/设计师，2026-09-03。
//
// 为什么 hover / pressed 是 color-mix 派生值而不是 alias 到既有 slot：
// 暗色下 `--surface-hover` 与 `--surface-chip` 本就同值（default-dark / cindy-dark /
// one-dark-pro / monokai-pro 实测），primary rest 与 hover 会撞成同色 —— 悬停零反馈，
// 违反 DESIGN.md §10 双模式交付门槛「状态不可区分即真实缺陷」。secondary 的
// `--surface-hover-soft` 同样在 atom-one-light / cindy-dark / eclipse / github-dark
// 贴着 `--surface-elevated`（CINDY 暗色只差 2/255）。
// 因此改为「从本变体的 rest 底色朝本变体的前景色推一档」：hover 8%、pressed 再 10%。
// 这套派生按主题自动跟随（rest 与前景都是被 override 的 token），11 个内置主题实测
// 每一级 ΔRGB ≥ 8；也不再引入不跟主题的字面量。运行期派生值按治理合同 §3.4
// 留在代码中、只登记不进 DTCG 影子层（classification 里为
// runtime-derived-or-protected）。
registerColor('button-primary-hover', {
  light: 'color-mix(in srgb, var(--surface-chip) 92%, var(--text-primary))',
  dark: 'color-mix(in srgb, var(--surface-chip) 92%, var(--text-primary))',
}, 'DS-4 button/primary hover — rest 底色朝 text-primary 推 8%');
registerColor('button-primary-pressed', {
  light: 'color-mix(in srgb, var(--button-primary-hover) 90%, var(--text-primary))',
  dark: 'color-mix(in srgb, var(--button-primary-hover) 90%, var(--text-primary))',
}, 'DS-4 button/primary pressed — 自 hover 再推 10%，保证梯子单调');
registerColor('button-secondary-hover', {
  light: 'color-mix(in srgb, var(--surface-elevated) 92%, var(--text-primary))',
  dark: 'color-mix(in srgb, var(--surface-elevated) 92%, var(--text-primary))',
}, 'DS-4 button/secondary hover — rest 底色朝 text-primary 推 8%');
registerColor('button-secondary-pressed', {
  light: 'color-mix(in srgb, var(--button-secondary-hover) 90%, var(--text-primary))',
  dark: 'color-mix(in srgb, var(--button-secondary-hover) 90%, var(--text-primary))',
}, 'DS-4 button/secondary pressed — 自 hover 再推 10%');
// cta hover 沿用 §4 既有规定的 --accent-hover（其注释本写明 "CTA pressed/hover"），
// 只给 Button 一个组件级名字，便于 DS-8 生成 component 层时落回 semantic。
registerColor('button-cta-hover', GENERATED_DEFAULTS["button-cta-hover"], 'DS-4 button/cta hover — 沿用 --accent-hover（DESIGN.md §4）');
registerColor('button-cta-pressed', {
  light: 'color-mix(in srgb, var(--button-cta-hover) 90%, var(--accent-pure-cta-fg))',
  dark: 'color-mix(in srgb, var(--button-cta-hover) 90%, var(--accent-pure-cta-fg))',
}, 'DS-4 button/cta pressed — 自 cta hover 朝 CTA 前景再推 10%');
