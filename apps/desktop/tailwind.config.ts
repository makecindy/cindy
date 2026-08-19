import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        titlebar: {
          DEFAULT: 'hsl(var(--titlebar))',
          border: 'hsl(var(--titlebar-border))',
          icon: 'hsl(var(--titlebar-icon))',
          'button-hover': 'hsl(var(--titlebar-button-hover))',
          'control-hover': 'hsl(var(--titlebar-control-hover))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          border: 'hsl(var(--sidebar-border))',
          'item-hover': 'hsl(var(--sidebar-item-hover))',
          'item-active': 'hsl(var(--sidebar-item-active))',
          'search-bg': 'hsl(var(--sidebar-search-bg))',
          muted: 'hsl(var(--sidebar-muted))',
          'action-icon': 'hsl(var(--sidebar-action-icon))',
        },
        'content-area': 'hsl(var(--content-area))',
        'welcome-text': 'hsl(var(--welcome-text))',
        'search-match': {
          bg: 'hsl(var(--search-match-bg))',
          fg: 'hsl(var(--search-match-fg))',
        },
      },
      fontFamily: {
        mono: ['var(--app-font-code, var(--app-font-code-default))'],
      },
      // DESIGN.md §3 numeric 字号白名单的 Tailwind 权威来源之一。规范正本
      // 与三处权威来源代码由守卫互验；lib/utils.ts 是单独校验的消费端去重列表。
      fontSize: {
        xs: ['var(--text-xs)', { lineHeight: 'var(--text-xs-line-height)' }],
        sm: ['var(--text-sm)', { lineHeight: 'var(--text-sm-line-height)' }],
        base: ['var(--text-base)', { lineHeight: 'var(--text-base-line-height)' }],
        lg: ['var(--text-lg)', { lineHeight: 'var(--text-lg-line-height)' }],
        xl: ['var(--text-xl)', { lineHeight: 'var(--text-xl-line-height)' }],
        '2xl': ['var(--text-2xl)', { lineHeight: 'var(--text-2xl-line-height)' }],
        '3xl': ['var(--text-3xl)', { lineHeight: 'var(--text-3xl-line-height)' }],
        '4xl': ['var(--text-4xl)', { lineHeight: 'var(--text-4xl-line-height)' }],
        '5xl': ['var(--text-5xl)', { lineHeight: 'var(--text-5xl-line-height)' }],
        10: 'var(--text-10)',
        11: 'var(--text-11)',
        12: 'var(--text-12)',
        13: 'var(--text-13)',
        14: 'var(--text-14)',
        15: 'var(--text-15)',
        16: 'var(--text-16)',
        18: 'var(--text-18)',
        20: 'var(--text-20)',
        24: 'var(--text-24)',
        28: 'var(--text-28)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      lineClamp: {
        10: '10',
      },
      keyframes: {
        // 浮层通用入退场(时长/曲线走 globals.css 的 --motion-* token,规范见
        // DESIGN.md §14.4)。只允许 opacity / transform,保证 compositor-only。
        'float-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        // float-out 故意不写 from:省略时浏览器从属性当前计算值起插,
        // 入场进行到一半就关闭时不会先跳到 1 再淡出(review 反馈的闪变)。
        'float-out': {
          to: { opacity: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'confirm-overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'confirm-overlay-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        // 共享 confirm-content-in/out:存量弹窗仍是 left-1/2 top-1/2 +
        // -translate-x/y-1/2 的 transform 居中,动画期间 keyframes 的 transform
        // 会整体覆盖 Tailwind 的 translate —— 不把 translate(-50%, -50%) 烘进
        // 每一帧,弹窗入退场时会跳到视口左上角(位移一半宽高)。故共享动画
        // 保持 translate + scale,不得删除。
        'confirm-content-in': {
          from: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.95)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'confirm-content-out': {
          from: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.95)' },
        },
        // 布局居中弹窗专用(ConfirmDialog 的 inset-0 + m-auto 方案,confirm-dialog.tsx):
        // keyframes 里不得再带回 translate —— app-region 命中区不跟随 transform,
        // 入场/退场期间 translate 会把弹窗甩出 no-drag 挖洞。fade + scale 仍按
        // DESIGN.md §14.4 的 heavy-overlay 规格(250ms in / 150ms out)。
        'confirm-content-layout-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'confirm-content-layout-out': {
          from: { opacity: '1', transform: 'scale(1)' },
          to: { opacity: '0', transform: 'scale(0.95)' },
        },
      },
      animation: {
        // 功能性 loading spinner 使用 DESIGN.md §14.4 明确登记的语义循环 token；
        // 不复用 Tailwind animate-spin 的硬编码 1s,也不耦合 enter/exit 交互档位。
        spinner: 'spin var(--motion-spinner-cycle, 1000ms) linear infinite',
        // float-out 需要 forwards:Radix 等 animationend 才卸载,fill 不驻留
        // 会在动画结束到卸载之间闪回原状。
        'float-in':
          'float-in var(--motion-fast, 150ms) var(--motion-ease-out, cubic-bezier(0.16, 1, 0.3, 1))',
        'float-out':
          'float-out var(--motion-instant, 80ms) var(--motion-ease-in, cubic-bezier(0.4, 0, 1, 1)) forwards',
        'fade-in':
          'fade-in var(--motion-fast, 150ms) var(--motion-ease-out, cubic-bezier(0.16, 1, 0.3, 1))',
        // 时长接 motion token(值与原 250/150ms 一致,曲线不变):reduced-motion
        // 经 token 归零即可覆盖 data-[state=*]: 变体形态的用法。
        'confirm-overlay-in':
          'confirm-overlay-in var(--motion-enter, 250ms) cubic-bezier(0, 0, 0.2, 1)',
        'confirm-overlay-out':
          'confirm-overlay-out var(--motion-exit, 150ms) cubic-bezier(0.4, 0, 1, 1)',
        'confirm-content-in':
          'confirm-content-in var(--motion-enter, 250ms) cubic-bezier(0, 0, 0.2, 1)',
        'confirm-content-out':
          'confirm-content-out var(--motion-exit, 150ms) cubic-bezier(0.4, 0, 1, 1)',
        'confirm-content-layout-in':
          'confirm-content-layout-in var(--motion-enter, 250ms) cubic-bezier(0, 0, 0.2, 1)',
        'confirm-content-layout-out':
          'confirm-content-layout-out var(--motion-exit, 150ms) cubic-bezier(0.4, 0, 1, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
