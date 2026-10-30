import type { Theme } from '../types';
import cindyLogoLight from '../../assets/cindy-logo-light.png';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../../shared/windowBackdrop';

/*
 * CINDY Light — 品牌红 CTA + 暖象牙底(#F2F2ED)+ AA 正文。
 * 值的唯一权威: token-decision-table.md §3(2026-07-17 U8 批准) + §9(2026-08 色阶改版,用户批准)。
 * §9 要点: 面/边框全暖(B=R-5)、文字渐进暖、二级抬到 >=3.0(取代 U2 light 原值)、
 * 交互态分页面/卡片双锚定。每个 override 注释来源;零自由裁量。
 */

// 既有分组/对比度/否决依据：docs/design-rules/design-decision-log.md
// 「2026-09-11 DS-8 内置主题依据迁移」→ cindy-light（生成区外保留）。
// BEGIN GENERATED DS-8: theme
const GENERATED_OVERRIDES = {
  "surface": "#F2F2ED", // 直映: 页底(暖象牙)
  "surface-hsl": "60.0 16.1% 93.9%", // 页底 -> HSL
  "surface-elevated": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "surface-elevated-soft": "#FAFAF5", // 阶梯: 次级卡片
  "surface-card-ivory": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "surface-chip": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-chip-alt": "#FAFAF5", // 阶梯: 次级卡片
  "surface-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-hover-soft": "rgba(0, 0, 0, 0.035)", // 墨水 黑 3.5%: 柔和悬停(2026-10-22 用户裁决,取代实色灰)
  "surface-hover-hsl": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "surface-on-card": "#FFFFFF", // 裁决: 中性反相前景,不作红 CTA 专用
  "switch-track-off": "#808080", // 关闭态轨道: 悬停底加深后由 #888888 加深到 #808080,压在悬停行上保住 3:1(2026-10-22 用户裁决)
  "switch-track-on": "#417CDD", // 开启态轨道:蓝色 #417CDD(用户裁决 2026-09-15)
  "switch-thumb-on": "hsl(var(--background))", // Switch 滑块:用户批准 HTML 效果 2026-09-16;暗色近白,浅色沿用原有别名
  "switch-thumb-off": "var(--surface-on-card)", // Switch 滑块:用户批准 HTML 效果 2026-09-16;暗色近白,浅色沿用原有别名
  "fast-toggle-track": "var(--switch-track-off)", // Fast/思考小开关的关闭轨道跟随开关关闭轨道:文字改墨水后不再借用禁用文字色,两类开关关闭态一致并保住 3:1(2026-10-22 用户裁决随附)
  "status-badge-fg": "#1F1F1F", // §7 必炸点:值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17
  "border-default": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-default-hsl": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-shadcn-hsl": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "border-transparent-mixed": "transparent", // light transparent / dark 边框
  "text-primary": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-primary-on-dark": "#FFFFFF", // 深底/红底前景白
  "text-primary-emphasis": "rgba(0, 0, 0, 0.95)", // 墨水 黑 95%: 强调文字(2026-10-22 用户裁决,取代实色灰)
  "text-primary-inv": "#FFFFFF", // 反相文字
  "text-primary-body-strong": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-primary-hsl": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "text-secondary": "rgba(0, 0, 0, 0.56)", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-secondary-cross": "rgba(0, 0, 0, 0.44)", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "text-secondary-mid": "rgba(0, 0, 0, 0.70)", // 墨水 黑 70%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary": "rgba(0, 0, 0, 0.44)", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-stone": "rgba(0, 0, 0, 0.56)", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-mid": "rgba(0, 0, 0, 0.70)", // 墨水 黑 70%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "text-tertiary-hsl": "0.0 0.0% 0.0% / 0.56", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "text-disabled": "rgba(0, 0, 0, 0.32)", // 墨水 黑 32%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "text-disabled-tertiary": "rgba(0, 0, 0, 0.44)", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "accent-cta-bg": "#3C3F43", // E1D 反相中性底(用户批准 2026-07-17,不用红)
  "accent-cta-bg-pure": "#3C3F43", // E1D 反相中性底
  "accent-emphasis": "#3C3F43", // E1D 反相中性底
  "accent-soft": "#25282C", // E1D pressed 中性(soft→pressed)
  "accent-hover": "#2E3237", // E1D hover 中性
  "accent-pure-cta-fg": "#FCFCFC", // E1D 中性字(非白)
  "accent": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "agent-actions-rail": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "ask-checkbox-border": "rgba(0, 0, 0, 0.70)", // 墨水 黑 70%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "ask-option-list-bg": "#FFFFFF", // ask 卡选项列表面: 纯白浮在 #F8F8F8 卡底上(2026-07-23 ask 卡整改)
  "background": "60.0 16.1% 93.9%", // 页底 -> HSL
  "chat-input-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "chat-input-border-focus": "rgba(107, 107, 103, 0.30)", // 聚焦描边: 三级色 30% 派生
  "chat-input-chip-border": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "chat-input-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "chat-input-placeholder-subtle": "var(--text-placeholder)", // 聊天输入框占位文字直接用占位档,不再叠 40% 透明度(2026-10-22 用户裁决随附:占位文字统一用占位档)
  "thinking-body-text": "var(--text-secondary)", // 思考过程正文用次要档(2026-10-23 用户裁决:三级在墨水阶梯里过淡,浅色 3.2、深色 3.8;次要浅色与改前持平 4.8、深色 6.1)
  "color-primary": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "caret-accent": "#417CDD", // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  "confirm-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "confirm-btn-primary-bg": "#3C3F43", // E1D C 类裁决 1:普通确认反相中性(danger 确认另设)
  "confirm-btn-primary-text": "#FCFCFC", // E1D 反相中性字
  "confirm-btn-secondary-border": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "confirm-btn-secondary-hover": "rgba(0, 0, 0, 0.06)", // 中性 alpha hover
  "confirm-btn-secondary-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "confirm-title": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "file-chip-bg": "rgba(0, 0, 0, 0.10)", // 墨水 黑 10%: 加深底(2026-10-22 用户裁决,取代实色灰)
  "file-remove-bg": "rgba(0, 0, 0, 0.70)", // 墨水 黑 70%: 说明文字(2026-10-22 用户裁决,取代实色灰)
  "info-700": "#1D4ED8", // 信息/链接蓝
  "model-trigger-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "model-item-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "msg-link": "#1D4ED8", // 链接蓝
  "msg-scrollbar-hover": "rgba(0, 0, 0, 0.10)", // 墨水 黑 10%: 加深底(2026-10-22 用户裁决,取代实色灰)
  "msg-user-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "muted": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "muted-foreground": "0.0 0.0% 0.0% / 0.56", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "perm-auto-selected-text": "#417CDD", // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  "perm-allow-btn-bg": "#3C3F43", // E1D C 类裁决 2:反相中性(警示由橙 chip 承担)
  "perm-allow-btn-text": "#FCFCFC", // E1D 反相中性字
  "perm-allow-kbd-bg": "rgba(255, 255, 255, 0.16)", // kbd bg:随反相深钮的浅翻译层(修复 2026-07-19:原页面级浅灰在深钮上字底同亮)
  "perm-allow-kbd-border": "rgba(255, 255, 255, 0.30)", // 边框:同上
  "perm-code-bg": "#FAFAF5", // 代码块底: 卡片锚定(比卡片暗 ~2.6%)
  "perm-item-selected-bg": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "plan-outline-active-bg": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "plan-toolbar-btn-hover-bg": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "popover": "60.0 55.6% 98.2%", // 卡片 -> HSL
  "primary-foreground": "0.0 0.0% 100.0%", // 白前景
  "search-match-fg": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "secondary": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "settings-btn-primary-text": "#FCFCFC", // E1D 中性字
  "settings-btn-secondary-hover-bg": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "text-placeholder": "rgba(0, 0, 0, 0.32)", // 墨水 黑 32%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "settings-integration-avatar-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "settings-logout-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "settings-menu-bg-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "settings-menu-bg-selected": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "settings-source-link": "#1D4ED8", // 可访问链接蓝
  "settings-theme-auto-dark": "#181818", // Auto 预览: 新暗色底
  "sidebar-action-icon": "0.0 0.0% 0.0% / 0.44", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "cmd-palette-item-meta": "rgba(0, 0, 0, 0.56)", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "sidebar-item-active-foreground": "#292A2C", // Soft selected pill with same-polarity readable foreground.
  "sidebar-item-active-border": "transparent", // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  "sidebar-item-active": "214.3 6.0% 99.0%", // Soft selected pill with same-polarity readable foreground.
  "splash-bg": "60.0 16.1% 93.9%", // 页底 -> HSL
  "splash-text": "0.0 0.0% 0.0% / 0.56", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "splash-text-destructive": "0.0 0.0% 10.2%", // 正文 -> HSL
  "splash-text-muted": "0.0 0.0% 0.0% / 0.44", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "titlebar-icon": "0.0 0.0% 0.0% / 0.56", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "tooltip-bg": "#3C3F43", // tooltip 深底
  "tooltip-text": "#FFFFFF", // tooltip 白字
  "update-btn-border": "#3C3F43", // E1D 中性底(实心胶囊,与 bg 同色)
  "update-btn-bg": "#3C3F43", // E1D §15.10 反相中性:light 深底,承载浅字
  "update-btn-text": "#FCFCFC", // E1D 中性字(#FCFCFC on #3C3F43 = 10.32:1)
  "update-btn-hover": "#2E3237", // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  "accent-foreground": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "panel-bg": "#F2F2ED", // 直映: 页底(暖象牙)
  "primary": "214.3 5.5% 24.9%", // E1D C 类裁决 3:反相中性 HSL
  "ring": "217.3 69.7% 56.1%", // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  "settings-theme-auto-light": "#F2F2ED", // Auto 预览: 新页底
  "foreground": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "border": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "input": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "secondary-foreground": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "popover-foreground": "0.0 0.0% 0.0% / 0.88", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "titlebar": "60.0 16.1% 93.9%", // 页底 -> HSL
  "titlebar-border": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "titlebar-button-hover": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "titlebar-control-hover": "0.0 0.0% 0.0% / 0.05", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "sidebar": "60.0 12.8% 92.4%", // 侧栏兜底: 与侧栏玻璃同色(无玻璃平台回落用)
  "sidebar-border": "0.0 0.0% 0.0% / 0.08", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "sidebar-item-hover": "0.0 0.0% 0.0% / 0.05", // 玻璃面 hover 半透明化 2026-07-21:黑 5% 叠加(原实色 #F1F1F1 在白底上的等价叠加量),毛玻璃侧栏上壁纸可继续透过
  "sidebar-search-bg": "60.0 12.8% 92.4%", // 侧栏搜索区: 同侧栏面
  "sidebar-search-input-bg": "rgba(255, 255, 250, 0.55)", // 暖化
  "sidebar-muted": "0.0 0.0% 0.0% / 0.56", // 墨水 黑 56%: 次要文字(2026-10-22 用户裁决,取代实色灰)
  "surface-translucent-main": "#F2F2ED", // 直映: 页底(暖象牙)
  "surface-translucent-overlay": "rgba(251, 251, 246, 0.90)", // 浮层玻璃: 暖化
  "composer-pill-bg": "#FFFFFA", // 近白档
  "composer-pill-icon": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "send-btn-bg": "#3C3F43", // R4 D1/D2 反相中性可用底(不用红,用户裁决)
  "send-btn-icon": "#FCFCFC", // R4 反相中性字
  "send-btn-disabled-bg": "#444242", // R4 唤醒态禁用灰底(§2.6)
  "send-btn-disabled-icon": "#585555", // R4 禁用灰字(§2.6 send 图标)
  "send-btn-hover-bg": "#2E3237", // E1D 反相中性 hover(lead 四态)
  "send-btn-pressed-bg": "#25282C", // E1D 反相中性 pressed(lead 四态)
  "ask-badge-bg": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "ask-header-chip-bg": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 选中/按下(2026-10-22 用户裁决,取代实色灰)
  "cmd-palette-item-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-bg": "#FFFFFA", // 近白档
  "create-agent-control-border": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-icon": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-control-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-bg": "#FDFDF8", // 直映: 卡片/输入框(留暖近白)
  "create-agent-quick-card-bg-hover": "rgba(0, 0, 0, 0.05)", // 墨水 黑 5%: 悬停/标签底(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-border": "rgba(0, 0, 0, 0.08)", // 墨水 黑 8%: 边框/分割线(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-icon": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-quick-card-icon-bg": "#F2F2ED", // 直映: 页底(暖象牙)
  "create-agent-quick-card-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "create-agent-segment-inactive-text": "rgba(0, 0, 0, 0.44)", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "create-agent-segment-track-bg": "#F2F2ED", // 直映: 页底(暖象牙)
  "create-agent-send-disabled-bg": "#F2F2ED", // 直映: 页底(暖象牙)
  "create-agent-send-disabled-icon": "rgba(0, 0, 0, 0.32)", // 墨水 黑 32%: 占位/禁用文字(2026-10-22 用户裁决,取代实色灰)
  "md-table-bg": "rgba(241, 241, 236, 0.55)", // 表格条纹: 跟页底暖化
  "settings-integration-avatar-border": "#EDEDE8", // 阶梯: 头像描边
  "sidebar-list-muted": "rgba(0, 0, 0, 0.44)", // 墨水 黑 44%: 三级文字(2026-10-22 用户裁决,取代实色灰)
  "sidebar-nav-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "sidebar-user-card-bg-hover": "rgba(26, 26, 26, 0.06)", // 正文色 6% 派生
  "sidebar-user-card-border": "rgba(26, 26, 26, 0.10)", // 正文色 10% 派生
  "sidebar-user-card-text": "rgba(0, 0, 0, 0.88)", // 墨水 黑 88%: 正文(2026-10-22 用户裁决,取代实色灰)
  "ask-option-hover": "var(--surface-hover-soft)",
  "ask-send-disabled-bg": "var(--surface-elevated-soft)",
  "completion-badge-fg": "#1f1f1e",
  "create-agent-control-bg-hover": "var(--surface-hover)",
  "create-agent-control-bg-pressed": "var(--surface-hover-soft)",
  "create-agent-send-icon": "#FCFCFC",
  "slider-track": "#A3A39E", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "slider-fill": "#3C3F43", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "slider-thumb": "#FDFDF8", // Slider 用户定稿 2026-09-17;与 Switch 独立
  "segmented-selected-bg": "#FDFDF8",
  "segmented-selected-border": "#F0F0EB",
  "segmented-option-fg": "#6B6B67",
  "segmented-hover-bg": "#E4E4DF",
} as const;
// END GENERATED DS-8: theme



export const cindyLight: Theme = {
  id: 'cindy-light',
  name: 'CINDY Light',
  type: 'light',
  colors: {
    ...GENERATED_OVERRIDES,
    "surface-translucent-sidebar": CINDY_ACRYLIC_WINDOW_BACKING.light,
  },
  // U5 品牌版横向 logo：黑字+红箭头，浅底可见。
  brand: { logo: { src: cindyLogoLight } },
};
