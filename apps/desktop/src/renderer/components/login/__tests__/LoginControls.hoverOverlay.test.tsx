// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LoginBackButton, LoginInput, LoginMethodRow } from '../LoginControls';

/**
 * hover / pressed 叠层只能染控件底色,不能盖住内容,也不能被内联样式吞掉:
 * - 返回钮、方式行的叠层挂在 ::after 上(position:absolute,绘制在后),
 *   内容层若没有 z-index 就会被盖住——亮色返回钮悬停时箭头只剩 1.76:1;
 * - 输入框的 hover 叠层是 background-image,内联 `background` 简写会把它重置为
 *   none,导致悬停反馈从未生效。
 */
describe('登录控件 hover 叠层', () => {
  afterEach(() => cleanup());

  it('返回钮箭头位于叠层之上', () => {
    render(<LoginBackButton label="Back" onClick={() => {}} />);
    const svg = screen.getByTestId('login-back-button').querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('z-[1]');
  });

  it('方式行图标与文字位于叠层之上', () => {
    render(
      <LoginMethodRow
        top={158}
        title="Sign in with a personal account"
        subtitle="Send a verification code to your email"
        onClick={() => {}}
        testId="row"
      />,
    );
    const contentLayers = [...screen.getByTestId('row').children].filter((child) =>
      child.className.includes('absolute'),
    );
    expect(contentLayers).toHaveLength(3);
    for (const layer of contentLayers) expect(layer.className).toContain('z-[1]');
  });

  it('输入框底色不用 background 简写,hover 的 background-image 叠层得以生效', () => {
    render(<LoginInput value="" onChange={() => {}} placeholder="Email" testId="input" />);
    const input = screen.getByRole('textbox');
    const style = input.getAttribute('style') ?? '';
    expect(style).toContain('background-color');
    expect(style).not.toMatch(/(^|;)\s*background:/);
    expect(input.className).toContain('hover:enabled:[background-image:');
  });
});
