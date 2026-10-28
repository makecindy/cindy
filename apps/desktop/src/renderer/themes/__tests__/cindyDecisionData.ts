// 初版自动从 2026-07-17-cindy-token-decision-table.md 提取(U8 批准冻结值;该表为
// 设计期工作文件,不随仓维护,生成器亦未入仓——见 DESIGN.md §15 对权威载体的说明)。
// E1D 红色体系重构(用户批准 2026-07-17):B 类 11 项改反相中性,C 类按 8 项裁决。
// D2T 八组断言 + 零残留脚本共享的决策基线;手改 cindy 主题值时此处不变 → 测试抓漂移。
// 2026-08 色阶改版(用户逐项批准 2026-08-11~14,正本 token-decision-table.md §9):
// light 暖象牙阶梯 + dark 中性近黑,受影响条目值已按新阶梯更新。
// 2026-10-22 墨水改版(用户裁决,正本 token-decision-table.md §9.2/§9.4):文字、悬停/标签底、
// 选中/按下与边框改为浅色黑 / 深色白的墨水加透明度,受影响条目已逐项更新。
// 修订契约:改值必须先过用户关卡,然后直接更新本文件对应条目,并以「用户裁决/调参/
// 改稿 + 日期」行尾注释记录依据(先例:caret-accent 2026-07-18、text-secondary
// 2026-07-20、switch-track-off 2026-08-05);没有带日期用户裁决的手编仍然禁止。

export const CINDY_REQUIRED_COLOR_IDS = [
  'segmented-option-fg',
  'segmented-hover-bg',
  'segmented-selected-bg',
  'segmented-selected-border',
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
  'switch-track-off', // 用户裁决 2026-08-05 入表(见 CINDY_EXPECTED_VALUES 同名条目)
  'switch-thumb-on', // 用户批准 2026-09-16 HTML 效果
  'switch-thumb-off', // 用户批准 2026-09-16 HTML 效果
  'switch-track-on', // 用户裁决 2026-08-05 入表(见 CINDY_EXPECTED_VALUES 同名条目)
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
  // 用户裁决 2026-09-18: Segmented v8 低对比选中药丸。
  'segmented-option-fg': { light: '#6B6B67', dark: '#AAAAAA' },
  'segmented-hover-bg': { light: '#E4E4DF', dark: '#292929' },
  'segmented-selected-bg': { light: '#FDFDF8', dark: '#353535' },
  'segmented-selected-border': { light: '#F0F0EB', dark: '#3B3B3B' },
  surface: { light: '#F2F2ED', dark: '#181818' },
  'surface-hsl': { light: '60.0 16.1% 93.9%', dark: '0 0% 9.4%' },
  'surface-elevated': { light: '#FDFDF8', dark: '#1F1F1F' },
  'surface-elevated-soft': { light: '#FAFAF5', dark: '#1D1D1D' },
  'surface-card-ivory': { light: '#FDFDF8', dark: '#1F1F1F' },
  'surface-chip': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'surface-chip-alt': { light: '#FAFAF5', dark: '#1D1D1D' },
  'surface-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'surface-hover-soft': { light: 'rgba(0, 0, 0, 0.035)', dark: 'rgba(255, 255, 255, 0.04)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'surface-hover-hsl': { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'surface-on-card': { light: '#FFFFFF', dark: '#181818' },
  'border-default': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'border-default-hsl': { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'border-shadcn-hsl': { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'border-transparent-mixed': { light: 'transparent', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-primary': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-primary-on-dark': { light: '#FFFFFF', dark: '#FFFFFF' },
  'text-primary-emphasis': { light: 'rgba(0, 0, 0, 0.95)', dark: 'rgba(255, 255, 255, 1.00)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-primary-inv': { light: '#FFFFFF', dark: '#181818' },
  'text-primary-body-strong': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-primary-hsl': { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-secondary': { light: 'rgba(0, 0, 0, 0.56)', dark: 'rgba(255, 255, 255, 0.55)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、用户调参 2026-07-20:light 二次加深 #8C8E94
  'text-secondary-cross': { light: 'rgba(0, 0, 0, 0.44)', dark: 'rgba(255, 255, 255, 0.40)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-secondary-mid': { light: 'rgba(0, 0, 0, 0.70)', dark: 'rgba(255, 255, 255, 0.66)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-tertiary': { light: 'rgba(0, 0, 0, 0.44)', dark: 'rgba(255, 255, 255, 0.40)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-tertiary-stone': { light: 'rgba(0, 0, 0, 0.56)', dark: 'rgba(255, 255, 255, 0.55)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-tertiary-mid': { light: 'rgba(0, 0, 0, 0.70)', dark: 'rgba(255, 255, 255, 0.66)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-tertiary-hsl': { light: '0.0 0.0% 0.0% / 0.56', dark: '0.0 0.0% 100.0% / 0.55' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-disabled': { light: 'rgba(0, 0, 0, 0.32)', dark: 'rgba(255, 255, 255, 0.30)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-disabled-tertiary': { light: 'rgba(0, 0, 0, 0.44)', dark: 'rgba(255, 255, 255, 0.40)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'slider-track': { light: '#A3A39E', dark: '#626262' },
  'slider-fill': { light: '#3C3F43', dark: '#EEEEEE' },
  'slider-thumb': { light: '#FDFDF8', dark: '#FCFCFC' },
  'switch-track-off': { light: '#808080', dark: '#787878' }, // 用户裁决 2026-10-22: light 随悬停墨水加深 #888888→#808080,压在悬停行上保住 3:1;沿革: 用户调参 2026-08-05:两端都顶到 3:1 底线内的极值拉开开/关差距——light 最亮档 #888888(×surface 3.03),dark 最深档 #787878(×elevated 3.01,等效白 36% 透明)
  'switch-track-on': { light: '#417CDD', dark: '#417CDD' }, // 用户裁决 2026-09-15:两模式开启轨道改为蓝色,替代 2026-08-05 中性开启态;亮色滑块后续裁决见下
  'switch-thumb-on': { light: 'hsl(var(--background))', dark: '#FCFCFC' }, // 用户批准 2026-09-16:暗色亮滑块,浅色保留别名
  'switch-thumb-off': { light: 'var(--surface-on-card)', dark: '#FCFCFC' }, // 用户批准 2026-09-16:开关两态统一亮滑块
  'caret-accent': { light: '#417CDD', dark: '#417CDD' }, // 用户改稿 2026-07-18:光标撤红改回蓝
  'accent-cta-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-cta-bg-pure': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-emphasis': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'accent-soft': { light: '#25282C', dark: '#D4D4D4' }, // E1D
  'accent-hover': { light: '#2E3237', dark: '#E2E2E2' }, // E1D
  'accent-pure-cta-fg': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: E1D
  accent: { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'agent-actions-rail': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'ask-checkbox-border': { light: 'rgba(0, 0, 0, 0.70)', dark: 'rgba(255, 255, 255, 0.66)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  background: { light: '60.0 16.1% 93.9%', dark: '0 0% 9.4%' },
  'chat-input-bg': { light: '#FDFDF8', dark: '#1F1F1F' },
  'chat-input-border-focus': {
    light: 'rgba(107, 107, 103, 0.30)',
    dark: 'rgba(193, 193, 193, 0.30)',
  }, // 用户改稿 2026-07-20:输入框聚焦描边降至 30%
  'chat-input-chip-border': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'chat-input-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'color-primary': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'confirm-bg': { light: '#FDFDF8', dark: '#1F1F1F' },
  'confirm-btn-primary-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'confirm-btn-primary-text': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: E1D
  'confirm-btn-secondary-border': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'confirm-btn-secondary-hover': {
    light: 'rgba(0, 0, 0, 0.06)',
    dark: 'rgba(255, 255, 255, 0.08)',
  },
  'confirm-btn-secondary-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'confirm-title': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'file-chip-bg': { light: 'rgba(0, 0, 0, 0.10)', dark: 'rgba(255, 255, 255, 0.13)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'file-remove-bg': { light: 'rgba(0, 0, 0, 0.70)', dark: 'rgba(255, 255, 255, 0.66)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'info-700': { light: '#1D4ED8', dark: '#93C5FD' },
  'model-trigger-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'msg-link': { light: '#1D4ED8', dark: '#93C5FD' },
  'msg-scrollbar-hover': { light: 'rgba(0, 0, 0, 0.10)', dark: 'rgba(255, 255, 255, 0.13)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'msg-user-bg': { light: '#FDFDF8', dark: '#1F1F1F' },
  muted: { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'muted-foreground': { light: '0.0 0.0% 0.0% / 0.56', dark: '0.0 0.0% 100.0% / 0.55' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'perm-auto-selected-text': { light: '#417CDD', dark: '#417CDD' }, // E5D 定稿 2026-07-17
  'perm-allow-btn-bg': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'perm-allow-btn-text': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: E1D
  // E1D send-btn 族(lead 反相中性四态 + disabled #444242 系;default send-btn-bg aliases accent-cta-bg,CINDY override 全族)
  'send-btn-bg': { light: '#3C3F43', dark: '#EEEEEE' },
  'send-btn-icon': { light: '#FCFCFC', dark: '#151515' },
  'send-btn-hover-bg': { light: '#2E3237', dark: '#E2E2E2' },
  'send-btn-pressed-bg': { light: '#25282C', dark: '#D4D4D4' },
  'send-btn-disabled-bg': { light: '#444242', dark: '#323232' },
  'send-btn-disabled-icon': { light: '#585555', dark: '#464646' },
  'perm-allow-kbd-bg': { light: 'rgba(255, 255, 255, 0.16)', dark: 'rgba(0, 0, 0, 0.08)' }, // 2026-07-19 修复:kbd 随按钮反相
  'perm-allow-kbd-border': { light: 'rgba(255, 255, 255, 0.30)', dark: 'rgba(0, 0, 0, 0.20)' },
  'perm-code-bg': { light: '#FAFAF5', dark: '#191919' },
  'perm-item-selected-bg': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'plan-outline-active-bg': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'plan-toolbar-btn-hover-bg': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、用户改稿 2026-07-23(ask 卡整改):原值贴着卡底(#F8F8F8/#312F2F)不可见,借 settings-menu-bg-hover(light)/send-btn-disabled-bg(dark)同档
  popover: { light: '60.0 55.6% 98.2%', dark: '0 0% 12.2%' },
  'primary-foreground': { light: '0.0 0.0% 100.0%', dark: '0.0 0.0% 100.0%' },
  'search-match-fg': { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  secondary: { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'settings-btn-primary-text': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: E1D
  'settings-btn-secondary-hover-bg': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'text-placeholder': { light: 'rgba(0, 0, 0, 0.32)', dark: 'rgba(255, 255, 255, 0.30)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'settings-integration-avatar-bg': { light: '#FDFDF8', dark: '#1D1D1D' },
  'settings-logout-bg': { light: '#FDFDF8', dark: '#1F1F1F' },
  'settings-menu-bg-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、用户改稿 2026-07-21:原值贴着页底(#EDEDED/#2A2828)不可见,light 压暗 / dark 提亮到 ~5-6% 亮度差
  'settings-menu-bg-selected': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08-13: dark 从页底锚定 #1D1D1D 抬到卡片之上,与 settings-menu-bg-hover 同档
  'settings-source-link': { light: '#1D4ED8', dark: '#93C5FD' },
  'settings-theme-auto-dark': { light: '#181818', dark: '#181818' },
  'sidebar-action-icon': { light: '0.0 0.0% 0.0% / 0.44', dark: '0.0 0.0% 100.0% / 0.40' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、E1D 侧栏层级 #9A9DA3/#6F6F6F
  'cmd-palette-item-meta': { light: 'rgba(0, 0, 0, 0.56)', dark: 'rgba(255, 255, 255, 0.55)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、E1D 侧栏二级暗灰
  'sidebar-item-active-foreground': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: 用户二次改稿 2026-07-20:反相胶囊浅字/深字(同 accent-pure-cta-fg)
  'sidebar-item-active-border': { light: 'transparent', dark: 'transparent' }, // 用户三次改稿 2026-07-20:去描边
  'sidebar-item-active': { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 93.3%' }, // 用户二次改稿 2026-07-20:反相胶囊 #3C3F43/#EEEEEE(同 accent-cta-bg)
  'splash-bg': { light: '60.0 16.1% 93.9%', dark: '0 0% 9.4%' },
  'splash-text': { light: '0.0 0.0% 0.0% / 0.56', dark: '0.0 0.0% 100.0% / 0.55' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'splash-text-destructive': { light: '0.0 0.0% 10.2%', dark: '0.0 0.0% 100.0%' },
  'splash-text-muted': { light: '0.0 0.0% 0.0% / 0.44', dark: '0.0 0.0% 100.0% / 0.40' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'titlebar-icon': { light: '0.0 0.0% 0.0% / 0.56', dark: '0.0 0.0% 100.0% / 0.55' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'tooltip-bg': { light: '#3C3F43', dark: '#181818' },
  'tooltip-text': { light: '#FFFFFF', dark: '#FFFFFF' },
  'update-btn-border': { light: '#3C3F43', dark: '#EEEEEE' }, // E1D
  'update-btn-text': { light: '#FCFCFC', dark: '#151515' }, // 2026-08 §9 更新;沿革: E1D
  'accent-foreground': { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'panel-bg': { light: '#F2F2ED', dark: '#181818' },
  primary: { light: '214.3 5.5% 24.9%', dark: '0.0 0.0% 93.3%' }, // E1D
  ring: { light: '217.3 69.7% 56.1%', dark: '217.3 69.7% 56.1%' }, // E5D 定稿 2026-07-17 #417CDD HSL(取代 #3b82f6)
  'settings-theme-auto-light': { light: '#F2F2ED', dark: '#F2F2ED' },
  foreground: { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  border: { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  input: { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'secondary-foreground': { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'popover-foreground': { light: '0.0 0.0% 0.0% / 0.88', dark: '0.0 0.0% 100.0% / 0.82' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  titlebar: { light: '60.0 16.1% 93.9%', dark: '0 0% 9.4%' },
  'titlebar-border': { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'titlebar-button-hover': { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'titlebar-control-hover': { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.06' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  sidebar: { light: '60.0 12.8% 92.4%', dark: '0 0% 9.4%' },
  'sidebar-border': { light: '0.0 0.0% 0.0% / 0.08', dark: '0.0 0.0% 100.0% / 0.10' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'sidebar-item-hover': { light: '0.0 0.0% 0.0% / 0.05', dark: '0.0 0.0% 100.0% / 0.09' }, // 用户裁决 2026-07-21:玻璃面 hover 半透明化(黑 5% / 白 9% 叠加替代实色,壁纸可透过)
  'sidebar-search-bg': { light: '60.0 12.8% 92.4%', dark: '0 0% 9.4%' },
  'sidebar-muted': { light: '0.0 0.0% 0.0% / 0.56', dark: '0.0 0.0% 100.0% / 0.55' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、E1D 侧栏层级 #9A9DA3/#6F6F6F
  'status-badge-fg': { light: '#1F1F1F', dark: '#121212' }, // 2026-08 §9 更新;沿革: §7 必炸点(lead 裁决)
  'surface-translucent-sidebar': {
    light: 'rgba(238, 238, 233, 0.85)',
    dark: 'rgba(5, 5, 5, 0.85)',
  }, // 用户调参 2026-07-20:双端 80%(light #F6F6F6 试色后退回纯白)
  'sidebar-search-input-bg': {
    light: 'rgba(255, 255, 250, 0.55)',
    dark: 'rgba(0, 0, 0, 0.25)',
  }, // 用户裁决 2026-07-21:玻璃面搜索输入框半透明化(与 hover 叠加方向相反,保证"可输入"字段感)
  'surface-translucent-main': { light: '#F2F2ED', dark: '#181818' }, // 2026-08 §9 更新;沿革: E4D 主面板:用户勘误 2026-07-17 撤销毛玻璃,改不透明等价 surface(原 rgba 半透明)
  'surface-translucent-overlay': {
    light: 'rgba(251, 251, 246, 0.90)',
    dark: 'rgba(21, 21, 21, 0.80)',
  }, // E4D R1 模式3
  'composer-pill-bg': { light: '#FFFFFA', dark: '#272727' }, // 2026-08 §9 更新;沿革: E2 composer pill 底(取代 glass-pill-bg)
  'composer-pill-icon': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9);沿革: 2026-08 §9 更新、E2 composer pill 图标
  // ── 2026-08 色阶改版入表(用户裁决 2026-08-11~14, 决策表 §9): 原走注册表默认值的新增
  // override; 单侧改动的另一侧按当时解析值锚定入表(不改变解析结果)。──
  'ask-badge-bg': { light: 'rgba(0, 0, 0, 0.05)', dark: 'var(--surface-chip)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'ask-header-chip-bg': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'ask-option-hover': { light: 'var(--surface-hover-soft)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'ask-option-list-bg': { light: '#FFFFFF', dark: '#282828' },
  'ask-send-disabled-bg': { light: 'var(--surface-elevated-soft)', dark: '#282828' },
  'cmd-palette-item-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'var(--surface-hover)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'completion-badge-fg': { light: '#1f1f1e', dark: '#121212' },
  'create-agent-control-bg': { light: '#FFFFFA', dark: '#272727' },
  'create-agent-control-bg-hover': { light: 'var(--surface-hover)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-control-bg-pressed': { light: 'var(--surface-hover-soft)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-control-border': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-control-icon': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-control-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-quick-card-bg': { light: '#FDFDF8', dark: '#1F1F1F' },
  'create-agent-quick-card-bg-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-quick-card-border': { light: 'rgba(0, 0, 0, 0.08)', dark: 'rgba(255, 255, 255, 0.10)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-quick-card-icon': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-quick-card-icon-bg': { light: '#F2F2ED', dark: '#181818' },
  'create-agent-quick-card-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-segment-inactive-text': { light: 'rgba(0, 0, 0, 0.44)', dark: 'rgba(255, 255, 255, 0.40)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-segment-track-bg': { light: '#F2F2ED', dark: '#181818' },
  'create-agent-send-disabled-bg': { light: '#F2F2ED', dark: '#323232' },
  'create-agent-send-disabled-icon': { light: 'rgba(0, 0, 0, 0.32)', dark: 'rgba(255, 255, 255, 0.30)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'create-agent-send-icon': { light: '#FCFCFC', dark: '#151515' },
  'md-table-bg': { light: 'rgba(241, 241, 236, 0.55)', dark: 'rgba(26, 26, 26, 0.55)' },
  'model-item-hover': { light: 'rgba(0, 0, 0, 0.05)', dark: 'rgba(255, 255, 255, 0.06)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'settings-integration-avatar-border': { light: '#EDEDE8', dark: 'rgba(255, 255, 255, 0.08)' },
  'sidebar-list-muted': { light: 'rgba(0, 0, 0, 0.44)', dark: 'rgba(255, 255, 255, 0.40)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'sidebar-nav-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
  'sidebar-user-card-bg-hover': { light: 'rgba(26, 26, 26, 0.06)', dark: 'rgba(255, 255, 255, 0.10)' },
  'sidebar-user-card-border': { light: 'rgba(26, 26, 26, 0.10)', dark: 'rgba(255, 255, 255, 0.13)' },
  'sidebar-user-card-text': { light: 'rgba(0, 0, 0, 0.88)', dark: 'rgba(255, 255, 255, 0.82)' }, // 用户裁决 2026-10-22 墨水透明度(决策表 §9)
};

// 用户裁决 2026-10-22:文字阶梯 = 浅色纯黑 / 深色纯白墨水,逐档透明度严格递减(决策表 §9.4)。
// cindyThemes.test.ts 组⑦ 据此反向冻结,防止文字退回凭眼挑的实色灰;改任一档须新的用户裁决。
export const CINDY_INK_TEXT_TIERS = [
  { id: 'text-primary-emphasis', role: '强调', light: 0.95, dark: 1 },
  { id: 'text-primary', role: '正文', light: 0.88, dark: 0.82 },
  { id: 'text-secondary-mid', role: '说明', light: 0.7, dark: 0.66 },
  { id: 'text-secondary', role: '次要', light: 0.56, dark: 0.55 },
  { id: 'text-tertiary', role: '三级', light: 0.44, dark: 0.4 },
  { id: 'text-placeholder', role: '占位/禁用', light: 0.32, dark: 0.3 },
] as const;

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
