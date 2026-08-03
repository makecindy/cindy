import type { Theme } from '../types';
import cindyLogoDark from '../../assets/cindy-logo-dark.png';

/*
 * CINDY Dark — 品牌红 CTA + 深灰底(#2A2828)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: 2026-07-17-cindy-token-decision-table.md §3(用户 U8 批准)。
 * 每个 override 注释来源(直映/插值比例/裁决);零自由裁量。
 */

const overrides = {
  surface: '#2A2828', // 直映: 背景
  'surface-hsl': '0.0 2.4% 16.1%', // 直映: 背景 -> HSL
  'surface-elevated': '#312F2F', // 直映: 卡片/输入框
  'surface-elevated-soft': '#2F2D2D', // 插值: 背景->卡片 65%
  'surface-card-ivory': '#312F2F', // 直映: 卡片/输入框
  'surface-chip': '#2F2D2D', // 插值: Light 40% / Dark 75%
  'surface-chip-alt': '#2F2D2D', // 插值: 65%
  'surface-hover': '#2F2D2D', // 插值: hover
  'surface-hover-soft': '#2B2929', // 插值: 20%
  'surface-hover-hsl': '0.0 2.2% 18.0%', // 插值: hover -> HSL
  'surface-on-card': '#2A2828', // 裁决: 中性反相前景,不作红 CTA 专用
  // 有意引用决策表已冻结的 disabled 灰，与 fast-toggle-track 同源；不新增自由字面值。
  'switch-track-off': 'var(--text-disabled)',
  'status-badge-fg': '#1F1F1F', // §7 必炸点:值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17
  'border-default': '#434343', // 直映: 边框
  'border-default-hsl': '0.0 0.0% 26.3%', // 边框 -> HSL
  'border-shadcn-hsl': '0.0 0.0% 26.3%', // 边框 -> HSL
  'border-transparent-mixed': '#434343', // light transparent / dark 边框
  'text-primary': '#D4D4D4', // 直映: 正文
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#FFFFFF', // 强调正文
  'text-primary-inv': '#2A2828', // 反相文字
  'text-primary-body-strong': '#D4D4D4', // 直映: 正文
  'text-primary-hsl': '0.0 0.0% 83.1%', // 正文 -> HSL
  'text-secondary': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-cross': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-mid': '#BFC1C4', // 整改: 小正文 AA
  'text-tertiary': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-stone': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-mid': '#BFC1C4', // 整改: 非 U2 token AA
  'text-tertiary-hsl': '216.0 4.1% 75.9%', // tertiary -> HSL
  'text-disabled': '#BFC1C4', // 整改: 文档矩阵 AA; 禁用视觉用 opacity
  'text-disabled-tertiary': '#BFC1C4', // 整改: disabled tertiary AA
  'accent-cta-bg': '#EEEEEE', // E1D 反相中性底
  'accent-cta-bg-pure': '#EEEEEE', // E1D 反相中性底
  'accent-emphasis': '#EEEEEE', // E1D 反相中性底
  'accent-soft': '#D4D4D4', // E1D pressed 中性
  'accent-hover': '#E2E2E2', // E1D hover 中性
  'accent-pure-cta-fg': '#252222', // E1D 中性字(非白)
  accent: '0.0 2.2% 18.0%', // 裁决: shadcn 中性 hover
  'agent-actions-rail': '#434343', // 边框/rail
  'ask-checkbox-border': '#BFC1C4', // AA checkbox border
  'ask-header-chip-bg': '#3A3838', // ask 卡 header chip 底: surface-chip #2F2D2D 与卡底 #312F2F 撞色不可辨,借 settings-menu-bg-hover 同档提亮值(2026-07-21 已验证在 #312F2F 上可分辨);序号角标(ask-badge-bg)落在 #3A3838 列表面上,维持默认 #2F2D2D 反而可辨,不随 header chip 提亮档调整
  'ask-send-disabled-bg': '#3A3838', // ask 卡自由输入行禁用圆形 Send 底: 同 chip 提亮档(禁用感由 text-disabled-tertiary 文字承担)
  'ask-option-list-bg': '#3A3838', // ask 卡选项列表面: 同 chip 提亮档,浮在 #312F2F 卡底上
  'ask-option-hover': '#444242', // ask 卡选项行 hover: 需高于列表面 #3A3838 一档,借 send-btn-disabled-bg 同档(2026-07-23 ask 卡整改)
  background: '0.0 2.4% 16.1%', // 背景 -> HSL
  'chat-input-bg': '#312F2F', // 输入框
  'chat-input-border-focus': 'rgba(191, 193, 196, 0.30)', // 用户改稿 2026-07-20:输入框聚焦描边降至 30%
  'chat-input-chip-border': '#434343', // 边框
  'chat-input-text': '#D4D4D4', // 正文
  'color-primary': '#D4D4D4', // 正文
  'caret-accent': '#417CDD', // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  'confirm-bg': '#312F2F', // 卡片
  'confirm-btn-primary-bg': '#EEEEEE', // E1D C 类裁决 1:反相中性
  'confirm-btn-primary-text': '#252222', // E1D 反相中性字
  'confirm-btn-secondary-border': '#434343', // 边框
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.08)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#D4D4D4', // 正文
  'confirm-title': '#D4D4D4', // 正文
  'file-chip-bg': '#3B3A3A', // neutral chip thumb
  'file-remove-bg': '#BFC1C4', // AA remove affordance
  'info-700': '#93C5FD', // 信息/链接蓝
  'model-trigger-hover': '#2F2D2D', // hover
  // 下拉行 hover/选中底:必须比弹层面板(surface-elevated #312F2F)更亮才可见。
  // surface-hover(#2F2D2D)是为"压在页面底 #2A2828 上"调的,比抬起的面板还暗→行高亮隐形。
  // 故菜单行专用 token 单独抬亮一档(+12/通道),模型/权限/+ 三个菜单共用它,hover 统一可见。
  'model-item-hover': '#3D3B3B', // 下拉行 hover/选中(抬亮到面板之上)
  'msg-link': '#93C5FD', // 链接蓝
  'msg-scrollbar-hover': '#504F4F', // 弱档
  'msg-user-bg': '#312F2F', // 卡片
  muted: '0.0 2.2% 18.0%', // muted surface
  'muted-foreground': '216.0 4.1% 75.9%', // AA muted 前景
  'perm-auto-selected-text': '#417CDD', // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  'perm-allow-btn-bg': '#EEEEEE', // E1D C 类裁决 2:反相中性
  'perm-allow-btn-text': '#252222', // E1D 反相中性字
  'perm-allow-kbd-bg': 'rgba(0, 0, 0, 0.08)', // kbd bg:随反相浅钮的深翻译层(修复 2026-07-19:原页面级深灰在浅钮上吞掉近黑字)
  'perm-allow-kbd-border': 'rgba(0, 0, 0, 0.20)', // 边框:同上
  'perm-code-bg': '#2B2929', // code bg
  'perm-item-selected-bg': '#2F2D2D', // selected bg
  'plan-outline-active-bg': '#2F2D2D', // active bg
  'plan-toolbar-btn-hover-bg': '#444242', // hover bg: 原 #2F2D2D 比卡底 #312F2F 更暗近不可辨,且低于 ask 卡按钮静默底 #3A3838 会反向变暗,提亮到已有禁用灰底档 #444242(2026-07-23 ask 卡整改)
  popover: '0.0 2.1% 18.8%', // elevated -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '0.0 0.0% 83.1%', // search fg
  secondary: '0.0 2.2% 18.0%', // neutral secondary
  'settings-btn-primary-text': '#252222', // E1D 中性字
  'settings-btn-secondary-hover-bg': '#2F2D2D', // secondary hover
  'text-placeholder': '#BFC1C4', // 整改: placeholder AA; 透明度由组件控制
  'settings-integration-avatar-bg': '#2F2D2D', // avatar chip
  'settings-logout-bg': '#312F2F', // 卡片
  'settings-menu-bg-hover': '#3A3838', // 用户反馈 2026-07-21:原 #2B2929 在 #2A2828 页底上几乎不可见,提亮到 ~6% 亮度差(在 #312F2F 弹窗底上也可分辨)
  'settings-menu-bg-selected': '#2F2D2D', // menu selected
  'settings-source-link': '#93C5FD', // 可访问链接蓝
  'settings-theme-auto-dark': '#2A2828', // Auto 预览 dark 固定
  'sidebar-action-icon': '0 0% 43.5%', // E1D 侧栏层级:二级暗灰 #6F6F6F(时间戳/RemoteProjectIcon)
  'cmd-palette-item-meta': '#6F6F6F', // E1D 侧栏层级:二级暗灰(分组标签/meta)
  'sidebar-item-active-foreground': '#252222', // 用户二次改稿 2026-07-20:反相胶囊,dark 浅底深字(同 accent-pure-cta-fg)
  'sidebar-item-active-border': 'transparent', // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  'sidebar-item-active': '0.0 0.0% 93.3%', // 用户二次改稿 2026-07-20:反相胶囊 #EEEEEE 浅底(同 accent-cta-bg)
  'splash-bg': '0.0 2.4% 16.1%', // 背景 -> HSL
  'splash-text': '216.0 4.1% 75.9%', // AA splash text
  'splash-text-destructive': '0.0 0.0% 100.0%', // destructive splash text
  'splash-text-muted': '216.0 4.1% 75.9%', // AA splash muted
  'titlebar-icon': '216.0 4.1% 75.9%', // AA icon
  'tooltip-bg': '#2A2828', // tooltip 深底
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#EEEEEE', // E1D 中性底(实心胶囊,与 bg 同色)
  'update-btn-bg': '#EEEEEE', // E1D §15.10 反相中性:dark 浅底,承载深字
  'update-btn-text': '#252222', // E1D 中性字(#252222 on #EEEEEE = 13.60:1)
  'update-btn-hover': '#E2E2E2', // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  'accent-foreground': '0.0 0.0% 83.1%', // 裁决: accent 成对中性前景
  'panel-bg': '#2A2828', // 依赖 D1: 注册后直映背景
  primary: '0.0 0.0% 93.3%', // E1D C 类裁决 3:反相中性 HSL
  ring: '217.3 69.7% 56.1%', // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  'settings-theme-auto-light': '#EDEDED', // Auto 预览 light 固定
  foreground: '0.0 0.0% 83.1%', // alias closure 直接值
  border: '0.0 0.0% 26.3%', // alias closure
  input: '0.0 0.0% 26.3%', // alias closure
  'secondary-foreground': '0.0 0.0% 83.1%', // alias closure
  'popover-foreground': '0.0 0.0% 83.1%', // alias closure
  titlebar: '0.0 2.4% 16.1%', // alias closure: surface
  'titlebar-border': '0.0 0.0% 26.3%', // alias closure: border
  'titlebar-button-hover': '0.0 2.2% 18.0%', // alias closure: hover
  'titlebar-control-hover': '0.0 2.2% 18.0%', // alias closure: hover
  sidebar: '0.0 2.4% 16.1%', // alias closure: surface
  'sidebar-border': '0.0 0.0% 26.3%', // alias closure: border
  'sidebar-item-hover': '0.0 0.0% 100.0% / 0.09', // 玻璃面 hover 半透明化 2026-07-21:白 9% 叠加(原实色 hsl(0 2.2% 18%) 在暗玻璃底上的等价叠加量),壁纸可继续透过
  'sidebar-search-bg': '0.0 2.4% 16.1%', // alias closure: surface
  'sidebar-search-input-bg': 'rgba(0, 0, 0, 0.25)', // 玻璃面搜索输入框 2026-07-21:黑 25% 下陷字段感(与 hover 白 9% 方向相反,可区分"可输入")
  'sidebar-muted': '0 0% 43.5%', // E1D 侧栏层级:二级暗灰 #6F6F6F(行首图标普通态)
  'surface-translucent-sidebar': 'rgba(18, 15, 15, 0.80)', // 用户调参 2026-07-20:75%→80%(壁纸透入略收)
  'surface-translucent-main': '#2A2828', // E4D 主面板:用户勘误 2026-07-17 撤销毛玻璃,改不透明等价 surface(原 rgba(18,15,15,0.85))
  'surface-translucent-overlay': 'rgba(37, 35, 35, 0.80)', // E4D R1 模式3
  'composer-pill-bg': '#393838', // E2 composer pill 底(dark,lead Figma 实测 §2-3;取代错稿 glass-pill)
  'composer-pill-icon': '#D9D9D9', // E2 composer pill 图标(dark)
  'send-btn-bg': '#EEEEEE', // R4 D1/D2 反相中性可用底
  'send-btn-icon': '#252222', // R4 反相中性字
  'send-btn-disabled-bg': '#444242', // R4 禁用灰底
  'send-btn-disabled-icon': '#585555', // R4 禁用灰字
  'send-btn-hover-bg': '#E2E2E2', // E1D 反相中性 hover(lead 四态)
  'send-btn-pressed-bg': '#D4D4D4', // E1D 反相中性 pressed(lead 四态)
} as const;

export const cindyDark: Theme = {
  id: 'cindy-dark',
  name: 'CINDY Dark',
  type: 'dark',
  colors: overrides,
  // U5 品牌版横向 logo：白字+红箭头，深底可见。
  brand: { logo: { src: cindyLogoDark } },
};
