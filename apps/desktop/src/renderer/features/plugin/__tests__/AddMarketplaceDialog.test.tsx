/**
 * 添加市场对话框：切到本地来源后不得再提交 Git 专属字段。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // AuthContext 链路会引入 i18n 初始化,mock 必须补齐这些导出。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const auth = { mode: 'cloud' as string, dataOwnerId: 'user-1' as string | null };
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));

import { AddMarketplaceDialog } from '../AddMarketplaceDialog';

const addSource = vi.fn(async () => ({}) as never);
const pickLocalSource = vi.fn(async () => ({ canceled: false, summary: {} }) as never);
const resolveDefaultBranch = vi.fn(async () => null as string | null);
const gitPreflight = vi.fn<() => Promise<{ ok: boolean; version: string | null }>>(async () => ({
  ok: true,
  version: '2.43.0',
}));

beforeEach(() => {
  addSource.mockClear();
  vi.stubGlobal('window', window);
  pickLocalSource.mockClear();
  resolveDefaultBranch.mockReset();
  resolveDefaultBranch.mockResolvedValue(null);
  gitPreflight.mockReset();
  gitPreflight.mockResolvedValue({ ok: true, version: '2.43.0' });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: {
      addSource,
      pickLocalSource,
      resolveDefaultBranch,
      listSources: vi.fn(async () => []),
      removeSource: vi.fn(async () => ({ ok: true })),
      refreshSource: vi.fn(),
      gitPreflight,
    },
  };
});

/** 按 placeholder key 定位输入框（i18n 被 mock 成回显 key）。 */
function input(key: string): HTMLElement {
  return screen.getByPlaceholderText(key);
}

async function waitForGitReady(): Promise<void> {
  await waitFor(() => expect(gitPreflight).toHaveBeenCalledTimes(1));
  await act(async () => {
    await gitPreflight.mock.results[0]?.value;
  });
}

describe('AddMarketplaceDialog', () => {
  it('prefills the remote default branch after the source loses focus', async () => {
    resolveDefaultBranch.mockResolvedValueOnce('main');
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);

    await waitForGitReady();

    const sourceField = input('settings.ghosts.market.sources.sourcePlaceholder');
    const refField = input('settings.ghosts.market.sources.refPlaceholder') as HTMLInputElement;
    fireEvent.change(sourceField, { target: { value: 'openai/plugins' } });
    fireEvent.blur(sourceField);

    await waitFor(() => expect(refField.value).toBe('main'));
    expect(resolveDefaultBranch).toHaveBeenCalledWith('openai/plugins');
    expect(screen.getByText('settings.ghosts.market.sources.defaultBranchDetected')).toBeTruthy();
  });

  it('does not probe the remote default branch when Git is unavailable', async () => {
    gitPreflight.mockResolvedValueOnce({ ok: false, version: null });
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);

    await screen.findByText('settings.ghosts.market.sources.gitUnavailable');
    const sourceField = input('settings.ghosts.market.sources.sourcePlaceholder');
    const refField = input('settings.ghosts.market.sources.refPlaceholder');
    fireEvent.change(sourceField, { target: { value: 'openai/plugins' } });
    fireEvent.blur(sourceField);

    expect(resolveDefaultBranch).not.toHaveBeenCalled();
    expect(refField.getAttribute('aria-busy')).toBe('false');
    expect(
      screen.queryByText('settings.ghosts.market.sources.defaultBranchResolving'),
    ).toBeNull();
  });

  it('does not overwrite a user-entered Git ref', async () => {
    resolveDefaultBranch.mockResolvedValueOnce('main');
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);
    await waitForGitReady();

    const sourceField = input('settings.ghosts.market.sources.sourcePlaceholder');
    const refField = input('settings.ghosts.market.sources.refPlaceholder') as HTMLInputElement;
    fireEvent.change(sourceField, { target: { value: 'openai/plugins' } });
    fireEvent.change(refField, { target: { value: 'release' } });
    fireEvent.blur(sourceField);

    await waitFor(() => expect(refField.value).toBe('release'));
    expect(resolveDefaultBranch).not.toHaveBeenCalled();
    expect(refField.value).toBe('release');
  });

  it('ignores a stale default branch response after the source changes', async () => {
    let resolveBranch!: (branch: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      resolveBranch = resolve;
    });
    resolveDefaultBranch.mockReturnValueOnce(pending);
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);
    await waitForGitReady();

    const sourceField = input('settings.ghosts.market.sources.sourcePlaceholder');
    const refField = input('settings.ghosts.market.sources.refPlaceholder') as HTMLInputElement;
    fireEvent.change(sourceField, { target: { value: 'openai/plugins' } });
    fireEvent.blur(sourceField);
    await waitFor(() => expect(resolveDefaultBranch).toHaveBeenCalledWith('openai/plugins'));

    fireEvent.change(sourceField, { target: { value: 'acme/tools' } });
    resolveBranch('main');
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refField.value).toBe('');
    expect(screen.queryByText('settings.ghosts.market.sources.defaultBranchDetected')).toBeNull();
  });

  it('explains when sparse paths are useful', async () => {
    render(<AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />);

    const sparseField = input('settings.ghosts.market.sources.sparsePlaceholder');
    const descriptionId = sparseField.getAttribute('aria-describedby');

    expect(descriptionId).toBeTruthy();
    await waitFor(() => {
      const description = document.getElementById(descriptionId ?? '')?.textContent;
      expect(description).toContain('settings.ghosts.market.sources.sparseDescription');
      expect(description).toContain('settings.ghosts.market.sources.sparseExample');
    });
  });

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
    // 本地目录必须走 Main 原生选择器(选择即授权),输入的路径只是初始定位提示;
    // Renderer 直传本地路径的 addSource 会在 IPC 层被拒。
    await waitFor(() => expect(pickLocalSource).toHaveBeenCalledWith('~/team/plugins'));
    expect(addSource).not.toHaveBeenCalled();
  });

  it('drops the loaded source summaries when the account switches', async () => {
    const listSources = vi
      .fn(async () => [
        {
          name: 'team-lib',
          addedAt: '2026-07-30T00:00:00.000Z',
          lastSyncedAt: null,
          lastRevision: null,
          source: { type: 'git' as const, url: 'https://git.acme.test/private/repo.git', sparsePaths: [] },
          pluginCount: 1,
          status: 'ok' as const,
          errorCode: null,
        },
      ])
      .mockName('listSources');
    (window as unknown as { electronAPI: { pluginMarket: Record<string, unknown> } }).electronAPI
      .pluginMarket.listSources = listSources;

    const view = render(
      <AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />,
    );
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(1));

    // 切号:来源摘要里有私有仓库 URL 与本地绝对路径,属于上一账号的数据。
    // Main 的 generation 校验只能拒掉新请求,撤不回 Renderer 已缓存的列表,
    // 所以必须由 Renderer 自己按账号作用域清空并重载。
    auth.mode = 'local';
    auth.dataOwnerId = 'local';
    view.rerender(
      <AddMarketplaceDialog open onOpenChange={() => {}} onSourcesChanged={() => {}} />,
    );
    await waitFor(() => expect(listSources).toHaveBeenCalledTimes(2));

    auth.mode = 'cloud';
    auth.dataOwnerId = 'user-1';
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
