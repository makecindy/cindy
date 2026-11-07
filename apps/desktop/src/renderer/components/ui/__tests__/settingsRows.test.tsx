// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsDrawerScope, SettingsRow, SettingsSection } from '../settings-rows';

afterEach(cleanup);

describe('SettingsRow', () => {
  it('整行只有一个点击目标；有右侧控件时行本身不是按钮', () => {
    const onClick = vi.fn();
    const { rerender } = render(<SettingsRow title="群管理" hint="说明" chevron onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /群管理/ }));
    expect(onClick).toHaveBeenCalledOnce();

    rerender(<SettingsRow title="通知" trailing={<button type="button">开关</button>} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button').textContent).toBe('开关');
  });

  it('设置页和抽屉的行名称都是 13px / 500，抽屉收紧组名和行高', () => {
    const name = () => screen.getByText('名称').parentElement as HTMLElement;
    const { rerender } = render(<SettingsSection title="分组"><SettingsRow title="名称" /></SettingsSection>);
    expect(name().className).toContain('text-13 font-medium');
    expect(screen.getByRole('heading').className).toContain('text-16');
    expect(name().parentElement?.parentElement?.className).toContain('py-4');

    rerender(<SettingsDrawerScope><SettingsSection title="分组"><SettingsRow title="名称" /></SettingsSection></SettingsDrawerScope>);
    expect(name().className).toContain('text-13 font-medium');
    expect(screen.getByRole('heading').className).toContain('text-13');
    expect(name().parentElement?.parentElement?.className).toContain('min-h-12');
  });
});
