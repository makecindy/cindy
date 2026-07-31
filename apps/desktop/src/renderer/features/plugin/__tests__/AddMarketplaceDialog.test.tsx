/**
 * 添加市场对话框：切到本地来源后不得再提交 Git 专属字段。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddMarketplaceDialog } from '../AddMarketplaceDialog';

const addSource = vi.fn(async () => ({}) as never);

beforeEach(() => {
  addSource.mockClear();
  vi.stubGlobal('window', window);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: {
      addSource,
      listSources: vi.fn(async () => []),
      removeSource: vi.fn(async () => ({ ok: true })),
      refreshSource: vi.fn(),
      gitPreflight: vi.fn(async () => ({ ok: true, version: '2.43.0' })),
    },
  };
});

/** 按 placeholder key 定位输入框（i18n 被 mock 成回显 key）。 */
function input(key: string): HTMLElement {
  return screen.getByPlaceholderText(key);
}

describe('AddMarketplaceDialog', () => {
  it('drops ref and sparse paths once the source turns out to be a local path', async () => {
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);

    // 先按 Git 源填 ref 与稀疏路径。
    fireEvent.change(input('settings.ghosts.market.sources.sourcePlaceholder'), {
      target: { value: 'openai/plugins' },
    });
    fireEvent.change(input('settings.ghosts.market.sources.refPlaceholder'), {
      target: { value: 'release' },
    });
    fireEvent.change(input('settings.ghosts.market.sources.sparsePlaceholder'), {
      target: { value: 'plugins/a\nplugins/b' },
    });

    // 再把来源改成本地目录:两个输入框变为禁用,用户无法自己清空它们。
    fireEvent.change(input('settings.ghosts.market.sources.sourcePlaceholder'), {
      target: { value: '~/team/plugins' },
    });
    expect(
      (input('settings.ghosts.market.sources.refPlaceholder') as HTMLInputElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.market.sources.add' }));
    await waitFor(() => expect(addSource).toHaveBeenCalled());

    // 提交的 payload 里不能带 Git 专属字段,否则 Main 会以
    // REF_NOT_ALLOWED_FOR_LOCAL / SPARSE_NOT_ALLOWED_FOR_LOCAL 拒绝,成为死结。
    expect(addSource).toHaveBeenCalledWith({ source: '~/team/plugins' });
  });

  it('still forwards ref and sparse paths for git sources', async () => {
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);
    fireEvent.change(input('settings.ghosts.market.sources.sourcePlaceholder'), {
      target: { value: 'openai/plugins' },
    });
    fireEvent.change(input('settings.ghosts.market.sources.refPlaceholder'), {
      target: { value: 'release' },
    });
    fireEvent.change(input('settings.ghosts.market.sources.sparsePlaceholder'), {
      target: { value: 'plugins/a' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.market.sources.add' }));
    await waitFor(() => expect(addSource).toHaveBeenCalled());
    expect(addSource).toHaveBeenCalledWith({
      source: 'openai/plugins',
      ref: 'release',
      sparsePaths: ['plugins/a'],
    });
  });
});
