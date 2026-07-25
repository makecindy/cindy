import { registerColor } from './color-registry';

function createNotAllowedCursor(stroke: string): string {
  const encodedStroke = stroke.startsWith('#')
    ? `%23${stroke.slice(1)}`
    : encodeURIComponent(stroke);
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='10' fill='none' stroke='${encodedStroke}' stroke-width='2.6'/%3E%3Cpath d='M9.2 22.8 22.8 9.2' fill='none' stroke='${encodedStroke}' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E") 16 16, not-allowed`;
}

/* === P3.2: Semantic slot tokens === */
registerColor('surface', {
  light: '#f8f8f6',
  dark: '#1f1f1e',
}, 'Surface 页面背景 (hex 形式)');
registerColor('surface-hsl', {
  light: '60 12.5% 97%',
  dark: '60 2% 12%',
}, 'Surface 页面背景 (HSL 形式)');
registerColor('surface-elevated', {
  light: '#ffffff',
  dark: '#2c2c2a',
}, 'Card 抬一层 / 弹窗 / popover 背景');
registerColor('surface-elevated-soft', {
  light: '#e5e5e5',
  dark: '#2c2c2a',
}, 'Disabled / dimmed 卡片背景');
registerColor('surface-card-ivory', {
  light: '#faf9f5',
  dark: '#2c2c2a',
}, 'Settings 微暖 ivory Card');
registerColor('surface-chip', {
  light: '#e5e5e5',
  dark: '#3c3c3a',
}, 'Chip / pill / 选中行背景');
registerColor('surface-chip-alt', {
  light: '#e5e5e5',
  dark: '#2c2c2a',
}, 'Chip 暗态塌缩到 Card 的变体');
registerColor('surface-hover', {
  light: '#e5e5e5',
  dark: '#3c3c3a',
}, '通用 hover 背景');
registerColor('surface-hover-soft', {
  light: '#f8f8f6',
  dark: '#3c3c3a',
}, '柔和 hover 背景');
registerColor('surface-hover-hsl', {
  light: '0 0% 90%',
  dark: '60 2% 17%',
}, 'Hover 背景 HSL 形式');
registerColor('surface-on-card', {
  light: '#ffffff',
  dark: '#1f1f1e',
}, 'CTA/checked icon 的深色前景');
// 历史幽灵 token 补注册:--panel-bg 被 9 处宿主组件裸引用(PanelChrome / TabBar
// / RightSidebarShell / ReviewTabBody / ghostPanels / RightSidebar / SidebarWindowLayout,
// 均 bg-[var(--panel-bg)] 无 fallback)但 colors.ts 从未注册,:root 读不到值 → 面板/
// 侧边栏头部背景失效。语义 = 面板背景 = surface(与 ghostPanelTheme.ts 沙箱 body
// fallback var(--panel-bg, var(--surface)) 兜底一致),故 alias 到 --surface,
// 注册后宿主消费点显式取到 surface 值。
registerColor('panel-bg', {
  light: 'var(--surface)',
  dark: 'var(--surface)',
}, '面板 / 侧边栏 / 工具面板头部背景(历史幽灵 token 补注册,alias 到 surface)');
registerColor('md-table-bg', {
  light: 'rgba(236, 236, 234, 0.55)',
  dark: 'rgba(44, 44, 42, 0.55)',
}, 'Markdown 编辑器表格行 / 表头半透明背景');
registerColor('border-default', {
  light: '#d7d7d4',
  dark: '#3c3c3a',
}, 'docs/design-rules/cindy-design-system.md Board 1px 边框');
registerColor('border-default-hsl', {
  light: '60 3% 84%',
  dark: '60 2% 23%',
}, 'Board HSL 形式');
registerColor('border-shadcn-hsl', {
  light: '0 0% 90%',
  dark: '30 4% 28%',
}, 'shadcn input/border HSL');
registerColor('border-transparent-mixed', {
  light: 'transparent',
  dark: '#3c3c3a',
}, 'Light transparent / dark board border');
// 历史幽灵 token 补注册:--board 被 RewindPreviewDialog 4 处 border-[var(--board)]
// 裸引用(无 fallback)但从未注册,边框读不到值。名字泛但消费点全是边框,语义 =
// 边框,alias 到 --border-default。
registerColor('board', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, '通用边框(历史幽灵 token --board 补注册,alias 到 border-default)');
registerColor('text-primary', {
  light: '#262626',
  dark: '#d4d4d4',
}, '主标题 / 主正文');
registerColor('text-primary-on-dark', {
  light: '#262626',
  dark: '#ffffff',
}, '深色按钮上的主前景');
registerColor('text-primary-emphasis', {
  light: '#1a1a1a',
  dark: '#d4d4d4',
}, '强调主文字');
registerColor('text-primary-inv', {
  light: '#1a1a1a',
  dark: '#ffffff',
}, '反相强调文字');
registerColor('text-primary-body-strong', {
  light: '#525252',
  dark: '#d4d4d4',
}, '加重正文');
registerColor('text-primary-hsl', {
  light: '0 0% 9%',
  dark: '0 0% 83%',
}, 'Primary text HSL 形式');
registerColor('text-secondary', {
  light: '#737373',
  dark: '#a3a3a3',
}, 'Secondary 文字 / meta / icon');
registerColor('text-secondary-cross', {
  light: '#a3a3a3',
  dark: '#a3a3a3',
}, '跨主题 secondary 文字');
registerColor('text-secondary-mid', {
  light: '#525252',
  dark: '#a3a3a3',
}, '偏深 secondary 文字');
registerColor('text-tertiary', {
  light: '#a3a3a3',
  dark: '#737373',
}, 'Tertiary / placeholder 文字');
registerColor('text-tertiary-stone', {
  light: '#737373',
  dark: '#737373',
}, 'Stone 跨主题三级文字');
registerColor('text-tertiary-mid', {
  light: '#525252',
  dark: '#737373',
}, 'Mid Gray 三级文字');
registerColor('text-tertiary-hsl', {
  light: '0 0% 45%',
  dark: '0 0% 45%',
}, 'Sidebar / welcome muted HSL');
registerColor('text-disabled', {
  light: '#d4d4d4',
  dark: '#525252',
}, 'Disabled 文字 / failed dimmed');
registerColor('text-disabled-tertiary', {
  light: '#a3a3a3',
  dark: '#737373',
}, 'Disabled tertiary 文字');
registerColor('text-placeholder', {
  light: '#c4c4c4',
  dark: '#525252',
}, 'Placeholder 文字 — 必须读着像空(比 tertiary 更淡);统一 slot,各输入面 placeholder alias 均收口于此');
registerColor('cursor-not-allowed', {
  light: createNotAllowedCursor('#373737'),
  dark: createNotAllowedCursor('#d4d4d4'),
}, 'Windows disabled cursor SVG (完整 cursor 值,可由主题覆盖)');
registerColor('accent-cta-bg', {
  light: '#262626',
  dark: '#ffffff',
}, '反相 CTA 背景');
registerColor('accent-cta-bg-pure', {
  light: '#000000',
  dark: '#ffffff',
}, 'Pure CTA 背景');
registerColor('accent-emphasis', {
  light: '#262626',
  dark: '#d4d4d4',
}, '强调品牌前景 / ring');
registerColor('accent-soft', {
  light: '#262626',
  dark: '#ffffff',
}, 'Soft accent 前景');
registerColor('accent-hover', {
  light: '#262626',
  dark: '#e5e5e5',
}, 'CTA pressed / hover');
registerColor('accent-pure-cta-fg', {
  light: '#ffffff',
  dark: '#000000',
}, 'Pure CTA 文字');
registerColor('error-flat', {
  light: '#ef4444',
  dark: '#ef4444',
}, '扁平 danger 前景');
registerColor('warning-accent', {
  light: '#EA6B17',
  dark: '#EA6B17',
}, 'Thinking orange / warning accent — running 状态色,设计定稿 2026-07-17(取代 #FF6600 冻结红线);全局同值,9 主题无 override 自动跟随');
registerColor('shadow-soft-panel', {
  light: '0 4px 12px rgb(0 0 0 / 0.08)',
  dark: '0 4px 12px rgb(0 0 0 / 0.3)',
}, '中型弹层 shadow');
// Base
registerColor('background', {
  light: '0 0% 100%',
  dark: '60 3% 14%',
}, 'background');
registerColor('foreground', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'foreground');
registerColor('muted', {
  light: '0 0% 96%',
  dark: '30 6% 20%',
}, 'muted');
registerColor('muted-foreground', {
  light: '0 0% 45%',
  dark: '24 5% 64%',
}, 'muted-foreground');
registerColor('border', {
  light: 'var(--border-shadcn-hsl)',
  dark: 'var(--border-shadcn-hsl)',
}, 'border');
registerColor('input', {
  light: 'var(--border-shadcn-hsl)',
  dark: 'var(--border-shadcn-hsl)',
}, 'input');
registerColor('ring', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'ring');
registerColor('primary', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'primary');
registerColor('primary-foreground', {
  light: '0 0% 98%',
  dark: '60 3% 14%',
}, 'primary-foreground');
registerColor('secondary', {
  light: '0 0% 96%',
  dark: '30 6% 20%',
}, 'secondary');
registerColor('secondary-foreground', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'secondary-foreground');
registerColor('accent', {
  light: '0 0% 96%',
  dark: '30 6% 20%',
}, 'accent');
registerColor('accent-foreground', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'accent-foreground');
registerColor('popover', {
  light: '0 0% 100%',
  dark: '60 3% 15%',
}, 'popover');
registerColor('popover-foreground', {
  light: 'var(--text-primary-hsl)',
  dark: 'var(--text-primary-hsl)',
}, 'popover-foreground');
registerColor('radius', {
  light: '0.5rem',
  dark: null,
}, 'radius Light only in source CSS; dark mode inherits the root value.');

// Titlebar — Ollama layer system (Light)
registerColor('titlebar', {
  light: 'var(--surface-hsl)',
  dark: 'var(--surface-hsl)',
}, 'Light Surface #f8f8f6');
registerColor('titlebar-border', {
  light: 'var(--border-default-hsl)',
  dark: 'var(--border-default-hsl)',
}, 'Light Board #d7d7d4');
registerColor('titlebar-icon', {
  light: '0 0% 45%',
  dark: '0 0% 63.92%',
}, 'Stone #737373');
registerColor('titlebar-button-hover', {
  light: 'var(--surface-hover-hsl)',
  dark: 'var(--surface-hover-hsl)',
}, 'Light Gray #e5e5e5');
registerColor('titlebar-control-hover', {
  light: 'var(--surface-hover-hsl)',
  dark: 'var(--surface-hover-hsl)',
}, 'Light Gray #e5e5e5');
registerColor('splash-bg', {
  light: '60 12.45% 96.86%',
  dark: '60 1.64% 11.96%',
}, 'Light Surface #f8f8f6 — docs/design-rules/cindy-design-system.md layer system (high-precision HSL for exact hex match)');
registerColor('splash-text', {
  light: '0 0% 45.1%',
  dark: '0 0% 63.92%',
}, 'Stone #737373 — docs/design-rules/cindy-design-system.md secondary text');
registerColor('splash-text-muted', {
  light: '30 3.6% 62.55%',
  dark: '30 2.78% 43.73%',
}, 'Warm Gray #a39e98 — docs/design-rules/cindy-design-system.md muted text');
registerColor('splash-text-destructive', {
  light: '0 0% 14.9%',
  dark: '0 0% 100%',
}, 'Near Black #262626 — docs/design-rules/cindy-design-system.md max emphasis (grayscale)');
registerColor('splash-fade-duration', {
  light: '400ms',
  dark: null,
}, 'Titlebar — Ollama layer system (Light) Light only in source CSS; dark mode inherits the root value.');
registerColor('splash-fade-easing', {
  light: 'cubic-bezier(0.4, 0, 1, 1)',
  dark: null,
}, 'Titlebar — Ollama layer system (Light) Light only in source CSS; dark mode inherits the root value.');
registerColor('destructive', {
  light: '0 84% 60%',
  dark: '0 72% 63%',
}, 'Titlebar — Ollama layer system (Light)');

// confirm-dialog
registerColor('confirm-bg', {
  light: '#fafafa',
  dark: '#2c2c2a',
}, 'confirm-dialog');
registerColor('confirm-shadow', {
  light: 'var(--shadow-soft-panel)',
  dark: 'var(--shadow-soft-panel)',
}, 'confirm-dialog');
registerColor('confirm-title', {
  light: '#171717',
  dark: '#fafafa',
}, 'confirm-dialog');
registerColor('confirm-desc', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'confirm-dialog');
registerColor('confirm-btn-primary-bg', {
  light: '#171717',
  dark: '#fafafa',
}, 'confirm-dialog');
registerColor('confirm-btn-primary-text', {
  light: '#fafafa',
  dark: '#171717',
}, 'confirm-dialog');
registerColor('confirm-btn-primary-hover', {
  light: 'var(--accent-hover)',
  dark: 'var(--accent-hover)',
}, 'confirm-dialog');
registerColor('confirm-btn-secondary-text', {
  light: '#262626',
  dark: '#fafafa',
}, 'confirm-dialog');
registerColor('confirm-btn-secondary-border', {
  light: '#d4d4d4',
  dark: '#3c3c3a',
}, 'confirm-dialog');
registerColor('confirm-btn-secondary-hover', {
  light: 'rgba(0, 0, 0, 0.04)',
  dark: 'rgba(255, 255, 255, 0.06)',
}, 'confirm-dialog');

// Sidebar — Ollama layer system (Light)
registerColor('sidebar', {
  light: 'var(--surface-hsl)',
  dark: 'var(--surface-hsl)',
}, 'Light Surface #f8f8f6');
registerColor('sidebar-border', {
  light: 'var(--border-default-hsl)',
  dark: 'var(--border-default-hsl)',
}, 'Light Board #d7d7d4');
registerColor('sidebar-item-hover', {
  light: 'var(--surface-hover-hsl)',
  dark: 'var(--surface-hover-hsl)',
}, 'Light Gray #e5e5e5');
registerColor('sidebar-item-active', {
  light: '0 0% 90%',
  dark: '60 2% 17%',
}, 'Light Gray #e5e5e5 — selected pill');
registerColor('sidebar-item-active-foreground', {
  light: 'var(--foreground)',
  dark: 'var(--foreground)',
}, 'Selected pill 文字/图标前景(default=foreground 正文;CINDY 2026-07-20 撤红后跟正文色)');
registerColor('sidebar-item-active-border', {
  light: 'var(--sidebar-item-active)',
  dark: 'var(--sidebar-item-active)',
}, 'Selected pill 1px 描边(default=invisible 同 pill bg;CINDY 2026-07-20 撤红后跟中性边框)');
registerColor('sidebar-search-bg', {
  light: 'var(--surface-hsl)',
  dark: 'var(--surface-hsl)',
}, 'Light Surface');
registerColor('sidebar-muted', {
  light: 'var(--text-tertiary-hsl)',
  dark: 'var(--text-tertiary-hsl)',
}, 'Stone #737373');
registerColor('sidebar-action-icon', {
  light: '0 0% 64%',
  dark: '0 0% 45%',
}, 'Silver #a3a3a3 — hover action icons');
registerColor('search-match-bg', {
  light: '53 100% 89%',
  dark: '40 33% 16%',
}, '#fff8c5 — Primer attention-muted');
registerColor('search-match-fg', {
  light: '0 0% 15%',
  dark: '0 0% 90%',
}, 'Near-black #262626 — text inherit');

// UpdateBanner — Relaunch button (White Pill variant)
registerColor('update-btn-border', {
  light: '#d4d4d4',
  dark: '#3c3c3a',
}, 'Border Light — per docs/design-rules/cindy-design-system.md White Pill');
registerColor('update-btn-text', {
  light: '#404040',
  dark: '#ffffff',
}, 'Button Text Dark — per docs/design-rules/cindy-design-system.md White Pill');
registerColor('update-btn-hover', {
  light: 'rgba(0, 0, 0, 0.04)',
  dark: 'rgba(255, 255, 255, 0.06)',
}, 'Alpha-blended overlay — intentionally not an HSL token; needs transparency over variable backgrounds');
// Fill background for the relaunch pill. Default themes keep the classic
// transparent-outline White Pill (transparent → border+text define the shape);
// E1D neutral themes (cindy) override this to a solid fill so the on-fill text
// color (update-btn-text) has the intended contrast surface behind it. Non-HSL
// raw value on purpose (needs a real `transparent`, not an HSL triple).
registerColor('update-btn-bg', {
  light: 'transparent',
  dark: 'transparent',
}, 'Relaunch pill fill — transparent (outline) by default, solid in E1D neutral themes');

// Content area — Surface single-flat background per full-window rule
registerColor('content-area', {
  light: 'var(--surface-hsl)',
  dark: 'var(--surface-hsl)',
}, 'Light Surface #f8f8f6');

// Welcome text
registerColor('welcome-text', {
  light: 'var(--text-tertiary-hsl)',
  dark: 'var(--text-tertiary-hsl)',
}, 'Stone #737373');

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
registerColor('login-bg-base', {
  light: '#EDEDED',
  dark: '#1F1F1E',
}, 'Login — 画布底(亮色 #EDEDED / 暗色 #1F1F1E,figma 532:585 暗色帧实测;纯平,红渐变两层随 PR#104 拍板撤除,暗色沿用纯平口径)');
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
registerColor('login-panel-border', {
  light: '#D4D4D4',
  dark: '#434343',
}, 'Login — 面板 1px inside 描边(亮色 #D4D4D4 / 暗色 #434343;DESIGN.md §16.1)');
// 品牌红 accent 族:wave4 改判后 #DF0C27 语义限定为 accent(Global pill/字标
// 红元素等品牌点缀),禁止表达页面/画板背景——命名刻意不含 bg/background
// (token-decision-table.md 原案名 login-brand-bg 已随改判弃用)。
registerColor('login-brand-accent', {
  light: '#DF0C27',
  dark: '#DF0C27',
}, 'Login — 品牌红 accent(Global pill/字标红元素;禁止用作页面背景,wave4 改判)');
registerColor('login-brand-accent-pressed', {
  light: '#A61629',
  dark: '#A61629',
}, 'Login — 品牌红 accent pressed/hover 深红(figma §1 Color System)');
// Text_link pressed(U-9 裁决 2026-07-20:default #2A2828 加深至 #1A1818,
// lead 受托定值;wave3 实测节点落地后以实测替换 token 值)。
registerColor('login-link-pressed', {
  light: '#1A1818',
  dark: '#C0BEBE',
}, 'Login — Text_link pressed 态(亮色 U-9 #1A1818 / 暗色 #C0BEBE 推导,待 Figma 精确)');
// ── 回调卡 component alias(PR3,LegacyMigrationDialog 消费——design §7.4 唯一
// App 内表情包例外,弹窗用回调卡形式)。参数权威:callback-pages-classification.md
// 「卡片共用参数」(figma §6.1:White #FBFBFB/#D4D4D4/#252222/#2A2828 CTA;
// Dark #312F2F/#434343/#D4D4D4/#EEEEEE CTA)。token-decision-table 决策为
// component alias 且「两套模式时可拆」——此处按 light/dark mode 拆分承载。
// 浏览器回调页本体不消费 renderer token(独立 HTML,同表决策用内联常量,见
// oauthResultPage.ts renderBrandLoginCallbackPage);本组仅供 App 内例外消费。
// 品牌豁免族:非默认主题不 override(与 wave4 组同口径)。
registerColor('login-callback-card-bg', {
  light: '#FBFBFB',
  dark: '#312F2F',
}, 'Login callback card — 卡底(White/Dark 卡,figma §6.1)');
registerColor('login-callback-card-border', {
  light: '#D4D4D4',
  dark: '#434343',
}, 'Login callback card — 1px 卡描边');
registerColor('login-callback-title', {
  light: '#252222',
  dark: '#D4D4D4',
}, 'Login callback card — 标题');
registerColor('login-callback-body', {
  light: '#6F6F6F',
  dark: '#6F6F6F',
}, 'Login callback card — 副文案(两模式同值)');
registerColor('login-callback-cta-bg', {
  light: '#2A2828',
  dark: '#EEEEEE',
}, 'Login callback card — CTA 底(反相)');
registerColor('login-callback-cta-border', {
  light: '#434343',
  dark: '#FFFFFF',
}, 'Login callback card — CTA 1px 描边');
registerColor('login-callback-cta-text', {
  light: '#D4D4D4',
  dark: '#2A2828',
}, 'Login callback card — CTA 文字(反相)');

// ── Login 组件色 alias(暗色实现 PR:light/dark 二态,DESIGN.md §16.1)──
// 语义 = 登录入口 100% 还原设计稿;随基础 light/dark 二态切换,不跟具体扩展主题
// (规则 16 豁免族:扩展主题不 override)。色值经 Figma 组件库 Dark symbol 核验。
// disabled 态两模式同构(深底#2A2828+白70%叠层+边#B4B4B4+字#D4D4D4 opacity0.8,不反相,§16.5)。
registerColor('login-panel-bg', {
  light: '#FBFBFB',
  dark: '#312F2F',
}, 'Login — 面板底(亮色 #FBFBFB / 暗色 #312F2F;DESIGN.md §16.1)');
registerColor('login-control-bg', {
  light: '#EEEEEE',
  dark: '#2C2A2A',
}, 'Login — 输入框底(亮色 #EEEEEE / 暗色 #2C2A2A,figma Dark_normal 输入 symbol。暗色下与方式行/返回钮底分化,后者走 login-action-control-bg)');
registerColor('login-action-control-bg', {
  light: '#EEEEEE',
  dark: '#2A2828',
}, 'Login — 方式行/返回钮底(亮色与输入框同 #EEEEEE;暗色 #2A2828 与输入框分化;figma 549:850/549:897,组件库更新 2026-07-23)');
registerColor('login-back-border', {
  light: '#FFFFFF',
  dark: '#434343',
}, 'Login — 返回钮描边(亮色白 / 暗色 #434343;figma 549:897。Global pill 白字仍走 login-inverted-button-border)');
registerColor('login-control-border', {
  light: '#D4D4D4',
  dark: '#434343',
}, 'Login — 控件 default 描边(亮色 #D4D4D4 / 暗色 #434343)');
registerColor('login-control-border-active', {
  light: '#2A2828',
  dark: '#EEEEEE',
}, 'Login — 控件 focus/filled 描边(亮色 #2A2828 / 暗色 #EEEEEE 反相)');
registerColor('login-control-border-disabled', {
  light: '#B4B4B4',
  dark: '#B4B4B4',
}, 'Login — disabled 控件描边(两模式同构,§16.5 disabled 特例)');
registerColor('login-control-text', {
  light: '#252222',
  dark: '#EEEEEE',
}, 'Login — 控件已填文本/标题(亮色 #252222 / 暗色 #EEEEEE)');
registerColor('login-control-placeholder', {
  light: '#D4D4D4',
  dark: '#6F6F6F',
}, 'Login — 控件 placeholder/countdown(亮色 #D4D4D4 / 暗色 #6F6F6F;figma 539:754 dark_倒计时重发)');
registerColor('login-title-text', {
  light: '#252222',
  dark: '#D4D4D4',
}, 'Login — 面板标题 32 Bold(亮色 #252222 / 暗色 #D4D4D4)');
registerColor('login-secondary-text', {
  light: '#6F6F6F',
  dark: '#6F6F6F',
}, 'Login — 副标题/说明文字(两模式同值 #6F6F6F)');
registerColor('login-primary-button-bg', {
  light: '#2A2828',
  dark: '#EEEEEE',
}, 'Login — 主按钮/第三方圆钮底(亮色深 #2A2828 / 暗色白 #EEEEEE 反相;社交圆图标保品牌色)');
registerColor('login-primary-button-border', {
  light: '#434343',
  dark: '#FFFFFF',
}, 'Login — 主按钮/圆钮描边(亮色 #434343 / 暗色 #FFFFFF)');
registerColor('login-primary-button-text', {
  light: '#D4D4D4',
  dark: '#2A2828',
}, 'Login — 主按钮文字(亮色 #D4D4D4 / 暗色 #2A2828 反相)');
registerColor('login-disabled-button-overlay', {
  light: 'rgba(255, 255, 255, 0.7)',
  dark: 'rgba(255, 255, 255, 0.7)',
}, 'Login — disabled 按钮白 70% 叠层(两模式同构,§16.5 disabled 特例)');
registerColor('login-disabled-button-bg', {
  light: '#2A2828',
  dark: '#2A2828',
}, 'Login — disabled 主按钮底(两模式同构深底;暗色不随 primary-button-bg 反相为白,figma white_button Disable)');
registerColor('login-disabled-button-text', {
  light: '#D4D4D4',
  dark: '#D4D4D4',
}, 'Login — disabled 主按钮文字(两模式同构,配合 opacity 0.8;figma white_button Disable)');
registerColor('login-inverted-button-border', {
  light: '#FFFFFF',
  dark: '#FFFFFF',
}, 'Login — 浅底钮白描边/Global pill 白字(两模式同值 #FFFFFF;推导,待 Figma 精确)');
registerColor('login-link-text', {
  light: '#2A2828',
  dark: '#EEEEEE',
}, 'Login — Text_link default 重发链接(亮色墨黑 #2A2828 / 暗色浅色 #EEEEEE 下划线;figma 539:752 dark_重新发送)');
registerColor('login-link-hover', {
  light: '#4A4848',
  dark: '#A8A8A8',
}, 'Login — Text_link hover(亮色 #4A4848 / 暗色 #A8A8A8 推导,待 Figma;仅桌面 hover)');
registerColor('login-error-fg', {
  light: '#D91F37',
  dark: '#D91F37',
}, 'Login — 错误文本/error 描边(语义豁免,跨模式不变 #D91F37)');
// Splash 统一面板进度条(亮色 track #D9D9D9/fill #252222;暗色推导 track #434343/fill #D4D4D4,待 Figma 精确)。
registerColor('login-splash-progress-track', {
  light: '#D9D9D9',
  dark: '#434343',
}, 'Login splash — 进度条轨(亮色 #D9D9D9 / 暗色 #434343 推导,待 Figma)');
registerColor('login-splash-progress-fill', {
  light: '#252222',
  dark: '#D4D4D4',
}, 'Login splash — 进度条填充(亮色 #252222 / 暗色 #D4D4D4 推导,待 Figma)');

// ── Login overlay 叠层 token(暗色实现 PR;hover/pressed 叠层 light/dark 二态,
// 组件 hardcode rgba → var(--login-overlay-*);DESIGN.md §16.5)──
// 暗色叠层方向反转(亮色深底叠白 / 暗色白底叠黑),无法用单一 token 值切换,故二态。
registerColor('login-overlay-button-hover', {
  light: 'rgba(255, 255, 255, 0.08)',
  dark: 'rgba(0, 0, 0, 0.05)',
}, 'Login — 主按钮/圆钮 hover 叠层(亮色白8% / 暗色黑5%;figma §1.4)');
registerColor('login-overlay-button-pressed', {
  light: 'rgba(0, 0, 0, 0.5)',
  dark: 'rgba(0, 0, 0, 0.1)',
}, 'Login — 主按钮/圆钮 pressed 叠层(亮色黑50% / 暗色黑10%;figma §1.4;暗色 pressed 边 #E5E5E5 待组件层裁决)');
registerColor('login-overlay-back-hover', {
  light: 'rgba(255, 255, 255, 0.7)',
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'Login — 返回钮 hover 叠层(亮色白70% / 暗色白8% 变浅;figma 549:904)');
registerColor('login-overlay-back-pressed', {
  light: 'rgba(0, 0, 0, 0.08)',
  dark: 'rgba(0, 0, 0, 0.08)',
}, 'Login — 返回钮 pressed 叠层(两模式黑8%)');
registerColor('login-overlay-row-hover', {
  light: 'rgba(255, 255, 255, 0.08)',
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'Login — 方式行 hover 叠层(两模式白8% 变浅;figma 549:865)');
registerColor('login-overlay-row-pressed', {
  light: 'rgba(0, 0, 0, 0.08)',
  dark: 'rgba(0, 0, 0, 0.08)',
}, 'Login — 方式行 pressed 叠层(两模式黑8%)');
registerColor('login-overlay-input-hover', {
  light: 'rgba(0, 0, 0, 0.05)',
  dark: 'rgba(255, 255, 255, 0.05)',
}, 'Login — 输入框 hover 叠层(亮色黑5% / 暗色白5% 推导,待 Figma)');
registerColor('login-loading-ring-track', {
  light: 'rgba(42, 40, 40, 0.18)',
  dark: 'rgba(212, 212, 212, 0.18)',
}, 'Login — loading 环轨(亮色深半透 / 暗色浅半透 推导,待 Figma)');

// ── Login 协议同意族(consent PR;figma wave5 radiobutton 600:627 四态 +
// 服务条款弹窗 602:822/602:1249 + 双色小按钮四母版 602:846/863/1297/1311)──
// 与 login-* 族同口径:随基础 light/dark 二态切换,扩展主题不 override。
// radio 选中态为对勾(非圆点),四态双模式反色,色值经 figma SVG 源码直读核对。
registerColor('login-consent-radio-bg', {
  light: '#F1F0F1',
  dark: '#2A2828',
}, 'Login — 协议 radio 未选中圈底(figma white_normal 600:626 / Dark_normal 602:1091)');
registerColor('login-consent-radio-border', {
  light: '#434343',
  dark: '#F1F0F1',
}, 'Login — 协议 radio 未选中 2px 描边(双模式反色)');
registerColor('login-consent-radio-checked-bg', {
  light: '#2A2828',
  dark: '#F1F0F1',
}, 'Login — 协议 radio 选中圈底(figma white_highlight 600:628 / Dark_highlight 602:1093)');
registerColor('login-consent-radio-check', {
  light: '#FFFFFF',
  dark: '#2A2828',
}, 'Login — 协议 radio 选中对勾(亮色白勾 / 暗色墨勾)');
registerColor('login-consent-overlay', {
  light: 'rgba(0, 0, 0, 0.85)',
  dark: 'rgba(0, 0, 0, 0.85)',
}, 'Login — 协议弹窗全屏遮罩(两模式同值黑 85%;figma 602:820/602:1248 实测)');
// 弹窗次级钮(「不同意」):亮模式浅底 light_button_Normal(602:863),暗模式
// Dark_button_Normal(602:1311,#434141 与面板 #312F2F/描边 #434343 均不同值)。
// 「同意」钮 = 强调钮,双模式恰与 login-primary-button-* 同值,直接复用不新增。
registerColor('login-secondary-button-bg', {
  light: '#EEEEEE',
  dark: '#434141',
}, 'Login — 弹窗次级钮底(亮 #EEEEEE / 暗 #434141;figma 双色小按钮 wave5)');
registerColor('login-secondary-button-border', {
  light: '#FFFFFF',
  dark: '#565454',
}, 'Login — 弹窗次级钮 1px 描边(亮白 / 暗 #565454)');
registerColor('login-secondary-button-text', {
  light: '#2A2828',
  dark: '#EEEEEE',
}, 'Login — 弹窗次级钮文字(亮墨 / 暗浅,双模式反色)');
// wave5 hover/pressed 统一口径:hover = 底叠白(深底 8% / 浅底 10%);
// pressed = 叠黑(浅底钮 10% / Dark_button_Normal 20%)。次级钮亮浅暗深,
// 两模式叠层参数不同故二态注册(与 login-overlay-* 族同理)。
registerColor('login-overlay-secondary-hover', {
  light: 'rgba(255, 255, 255, 0.1)',
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'Login — 弹窗次级钮 hover 叠层(亮浅底白10% / 暗深底白8%;wave5 §11.1)');
registerColor('login-overlay-secondary-pressed', {
  light: 'rgba(0, 0, 0, 0.1)',
  dark: 'rgba(0, 0, 0, 0.2)',
}, 'Login — 弹窗次级钮 pressed 叠层(亮浅底黑10% / 暗 Dark_button_Normal 黑20%;wave5 §11.1)');

// Apple 登录圆钮(App Store Guideline 4 对齐,用户标准图 2026-07-24):亮色模式 =
// ADR Black button 配色(纯黑圆 + 白标),暗色模式 = ADR White button 配色
// (纯白圆 + 黑标),无描边。语义豁免:官方按钮配色,扩展主题不 override。
registerColor('login-apple-circle-bg', {
  light: '#000000',
  dark: '#FFFFFF',
}, 'Login — Apple 圆钮底(ADR Black/White 官方按钮底色;亮黑圆白标/暗白圆黑标,无描边)');

registerColor('lightbox-cta-bg', {
  light: 'var(--accent-cta-bg-pure)',
  dark: 'var(--accent-cta-bg-pure)',
}, 'Black Pill — Light');
registerColor('lightbox-cta-fg', {
  light: 'var(--accent-pure-cta-fg)',
  dark: 'var(--accent-pure-cta-fg)',
}, 'Black Pill CTA foreground');
registerColor('lightbox-cta-hover', {
  light: 'var(--accent-hover)',
  dark: 'var(--accent-hover)',
}, 'Near Black — pressed/hover');

// Chat input — Ollama layer system (Light)
registerColor('chat-input-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card — elevated input box on Surface');
registerColor('chat-input-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board — 1px outline');
registerColor('chat-input-border-focus', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver — focus hint, still grayscale');
registerColor('chat-input-placeholder-subtle', {
  light: 'color-mix(in srgb, var(--chat-input-placeholder) 40%, transparent)',
  dark: 'color-mix(in srgb, var(--chat-input-placeholder) 40%, transparent)',
}, 'Chat input placeholder at 40% opacity');
registerColor('chat-input-text', {
  light: '#000000',
  dark: '#d4d4d4',
}, 'Pure Black — primary text');
registerColor('chat-input-placeholder', {
  light: 'var(--text-placeholder)',
  dark: 'var(--text-placeholder)',
}, 'Placeholder — 收口至 --text-placeholder slot');

// File attachment tokens (F-FI-3/4) — Light
registerColor('file-chip-bg', {
  light: '#a3a3a3',
  dark: '#525252',
}, 'Silver — non-image thumbnail bg');
registerColor('drop-overlay-bg', {
  light: 'rgba(163, 163, 163, 0.08)',
  dark: 'rgba(115, 115, 115, 0.1)',
}, 'chat-input-border-focus @ 8%');
registerColor('drop-overlay-border', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'chat-input-border-focus');
registerColor('tooltip-bg', {
  light: '#262626',
  dark: '#1f1f1e',
}, 'Near Black');
registerColor('tooltip-text', {
  light: '#ffffff',
  dark: '#ffffff',
}, 'Pure White');
registerColor('file-remove-bg', {
  light: '#525252',
  dark: '#737373',
}, 'Mid Gray');
registerColor('chat-input-chip-bg', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'Light Gray — docs/design-rules/cindy-design-system.md Chip');
registerColor('chat-input-chip-border', {
  light: '#d7d7d4',
  dark: '#525250',
}, 'Board — 1px outline');
registerColor('chat-input-chip-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('chat-input-chip-icon', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');

// Command Palette shared tokens — panel + tooltip (light)
registerColor('cmd-palette-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('cmd-palette-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('cmd-palette-shadow', {
  light: 'var(--shadow-soft-panel)',
  dark: 'var(--shadow-soft-panel)',
}, 'Command Palette shared tokens — panel + tooltip (light)');
registerColor('cmd-palette-item-hover', {
  light: 'var(--surface-hover)',
  dark: 'var(--surface-hover)',
}, 'Light Gray');
registerColor('cmd-palette-item-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('cmd-palette-item-meta', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — source tag / path / Agent');
registerColor('cmd-palette-item-icon', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('cmd-palette-empty', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — "No matching commands"');
registerColor('cmd-palette-tooltip-body', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — description body');

// Send button — grayscale pill
registerColor('send-btn-bg', {
  light: 'var(--accent-cta-bg)',
  dark: 'var(--accent-cta-bg)',
}, 'Near Black — per cc-agent-view spec');
registerColor('send-btn-icon', {
  light: 'var(--surface-on-card)',
  dark: 'var(--surface-on-card)',
}, 'Send button — grayscale pill');
registerColor('send-btn-disabled-bg', {
  light: 'var(--surface-elevated-soft)',
  dark: 'var(--surface-elevated-soft)',
}, 'Light Gray');
registerColor('send-btn-disabled-icon', {
  light: 'var(--text-disabled-tertiary)',
  dark: 'var(--text-disabled-tertiary)',
}, 'Silver');
registerColor('send-btn-hover-bg', {
  light: 'var(--send-btn-bg)',
  dark: 'var(--send-btn-bg)',
}, 'Send button hover bg(default 同 bg,默认皮肤维持 opacity-85 hover;CINDY override 反相中性 hover #2E3237/#E2E2E2,E1D 纳入值表)');
registerColor('send-btn-pressed-bg', {
  light: 'var(--send-btn-bg)',
  dark: 'var(--send-btn-bg)',
}, 'Send button pressed bg(default 同 bg;CINDY override 反相中性 pressed #25282C/#D4D4D4,E1D 纳入值表)');

// Permission prompt (F-PERM-2)
registerColor('perm-code-bg', {
  light: '#f5f5f5',
  dark: '#1f1f1e',
}, 'Light code block bg');
registerColor('perm-code-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board — code block outline');
registerColor('perm-allow-btn-bg', {
  light: '#ffffff',
  dark: '#ffffff',
}, 'Allow once — white bg per ref');
registerColor('perm-allow-btn-text', {
  light: '#262626',
  dark: '#262626',
}, 'Allow once — dark text');
registerColor('perm-allow-kbd-bg', {
  light: '#f5f5f5',
  dark: '#e5e5e5',
}, 'Allow once kbd bg');
registerColor('perm-allow-kbd-border', {
  light: '#d7d7d4',
  dark: '#d7d7d4',
}, 'Allow once kbd border');

// Model selector
registerColor('model-trigger-hover', {
  light: '#e5e5e5',
  dark: '#2c2c2a',
}, 'Light Gray — pill hover');
registerColor('model-trigger-text', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — model name + effort name');
registerColor('model-trigger-meta', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver — middle dot separator (·)');
registerColor('model-trigger-arrow', {
  light: 'var(--text-secondary-cross)',
  dark: 'var(--text-secondary-cross)',
}, 'Silver');
registerColor('thinking-body-text', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver — one tier below title');
registerColor('model-dropdown-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('model-dropdown-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('model-item-hover', {
  light: 'var(--surface-hover)',
  dark: 'var(--surface-hover)',
}, 'Light Gray');
registerColor('model-item-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('model-item-check', {
  light: 'var(--accent-cta-bg-pure)',
  dark: 'var(--accent-cta-bg-pure)',
}, 'Pure Black');
registerColor('model-item-desc', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — model description');
registerColor('model-section-label', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — "Effort" header');
registerColor('model-budget-badge-bg', {
  light: '#dcfce7',
  dark: '#14532d',
}, 'Budget model badge background');
registerColor('model-budget-badge-text', {
  light: '#16a34a',
  dark: '#86efac',
}, 'Budget model badge text');

// Permission selector
registerColor('perm-item-selected-bg', {
  light: '#f8f8f6',
  dark: '#3c3c3a',
}, 'Warm White — selected item bg');

// Narrow scoped text hints: only selected risky permission modes use color.
registerColor('perm-auto-selected-text', {
  light: '#417CDD',
  dark: '#417CDD',
}, 'Auto Approval accent(设计定稿 2026-07-17 #417CDD,light/dark 同值;原 light #000050/dark #00D9C5)');
registerColor('perm-bypass-selected-text', {
  light: 'var(--warning-accent)',
  dark: 'var(--warning-accent)',
}, 'Heart Orange');

// Folder picker
registerColor('folder-picker-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('folder-picker-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('folder-item-hover', {
  light: 'var(--surface-hover)',
  dark: 'var(--surface-hover)',
}, 'Light Gray — docs/design-rules/cindy-design-system.md Chip');
registerColor('folder-item-name', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('folder-item-path', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('folder-item-icon', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('folder-label', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — "Recent" label');
registerColor('folder-btn-bg', {
  light: 'var(--chat-input-bg)',
  dark: 'var(--chat-input-bg)',
}, 'Match input box');
registerColor('folder-btn-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('folder-btn-text', {
  light: 'var(--accent-soft)',
  dark: 'var(--accent-soft)',
}, 'Near Black');
registerColor('folder-btn-icon', {
  light: 'var(--accent-soft)',
  dark: 'var(--accent-soft)',
}, 'Near Black — per cc-agent-view spec');

// WorkingDir bar
registerColor('workingdir-text', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('workingdir-icon', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');

// FastToggle (F1)
registerColor('fast-toggle-off', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — OFF icon/text');
registerColor('fast-toggle-track', {
  light: 'var(--text-disabled)',
  dark: 'var(--text-disabled)',
}, 'Border Light — OFF switch track');

// Chat placeholder
registerColor('chat-placeholder-text', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver');

// Message stream (F-MSG-1/2/4)
registerColor('msg-user-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('msg-user-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-user-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('msg-assistant-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('msg-tool-text', {
  light: 'var(--text-secondary-mid)',
  dark: 'var(--text-secondary-mid)',
}, 'Dark Gray — secondary');
registerColor('msg-code-block-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('msg-code-block-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-code-inline-bg', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'Light Gray');
registerColor('msg-table-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-table-header-bg', {
  light: 'var(--surface)',
  dark: 'var(--surface)',
}, 'Surface');
registerColor('msg-blockquote-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-blockquote-text', {
  light: 'var(--text-secondary-mid)',
  dark: 'var(--text-secondary-mid)',
}, 'Dark Gray — secondary');
registerColor('msg-hr-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-scrollbar', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-scrollbar-hover', {
  light: '#b0b0ae',
  dark: '#555553',
}, 'Board darker — scrollbar hover');
registerColor('msg-cursor', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('msg-link', {
  light: '#2563eb',
  dark: '#60a5fa',
}, 'Blue 600 — clickable link');

// Tool Call Card (F-MSG-3)
registerColor('msg-tool-card-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('msg-tool-card-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('msg-tool-card-chevron', {
  light: 'var(--text-secondary-mid)',
  dark: 'var(--text-secondary-mid)',
}, 'Dark Gray — secondary');
registerColor('msg-tool-card-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');

// Todo Checklist Card
registerColor('todo-bar-track', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'Progress bar track');
registerColor('diff-del-fg', {
  light: '#b31d28',
  dark: '#ff7b72',
}, 'GitHub Diff Red (Light)');
registerColor('diff-del-bg', {
  light: '#ffeef0',
  dark: '#67060c',
}, 'GitHub Diff Red BG (Light)');
registerColor('diff-del-emphasis', {
  light: '#ffd7d5',
  dark: 'rgba(248, 81, 73, 0.42)',
}, 'GitHub Diff Red inline emphasis');
registerColor('diff-add-fg', {
  light: '#22863a',
  dark: '#7ee787',
}, 'GitHub Diff Green (Light)');
registerColor('diff-add-bg', {
  light: '#f0fff4',
  dark: '#033a16',
}, 'GitHub Diff Green BG (Light)');
registerColor('diff-add-emphasis', {
  light: '#acf2bd',
  dark: 'rgba(46, 160, 67, 0.42)',
}, 'GitHub Diff Green inline emphasis');
registerColor('diff-line-num', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('info-700', {
  light: '#1D4ED8',
  dark: '#60a5fa',
}, 'blue-700 — file/param highlight (Light)');
registerColor('agent-actions-rail', {
  light: '#DDD6CB',
  dark: '#404040',
}, 'warm neutral — left rail (Light)');

// 图片标注(image-annotation):托盘缩略图"带标注"角标底色。语义豁免色——
// 必须与烧进图片位图的笔迹红(lightboxAnnotations.ANNOTATION_STROKE_COLOR
// #FF3B30)保持一致,笔迹是图片内容的一部分不随主题变,角标作为它的指示器
// 同样跨主题恒定;走 token 只为满足规则 16 的可寻址性,不期望被主题 override。
registerColor('annotation-accent', {
  light: '#FF3B30',
  dark: '#FF3B30',
}, 'Annotation Red — 与烧录笔迹同色,语义豁免');

// Running Status Bar (F-SDK-3)
registerColor('status-bar-accent', {
  light: 'var(--warning-accent)',
  dark: 'var(--warning-accent)',
}, 'Thinking Orange — docs/design-rules/cindy-design-system.md');
// 状态徽章前景(§7 必炸点):橙底(status-bar-accent #FF6600)深字。
// 此前橙徽章借用 accent-pure-cta-fg(白字)→ #FFFFFF×#FF6600=2.94:1 不达标;
// 拆独立 token 走深字(=text-primary/text-primary-inv),× status-bar-accent ≥4.5:1。
registerColor('status-badge-fg', {
  light: 'var(--accent-pure-cta-fg)',
  dark: 'var(--accent-pure-cta-fg)',
}, '状态徽章前景(§7 必炸点;default 镜像 accent-pure-cta-fg 保证既有 9 主题零变化,CINDY override #1F1F1F)');
// E4D 毛玻璃(R1 audit,用户裁决透壁纸 2026-07-17):半透明底色,仅 CINDY override 生效;
// default 不透明等价色(其他 family 行为零变化)。blur 在 CSS backdrop-filter(50px/6px)。
registerColor('surface-translucent-sidebar', {
  light: 'var(--surface)',
  dark: 'var(--surface)',
}, 'E4D 侧栏半透明底(default 等价 surface;CINDY override rgba #F6F6F6@90%/#120F0F@85% R1 模式1)');
registerColor('surface-translucent-main', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'E4D 主面板半透明底(default surface-elevated;CINDY override rgba #FFFFFF@93%/#120F0F@85% R1 模式2)');
registerColor('surface-translucent-overlay', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'E4D 浮层半透明底(default surface-elevated;CINDY override rgba #F6F6F6@90%/#252323@80% R1 模式3)');
// 玻璃侧栏上的搜索输入框底(2026-07-21 玻璃面 hover 半透明化配套):default 透传 surface-elevated
// 保证其余 9 主题零变化;CINDY override 半透明(light 白 55% 提亮成"可输入"字段感,dark 黑 25%
// 下陷字段感),方向与 sidebar-item-hover 的叠加方向相反,保证 hover 与输入框视觉可区分。
registerColor('sidebar-search-input-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, '玻璃侧栏搜索输入框底(default 等价 surface-elevated;CINDY override rgba 白@55%/黑@25%)');
registerColor('composer-pill-bg', {
  light: '#FCFCFC',
  dark: '#393838',
}, 'E2 composer pill/圆钮底(输入条 pill/圆钮,比卡面浅一档刻意对比;lead Figma 实测 spec §2-3;取代错稿 glass-pill-bg)');
registerColor('composer-pill-icon', {
  light: '#3C3F43',
  dark: '#D9D9D9',
}, 'E2 composer pill 图标(light=text-primary #3C3F43;dark #D9D9D9;spec §2-3)');
registerColor('status-bar-meta', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');

// Settings page — Ollama layer system (Light)
registerColor('settings-bg', {
  light: 'var(--surface)',
  dark: 'var(--surface)',
}, 'Surface');
registerColor('settings-divider', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board — hairline');
registerColor('settings-back-icon', {
  light: 'var(--text-tertiary-mid)',
  dark: 'var(--text-tertiary-mid)',
}, 'Mid Gray — arrow glyph');
registerColor('settings-back-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — "Settings" title');
registerColor('settings-back-hover', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — subtle hover');

// Settings - inner sidebar menu items
registerColor('settings-menu-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — unselected label (用户改稿 2026-07-21:与设置标题同色,不再用二级灰)');
registerColor('settings-menu-text-selected', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — selected label');
registerColor('settings-menu-bg-selected', {
  light: '#e8e8e6',
  dark: '#2c2c2a',
}, 'Soft tint — selected pill');
registerColor('settings-menu-border-selected', {
  light: 'var(--border-transparent-mixed)',
  dark: 'var(--border-transparent-mixed)',
}, 'Settings - inner sidebar menu items');
registerColor('settings-menu-bg-hover', {
  light: '#ececea',
  dark: '#2c2c2a',
}, 'Subtle hover');
registerColor('settings-section-title', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — section heading');
registerColor('settings-section-desc', {
  light: 'var(--text-tertiary-mid)',
  dark: 'var(--text-tertiary-mid)',
}, 'Mid Gray — description body');
registerColor('settings-section-sublabel', {
  light: 'var(--text-tertiary-mid)',
  dark: 'var(--text-tertiary-mid)',
}, 'Mid Gray — "Theme" sublabel');

// Settings - User card (elevated on Surface)
registerColor('settings-profile-card-bg', {
  light: 'var(--surface-card-ivory)',
  dark: 'var(--surface-card-ivory)',
}, 'Card');
registerColor('settings-profile-card-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('settings-profile-avatar-bg', {
  light: 'var(--surface-chip-alt)',
  dark: 'var(--surface-chip-alt)',
}, 'Light Gray chip');
registerColor('settings-profile-avatar-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-profile-name', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');

// Settings - API Key input (pill input on Card)
registerColor('settings-input-bg', {
  light: 'var(--surface-card-ivory)',
  dark: 'var(--surface-card-ivory)',
}, 'Card');
registerColor('settings-input-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('settings-input-border-focus', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone — focus hint');
registerColor('settings-input-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-input-placeholder', {
  light: 'var(--text-placeholder)',
  dark: 'var(--text-placeholder)',
}, 'Placeholder — 收口至 --text-placeholder slot');
registerColor('settings-eye-icon', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('settings-eye-icon-hover', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-trash-icon', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — API Key clear button');
registerColor('settings-trash-icon-hover', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-source-meta', {
  light: 'var(--text-secondary-cross)',
  dark: 'var(--text-secondary-cross)',
}, 'Silver — "Source: ..." meta');
registerColor('settings-source-link', {
  light: '#262626',
  dark: '#d4d4d4',
}, 'Near Black — "Open Console" link');
registerColor('settings-error-text', {
  light: 'var(--error-flat)',
  dark: 'var(--error-flat)',
}, 'Functional only');

// Settings - StatusBadge (pill on Card) — grayscale per-status ladder
registerColor('settings-badge-bg', {
  light: 'var(--surface-card-ivory)',
  dark: 'var(--surface-card-ivory)',
}, 'Card');
registerColor('settings-badge-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');

// Per-status text/dot — Light ladder: Silver (weakest) → Stone → Pure Black (strongest)
registerColor('settings-badge-needs-config', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver — de-emphasized "empty" state');
registerColor('settings-badge-saved', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — neutral default once persisted');
registerColor('settings-badge-connected', {
  light: 'var(--card-status-done)',
  dark: 'var(--card-status-done)',
}, 'Done green — connected status indicator');
registerColor('settings-badge-connected-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black — connected badge text remains neutral');
registerColor('settings-badge-error', {
  light: 'var(--error-flat)',
  dark: 'var(--error-flat)',
}, 'Functional error only — grayscale exception');

// Settings - Primary button (Save) = Black Pill CTA
registerColor('settings-btn-primary-bg', {
  light: 'var(--accent-emphasis)',
  dark: 'var(--accent-emphasis)',
}, 'Near Black');
registerColor('settings-btn-primary-text', {
  light: '#faf9f5',
  dark: '#262626',
}, 'Surface ivory');
registerColor('settings-btn-primary-border', {
  light: 'var(--accent-emphasis)',
  dark: 'var(--accent-emphasis)',
}, 'Settings - Primary button (Save) = Black Pill CTA');
registerColor('settings-btn-primary-hover-bg', {
  light: 'var(--accent-hover)',
  dark: 'var(--accent-hover)',
}, 'Near Black');

// Settings - Secondary button (Test / Logout) = Gray Pill
registerColor('settings-btn-secondary-bg', {
  light: 'var(--surface-chip-alt)',
  dark: 'var(--surface-chip-alt)',
}, 'Light Gray');
registerColor('settings-btn-secondary-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-btn-secondary-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('settings-btn-secondary-hover-bg', {
  light: '#d7d7d4',
  dark: '#3c3c3a',
}, 'Board');

// Settings - Theme cards
registerColor('settings-theme-card-bg', {
  light: 'var(--surface-card-ivory)',
  dark: 'var(--surface-card-ivory)',
}, 'Card');
registerColor('settings-theme-card-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('settings-social-card-pressed-bg', {
  light: 'color-mix(in srgb, var(--surface-hover) 88%, var(--text-primary) 12%)',
  dark: 'color-mix(in srgb, var(--surface-hover) 88%, var(--text-primary) 12%)',
}, 'Settings social card pressed background — visibly distinct from hover in every theme');
registerColor('settings-theme-preview-bg', {
  light: 'var(--surface)',
  dark: 'var(--surface)',
}, 'Surface — inside preview');
registerColor('settings-theme-preview-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board — unselected border');
registerColor('settings-theme-preview-border-active', {
  light: 'var(--accent-emphasis)',
  dark: 'var(--accent-emphasis)',
}, 'Near Black — selected 2px ring');
registerColor('settings-theme-icon', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone — unselected');
registerColor('settings-theme-icon-active', {
  light: 'var(--accent-emphasis)',
  dark: 'var(--accent-emphasis)',
}, 'Near Black — selected');
registerColor('settings-theme-label', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone — unselected');
registerColor('settings-theme-label-active', {
  light: 'var(--accent-emphasis)',
  dark: 'var(--accent-emphasis)',
}, 'Near Black — selected');

// Auto preview gradient halves
registerColor('settings-theme-auto-light', {
  light: '#f8f8f6',
  dark: '#f8f8f6',
}, 'Auto preview gradient halves');
registerColor('settings-theme-auto-dark', {
  light: '#1f1f1e',
  dark: '#1f1f1e',
}, 'Auto preview gradient halves');

// Settings - Logout button (Card surface pill)
registerColor('settings-logout-bg', {
  light: '#faf9f5',
  dark: '#2c2c2a',
}, 'Card');
registerColor('settings-logout-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('settings-logout-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-logout-icon', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('settings-logout-hover-bg', {
  light: 'var(--surface-hover-soft)',
  dark: 'var(--surface-hover-soft)',
}, 'Surface — gentle hover');

// Settings - Integrations row (Google + future providers)
registerColor('settings-integration-avatar-bg', {
  light: '#faf9f5',
  dark: '#3c3c3a',
}, 'Card on Card — neutral chip');
registerColor('settings-integration-avatar-border', {
  light: '#e8e8e6',
  // dark 不能用 transparent / border-default(#3c3c3a 与默认 chip bg 同色都不可见);
  // 白色低透明度 hairline 叠在任意暗色主题的 chip 底上都能读出细边,无需各主题 override。
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'Hairline');
registerColor('settings-integration-avatar-icon', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Mono Google G');
registerColor('settings-integration-subtitle', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone — email / "Not connected"');
registerColor('settings-integration-warning', {
  light: 'var(--warning-accent)',
  dark: 'var(--warning-accent)',
}, 'Thinking Orange — "Reconnect required" (docs/design-rules/cindy-design-system.md §2 sanctioned brand orange)');

// Remote SSH host status dot — semantic colors (sanctioned exception to the
// "no hue" rule for this widget specifically: user explicitly asked for
// 绿/橙/红/灰 status signaling, akin to focus-ring/error/warning豁免 in
// docs/design-rules/cindy-design-system.md §2). Hues are kept identical across light/dark — the dot is
// small enough that saturation issues don't arise; legibility comes from
// the dot's high-contrast position against surface, not from luminance.
registerColor('remote-status-ready', {
  light: '#2AAE5B',
  dark: '#2AAE5B',
}, 'Status — connected / ready (green)');
registerColor('remote-status-progress', {
  light: '#f59e0b',
  dark: '#f59e0b',
}, 'Status — connecting/authenticating/reconnecting (amber-500, 偏黄不容易在小圆点上被误读为红)');
registerColor('remote-status-failed', {
  light: '#D91F37',
  dark: '#D91F37',
}, 'Status — connect failed (red)');

// 会话状态点(AttentionDot / 列表行右槽 / 灵动岛)三态语义色 —— 同 remote-status 走
// docs/design-rules/cindy-design-system.md §2 "小状态点 hue 豁免":跨主题同色,靠位置高对比区分。
// 全端统一色表(与灵动岛 native 对齐):running=Thinking Orange(status-bar-accent)、
// awaiting=TapTap 蓝、error=红、完成未读=绿。
registerColor('card-status-awaiting', {
  light: '#19D2C1',
  dark: '#19D2C1',
}, '状态点 — 待用户回复/选择 (设计定稿 2026-07-17 #19D2C1,取代 #00D9C5 冻结红线;light/dark 同值)');
registerColor('card-status-error', {
  light: '#D91F37',
  dark: '#D91F37',
}, '状态点 — 任务出错 (设计定稿 2026-07-17 #D91F37,取代 #ef4444;状态族 error,非 error-flat 正文文案)');
registerColor('card-status-done', {
  light: '#2AAE5B',
  dark: '#2AAE5B',
}, '状态点 — 完成未读 (设计定稿 2026-07-17 #2AAE5B,取代 #22c55e;普通/定时任务完成统一,橙专职 running)');
registerColor('remote-status-disconnected', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Status — never connected / manually disconnected (grey, neutral)');

// AskUserQuestion card (F7.3) — Light
registerColor('ask-card-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('ask-card-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('ask-header-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('ask-page-text', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver');
registerColor('ask-option-label', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('ask-option-desc', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('ask-option-custom', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver — "Type something else..."');
registerColor('ask-option-divider', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('ask-option-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board — options container outline');
registerColor('ask-badge-bg', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'Light Gray');
registerColor('ask-badge-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, '主文字 — chip/角标文字随主题(勿接 on-dark 槽位,light 会白字压浅底)');
registerColor('ask-header-chip-bg', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'header chip 底 — 落在卡底上,与选项行上的序号角标(ask-badge-bg)分家,皮肤可各自调档');
registerColor('ask-option-list-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, '选项列表面 — 原透明露卡底在 dark 下成一坨深色(2026-07-23 用户实测),给独立列表面');
registerColor('ask-input-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('ask-input-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('ask-input-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, 'Near Black');
registerColor('ask-input-placeholder', {
  light: 'var(--text-placeholder)',
  dark: 'var(--text-placeholder)',
}, 'Placeholder — 收口至 --text-placeholder slot');
registerColor('ask-send-bg', {
  light: 'var(--accent-cta-bg)',
  dark: 'var(--accent-cta-bg)',
}, 'Near Black');
registerColor('ask-send-text', {
  light: 'var(--surface-on-card)',
  dark: 'var(--surface-on-card)',
}, 'Pure White');
registerColor('ask-send-disabled-bg', {
  light: 'var(--surface-elevated-soft)',
  dark: 'var(--surface-elevated-soft)',
}, 'Light Gray');
registerColor('ask-send-disabled-text', {
  light: 'var(--text-disabled-tertiary)',
  dark: 'var(--text-disabled-tertiary)',
}, 'Silver');
registerColor('ask-answered-text', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('ask-expired-text', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver');
registerColor('ask-option-hover', {
  light: 'var(--surface-hover-soft)',
  dark: 'var(--surface-hover-soft)',
}, 'Surface — option hover');

// Checkbox — inverted/反色: Light mode = dark border unchecked, dark bg checked
registerColor('ask-checkbox-border', {
  light: '#525250',
  dark: '#525250',
}, 'Mid Gray — unchecked border');
registerColor('ask-checkbox-checked-bg', {
  light: 'var(--accent-cta-bg)',
  dark: 'var(--accent-cta-bg)',
}, 'Near Black — checked fill');
registerColor('ask-checkbox-checked-icon', {
  light: 'var(--surface-on-card)',
  dark: 'var(--surface-on-card)',
}, 'Pure White — checkmark');

// Plan Viewer / Plan Action cards (FP-5/FP-6) — Light
registerColor('plan-card-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('plan-card-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('plan-header-title', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'pen: title color');
registerColor('plan-header-hint', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver');
registerColor('plan-header-divider', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('plan-toolbar-btn-icon', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('plan-toolbar-btn-hover-bg', {
  light: '#e8e8e5',
  dark: '#3c3c3a',
}, 'Light Chip hover');
registerColor('plan-outline-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('plan-outline-border', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board right divider');
registerColor('plan-outline-label', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('plan-outline-item-text', {
  light: 'var(--text-tertiary-stone)',
  dark: 'var(--text-tertiary-stone)',
}, 'Stone');
registerColor('plan-outline-active-bg', {
  light: '#e8e8e5',
  dark: '#3c3c3a',
}, 'pen: Light Chip');
registerColor('plan-outline-active-text', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'Near Black');
registerColor('plan-content-bg', {
  light: 'var(--surface-elevated)',
  dark: 'var(--surface-elevated)',
}, 'Card');
registerColor('plan-content-section', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'Near Black heading');
registerColor('plan-content-body', {
  light: 'var(--text-primary-body-strong)',
  dark: 'var(--text-primary-body-strong)',
}, 'Mid Gray body');
registerColor('plan-content-divider', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('plan-edit-body', {
  light: 'var(--text-primary-body-strong)',
  dark: 'var(--text-primary-body-strong)',
}, 'Mid Gray JetBrains Mono');

// Action card
registerColor('plan-action-approve-text', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'Plan 操作卡强调主文字');
registerColor('plan-action-approve-enter', {
  light: 'var(--text-secondary-cross)',
  dark: 'var(--text-secondary-cross)',
}, 'Silver');
registerColor('plan-action-row-divider', {
  light: 'var(--border-default)',
  dark: 'var(--border-default)',
}, 'Board');
registerColor('plan-action-fb-icon', {
  light: 'var(--text-secondary-cross)',
  dark: 'var(--text-secondary-cross)',
}, 'Silver');
registerColor('plan-action-fb-placeholder', {
  light: 'var(--text-placeholder)',
  dark: 'var(--text-placeholder)',
}, 'Placeholder — 收口至 --text-placeholder slot');
registerColor('plan-action-fb-text', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'Plan 反馈输入强调主文字');
registerColor('plan-action-row-hover-bg', {
  light: 'var(--surface-hover-soft)',
  dark: 'var(--surface-hover-soft)',
}, 'Surface hover');
registerColor('plan-action-approve-icon-bg', {
  light: 'var(--warning-accent)',
  dark: 'var(--warning-accent)',
}, 'Action card');
registerColor('plan-action-approve-icon-fg', {
  light: '#ffffff',
  dark: '#ffffff',
}, 'Action card');

// Minimized bar
registerColor('plan-min-title', {
  light: 'var(--text-primary-emphasis)',
  dark: 'var(--text-primary-emphasis)',
}, 'Minimized bar');
registerColor('plan-min-icon', {
  light: 'var(--text-secondary-cross)',
  dark: 'var(--text-secondary-cross)',
}, 'Minimized bar');

// History bubbles (FP-8) — grayscale per docs/design-rules/cindy-design-system.md
registerColor('plan-bubble-badge-bg', {
  light: 'var(--surface-chip)',
  dark: 'var(--surface-chip)',
}, 'Light Gray chip');
registerColor('plan-bubble-badge-text', {
  light: 'var(--text-primary)',
  dark: 'var(--text-primary)',
}, '主文字 — badge 文字随主题(勿接 on-dark 槽位)');
registerColor('plan-bubble-body-text', {
  light: 'var(--text-primary-body-strong)',
  dark: 'var(--text-primary-body-strong)',
}, 'Mid Gray');
registerColor('plan-bubble-summary-text', {
  light: 'var(--text-secondary)',
  dark: 'var(--text-secondary)',
}, 'Stone');
registerColor('color-primary', {
  light: '#171717',
  dark: '#d4d4d4',
}, '= foreground');
registerColor('color-neutral-300', {
  light: 'var(--text-disabled)',
  dark: 'var(--text-disabled)',
}, 'History bubbles (FP-8) — grayscale per docs/design-rules/cindy-design-system.md');
registerColor('color-neutral-400', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'Silver');
registerColor('color-error-600', {
  light: 'var(--error-flat)',
  dark: 'var(--error-flat)',
}, 'Danger');
registerColor('color-error-700', {
  light: '#dc2626',
  dark: '#dc2626',
}, 'Danger hover');

/* === P3.1: focus / shadow / overlay / error / warning 语义槽 === */
registerColor('focus-ring', {
  light: '#417CDD',
  dark: '#417CDD',
}, 'Opaque a11y focus border(设计定稿 2026-07-17 #417CDD,取代 blue-500 #3b82f6)');
registerColor('focus-ring-soft', {
  light: 'rgba(65, 124, 221, 0.5)',
  dark: 'rgba(65, 124, 221, 0.5)',
}, '50% alpha focus ring(随 focus-ring #417CDD,定稿 2026-07-17)— 替代 ring-[#xxx]/50 写法');
registerColor('shadow-menu', {
  light: '0 4px 16px rgba(0, 0, 0, 0.15)',
  dark: '0 4px 16px rgba(0, 0, 0, 0.5)',
}, 'Dropdown / context menu / 中型悬浮卡 shadow');
registerColor('overlay-modal', {
  light: 'rgba(0, 0, 0, 0.5)',
  dark: 'rgba(0, 0, 0, 0.7)',
}, '常规模态 backdrop');
registerColor('overlay-lightbox', {
  light: 'rgba(0, 0, 0, 0.85)',
  dark: 'rgba(0, 0, 0, 0.85)',
}, '图片/视频/mermaid lightbox 深 backdrop');
// lightbox chrome(胶囊工具栏):浮在恒黑 backdrop 上,跨主题恒定,语义豁免类
// (同 overlay-lightbox);仍注册为 token 保留主题 override 能力(规则 16)。
registerColor('lightbox-toolbar-bg', {
  light: 'rgba(0, 0, 0, 0.6)',
  dark: 'rgba(0, 0, 0, 0.6)',
}, 'lightbox 胶囊工具栏底色(恒黑 backdrop 上)');
registerColor('lightbox-toolbar-border', {
  light: 'rgba(255, 255, 255, 0.2)',
  dark: 'rgba(255, 255, 255, 0.2)',
}, 'lightbox 胶囊工具栏描边/分隔线');
registerColor('lightbox-toolbar-fg', {
  light: 'rgba(255, 255, 255, 0.8)',
  dark: 'rgba(255, 255, 255, 0.8)',
}, 'lightbox 胶囊工具栏图标默认色(语义豁免,理由同 lightbox-toolbar-bg)');
registerColor('lightbox-toolbar-fg-hover', {
  light: '#ffffff',
  dark: '#ffffff',
}, 'lightbox 胶囊工具栏图标 hover 色(语义豁免,理由同上)');
registerColor('lightbox-toolbar-hover-bg', {
  light: 'rgba(255, 255, 255, 0.1)',
  dark: 'rgba(255, 255, 255, 0.1)',
}, 'lightbox 胶囊工具栏按钮 hover 背景(语义豁免,理由同上)');
registerColor('error-bg', {
  light: '#fef2f2',
  dark: '#3a2222',
}, '错误警告卡片背景');
registerColor('error-border', {
  light: 'rgba(220, 38, 38, 0.4)',
  dark: '#7f1d1d',
}, '错误卡片边框');
registerColor('error-fg', {
  light: '#dc2626',
  dark: '#f87171',
}, '错误卡片正文/图标');
registerColor('error-fg-strong', {
  light: '#991b1b',
  dark: '#fca5a5',
}, '错误卡片强调文字');
registerColor('warning-bg-soft', {
  light: 'rgba(234, 107, 23, 0.12)',
  dark: 'rgba(234, 107, 23, 0.18)',
}, 'Warning alpha surface (FeishuConflictDialog 类警告 badge;alpha 随 warning-accent #EA6B17 同步重算 2026-07-17)');
registerColor('warning-fg', {
  light: '#F3A115',
  dark: '#F3A115',
}, '警示强调文字/图标(设计定稿 2026-07-17 #F3A115;与 Toast amber #F59E0B 解耦——Toast 维持 B 组现状,本 token 走定稿前景)');
// cc-mgr 远端升级 banner (UpgradeBanner.tsx) — amber warning 语义,跨主题统一、语义豁免
// (规则 15:warning/amber 在豁免范围,不被非默认主题 override,但仍走 token)。
registerColor('upgrade-banner-bg', {
  light: 'rgba(255, 102, 0, 0.10)',
  dark: 'rgba(255, 102, 0, 0.16)',
}, 'cc-mgr 升级 banner 背景 (amber warning, 语义豁免)');
registerColor('upgrade-banner-border', {
  light: 'rgba(245, 158, 11, 0.45)',
  dark: 'rgba(245, 158, 11, 0.55)',
}, 'cc-mgr 升级 banner 边框 (amber warning, 语义豁免)');
registerColor('upgrade-banner-fg', {
  light: '#92400e',
  dark: '#FBBF24',
}, 'cc-mgr 升级 banner 正文/图标/按钮 (amber warning, 语义豁免)');
// Skill Hub 审核状态 badge (publishedStatus.ts) — warning 语义豁免,跨主题统一。
// 机审中 (pending/scanning) 橙色 / 人工复核中 (quarantine) 黄色;审核未通过 (rejected) 复用 error-* token。
registerColor('skillhub-review-pending-bg', {
  light: '#fff7ed',
  dark: 'rgba(251, 146, 60, 0.14)',
}, 'Skill Hub 机审中 badge 背景 (orange warning, 语义豁免)');
registerColor('skillhub-review-pending-border', {
  light: '#fed7aa',
  dark: 'rgba(251, 146, 60, 0.35)',
}, 'Skill Hub 机审中 badge 边框 (orange warning, 语义豁免)');
registerColor('skillhub-review-pending-fg', {
  light: '#ea580c',
  dark: '#fb923c',
}, 'Skill Hub 机审中 badge 文字 (orange warning, 语义豁免)');
registerColor('skillhub-review-quarantine-bg', {
  light: '#fefce8',
  dark: 'rgba(250, 204, 21, 0.12)',
}, 'Skill Hub 人工复核中 badge 背景 (yellow warning, 语义豁免)');
registerColor('skillhub-review-quarantine-border', {
  light: '#fef08a',
  dark: 'rgba(250, 204, 21, 0.35)',
}, 'Skill Hub 人工复核中 badge 边框 (yellow warning, 语义豁免)');
registerColor('skillhub-review-quarantine-fg', {
  light: '#a16207',
  dark: '#facc15',
}, 'Skill Hub 人工复核中 badge 文字 (yellow warning, 语义豁免)');

// CREATE AGENT composer controls — Figma 185:1495 / 185:2724, E2-S 2026-07-17.
// These private tokens are exact light/dark values for the new-page solid
// composer controls. Do not reuse for the session-view glass composer pills.
registerColor('create-agent-control-bg', {
  light: '#FCFCFC',
  dark: '#393838',
}, 'CREATE AGENT pill / icon button background');
registerColor('create-agent-control-bg-hover', {
  light: 'var(--surface-hover)',
  dark: '#444242',
}, 'CREATE AGENT neutral hover background');
registerColor('create-agent-control-bg-pressed', {
  light: 'var(--surface-hover-soft)',
  dark: '#504F4F',
}, 'CREATE AGENT neutral pressed background');
registerColor('create-agent-control-border', {
  light: '#DCDFE3',
  dark: '#434343',
}, 'CREATE AGENT pill / icon button border');
registerColor('create-agent-control-text', {
  light: '#3C3F43',
  dark: '#D4D4D4',
}, 'CREATE AGENT pill text');
registerColor('create-agent-control-icon', {
  light: '#3C3F43',
  dark: '#D9D9D9',
}, 'CREATE AGENT icon / chevron');
registerColor('create-agent-segment-track-bg', {
  light: '#EDEDED',
  dark: '#2A2828',
}, 'CREATE AGENT Claude/Codex segmented track');
registerColor('create-agent-segment-inactive-text', {
  light: '#9A9DA3',
  dark: '#6F6F6F',
}, 'CREATE AGENT segmented inactive text');
registerColor('create-agent-send-bg', {
  light: '#3C3F43',
  dark: '#EEEEEE',
}, 'CREATE AGENT send button inverse neutral bg');
registerColor('create-agent-send-icon', {
  light: '#FCFCFC',
  dark: '#252222',
}, 'CREATE AGENT send button inverse neutral icon');
registerColor('create-agent-send-bg-hover', {
  light: '#2E3237',
  dark: '#E2E2E2',
}, 'CREATE AGENT send button neutral hover bg');
registerColor('create-agent-send-bg-pressed', {
  light: '#25282C',
  dark: '#D4D4D4',
}, 'CREATE AGENT send button neutral pressed bg');
registerColor('create-agent-send-disabled-bg', {
  light: '#EDEDED',
  dark: '#444242',
}, 'CREATE AGENT send button disabled bg');
registerColor('create-agent-send-disabled-icon', {
  light: '#9A9DA3',
  dark: '#585555',
}, 'CREATE AGENT send button disabled icon');
registerColor('create-agent-focus-ring', {
  light: 'var(--text-tertiary)',
  dark: 'var(--text-tertiary)',
}, 'CREATE AGENT neutral focus border');
registerColor('create-agent-quick-card-bg', {
  light: '#F8F8F8',
  dark: '#312F2F',
}, 'CREATE AGENT quick-start card background');
registerColor('create-agent-quick-card-border', {
  light: '#DCDFE3',
  dark: '#434343',
}, 'CREATE AGENT quick-start card border');
registerColor('create-agent-quick-card-text', {
  light: '#3C3F43',
  dark: '#D4D4D4',
}, 'CREATE AGENT quick-start card text');
registerColor('create-agent-quick-card-icon-bg', {
  light: '#EDEDED',
  dark: '#2A2828',
}, 'CREATE AGENT quick-start icon circle background');
registerColor('create-agent-quick-card-icon', {
  light: '#3C3F43',
  dark: '#D4D4D4',
}, 'CREATE AGENT quick-start icon');
registerColor('create-agent-quick-card-bg-hover', {
  light: '#FCFCFC',
  dark: '#3B3A3A',
}, 'CREATE AGENT quick-start card neutral hover background');
registerColor('create-agent-avatar-ring', {
  light: 'rgba(255, 255, 255, 0.08)',
  dark: 'rgba(255, 255, 255, 0.08)',
}, 'CREATE AGENT lockup avatar outer ring');
registerColor('create-agent-avatar-glass-bg', {
  light: 'rgba(0, 0, 0, 0.004)',
  dark: 'rgba(0, 0, 0, 0.004)',
}, 'CREATE AGENT lockup avatar GLASS fill');
registerColor('create-agent-avatar-inner-ring-start', {
  light: 'rgba(255, 255, 255, 0.29)',
  dark: 'rgba(255, 255, 255, 0.29)',
}, 'CREATE AGENT lockup avatar inner gradient ring start');
registerColor('create-agent-avatar-inner-ring-end', {
  light: 'rgba(255, 255, 255, 0.24)',
  dark: 'rgba(255, 255, 255, 0.24)',
}, 'CREATE AGENT lockup avatar inner gradient ring end');
registerColor('sidebar-nav-text', {
  light: '#3C3F43',
  dark: '#D4D4D4',
}, 'CINDY sidebar top nav icon / text');
registerColor('sidebar-list-muted', {
  light: '#9A9DA3',
  dark: '#6F6F6F',
}, 'CINDY sidebar section and project list muted text');
registerColor('sidebar-user-card-bg', {
  light: 'rgba(255, 255, 255, 0.20)',
  dark: 'rgba(255, 255, 255, 0.05)',
}, 'CINDY sidebar user capsule background');
registerColor('sidebar-user-card-bg-hover', {
  light: 'rgba(60, 63, 67, 0.06)',
  dark: 'rgba(255, 255, 255, 0.10)',
}, 'CINDY sidebar user capsule hover background (light darkens on near-white sidebar, dark lightens)');
registerColor('sidebar-user-card-border', {
  light: 'rgba(60, 63, 67, 0.10)',
  dark: 'rgba(255, 255, 255, 0.13)',
}, 'CINDY sidebar user capsule border');
registerColor('sidebar-user-card-text', {
  light: '#3C3F43',
  dark: '#D4D4D4',
}, 'CINDY sidebar user capsule text and icon');
registerColor('caret-accent', {
  light: 'var(--accent-cta-bg)',
  dark: 'var(--accent-cta-bg)',
}, 'Editable caret accent; CINDY overrides to focus blue #417CDD per user decision 2026-07-18(撤红改蓝)');
