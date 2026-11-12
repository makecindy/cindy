// @vitest-environment jsdom

// 2026-11-13 主人试用反馈：模式不能收藏、也不在「全部」里。现在「全部」整段列出模式，行尾 ☆ 收藏后出现在「收藏」，
// 点 ☆ 只收藏不选中。真实入口：ModelGroupsPickerSection + 本机收藏存储(localStorage)。Tier: unit。
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelGroupsConfig } from '../../../../shared/modelGroups';

const i18nValue = { t: (key: string) => key };
vi.mock('react-i18next', () => ({ useTranslation: () => i18nValue }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => ({ dataOwnerId: 'owner-a' }) }));

import { ModelGroupsPickerSection } from '../ModelGroupsPickerSection';

const config = {
  routes: [
    { id: 'dev', name: 'Dev', strategy: 'order', candidates: [] },
    { id: 'cheap', name: 'Cheap', strategy: 'cheapest', candidates: [] },
  ],
} as unknown as ModelGroupsConfig;

afterEach(() => localStorage.clear());

describe('ModelGroupsPickerSection', () => {
  it('lists every mode in 全部, and a starred mode shows up under 收藏 without being selected', () => {
    const onSelect = vi.fn();
    const picker = { config, active: null, onSelect, onManage: vi.fn() };
    const all = render(<ModelGroupsPickerSection picker={picker} query="" onPicked={vi.fn()} variant="all" />);
    expect(screen.getByRole('group', { name: 'modelGroups.title' })).toBeTruthy();
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.getByText('Cheap')).toBeTruthy();

    fireEvent.click(all.container.querySelector('[data-model-group-favorite="cheap"]')!);
    expect(onSelect).not.toHaveBeenCalled();
    expect(all.container.querySelector('[data-model-group-favorite="cheap"]')?.getAttribute('aria-pressed')).toBe('true');
    all.unmount();

    const favorites = render(<ModelGroupsPickerSection picker={picker} query="" onPicked={vi.fn()} variant="favorites" />);
    expect(screen.queryByText('Dev')).toBeNull();
    fireEvent.click(screen.getByText('Cheap'));
    expect(onSelect).toHaveBeenCalledWith({ type: 'route', id: 'cheap' });
    favorites.unmount();

    // 选择器都关着时，同账号的另一个窗口取消了收藏(本窗口这时不听 storage 事件)：再打开要看到最新的。
    localStorage.setItem('cindy:modelGroupFavorites:v1:owner-a', '[]');
    const reopened = render(<ModelGroupsPickerSection picker={picker} query="" onPicked={vi.fn()} variant="all" />);
    expect(reopened.container.querySelector('[data-model-group-favorite="cheap"]')?.getAttribute('aria-pressed')).toBe('false');
    reopened.unmount();
  });
});
