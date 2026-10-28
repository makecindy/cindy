import type { Theme } from '../types';
import cindyLogoDark from '../../assets/cindy-logo-dark.png';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../../shared/windowBackdrop';

/*
 * CINDY Dark — 品牌红 CTA + 中性近黑底(#181818)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: token-decision-table.md §3(2026-07-17 U8 批准) + §9(2026-08 色阶改版,用户批准)。
 * §9 要点: 整体平移变暗且归零暖差、三级色等亮度转中性;已知债(层次保留率 ~65%)见 issue #2559。
 * 每个 override 注释来源;零自由裁量。
 */

// 既有分组/对比度/否决依据：docs/design-rules/design-decision-log.md
// 「2026-09-11 DS-8 内置主题依据迁移」→ cindy-dark（生成区外保留）。
// BEGIN GENERATED DS-8: theme
const GENERATED_OVERRIDES = {
  "surface": "#181818", // 直映: 页底(纯中性)
  "surface-hsl": "0 0% 9.4%", // 页底 -> HSL
  "surface-elevated": "#1F1F1F", // 卡片/输入框
  "surface-elevated-soft": "#1D1D1D", // hover/chip
  "surface-card-ivory": "#1F1F1F", // 卡片/输入框
  "surface-chip": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-chip-alt": "#1D1D1D", // hover/chip
  "surface-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-hover-soft": "rgba(255, 255, 255, 0.04)", // 墨水 白 4%: 柔和悬停(2026-10-22 用户裁决,取代实色灰)
  "surface-hover-hsl": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-on-card": "#181818", // 直映: 页底(纯中性)
  "switch-track-off": "#787878", // 关闭态轨道:值与依据见决策表(用户调参 2026-08-05)
  "switch-track-on": "#417CDD", // 开启态轨道:蓝色 #417CDD(用户裁决 2026-09-15)
  "switch-thumb-on": "#FCFCFC", // Switch 滑块:用户批准 HTML 效果 2026-09-16;暗色近白,浅色沿用原有别名
  "switch-thumb-off": "#FCFCFC", // Switch 滑块:用户批准 HTML 效果 2026-09-16;暗色近白,浅色沿用原有别名
  "fast-toggle-track": "var(--switch-track-off)", // Fast/思考小开关的关闭轨道跟随开关关闭轨道:文字改墨水后不再借用禁用文字色,两类开关关闭态一致并保住 3:1(2026-10-22 用户裁决随附)
  "status-badge-fg": "#121212", // 反相深字: 平移
  "border-default": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-default-hsl": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-shadcn-hsl": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-transparent-mixed": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "text-primary": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-primary-on-dark": "#FFFFFF", // 深底/红底前景白
  "text-primary-emphasis": "rgba(255, 255, 255, 1.00)", // 墨水 白 100%: 强调文字(2026-10-22 用户裁决,取代实色灰)
  "text-primary-inv": "#181818", // 直映: 页底(纯中性)
  "text-primary-body-strong": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-primary-hsl": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-secondary": "rgba(255, 255, 255, 0.55)", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-secondary-cross": "rgba(255, 255, 255, 0.40)", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "text-secondary-mid": "rgba(255, 255, 255, 0.66)", // 墨水 白 66%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary": "rgba(255, 255, 255, 0.40)", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-stone": "rgba(255, 255, 255, 0.55)", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-mid": "rgba(255, 255, 255, 0.66)", // 墨水 白 66%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-hsl": "0.0 0.0% 100.0% / 0.55", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-disabled": "rgba(255, 255, 255, 0.30)", // 墨水 白 30%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "text-disabled-tertiary": "rgba(255, 255, 255, 0.40)", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "accent-cta-bg": "#EEEEEE", // E1D 反相中性底
  "accent-cta-bg-pure": "#EEEEEE", // E1D 反相中性底
  "accent-emphasis": "#EEEEEE", // E1D 反相中性底
  "accent-soft": "#D4D4D4", // E1D pressed 中性
  "accent-hover": "#E2E2E2", // E1D hover 中性
  "accent-pure-cta-fg": "#151515", // 反相深字(浅钮上)
  "accent": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "agent-actions-rail": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "ask-checkbox-border": "rgba(255, 255, 255, 0.66)", // 墨水 白 66%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "ask-header-chip-bg": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "ask-send-disabled-bg": "#282828", // 菜单 hover/提问卡纸片档
  "ask-option-list-bg": "#282828", // 菜单 hover/提问卡纸片档
  "ask-option-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "background": "0 0% 9.4%", // 页底 -> HSL
  "chat-input-bg": "#1F1F1F", // 卡片/输入框
  "chat-input-border-focus": "rgba(193, 193, 193, 0.30)", // 聚焦描边: 三级色 30% 派生
  "chat-input-chip-border": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "chat-input-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "chat-input-placeholder-subtle": "var(--text-placeholder)", // 聊天输入框占位文字直接用占位档,不再叠 40% 透明度(2026-10-22 用户裁决随附:占位文字统一用占位档)
  "thinking-body-text": "var(--text-secondary)", // 思考过程正文用次要档(2026-10-23 用户裁决:三级在墨水阶梯里过淡,浅色 3.2、深色 3.8;次要浅色与改前持平 4.8、深色 6.1)
  "color-primary": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "caret-accent": "#417CDD", // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  "confirm-bg": "#1F1F1F", // 卡片/输入框
  "confirm-btn-primary-bg": "#EEEEEE", // E1D C 类裁决 1:反相中性
  "confirm-btn-primary-text": "#151515", // 反相深字(浅钮上)
  "confirm-btn-secondary-border": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "confirm-btn-secondary-hover": "rgba(255, 255, 255, 0.08)", // 中性 alpha hover
  "confirm-btn-secondary-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "confirm-title": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "file-chip-bg": "rgba(255, 255, 255, 0.13)", // 墨水 白 13%: 加深底(2026-10-22 用户裁决,取代实色灰)
  "file-remove-bg": "rgba(255, 255, 255, 0.66)", // 墨水 白 66%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "info-700": "#93C5FD", // 信息/链接蓝
  "model-trigger-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "model-item-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "msg-link": "#93C5FD", // 链接蓝
  "msg-scrollbar-hover": "rgba(255, 255, 255, 0.13)", // 墨水 白 13%: 加深底(2026-10-22 用户裁决,取代实色灰)
  "msg-user-bg": "#1F1F1F", // 卡片/输入框
  "muted": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "muted-foreground": "0.0 0.0% 100.0% / 0.55", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "perm-auto-selected-text": "#417CDD", // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  "perm-allow-btn-bg": "#EEEEEE", // E1D C 类裁决 2:反相中性
  "perm-allow-btn-text": "#151515", // 反相深字(浅钮上)
  "perm-allow-kbd-bg": "rgba(0, 0, 0, 0.08)", // kbd bg:随反相浅钮的深翻译层(修复 2026-07-19:原页面级深灰在浅钮上吞掉近黑字)
  "perm-allow-kbd-border": "rgba(0, 0, 0, 0.20)", // 边框:同上
  "perm-code-bg": "#191919", // 柔和 hover/代码块底
  "perm-item-selected-bg": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "plan-outline-active-bg": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "plan-toolbar-btn-hover-bg": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "popover": "0 0% 12.2%", // 卡片 -> HSL
  "primary-foreground": "0.0 0.0% 100.0%", // 白前景
  "search-match-fg": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "secondary": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "settings-btn-primary-text": "#151515", // 反相深字(浅钮上)
  "settings-btn-secondary-hover-bg": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "text-placeholder": "rgba(255, 255, 255, 0.30)", // 墨水 白 30%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "settings-integration-avatar-bg": "#1D1D1D", // hover/chip
  "settings-logout-bg": "#1F1F1F", // 卡片/输入框
  "settings-menu-bg-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "settings-menu-bg-selected": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "settings-source-link": "#93C5FD", // 可访问链接蓝
  "settings-theme-auto-dark": "#181818", // Auto 预览: 新暗色底
  "sidebar-action-icon": "0.0 0.0% 100.0% / 0.40", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "cmd-palette-item-meta": "rgba(255, 255, 255, 0.55)", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "sidebar-item-active-foreground": "#151515", // 反相深字(浅钮上)
  "sidebar-item-active-border": "transparent", // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  "sidebar-item-active": "0.0 0.0% 93.3%", // 用户二次改稿 2026-07-20:反相胶囊 #EEEEEE 浅底(同 accent-cta-bg)
  "splash-bg": "0 0% 9.4%", // 页底 -> HSL
  "splash-text": "0.0 0.0% 100.0% / 0.55", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "splash-text-destructive": "0.0 0.0% 100.0%", // destructive splash text
  "splash-text-muted": "0.0 0.0% 100.0% / 0.40", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "titlebar-icon": "0.0 0.0% 100.0% / 0.55", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "tooltip-bg": "#181818", // 直映: 页底(纯中性)
  "tooltip-text": "#FFFFFF", // tooltip 白字
  "update-btn-border": "#EEEEEE", // E1D 中性底(实心胶囊,与 bg 同色)
  "update-btn-bg": "#EEEEEE", // E1D §15.10 反相中性:dark 浅底,承载深字
  "update-btn-text": "#151515", // 反相深字(浅钮上)
  "update-btn-hover": "#E2E2E2", // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  "accent-foreground": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "panel-bg": "#181818", // 直映: 页底(纯中性)
  "primary": "0.0 0.0% 93.3%", // E1D C 类裁决 3:反相中性 HSL
  "ring": "217.3 69.7% 56.1%", // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  "settings-theme-auto-light": "#F2F2ED", // Auto 预览: 新页底(暖象牙)
  "foreground": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "border": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "input": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "secondary-foreground": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "popover-foreground": "0.0 0.0% 100.0% / 0.82", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "titlebar": "0 0% 9.4%", // 页底 -> HSL
  "titlebar-border": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "titlebar-button-hover": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "titlebar-control-hover": "0.0 0.0% 100.0% / 0.06", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "sidebar": "0 0% 9.4%", // 页底 -> HSL
  "sidebar-border": "0.0 0.0% 100.0% / 0.10", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "sidebar-item-hover": "0.0 0.0% 100.0% / 0.09", // 玻璃面 hover 半透明化 2026-07-21:白 9% 叠加(原实色 hsl(0 2.2% 18%) 在暗玻璃底上的等价叠加量),壁纸可继续透过
  "sidebar-search-bg": "0 0% 9.4%", // 页底 -> HSL
  "sidebar-search-input-bg": "rgba(0, 0, 0, 0.25)", // 玻璃面搜索输入框 2026-07-21:黑 25% 下陷字段感(与 hover 白 9% 方向相反,可区分"可输入")
  "sidebar-muted": "0.0 0.0% 100.0% / 0.55", // 墨水 白 55%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "surface-translucent-main": "#181818", // 直映: 页底(纯中性)
  "surface-translucent-overlay": "rgba(21, 21, 21, 0.80)", // 浮层玻璃: 平移
  "composer-pill-bg": "#272727", // composer pill
  "composer-pill-icon": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "send-btn-bg": "#EEEEEE", // R4 D1/D2 反相中性可用底
  "send-btn-icon": "#151515", // 反相深字(浅钮上)
  "send-btn-disabled-bg": "#323232", // 禁用底/option hover 档
  "send-btn-disabled-icon": "#464646", // 禁用图标
  "send-btn-hover-bg": "#E2E2E2", // E1D 反相中性 hover(lead 四态)
  "send-btn-pressed-bg": "#D4D4D4", // E1D 反相中性 pressed(lead 四态)
  "completion-badge-fg": "#121212", // 反相深字: 平移
  "create-agent-control-bg": "#272727", // composer pill
  "create-agent-control-bg-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-bg-pressed": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-border": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-bg": "#1F1F1F", // 卡片/输入框
  "create-agent-quick-card-bg-hover": "rgba(255, 255, 255, 0.06)", // 墨水 白 6%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-border": "rgba(255, 255, 255, 0.10)", // 墨水 白 10%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-icon-bg": "#181818", // 直映: 页底(纯中性)
  "create-agent-segment-track-bg": "#181818", // 直映: 页底(纯中性)
  "create-agent-send-disabled-bg": "#323232", // 禁用底/option hover 档
  "create-agent-send-disabled-icon": "rgba(255, 255, 255, 0.30)", // 墨水 白 30%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "create-agent-send-icon": "#151515", // 反相深字(浅钮上)
  "md-table-bg": "rgba(26, 26, 26, 0.55)", // 表格条纹: 平移
  "ask-badge-bg": "var(--surface-chip)",
  "cmd-palette-item-hover": "var(--surface-hover)",
  "create-agent-control-icon": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-icon": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-segment-inactive-text": "rgba(255, 255, 255, 0.40)", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "settings-integration-avatar-border": "rgba(255, 255, 255, 0.08)",
  "sidebar-list-muted": "rgba(255, 255, 255, 0.40)", // 墨水 白 40%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "sidebar-nav-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "sidebar-user-card-bg-hover": "rgba(255, 255, 255, 0.10)",
  "sidebar-user-card-border": "rgba(255, 255, 255, 0.13)",
  "sidebar-user-card-text": "rgba(255, 255, 255, 0.82)", // 墨水 白 82%: 正文(2026-10-22 用户裁决,取代实色灰)
  "slider-track": "#626262", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "slider-fill": "#EEEEEE", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "slider-thumb": "#FCFCFC", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "segmented-selected-bg": "#353535",
  "segmented-selected-border": "#3B3B3B",
  "segmented-option-fg": "#AAAAAA",
  "segmented-hover-bg": "#292929",
} as const;
// END GENERATED DS-8: theme



export const cindyDark: Theme = {
  id: 'cindy-dark',
  name: 'CINDY Dark',
  type: 'dark',
  colors: {
    ...GENERATED_OVERRIDES,
    "surface-translucent-sidebar": CINDY_ACRYLIC_WINDOW_BACKING.dark,
  },
  // U5 品牌版横向 logo：白字+红箭头，深底可见。
  brand: { logo: { src: cindyLogoDark } },
};
