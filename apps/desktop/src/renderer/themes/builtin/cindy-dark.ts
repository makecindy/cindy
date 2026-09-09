import type { Theme } from '../types';
import cindyLogoDark from '../../assets/cindy-logo-dark.png';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../../shared/windowBackdrop';

/*
 * CINDY Dark — 品牌红 CTA + 中性近黑底(#181818)+ AA 正文;U2 二级信息色忠于 Figma 原值。
 * 值的唯一权威: token-decision-table.md §3(2026-07-17 U8 批准) + §9(2026-08 色阶改版,用户批准)。
 * §9 要点: 整体平移变暗且归零暖差、三级色等亮度转中性;已知债(层次保留率 ~65%)见 issue #2559。
 * 每个 override 注释来源;零自由裁量。
 */

const overrides = {
  surface: '#181818', // 直映: 页底(纯中性)
  'surface-hsl': '0 0% 9.4%', // 页底 -> HSL
  'surface-elevated': '#1F1F1F', // 卡片/输入框
  'surface-elevated-soft': '#1D1D1D', // hover/chip
  'surface-card-ivory': '#1F1F1F', // 卡片/输入框
  'surface-chip': '#1D1D1D', // hover/chip
  'surface-chip-alt': '#1D1D1D', // hover/chip
  'surface-hover': '#1D1D1D', // hover/chip
  'surface-hover-soft': '#191919', // 柔和 hover/代码块底
  'surface-hover-hsl': '0 0% 11.4%', // hover -> HSL
  'surface-on-card': '#181818', // 直映: 页底(纯中性)
  'switch-track-off': '#787878', // 关闭态轨道:值与依据见决策表(用户调参 2026-08-05)
  'switch-track-on': '#EEEEEE', // 开启态轨道:值与依据见决策表(用户调参 2026-08-05)
  'status-badge-fg': '#121212', // 反相深字: 平移
  'border-default': '#313131', // 边框
  'border-default-hsl': '0 0% 19.2%', // 边框 -> HSL
  'border-shadcn-hsl': '0 0% 19.2%', // 边框 -> HSL
  'border-transparent-mixed': '#313131', // 边框
  'text-primary': '#D4D4D4', // 直映: 正文
  'text-primary-on-dark': '#FFFFFF', // 深底/红底前景白
  'text-primary-emphasis': '#FFFFFF', // 强调正文
  'text-primary-inv': '#181818', // 直映: 页底(纯中性)
  'text-primary-body-strong': '#D4D4D4', // 直映: 正文
  'text-primary-hsl': '0.0 0.0% 83.1%', // 正文 -> HSL
  'text-secondary': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-cross': '#6F6F6F', // 直映: 二级信息; U2 例外
  'text-secondary-mid': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'text-tertiary': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'text-tertiary-stone': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'text-tertiary-mid': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'text-tertiary-hsl': '0.0 0.0% 75.7%', // 三级 -> HSL
  'text-disabled': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'text-disabled-tertiary': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'accent-cta-bg': '#EEEEEE', // E1D 反相中性底
  'accent-cta-bg-pure': '#EEEEEE', // E1D 反相中性底
  'accent-emphasis': '#EEEEEE', // E1D 反相中性底
  'accent-soft': '#D4D4D4', // E1D pressed 中性
  'accent-hover': '#E2E2E2', // E1D hover 中性
  'accent-pure-cta-fg': '#151515', // 反相深字(浅钮上)
  accent: '0 0% 11.4%', // hover -> HSL
  'agent-actions-rail': '#313131', // 边框
  'ask-checkbox-border': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'ask-header-chip-bg': '#282828', // 菜单 hover/提问卡纸片档
  'ask-send-disabled-bg': '#282828', // 菜单 hover/提问卡纸片档
  'ask-option-list-bg': '#282828', // 菜单 hover/提问卡纸片档
  'ask-option-hover': '#323232', // 禁用底/option hover 档
  background: '0 0% 9.4%', // 页底 -> HSL
  'chat-input-bg': '#1F1F1F', // 卡片/输入框
  'chat-input-border-focus': 'rgba(193, 193, 193, 0.30)', // 聚焦描边: 三级色 30% 派生
  'chat-input-chip-border': '#313131', // 边框
  'chat-input-text': '#D4D4D4', // 正文
  'color-primary': '#D4D4D4', // 正文
  'caret-accent': '#417CDD', // 用户改稿 2026-07-18:光标撤红改回蓝(对齐 focus 蓝 #417CDD)
  'confirm-bg': '#1F1F1F', // 卡片/输入框
  'confirm-btn-primary-bg': '#EEEEEE', // E1D C 类裁决 1:反相中性
  'confirm-btn-primary-text': '#151515', // 反相深字(浅钮上)
  'confirm-btn-secondary-border': '#313131', // 边框
  'confirm-btn-secondary-hover': 'rgba(255, 255, 255, 0.08)', // 中性 alpha hover
  'confirm-btn-secondary-text': '#D4D4D4', // 正文
  'confirm-title': '#D4D4D4', // 正文
  'file-chip-bg': '#292929', // 文件纸片
  'file-remove-bg': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'info-700': '#93C5FD', // 信息/链接蓝
  'model-trigger-hover': '#1D1D1D', // hover/chip
  // 下拉行 hover/选中底:必须比弹层面板(surface-elevated #312F2F)更亮才可见。
  // surface-hover(#2F2D2D)是为"压在页面底 #2A2828 上"调的,比抬起的面板还暗→行高亮隐形。
  // 故菜单行专用 token 单独抬亮一档(+12/通道),模型/权限/+ 三个菜单共用它,hover 统一可见。
  'model-item-hover': '#2B2B2B', // 下拉行 hover: 抬亮到面板之上(沿革见 2026-07 注)
  'msg-link': '#93C5FD', // 链接蓝
  'msg-scrollbar-hover': '#3E3E3E', // 弱档
  'msg-user-bg': '#1F1F1F', // 卡片/输入框
  muted: '0 0% 11.4%', // hover -> HSL
  'muted-foreground': '0.0 0.0% 75.7%', // 三级 -> HSL
  'perm-auto-selected-text': '#417CDD', // auto approval 功能色(E5D 定稿 2026-07-17,light/dark 同值)
  'perm-allow-btn-bg': '#EEEEEE', // E1D C 类裁决 2:反相中性
  'perm-allow-btn-text': '#151515', // 反相深字(浅钮上)
  'perm-allow-kbd-bg': 'rgba(0, 0, 0, 0.08)', // kbd bg:随反相浅钮的深翻译层(修复 2026-07-19:原页面级深灰在浅钮上吞掉近黑字)
  'perm-allow-kbd-border': 'rgba(0, 0, 0, 0.20)', // 边框:同上
  'perm-code-bg': '#191919', // 柔和 hover/代码块底
  'perm-item-selected-bg': '#1D1D1D', // hover/chip
  'plan-outline-active-bg': '#1D1D1D', // hover/chip
  'plan-toolbar-btn-hover-bg': '#323232', // 禁用底/option hover 档
  popover: '0 0% 12.2%', // 卡片 -> HSL
  'primary-foreground': '0.0 0.0% 100.0%', // 白前景
  'search-match-fg': '0.0 0.0% 83.1%', // search fg
  secondary: '0 0% 11.4%', // hover -> HSL
  'settings-btn-primary-text': '#151515', // 反相深字(浅钮上)
  'settings-btn-secondary-hover-bg': '#1D1D1D', // hover/chip
  'text-placeholder': '#C1C1C1', // 三级转中性(等亮度,2026-08-13)
  'settings-integration-avatar-bg': '#1D1D1D', // hover/chip
  'settings-logout-bg': '#1F1F1F', // 卡片/输入框
  'settings-menu-bg-hover': '#282828', // 菜单 hover/提问卡纸片档
  'settings-menu-bg-selected': '#282828', // 卡片锚定: 比卡片 #1F1F1F 亮一档(压在设置卡上的选中态)
  'settings-source-link': '#93C5FD', // 可访问链接蓝
  'settings-theme-auto-dark': '#181818', // Auto 预览: 新暗色底
  'sidebar-action-icon': '0 0% 43.5%', // E1D 侧栏层级:二级暗灰 #6F6F6F(时间戳/RemoteProjectIcon)
  'cmd-palette-item-meta': '#6F6F6F', // E1D 侧栏层级:二级暗灰(分组标签/meta)
  'sidebar-item-active-foreground': '#151515', // 反相深字(浅钮上)
  'sidebar-item-active-border': 'transparent', // 用户三次改稿 2026-07-20:选中胶囊彻底去描边
  'sidebar-item-active': '0.0 0.0% 93.3%', // 用户二次改稿 2026-07-20:反相胶囊 #EEEEEE 浅底(同 accent-cta-bg)
  'splash-bg': '0 0% 9.4%', // 页底 -> HSL
  'splash-text': '0.0 0.0% 75.7%', // 三级 -> HSL
  'splash-text-destructive': '0.0 0.0% 100.0%', // destructive splash text
  'splash-text-muted': '0.0 0.0% 75.7%', // 三级 -> HSL
  'titlebar-icon': '0.0 0.0% 75.7%', // 三级 -> HSL
  'tooltip-bg': '#181818', // 直映: 页底(纯中性)
  'tooltip-text': '#FFFFFF', // tooltip 白字
  'update-btn-border': '#EEEEEE', // E1D 中性底(实心胶囊,与 bg 同色)
  'update-btn-bg': '#EEEEEE', // E1D §15.10 反相中性:dark 浅底,承载深字
  'update-btn-text': '#151515', // 反相深字(浅钮上)
  'update-btn-hover': '#E2E2E2', // E1D §15.10 四态 hover(实心,非 alpha 叠加)
  'accent-foreground': '0.0 0.0% 83.1%', // 裁决: accent 成对中性前景
  'panel-bg': '#181818', // 直映: 页底(纯中性)
  primary: '0.0 0.0% 93.3%', // E1D C 类裁决 3:反相中性 HSL
  ring: '217.3 69.7% 56.1%', // 固定蓝(E5D 定稿 2026-07-17 #417CDD HSL,取代 #3b82f6)
  'settings-theme-auto-light': '#F2F2ED', // Auto 预览: 新页底(暖象牙)
  foreground: '0.0 0.0% 83.1%', // alias closure 直接值
  border: '0 0% 19.2%', // 边框 -> HSL
  input: '0 0% 19.2%', // 边框 -> HSL
  'secondary-foreground': '0.0 0.0% 83.1%', // alias closure
  'popover-foreground': '0.0 0.0% 83.1%', // alias closure
  titlebar: '0 0% 9.4%', // 页底 -> HSL
  'titlebar-border': '0 0% 19.2%', // 边框 -> HSL
  'titlebar-button-hover': '0 0% 11.4%', // hover -> HSL
  'titlebar-control-hover': '0 0% 11.4%', // hover -> HSL
  sidebar: '0 0% 9.4%', // 页底 -> HSL
  'sidebar-border': '0 0% 19.2%', // 边框 -> HSL
  'sidebar-item-hover': '0.0 0.0% 100.0% / 0.09', // 玻璃面 hover 半透明化 2026-07-21:白 9% 叠加(原实色 hsl(0 2.2% 18%) 在暗玻璃底上的等价叠加量),壁纸可继续透过
  'sidebar-search-bg': '0 0% 9.4%', // 页底 -> HSL
  'sidebar-search-input-bg': 'rgba(0, 0, 0, 0.25)', // 玻璃面搜索输入框 2026-07-21:黑 25% 下陷字段感(与 hover 白 9% 方向相反,可区分"可输入")
  'sidebar-muted': '0 0% 43.5%', // E1D 侧栏层级:二级暗灰 #6F6F6F(行首图标普通态)
  'surface-translucent-sidebar': CINDY_ACRYLIC_WINDOW_BACKING.dark, // 侧栏玻璃: 用户调参 2026-08-11(黑 5 度 85%)
  'surface-translucent-main': '#181818', // 直映: 页底(纯中性)
  'surface-translucent-overlay': 'rgba(21, 21, 21, 0.80)', // 浮层玻璃: 平移
  'composer-pill-bg': '#272727', // composer pill
  'composer-pill-icon': '#D9D9D9', // E2 composer pill 图标(dark)
  'send-btn-bg': '#EEEEEE', // R4 D1/D2 反相中性可用底
  'send-btn-icon': '#151515', // 反相深字(浅钮上)
  'send-btn-disabled-bg': '#323232', // 禁用底/option hover 档
  'send-btn-disabled-icon': '#464646', // 禁用图标
  'send-btn-hover-bg': '#E2E2E2', // E1D 反相中性 hover(lead 四态)
  'send-btn-pressed-bg': '#D4D4D4', // E1D 反相中性 pressed(lead 四态)
  // ── 2026-08 色阶改版新增 override(原走注册表默认值,现按新阶梯定值;决策表 §9)──
  'completion-badge-fg': '#121212', // 反相深字: 平移
  'create-agent-control-bg': '#272727', // composer pill
  'create-agent-control-bg-hover': '#323232', // 禁用底/option hover 档
  'create-agent-control-bg-pressed': '#3E3E3E', // 弱档
  'create-agent-control-border': '#313131', // 边框
  'create-agent-quick-card-bg': '#1F1F1F', // 卡片/输入框
  'create-agent-quick-card-bg-hover': '#292929', // 文件纸片
  'create-agent-quick-card-border': '#313131', // 边框
  'create-agent-quick-card-icon-bg': '#181818', // 直映: 页底(纯中性)
  'create-agent-segment-track-bg': '#181818', // 直映: 页底(纯中性)
  'create-agent-send-disabled-bg': '#323232', // 禁用底/option hover 档
  'create-agent-send-disabled-icon': '#464646', // 禁用图标
  'create-agent-send-icon': '#151515', // 反相深字(浅钮上)
  'md-table-bg': 'rgba(26, 26, 26, 0.55)', // 表格条纹: 平移
  // ── 对侧入表锚定: 值 = 本侧此前的注册表解析原值(解析结果不变, 仅为决策表双边冻结)──
  'ask-badge-bg': 'var(--surface-chip)',
  'cmd-palette-item-hover': 'var(--surface-hover)',
  'create-agent-control-icon': '#D9D9D9',
  'create-agent-control-text': '#D4D4D4',
  'create-agent-quick-card-icon': '#D4D4D4',
  'create-agent-quick-card-text': '#D4D4D4',
  'create-agent-segment-inactive-text': '#6F6F6F',
  'settings-integration-avatar-border': 'rgba(255, 255, 255, 0.08)',
  'sidebar-list-muted': '#6F6F6F',
  'sidebar-nav-text': '#D4D4D4',
  'sidebar-user-card-bg-hover': 'rgba(255, 255, 255, 0.10)',
  'sidebar-user-card-border': 'rgba(255, 255, 255, 0.13)',
  'sidebar-user-card-text': '#D4D4D4',
} as const;

export const cindyDark: Theme = {
  id: 'cindy-dark',
  name: 'CINDY Dark',
  type: 'dark',
  colors: overrides,
  // U5 品牌版横向 logo：白字+红箭头，深底可见。
  brand: { logo: { src: cindyLogoDark } },
};
