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
      fontSize: {
        9: 'var(--text-9)',
        10: 'var(--text-10)',
        11: 'var(--text-11)',
        12: 'var(--text-12)',
        13: 'var(--text-13)',
        14: 'var(--text-14)',
        15: 'var(--text-15)',
        16: 'var(--text-16)',
        17: 'var(--text-17)',
        18: 'var(--text-18)',
        19: 'var(--text-19)',
        20: 'var(--text-20)',
        21: 'var(--text-21)',
        22: 'var(--text-22)',
        23: 'var(--text-23)',
        24: 'var(--text-24)',
        25: 'var(--text-25)',
        26: 'var(--text-26)',
        27: 'var(--text-27)',
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
        'confirm-content-in': {
          from: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.95)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'confirm-content-out': {
          from: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
          to: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.95)' },
        },
      },
      animation: {
        // 功能性 loading spinner 使用 DESIGN.md §14.4 明确登记的语义循环 token；
        // 不复用 Tailwind animate-spin 的硬编码 1s,也不耦合 enter/exit 交互档位。
        spinner:
          'spin var(--motion-spinner-cycle, 1000ms) linear infinite',
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
      },
    },
  },
  plugins: [],
};

export default config;
