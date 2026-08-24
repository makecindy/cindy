import type { Theme } from '../types';
import cindyLogoLight from '../../assets/cindy-logo-light.png';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../../shared/windowBackdrop';

/*
 * CINDY Light — 品牌红 CTA + 暖象牙底(#F2F2ED)+ AA 正文。
 * 值的唯一权威: token-decision-table.md §3(2026-07-17 U8 批准) + §9(2026-08 色阶改版,用户批准)。
 * §9 要点: 面/边框全暖(B=R-5)、文字渐进暖、二级抬到 >=3.0(取代 U2 light 原值)、
 * 交互态分页面/卡片双锚定。每个 override 注释来源;零自由裁量。
 */

const overrides = {
  surface: '#F2F2ED', // 直映: 页底(暖象牙)
  'surface-hsl': '60.0 16.1% 93.9%', // 页底 -> HSL
  'surface-elevated': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'surface-elevated-soft': '#FAFAF5', // 阶梯: 次级卡片
  'surface-card-ivory': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'surface-chip': '#EEEEE9', // 阶梯: hover/chip(压暗于页底)
  'surface-chip-alt': '#FAFAF5', // 阶梯: 次级卡片
  'surface-hover': '#EEEEE9', // 阶梯: hover/chip(压暗于页底)
  'surface-hover-soft': '#F0F0EB', // 阶梯: 柔和 hover
  'surface-hover-hsl': '60.0 12.8% 92.4%', // hover -> HSL
  'surface-on-card': '#FFFFFF', // 裁决: 中性反相前景,不作红 CTA 专用
  'switch-track-off': '#888888', // 关闭态轨道:值与依据见决策表(用户调参 2026-08-05)
  'switch-track-on': '#4A4D51', // 开启态轨道:值与依据见决策表(用户调参 2026-08-05)
  'status-badge-fg': '#1F1F1F', // §7 必炸点:值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17
  'border-default': '#E4E4DF', // 直映: 边框(冷转暖)
  'border-default-hsl': '60.0 8.5% 88.4%', // 边框 -> HSL
  'border-shadcn-hsl': '60.0 8.5% 88.4%', // 边框 -> HSL
  'border-transparent-mixed': 'transparent', // light transparent / dark 边框
  'text-primary': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#0C0C0C', // 强调正文: 最深档(用户定 #0C0C0C,2026-08-12)
  'text-primary-inv': '#FFFFFF', // 反相文字
  'text-primary-body-strong': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'text-primary-hsl': '0.0 0.0% 10.2%', // 正文 -> HSL
  'text-secondary': '#888883', // 二级: 暖灰,>=3.0 下限(2026-08 改版,取代 U2 原值)
  'text-secondary-cross': '#888883', // 二级同档(原更淡档并入 3.0 地板)
  'text-secondary-mid': '#6B6B67', // 三级: 等亮度暖化
  'text-tertiary': '#6B6B67', // 三级: 等亮度暖化
  'text-tertiary-stone': '#6B6B67', // 三级: 等亮度暖化
  'text-tertiary-mid': '#6B6B67', // 三级: 等亮度暖化
  'text-tertiary-hsl': '60.0 1.9% 41.2%', // 三级 -> HSL
  'text-disabled': '#6B6B67', // 三级: 等亮度暖化
  'text-disabled-tertiary': '#6B6B67', // 三级: 等亮度暖化
  'accent-cta-bg': '#3C3F43', // E1D 反相中性底(用户批准 2026-07-17,不用红)
  'accent-cta-bg-pure': '#3C3F43', // E1D 反相中性底
  'accent-emphasis': '#3C3F43', // E1D 反相中性底
  'accent-soft': '#25282C', // E1D pressed 中性(soft→pressed)
  'accent-hover': '#2E3237', // E1D hover 中性
  'accent-pure-cta-fg': '#FCFCFC', // E1D 中性字(非白)
  accent: '60.0 12.8% 92.4%', // hover -> HSL
  'agent-actions-rail': '#E4E4DF', // 直映: 边框(冷转暖)
  'ask-checkbox-border': '#6B6B67', // 三级: 等亮度暖化
  'ask-option-list-bg': '#FFFFFF', // ask 卡选项列表面: 纯白浮在 #F8F8F8 卡底上(2026-07-23 ask 卡整改)
  background: '60.0 16.1% 93.9%', // 页底 -> HSL
  'chat-input-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'chat-input-border-focus': 'rgba(107, 107, 103, 0.30)', // 聚焦描边: 三级色 30% 派生
  'chat-input-chip-border': '#E4E4DF', // 直映: 边框(冷转暖)
  'chat-input-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'color-primary': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'caret-accent': '#417CDD', // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  'confirm-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'confirm-btn-primary-bg': '#3C3F43', // E1D C 类裁决 1:普通确认反相中性(danger 确认另设)
  'confirm-btn-primary-text': '#FCFCFC', // E1D 反相中性字
  'confirm-btn-secondary-border': '#E4E4DF', // 直映: 边框(冷转暖)
  'confirm-btn-secondary-hover': 'rgba(0, 0, 0, 0.06)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'confirm-title': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'file-chip-bg': '#DFDFDA', // 阶梯: 弱档
  'file-remove-bg': '#6B6B67', // 三级: 等亮度暖化
  'info-700': '#1D4ED8', // 信息/链接蓝
  'model-trigger-hover': '#EEEEE9', // 阶梯: hover/chip(压暗于页底)
  // 下拉行 hover/选中底:surface-hover(#F1F1F1)相对面板(#F8F8F8)只差 7,行高亮几乎看不清。
  // 菜单行专用 token 压深一档(-14/通道)使 hover 在面板上清晰,模型/权限/+ 三菜单共用。
  'model-item-hover': '#EFEFEA', // 下拉行 hover: 锚定弹层面板(比面板暗 ~12%),勿改回页底锚定
  'msg-link': '#1D4ED8', // 链接蓝
  'msg-scrollbar-hover': '#DFDFDA', // 阶梯: 弱档
  'msg-user-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  muted: '60.0 12.8% 92.4%', // hover -> HSL
  'muted-foreground': '60.0 1.9% 41.2%', // 三级 -> HSL
  'perm-auto-selected-text': '#417CDD', // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  'perm-allow-btn-bg': '#3C3F43', // E1D C 类裁决 2:反相中性(警示由橙 chip 承担)
  'perm-allow-btn-text': '#FCFCFC', // E1D 反相中性字
  'perm-allow-kbd-bg': 'rgba(255, 255, 255, 0.16)', // kbd bg:随反相深钮的浅翻译层(修复 2026-07-19:原页面级浅灰在深钮上字底同亮)
  'perm-allow-kbd-border': 'rgba(255, 255, 255, 0.30)', // 边框:同上
  'perm-code-bg': '#FAFAF5', // 代码块底: 卡片锚定(比卡片暗 ~2.6%)
  'perm-item-selected-bg': '#F6F6F1', // 卡片锚定: 权限弹层选中行(2026-08-14)
  'plan-outline-active-bg': '#F6F6F1', // 卡片锚定: 计划大纲激活行(2026-08-14)
  'plan-toolbar-btn-hover-bg': '#E8E8E3', // 阶梯: 菜单 hover
  popover: '60.0 55.6% 98.2%', // 卡片 -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '0.0 0.0% 10.2%', // 正文 -> HSL
  secondary: '60.0 12.8% 92.4%', // hover -> HSL
  'settings-btn-primary-text': '#FCFCFC', // E1D 中性字
  'settings-btn-secondary-hover-bg': '#F6F6F1', // 卡片锚定: 设置卡上的次级按钮 hover(2026-08-14)
  'text-placeholder': '#6B6B67', // 三级: 等亮度暖化
  'settings-integration-avatar-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'settings-logout-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'settings-menu-bg-hover': '#E8E8E3', // 阶梯: 菜单 hover
  'settings-menu-bg-selected': '#F6F6F1', // 卡片锚定: 比卡片暗 ~6%(压在弹层上的选中态,2026-08-14)
  'settings-source-link': '#1D4ED8', // 可访问链接蓝
  'settings-theme-auto-dark': '#181818', // Auto 预览: 新暗色底
  'sidebar-action-icon': '60.0 2.1% 52.4%', // 侧栏灰字: 同上
  'cmd-palette-item-meta': '#888883', // 二级同档(同上)
  'sidebar-item-active-foreground': '#FCFCFC', // 用户二次改稿 2026-07-20:反相胶囊,light 深底浅字(同 accent-pure-cta-fg)
  'sidebar-item-active-border': 'transparent', // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  'sidebar-item-active': '214.3 5.5% 24.9%', // 用户二次改稿 2026-07-20:反相胶囊 #3C3F43 深底(同 accent-cta-bg)
  'splash-bg': '60.0 16.1% 93.9%', // 页底 -> HSL
  'splash-text': '60.0 1.9% 41.2%', // 三级 -> HSL
  'splash-text-destructive': '0.0 0.0% 10.2%', // 正文 -> HSL
  'splash-text-muted': '60.0 1.9% 41.2%', // 三级 -> HSL
  'titlebar-icon': '60.0 1.9% 41.2%', // 三级 -> HSL
  'tooltip-bg': '#3C3F43', // tooltip 深底
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#3C3F43', // E1D 中性底(实心胶囊,与 bg 同色)
  'update-btn-bg': '#3C3F43', // E1D §15.10 反相中性:light 深底,承载浅字
  'update-btn-text': '#FCFCFC', // E1D 中性字(#FCFCFC on #3C3F43 = 10.32:1)
  'update-btn-hover': '#2E3237', // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  'accent-foreground': '0.0 0.0% 10.2%', // 正文 -> HSL
  'panel-bg': '#F2F2ED', // 直映: 页底(暖象牙)
  primary: '214.3 5.5% 24.9%', // E1D C 类裁决 3:反相中性 HSL
  ring: '217.3 69.7% 56.1%', // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  'settings-theme-auto-light': '#F2F2ED', // Auto 预览: 新页底
  foreground: '0.0 0.0% 10.2%', // 正文 -> HSL
  border: '60.0 8.5% 88.4%', // 边框 -> HSL
  input: '60.0 8.5% 88.4%', // 边框 -> HSL
  'secondary-foreground': '0.0 0.0% 10.2%', // 正文 -> HSL
  'popover-foreground': '0.0 0.0% 10.2%', // 正文 -> HSL
  titlebar: '60.0 16.1% 93.9%', // 页底 -> HSL
  'titlebar-border': '60.0 8.5% 88.4%', // 边框 -> HSL
  'titlebar-button-hover': '60.0 12.8% 92.4%', // hover -> HSL
  'titlebar-control-hover': '60.0 12.8% 92.4%', // hover -> HSL
  sidebar: '60.0 12.8% 92.4%', // 侧栏兜底: 与侧栏玻璃同色(无玻璃平台回落用)
  'sidebar-border': '60.0 8.5% 88.4%', // 边框 -> HSL
  'sidebar-item-hover': '0.0 0.0% 0.0% / 0.05', // 玻璃面 hover 半透明化 2026-07-21:黑 5% 叠加(原实色 #F1F1F1 在白底上的等价叠加量),毛玻璃侧栏上壁纸可继续透过
  'sidebar-search-bg': '60.0 12.8% 92.4%', // 侧栏搜索区: 同侧栏面
  'sidebar-search-input-bg': 'rgba(255, 255, 250, 0.55)', // 暖化
  'sidebar-muted': '60.0 2.1% 52.4%', // 侧栏灰字: 同上
  'surface-translucent-sidebar': CINDY_ACRYLIC_WINDOW_BACKING.light, // 侧栏面: 独立压暗一档+85% 遮盖(用户调参 2026-08-17, 与深色对齐)
  'surface-translucent-main': '#F2F2ED', // 直映: 页底(暖象牙)
  'surface-translucent-overlay': 'rgba(251, 251, 246, 0.90)', // 浮层玻璃: 暖化
  'composer-pill-bg': '#FFFFFA', // 近白档
  'composer-pill-icon': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'send-btn-bg': '#3C3F43', // R4 D1/D2 反相中性可用底(不用红,用户裁决)
  'send-btn-icon': '#FCFCFC', // R4 反相中性字
  'send-btn-disabled-bg': '#444242', // R4 唤醒态禁用灰底(§2.6)
  'send-btn-disabled-icon': '#585555', // R4 禁用灰字(§2.6 send 图标)
  'send-btn-hover-bg': '#2E3237', // E1D 反相中性 hover(lead 四态)
  'send-btn-pressed-bg': '#25282C', // E1D 反相中性 pressed(lead 四态)
  // ── 2026-08 色阶改版新增 override(原走注册表默认值,现按新阶梯定值;决策表 §9)──
  'ask-badge-bg': '#F6F6F1', // 卡片锚定: 提问卡序号角标(2026-08-14)
  'ask-header-chip-bg': '#F6F6F1', // 卡片锚定: 压在提问卡上(2026-08-14)
  'cmd-palette-item-hover': '#F6F6F1', // 卡片锚定: 命令面板行 hover(2026-08-14)
  'create-agent-control-bg': '#FFFFFA', // 近白档
  'create-agent-control-border': '#E4E4DF', // 直映: 边框(冷转暖)
  'create-agent-control-icon': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'create-agent-control-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'create-agent-quick-card-bg': '#FDFDF8', // 直映: 卡片/输入框(留暖近白)
  'create-agent-quick-card-bg-hover': '#F6F6F1', // 卡片锚定: 快捷卡 hover(2026-08-14)
  'create-agent-quick-card-border': '#E4E4DF', // 直映: 边框(冷转暖)
  'create-agent-quick-card-icon': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'create-agent-quick-card-icon-bg': '#F2F2ED', // 直映: 页底(暖象牙)
  'create-agent-quick-card-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'create-agent-segment-inactive-text': '#9D9D98', // 未激活态: WCAG 豁免档,勿并入二级
  'create-agent-segment-track-bg': '#F2F2ED', // 直映: 页底(暖象牙)
  'create-agent-send-disabled-bg': '#F2F2ED', // 直映: 页底(暖象牙)
  'create-agent-send-disabled-icon': '#9D9D98', // 禁用态: WCAG 豁免档
  'md-table-bg': 'rgba(241, 241, 236, 0.55)', // 表格条纹: 跟页底暖化
  'settings-integration-avatar-border': '#EDEDE8', // 阶梯: 头像描边
  'sidebar-list-muted': '#888883', // 侧栏灰字: 暖化+压深至 >=3.0(2026-08-13)
  'sidebar-nav-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  'sidebar-user-card-bg-hover': 'rgba(26, 26, 26, 0.06)', // 正文色 6% 派生
  'sidebar-user-card-border': 'rgba(26, 26, 26, 0.10)', // 正文色 10% 派生
  'sidebar-user-card-text': '#1A1A1A', // 正文: 近黑中性(2026-08 文字阶梯)
  // ── 对侧入表锚定: 值 = 本侧此前的注册表解析原值(解析结果不变, 仅为决策表双边冻结)──
  'ask-option-hover': 'var(--surface-hover-soft)',
  'ask-send-disabled-bg': 'var(--surface-elevated-soft)',
  'completion-badge-fg': '#1f1f1e',
  'create-agent-control-bg-hover': 'var(--surface-hover)',
  'create-agent-control-bg-pressed': 'var(--surface-hover-soft)',
  'create-agent-send-icon': '#FCFCFC',
} as const;

export const cindyLight: Theme = {
  id: 'cindy-light',
  name: 'CINDY Light',
  type: 'light',
  colors: overrides,
  // U5 品牌版横向 logo：黑字+红箭头，浅底可见。
  brand: { logo: { src: cindyLogoLight } },
};
