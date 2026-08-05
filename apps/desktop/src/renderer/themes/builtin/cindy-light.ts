import type { Theme } from '../types';
import cindyLogoLight from '../../assets/cindy-logo-light.png';

/*
 * CINDY Light — 品牌红 CTA + 中性灰底(#EDEDED)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: 2026-07-17-cindy-token-decision-table.md §3(用户 U8 批准)。
 * 每个 override 注释来源(直映/插值比例/裁决);零自由裁量。
 */

const overrides = {
  surface: '#EDEDED', // 直映: 背景
  'surface-hsl': '0.0 0.0% 92.9%', // 直映: 背景 -> HSL
  'surface-elevated': '#F8F8F8', // 直映: 卡片/输入框
  'surface-elevated-soft': '#F4F4F4', // 插值: 背景->卡片 65%
  'surface-card-ivory': '#F8F8F8', // 直映: 卡片/输入框
  'surface-chip': '#F1F1F1', // 插值: Light 40% / Dark 75%
  'surface-chip-alt': '#F4F4F4', // 插值: 65%
  'surface-hover': '#F1F1F1', // 插值: hover
  'surface-hover-soft': '#EFEFEF', // 插值: 20%
  'surface-hover-hsl': '0.0 0.0% 94.5%', // 插值: hover -> HSL
  'surface-on-card': '#FFFFFF', // 裁决: 中性反相前景,不作红 CTA 专用
  'status-badge-fg': '#1F1F1F', // §7 必炸点:值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17
  'border-default': '#DCDFE3', // 直映: 边框
  'border-default-hsl': '214.3 11.1% 87.6%', // 边框 -> HSL
  'border-shadcn-hsl': '214.3 11.1% 87.6%', // 边框 -> HSL
  'border-transparent-mixed': 'transparent', // light transparent / dark 边框
  'text-primary': '#3C3F43', // 直映: 正文
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#2E3237', // 强调正文
  'text-primary-inv': '#FFFFFF', // 反相文字
  'text-primary-body-strong': '#3C3F43', // 直映: 正文
  'text-primary-hsl': '214.3 5.5% 24.9%', // 正文 -> HSL
  'text-secondary': '#8C8E94', // 直映: 二级信息; U2 例外; 用户调参 2026-07-20:#9A9DA3→#919399→#8C8E94 二次加深
  'text-secondary-cross': '#9A9DA3', // 直映: 二级信息; U2 例外
  'text-secondary-mid': '#686B72', // 整改: 小正文 AA
  'text-tertiary': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-stone': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-mid': '#686B72', // 整改: 非 U2 token AA
  'text-tertiary-hsl': '222.0 4.6% 42.7%', // tertiary -> HSL
  'text-disabled': '#686B72', // 整改: 文档矩阵 AA; 禁用视觉用 opacity
  'text-disabled-tertiary': '#686B72', // 整改: disabled tertiary AA
  'accent-cta-bg': '#3C3F43', // E1D 反相中性底(用户批准 2026-07-17,不用红)
  'accent-cta-bg-pure': '#3C3F43', // E1D 反相中性底
  'accent-emphasis': '#3C3F43', // E1D 反相中性底
  'accent-soft': '#25282C', // E1D pressed 中性(soft→pressed)
  'accent-hover': '#2E3237', // E1D hover 中性
  'accent-pure-cta-fg': '#FCFCFC', // E1D 中性字(非白)
  accent: '0.0 0.0% 94.5%', // 裁决: shadcn 中性 hover
  'agent-actions-rail': '#DCDFE3', // 边框/rail
  'ask-checkbox-border': '#686B72', // AA checkbox border
  'ask-option-list-bg': '#FFFFFF', // ask 卡选项列表面: 纯白浮在 #F8F8F8 卡底上(2026-07-23 ask 卡整改)
  background: '0.0 0.0% 92.9%', // 背景 -> HSL
  'chat-input-bg': '#F8F8F8', // 输入框
  'chat-input-border-focus': 'rgba(104, 107, 114, 0.30)', // 用户改稿 2026-07-20:输入框聚焦描边降至 30%
  'chat-input-chip-border': '#DCDFE3', // 边框
  'chat-input-text': '#3C3F43', // 正文
  'color-primary': '#3C3F43', // 正文
  'caret-accent': '#417CDD', // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  'confirm-bg': '#F8F8F8', // 卡片
  'confirm-btn-primary-bg': '#3C3F43', // E1D C 类裁决 1:普通确认反相中性(danger 确认另设)
  'confirm-btn-primary-text': '#FCFCFC', // E1D 反相中性字
  'confirm-btn-secondary-border': '#DCDFE3', // 边框
  'confirm-btn-secondary-hover': 'rgba(0, 0, 0, 0.06)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#3C3F43', // 正文
  'confirm-title': '#3C3F43', // 正文
  'file-chip-bg': '#D8D9DB', // neutral chip thumb
  'file-remove-bg': '#686B72', // AA remove affordance
  'info-700': '#1D4ED8', // 信息/链接蓝
  'model-trigger-hover': '#F1F1F1', // hover
  // 下拉行 hover/选中底:surface-hover(#F1F1F1)相对面板(#F8F8F8)只差 7,行高亮几乎看不清。
  // 菜单行专用 token 压深一档(-14/通道)使 hover 在面板上清晰,模型/权限/+ 三菜单共用。
  'model-item-hover': '#EAEAEA', // 下拉行 hover/选中(压深到面板之下,清晰可见)
  'msg-link': '#1D4ED8', // 链接蓝
  'msg-scrollbar-hover': '#D8D9DB', // 弱档
  'msg-user-bg': '#F8F8F8', // 卡片
  muted: '0.0 0.0% 94.5%', // muted surface
  'muted-foreground': '222.0 4.6% 42.7%', // AA muted 前景
  'perm-auto-selected-text': '#417CDD', // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  'perm-allow-btn-bg': '#3C3F43', // E1D C 类裁决 2:反相中性(警示由橙 chip 承担)
  'perm-allow-btn-text': '#FCFCFC', // E1D 反相中性字
  'perm-allow-kbd-bg': 'rgba(255, 255, 255, 0.16)', // kbd bg:随反相深钮的浅翻译层(修复 2026-07-19:原页面级浅灰在深钮上字底同亮)
  'perm-allow-kbd-border': 'rgba(255, 255, 255, 0.30)', // 边框:同上
  'perm-code-bg': '#F5F5F5', // code bg
  'perm-item-selected-bg': '#F1F1F1', // selected bg
  'plan-outline-active-bg': '#F1F1F1', // active bg
  'plan-toolbar-btn-hover-bg': '#E2E2E2', // hover bg: 原 #F1F1F1 与 chip 静默底同色无反馈、在 #F8F8F8 卡底上也近不可辨,借 settings-menu-bg-hover 同档往暗压(2026-07-23 ask 卡整改)
  popover: '0.0 0.0% 97.3%', // elevated -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '214.3 5.5% 24.9%', // search fg
  secondary: '0.0 0.0% 94.5%', // neutral secondary
  'settings-btn-primary-text': '#FCFCFC', // E1D 中性字
  'settings-btn-secondary-hover-bg': '#F1F1F1', // secondary hover
  'text-placeholder': '#686B72', // 整改: placeholder AA; 透明度由组件控制
  'settings-integration-avatar-bg': '#F8F8F8', // avatar chip
  'settings-logout-bg': '#F8F8F8', // 卡片
  'settings-menu-bg-hover': '#E2E2E2', // 用户反馈 2026-07-21:原 #EFEFEF 在 #EDEDED 页底上几乎不可见,改为往暗压 ~5% 亮度差
  'settings-menu-bg-selected': '#F1F1F1', // menu selected
  'settings-source-link': '#1D4ED8', // 可访问链接蓝
  'settings-theme-auto-dark': '#2A2828', // Auto 预览 dark 固定
  'sidebar-action-icon': '220.0 4.7% 62.2%', // E1D 侧栏层级:二级暗灰 #9A9DA3(时间戳/RemoteProjectIcon)
  'cmd-palette-item-meta': '#9A9DA3', // E1D 侧栏层级:二级暗灰(分组标签/meta)
  'sidebar-item-active-foreground': '#FCFCFC', // 用户二次改稿 2026-07-20:反相胶囊,light 深底浅字(同 accent-pure-cta-fg)
  'sidebar-item-active-border': 'transparent', // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  'sidebar-item-active': '214.3 5.5% 24.9%', // 用户二次改稿 2026-07-20:反相胶囊 #3C3F43 深底(同 accent-cta-bg)
  'splash-bg': '0.0 0.0% 92.9%', // 背景 -> HSL
  'splash-text': '222.0 4.6% 42.7%', // AA splash text
  'splash-text-destructive': '214.3 5.5% 24.9%', // destructive splash text
  'splash-text-muted': '222.0 4.6% 42.7%', // AA splash muted
  'titlebar-icon': '222.0 4.6% 42.7%', // AA icon
  'tooltip-bg': '#3C3F43', // tooltip 深底
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#3C3F43', // E1D 中性底(实心胶囊,与 bg 同色)
  'update-btn-bg': '#3C3F43', // E1D §15.10 反相中性:light 深底,承载浅字
  'update-btn-text': '#FCFCFC', // E1D 中性字(#FCFCFC on #3C3F43 = 10.32:1)
  'update-btn-hover': '#2E3237', // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  'accent-foreground': '214.3 5.5% 24.9%', // 裁决: accent 成对中性前景
  'panel-bg': '#EDEDED', // 依赖 D1: 注册后直映背景
  primary: '214.3 5.5% 24.9%', // E1D C 类裁决 3:反相中性 HSL
  ring: '217.3 69.7% 56.1%', // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  'settings-theme-auto-light': '#EDEDED', // Auto 预览 light 固定
  foreground: '214.3 5.5% 24.9%', // alias closure 直接值
  border: '214.3 11.1% 87.6%', // alias closure
  input: '214.3 11.1% 87.6%', // alias closure
  'secondary-foreground': '214.3 5.5% 24.9%', // alias closure
  'popover-foreground': '214.3 5.5% 24.9%', // alias closure
  titlebar: '0.0 0.0% 92.9%', // alias closure: surface
  'titlebar-border': '214.3 11.1% 87.6%', // alias closure: border
  'titlebar-button-hover': '0.0 0.0% 94.5%', // alias closure: hover
  'titlebar-control-hover': '0.0 0.0% 94.5%', // alias closure: hover
  sidebar: '0.0 0.0% 92.9%', // alias closure: surface
  'sidebar-border': '214.3 11.1% 87.6%', // alias closure: border
  'sidebar-item-hover': '0.0 0.0% 0.0% / 0.05', // 玻璃面 hover 半透明化 2026-07-21:黑 5% 叠加(原实色 #F1F1F1 在白底上的等价叠加量),毛玻璃侧栏上壁纸可继续透过
  'sidebar-search-bg': '0.0 0.0% 92.9%', // alias closure: surface
  'sidebar-search-input-bg': 'rgba(255, 255, 255, 0.55)', // 玻璃面搜索输入框 2026-07-21:白 55% 提亮字段感(与 hover 黑 5% 方向相反,可区分"可输入")
  'sidebar-muted': '220.0 4.7% 62.2%', // E1D 侧栏层级:二级暗灰 #9A9DA3(行首图标普通态)
  'surface-translucent-sidebar': 'rgba(255, 255, 255, 0.80)', // 用户调参 2026-07-20:纯白 85%→80%(透壁纸更多;#F6F6F6 试色后退回纯白)
  'surface-translucent-main': '#EDEDED', // E4D 主面板:用户勘误 2026-07-17 撤销毛玻璃,改不透明等价 surface(原 rgba(255,255,255,0.93))
  'surface-translucent-overlay': 'rgba(246, 246, 246, 0.90)', // E4D R1 模式3 浮层半透明
  'composer-pill-bg': '#FCFCFC', // E2 composer pill 底(light,lead Figma 实测 §2-3;取代错稿 glass-pill)
  'composer-pill-icon': '#3C3F43', // E2 composer pill 图标(light=text-primary)
  'send-btn-bg': '#3C3F43', // R4 D1/D2 反相中性可用底(不用红,用户裁决)
  'send-btn-icon': '#FCFCFC', // R4 反相中性字
  'send-btn-disabled-bg': '#444242', // R4 唤醒态禁用灰底(§2.6)
  'send-btn-disabled-icon': '#585555', // R4 禁用灰字(§2.6 send 图标)
  'send-btn-hover-bg': '#2E3237', // E1D 反相中性 hover(lead 四态)
  'send-btn-pressed-bg': '#25282C', // E1D 反相中性 pressed(lead 四态)
} as const;

export const cindyLight: Theme = {
  id: 'cindy-light',
  name: 'CINDY Light',
  type: 'light',
  colors: overrides,
  // U5 品牌版横向 logo：黑字+红箭头，浅底可见。
  brand: { logo: { src: cindyLogoLight } },
};
