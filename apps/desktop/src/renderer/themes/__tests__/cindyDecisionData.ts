// 自动从 2026-07-17-cindy-token-decision-table.md 提取(U8 批准冻结值)。
// E1D 红色体系重构(用户批准 2026-07-17):B 类 11 项改反相中性,C 类按 8 项裁决。
// D2T 八组断言 + 零残留脚本共享的决策基线;手改 cindy 主题值时此处不变 → 测试抓漂移。
// 不要手编此文件;改值请先过用户关卡再更新决策表 + 重生成。

export const CINDY_REQUIRED_COLOR_IDS = [
  'surface',
  'surface-hsl',
  'surface-elevated',
  'surface-elevated-soft',
  'surface-card-ivory',
  'surface-chip',
  'surface-chip-alt',
  'surface-hover',
  'surface-hover-soft',
  'surface-hover-hsl',
  'surface-on-card',
  'border-default',
  'border-default-hsl',
  'border-shadcn-hsl',
  'border-transparent-mixed',
  'text-primary',
  'text-primary-on-dark',
  'text-primary-emphasis',
  'text-primary-inv',
  'text-primary-body-strong',
  'text-primary-hsl',
  'text-secondary',
  'text-secondary-cross',
  'text-secondary-mid',
  'text-tertiary',
  'text-tertiary-stone',
  'text-tertiary-mid',
  'text-tertiary-hsl',
  'text-disabled',
  'text-disabled-tertiary',
  'caret-accent',
  'accent-cta-bg',
  'accent-cta-bg-pure',
  'accent-emphasis',
  'accent-soft',
  'accent-hover',
  'accent-pure-cta-fg',
  'accent',
  'agent-actions-rail',
  'ask-checkbox-border',
  'background',
  'chat-input-bg',
  'chat-input-border-focus',
  'chat-input-chip-border',
  'chat-input-text',
  'color-primary',
  'confirm-bg',
  'confirm-btn-primary-bg',
  'confirm-btn-primary-text',
  'confirm-btn-secondary-border',
  'confirm-btn-secondary-hover',
  'confirm-btn-secondary-text',
  'confirm-title',
  'file-chip-bg',
  'file-remove-bg',
  'info-700',
  'model-trigger-hover',
  'msg-link',
  'msg-scrollbar-hover',
  'msg-user-bg',
  'muted',
  'muted-foreground',
  'perm-auto-selected-text',
  'perm-allow-btn-bg',
  'perm-allow-btn-text',
  'perm-allow-kbd-bg',
  'perm-allow-kbd-border',
  'perm-code-bg',
  'perm-item-selected-bg',
  'plan-outline-active-bg',
  'plan-toolbar-btn-hover-bg',
  'popover',
  'primary-foreground',
  'search-match-fg',
  'secondary',
  'settings-btn-primary-text',
  'settings-btn-secondary-hover-bg',
  'text-placeholder',
  'settings-integration-avatar-bg',
  'settings-logout-bg',
  'settings-menu-bg-hover',
  'settings-menu-bg-selected',
  'settings-source-link',
  'settings-theme-auto-dark',
  'sidebar-action-icon',
  'sidebar-item-active-foreground', // 用户改稿 2026-07-20:选中胶囊中性前景
  'sidebar-item-active-border', // 用户改稿 2026-07-20:选中 pill 中性描边
  'cmd-palette-item-meta', // E1D 侧栏层级(分组标签/meta 二级暗灰)
  'sidebar-item-active',
  'splash-bg',
  'splash-text',
  'splash-text-destructive',
  'splash-text-muted',
  'titlebar-icon',
  'tooltip-bg',
  'tooltip-text',
  'update-btn-border',
  'update-btn-text',
  'accent-foreground',
  'panel-bg',
  'primary',
  'ring',
  'settings-theme-auto-light',
  'foreground',
  'border',
  'input',
  'secondary-foreground',
  'popover-foreground',
  'titlebar',
  'titlebar-border',
  'titlebar-button-hover',
  'titlebar-control-hover',
  'sidebar',
  'sidebar-border',
  'sidebar-item-hover',
  'sidebar-search-bg',
  'sidebar-muted',
  'status-badge-fg', // D2 期新增,值经队列震荡后按 HEAD 冻结(#1F1F1F,5.61:1 × #FF6600 ≥4.5),批准依据:用户亲批方案 2026-07-17,115→116
  'surface-translucent-sidebar', // R1 增补(E4D 毛玻璃,用户裁决透壁纸 2026-07-17)
  'surface-translucent-main', // R1 增补(E4D)
  'surface-translucent-overlay', // R1 增补(E4D)
  'sidebar-search-input-bg', // 玻璃面搜索输入框半透明化(用户裁决 2026-07-21)
  'composer-pill-bg', // E2 composer pill 底(取代错稿 glass-pill-bg,玻璃质感已废)
  'composer-pill-icon', // E2 composer pill 图标
  // E1D send-btn 族纳入值表(lead 裁决反相中性四态 + disabled #444242 系):
  'send-btn-bg',
  'send-btn-icon',
  'send-btn-hover-bg', // E1D 新增(反相中性 hover)
  'send-btn-pressed-bg', // E1D 新增(反相中性 pressed)
  'send-btn-disabled-bg',
  'send-btn-disabled-icon', // 120→126
] as const;

export const HSL_FORMAT_IDS = [
  'surface-hsl',
  'surface-hover-hsl',
  'border-default-hsl',
  'border-shadcn-hsl',
  'text-primary-hsl',
  'text-tertiary-hsl',
  'background',
  'foreground',
  'muted',
  'muted-foreground',
  'border',
  'input',
  'ring',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'accent',
  'accent-foreground',
  'popover',
  'popover-foreground',
  'titlebar',
  'titlebar-border',
  'titlebar-icon',
  'titlebar-button-hover',
  'titlebar-control-hover',
  'splash-bg',
  'splash-text',
  'splash-text-muted',
  'splash-text-destructive',
  'destructive',
  'sidebar',
  'sidebar-border',
  'sidebar-item-hover',
  'sidebar-item-active',
  'sidebar-search-bg',
  'sidebar-muted',
  'sidebar-action-icon',
  'search-match-bg',
  'search-match-fg',
  'content-area',
  'welcome-text',
] as const;

export const CINDY_EXPECTED_VALUES: Record<string, { light: string; dark: string }> = {
  surface: { light: '#EDEDED', dark: '#2A2828' },
  'surface-hsl': { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'surface-elevated': { light: '#F8F8F8', dark: '#312F2F' },
  'surface-elevated-soft': { light: '#F4F4F4', dark: '#2F2D2D' },
  'surface-card-ivory': { light: '#F8F8F8', dark: '#312F2F' },
  'surface-chip': { light: '#F1F1F1', dark: '#2F2D2D' },
  'surface-chip-alt': { light: '#F4F4F4', dark: '#2F2D2D' },
  'surface-hover': { light: '#F1F1F1', dark: '#2F2D2D' },
  'surface-hover-soft': { light: '#EFEFEF', dark: '#2B2929' },
  'surface-hover-hsl': { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  'surface-on-card': { light: '#FFFFFF', dark: '#2A2828' },
  'border-default': { light: '#DCDFE3', dark: '#434343' },
  'border-default-hsl': { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  'border-shadcn-hsl': { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  'border-transparent-mixed': { light: 'transparent', dark: '#434343' },
  'text-primary': { light: '#3C3F43', dark: '#D4D4D4' },
  'text-primary-on-dark': { light: '#FFFFFF', dark: '#FFFFFF' },
  'text-primary-emphasis': { light: '#2E3237', dark: '#FFFFFF' },
  'text-primary-inv': { light: '#FFFFFF', dark: '#2A2828' },
  'text-primary-body-strong': { light: '#3C3F43', dark: '#D4D4D4' },
  'text-primary-hsl': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  'text-secondary': { light: '#8C8E94', dark: '#6F6F6F' }, // 用户调参 2026-07-20:light 二次加深 #8C8E94
  'text-secondary-cross': { light: '#9A9DA3', dark: '#6F6F6F' },
  'text-secondary-mid': { light: '#686B72', dark: '#BFC1C4' },
  'text-tertiary': { light: '#686B72', dark: '#BFC1C4' },
  'text-tertiary-stone': { light: '#686B72', dark: '#BFC1C4' },
  'text-tertiary-mid': { light: '#686B72', dark: '#BFC1C4' },
  'text-tertiary-hsl': { light: '222.0 4.6% 42.7%', dark: '216.0 4.1% 75.9%' },
  'text-disabled': { light: '#686B72', dark: '#BFC1C4' },
  'text-disabled-tertiary': { light: '#686B72', dark: '#BFC1C4' },
  'caret-accent': { light: '#417CDD', dark: '#417CDD' }, // 用户改稿 2026-07-18:光标撤红改回蓝
  'accent-cta-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-cta-bg-pure': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-emphasis': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-soft': { light: '#25282C', dark: '#D4D4D4' }, // E1D
  'accent-hover': { light: '#2E3237', dark: '#E2E2E2' }, // E1D
  'accent-pure-cta-fg': { light: '#FCFCFC', dark: '#252222' }, // E1D
  accent: { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  'agent-actions-rail': { light: '#DCDFE3', dark: '#434343' },
  'ask-checkbox-border': { light: '#686B72', dark: '#BFC1C4' },
  background: { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'chat-input-bg': { light: '#F8F8F8', dark: '#312F2F' },
  'chat-input-border-focus': {
    light: 'rgba(104, 107, 114, 0.30)',
    dark: 'rgba(191, 193, 196, 0.30)',
  }, // 用户改稿 2026-07-20:输入框聚焦描边降至 30%
  'chat-input-chip-border': { light: '#DCDFE3', dark: '#434343' },
  'chat-input-text': { light: '#3C3F43', dark: '#D4D4D4' },
  'color-primary': { light: '#3C3F43', dark: '#D4D4D4' },
  'confirm-bg': { light: '#F8F8F8', dark: '#312F2F' },
  'confirm-btn-primary-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'confirm-btn-primary-text': { light: '#FCFCFC', dark: '#252222' }, // E1D
  'confirm-btn-secondary-border': { light: '#DCDFE3', dark: '#434343' },
  'confirm-btn-secondary-hover': {
    light: 'rgba(0, 0, 0, 0.06)',
    dark: 'rgba(255, 255, 255, 0.08)',
  },
  'confirm-btn-secondary-text': { light: '#3C3F43', dark: '#D4D4D4' },
  'confirm-title': { light: '#3C3F43', dark: '#D4D4D4' },
  'file-chip-bg': { light: '#D8D9DB', dark: '#3B3A3A' },
  'file-remove-bg': { light: '#686B72', dark: '#BFC1C4' },
  'info-700': { light: '#1D4ED8', dark: '#93C5FD' },
  'model-trigger-hover': { light: '#F1F1F1', dark: '#2F2D2D' },
  'msg-link': { light: '#1D4ED8', dark: '#93C5FD' },
  'msg-scrollbar-hover': { light: '#D8D9DB', dark: '#504F4F' },
  'msg-user-bg': { light: '#F8F8F8', dark: '#312F2F' },
  muted: { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  'muted-foreground': { light: '222.0 4.6% 42.7%', dark: '216.0 4.1% 75.9%' },
  'perm-auto-selected-text': { light: '#417CDD', dark: '#417CDD' }, // E5D 定稿 2026-07-17
  'perm-allow-btn-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'perm-allow-btn-text': { light: '#FCFCFC', dark: '#252222' }, // E1D
  // E1D send-btn 族(lead 反相中性四态 + disabled #444242 系;default send-btn-bg aliases accent-cta-bg,CINDY override 全族)
  'send-btn-bg': { light: '#3C3F43', dark: '#EEEEEE' },
  'send-btn-icon': { light: '#FCFCFC', dark: '#252222' },
  'send-btn-hover-bg': { light: '#2E3237', dark: '#E2E2E2' },
  'send-btn-pressed-bg': { light: '#25282C', dark: '#D4D4D4' },
  'send-btn-disabled-bg': { light: '#444242', dark: '#444242' },
  'send-btn-disabled-icon': { light: '#585555', dark: '#585555' },
  'perm-allow-kbd-bg': { light: 'rgba(255, 255, 255, 0.16)', dark: 'rgba(0, 0, 0, 0.08)' }, // 2026-07-19 修复:kbd 随按钮反相
  'perm-allow-kbd-border': { light: 'rgba(255, 255, 255, 0.30)', dark: 'rgba(0, 0, 0, 0.20)' },
  'perm-code-bg': { light: '#F5F5F5', dark: '#2B2929' },
  'perm-item-selected-bg': { light: '#F1F1F1', dark: '#2F2D2D' },
  'plan-outline-active-bg': { light: '#F1F1F1', dark: '#2F2D2D' },
  'plan-toolbar-btn-hover-bg': { light: '#E2E2E2', dark: '#444242' }, // 用户改稿 2026-07-23(ask 卡整改):原值贴着卡底(#F8F8F8/#312F2F)不可见,借 settings-menu-bg-hover(light)/send-btn-disabled-bg(dark)同档
  popover: { light: '0.0 0.0% 97.3%', dark: '0.0 2.1% 18.8%' },
  'primary-foreground': { light: '0.0 0.0% 100.0%', dark: '0.0 0.0% 100.0%' },
  'search-match-fg': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  secondary: { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  'settings-btn-primary-text': { light: '#FCFCFC', dark: '#252222' }, // E1D
  'settings-btn-secondary-hover-bg': { light: '#F1F1F1', dark: '#2F2D2D' },
  'text-placeholder': { light: '#686B72', dark: '#BFC1C4' },
  'settings-integration-avatar-bg': { light: '#F8F8F8', dark: '#2F2D2D' },
  'settings-logout-bg': { light: '#F8F8F8', dark: '#312F2F' },
  'settings-menu-bg-hover': { light: '#E2E2E2', dark: '#3A3838' }, // 用户改稿 2026-07-21:原值贴着页底(#EDEDED/#2A2828)不可见,light 压暗 / dark 提亮到 ~5-6% 亮度差
  'settings-menu-bg-selected': { light: '#F1F1F1', dark: '#2F2D2D' },
  'settings-source-link': { light: '#1D4ED8', dark: '#93C5FD' },
  'settings-theme-auto-dark': { light: '#2A2828', dark: '#2A2828' },
  'sidebar-action-icon': { light: '220.0 4.7% 62.2%', dark: '0 0% 43.5%' }, // E1D 侧栏层级 #9A9DA3/#6F6F6F
  'cmd-palette-item-meta': { light: '#9A9DA3', dark: '#6F6F6F' }, // E1D 侧栏二级暗灰
  'sidebar-item-active-foreground': { light: '#FCFCFC', dark: '#252222' }, // 用户二次改稿 2026-07-20:反相胶囊浅字/深字(同 accent-pure-cta-fg)
  'sidebar-item-active-border': { light: 'transparent', dark: 'transparent' }, // 用户三次改稿 2026-07-20:去描边
  'sidebar-item-active': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 93.3%' }, // 用户二次改稿 2026-07-20:反相胶囊 #3C3F43/#EEEEEE(同 accent-cta-bg)
  'splash-bg': { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'splash-text': { light: '222.0 4.6% 42.7%', dark: '216.0 4.1% 75.9%' },
  'splash-text-destructive': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 100.0%' },
  'splash-text-muted': { light: '222.0 4.6% 42.7%', dark: '216.0 4.1% 75.9%' },
  'titlebar-icon': { light: '222.0 4.6% 42.7%', dark: '216.0 4.1% 75.9%' },
  'tooltip-bg': { light: '#3C3F43', dark: '#2A2828' },
  'tooltip-text': { light: '#FFFFFF', dark: '#FFFFFF' },
  'update-btn-border': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'update-btn-text': { light: '#FCFCFC', dark: '#252222' }, // E1D
  'accent-foreground': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  'panel-bg': { light: '#EDEDED', dark: '#2A2828' },
  primary: { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 93.3%' }, // E1D
  ring: { light: '217.3 69.7% 56.1%', dark: '217.3 69.7% 56.1%' }, // E5D 定稿 2026-07-17 #417CDD HSL(取代 #3b82f6)
  'settings-theme-auto-light': { light: '#EDEDED', dark: '#EDEDED' },
  foreground: { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  border: { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  input: { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  'secondary-foreground': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  'popover-foreground': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 83.1%' },
  titlebar: { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'titlebar-border': { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  'titlebar-button-hover': { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  'titlebar-control-hover': { light: '0.0 0.0% 94.5%', dark: '0.0 2.2% 18.0%' },
  sidebar: { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'sidebar-border': { light: '214.3 11.1% 87.6%', dark: '0.0 0.0% 26.3%' },
  'sidebar-item-hover': { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.09' }, // 用户裁决 2026-07-21:玻璃面 hover 半透明化(黑 5% / 白 9% 叠加替代实色,壁纸可透过)
  'sidebar-search-bg': { light: '0.0 0.0% 92.9%', dark: '0.0 2.4% 16.1%' },
  'sidebar-muted': { light: '220.0 4.7% 62.2%', dark: '0 0% 43.5%' }, // E1D 侧栏层级 #9A9DA3/#6F6F6F
  'status-badge-fg': { light: '#1F1F1F', dark: '#1F1F1F' }, // §7 必炸点(lead 裁决)
  'surface-translucent-sidebar': {
    light: 'rgba(255, 255, 255, 0.80)',
    dark: 'rgba(18, 15, 15, 0.80)',
  }, // 用户调参 2026-07-20:双端 80%(light #F6F6F6 试色后退回纯白)
  'sidebar-search-input-bg': {
    light: 'rgba(255, 255, 255, 0.55)',
    dark: 'rgba(0, 0, 0, 0.25)',
  }, // 用户裁决 2026-07-21:玻璃面搜索输入框半透明化(与 hover 叠加方向相反,保证"可输入"字段感)
  'surface-translucent-main': { light: '#EDEDED', dark: '#2A2828' }, // E4D 主面板:用户勘误 2026-07-17 撤销毛玻璃,改不透明等价 surface(原 rgba 半透明)
  'surface-translucent-overlay': {
    light: 'rgba(246, 246, 246, 0.90)',
    dark: 'rgba(37, 35, 35, 0.80)',
  }, // E4D R1 模式3
  'composer-pill-bg': { light: '#FCFCFC', dark: '#393838' }, // E2 composer pill 底(取代 glass-pill-bg)
  'composer-pill-icon': { light: '#3C3F43', dark: '#D9D9D9' }, // E2 composer pill 图标
};

// E1D 红色体系重构(用户批准 2026-07-17):三份新 map 替代旧 BRAND_RED_*。
// 常规主操作反相中性(light #3C3F43/#FCFCFC, dark #EEEEEE/#252222);
// 红仅限 A 类(brand-login/error);sidebar-item-active 已于 2026-07-20 按用户改稿撤红改中性。
export const NEUTRAL_PRIMARY_EXPECTED_BY_ID: Record<string, { light: string; dark: string }> = {
  'accent-cta-bg': { light: '#3C3F43', dark: '#EEEEEE' },
  'accent-cta-bg-pure': { light: '#3C3F43', dark: '#EEEEEE' },
  'accent-emphasis': { light: '#3C3F43', dark: '#EEEEEE' },
  'confirm-btn-primary-bg': { light: '#3C3F43', dark: '#EEEEEE' },
  'perm-allow-btn-bg': { light: '#3C3F43', dark: '#EEEEEE' },
  'update-btn-border': { light: '#3C3F43', dark: '#EEEEEE' },
  primary: { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 93.3%' },
};

export const NEUTRAL_PRIMARY_FOREGROUND_BY_ID = [
  'accent-pure-cta-fg',
  'confirm-btn-primary-text',
  'perm-allow-btn-text',
  'settings-btn-primary-text',
  'update-btn-text',
] as const;

export const RED_EXCEPTION_ALLOWED_IDS = [
  // A 类:品牌资产/错误(保留红)
  'brand-login-bg',
  'brand-login-error-border',
  'brand-login-error-text',
  // hover/soft token(中性,但 token 名保留在 allowed 防误报)
  'accent-soft',
  'accent-hover',
  'confirm-btn-primary-hover',
  'settings-btn-primary-bg',
  'settings-btn-primary-border',
  'settings-btn-primary-hover-bg',
] as const;

// 旧 BRAND_RED_* map(保留供 D2T 迁移,迁完删):
export const BRAND_RED_EXPECTED_BY_ID: Record<string, string> = {
  'accent-cta-bg': '#DF0C27',
  'accent-cta-bg-pure': '#DF0C27',
  'accent-emphasis': '#DF0C27',
  'confirm-btn-primary-bg': '#DF0C27',
  'perm-allow-btn-bg': '#DF0C27',
  primary: '352.3 89.8% 46.1%',
  'update-btn-border': '#DF0C27',
  'update-btn-text': '#DF0C27',
};

export const BRAND_RED_ALLOWED_IDS = [
  'accent-cta-bg',
  'accent-cta-bg-pure',
  'accent-emphasis',
  'confirm-btn-primary-bg',
  'perm-allow-btn-bg',
  'primary',
  'update-btn-border',
  'update-btn-text',
  'accent-soft',
  'accent-hover',
  'confirm-btn-primary-hover',
  'settings-btn-primary-bg',
  'settings-btn-primary-border',
  'settings-btn-primary-hover-bg',
] as const;

export const CTA_FOREGROUND_WHITE_IDS = [
  'accent-pure-cta-fg',
  'confirm-btn-primary-text',
  'perm-allow-btn-text',
  'primary-foreground',
  'settings-btn-primary-text',
] as const;
