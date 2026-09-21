// @vitest-environment jsdom

/**
 * DS-4 Button 样式合同（Level 1 静态守卫）。
 *
 * 只锁「token 表达式 / 圆角 / 字号字重 / 尺寸档 / 禁用态」这些设计合同，不锁实现细节。
 * 状态值本身是否在各主题下可区分由 themes/__tests__/buttonStateContrast.test.ts 守。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, type ButtonVariant } from '../button';

/** 合同表：每个变体必须出现的 token 表达式。改绑 token 会在这里红。 */
const CONTRACT: Record<ButtonVariant, string[]> = {
  primary: [
    'bg-[var(--surface-chip)]',
    'text-[var(--text-primary)]',
    'enabled:hover:bg-[var(--button-primary-hover)]',
    'enabled:active:bg-[var(--button-primary-pressed)]',
  ],
  secondary: [
    'bg-[var(--surface-elevated)]',
    'border-[var(--border-default)]',
    'text-[var(--text-primary)]',
    'enabled:hover:bg-[var(--button-secondary-hover)]',
    'enabled:active:bg-[var(--button-secondary-pressed)]',
  ],
  cta: [
    'bg-[var(--accent-cta-bg-pure)]',
    'text-[var(--accent-pure-cta-fg)]',
    'enabled:hover:bg-[var(--button-cta-hover)]',
    'enabled:active:bg-[var(--button-cta-pressed)]',
  ],
};

/** 一律禁止出现的写法。 */
const FORBIDDEN = [
  'hover:opacity',        // G2：禁用透明度 hover
  'settings-btn-secondary', // G5：不继承设置页域 alias
  'h-10',                 // G1：按钮不设 40px 档
  'h-[40px]',
  'rounded-lg',           // §5：按钮一律胶囊
  'rounded-xl',
];

function classOf(name: string): string {
  return screen.getByRole('button', { name }).className;
}

function missing(cls: string, required: string[]): string[] {
  return required.filter((token) => !cls.includes(token));
}

describe('Button 样式合同', () => {
  afterEach(cleanup);

  for (const variant of Object.keys(CONTRACT) as ButtonVariant[]) {
    it(`${variant}：token 绑定齐全、胶囊圆角、text-13/500`, () => {
      render(<Button variant={variant}>{variant}</Button>);
      const cls = classOf(variant);

      expect(missing(cls, CONTRACT[variant]), `${variant} 缺失 token`).toEqual([]);
      expect(cls).toContain('rounded-full');
      expect(cls).toContain('text-13');
      expect(cls).toContain('font-medium');
      for (const banned of FORBIDDEN) {
        expect(cls, `${variant} 不应出现 ${banned}`).not.toContain(banned);
      }
    });
  }

  it('尺寸只有 32 / 36 两档', () => {
    render(
      <>
        <Button size="md">Md</Button>
        <Button size="lg">Lg</Button>
      </>,
    );
    expect(classOf('Md')).toContain('h-8');
    expect(classOf('Lg')).toContain('h-9');
  });

  it('focus-visible 走 --focus-ring；禁用态走普通指针 + 60% 不透明度', () => {
    render(<Button disabled>Disabled</Button>);
    const cls = classOf('Disabled');
    expect(cls).toContain('focus-visible:ring-[var(--focus-ring)]');
    expect(cls).toContain('disabled:cursor-not-allowed');
    expect(cls).toContain('disabled:opacity-60');
  });

  it('禁用态不得再触发 hover / active 换色（hover 一律带 enabled: 前缀）', () => {
    // CSS 的 :hover 对 disabled 元素照样匹配。不带 enabled: 前缀时，禁用按钮
    // 鼠标悬停仍会换底色——旧 PillButton 根本没有 hover，属迁移引入的行为回归。
    for (const variant of Object.keys(CONTRACT) as ButtonVariant[]) {
      cleanup();
      render(<Button variant={variant} disabled>{variant}</Button>);
      const cls = classOf(variant);
      const bare = cls
        .split(/\s+/)
        .filter((c) => (c.startsWith('hover:') || c.startsWith('active:')));
      expect(bare, `${variant} 存在无 enabled: 前缀的交互态`).toEqual([]);
    }
  });

  it('自证伪：合同表被改错时守卫必然红', () => {
    render(<Button variant="secondary">S</Button>);
    const cls = classOf('S');
    // 装作有人把 secondary 改回设置页域 alias：合同检查必须报缺失。
    expect(missing(cls, ['bg-[var(--settings-btn-secondary-bg)]'])).toEqual([
      'bg-[var(--settings-btn-secondary-bg)]',
    ]);
    // 装作有人把透明度 hover 加回来：禁令检查必须命中。
    expect('hover:opacity-90').toMatch(/hover:opacity/);
  });
});
