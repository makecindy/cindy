// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsRow } from '../settings-rows';

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
});
