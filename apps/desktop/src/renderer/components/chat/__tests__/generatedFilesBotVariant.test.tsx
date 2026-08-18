// @vitest-environment jsdom

/**
 * 「本轮产出文件」在伙伴会话里升级成交付物卡,在普通任务里保持原样。
 *
 * 这条边界是产品承诺:批次 δ 只动伙伴对话,普通任务的消息渲染一个像素都不许变。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  statPath: vi.fn(),
  openArtifact: vi.fn(),
  openBotArtifactsTab: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/features/bots/useBotArtifactOpen', () => ({
  useBotArtifactOpen: () => ({ openArtifact: mocks.openArtifact, artifactLightboxes: null }),
}));
vi.mock('@/features/right-sidebar/lib/openBotArtifactsTab', () => ({
  openBotArtifactsTab: mocks.openBotArtifactsTab,
}));
vi.mock('../useFileChipContextMenu', () => ({
  useFileChipContextMenu: () => ({ onContextMenu: vi.fn(), openAt: vi.fn(), menu: null }),
}));

import { GeneratedFilesCard } from '../GeneratedFilesCard';

const FILES = [
  { path: '/w/plan.md', name: 'plan.md', source: 'tool' as const },
  { path: '/w/data.csv', name: 'data.csv', source: 'tool' as const },
];

beforeEach(() => {
  mocks.openArtifact.mockClear();
  mocks.openBotArtifactsTab.mockClear();
  // 本轮时间窗内新建的真实文件:让存在性 / 时间窗过滤全部放行。
  mocks.statPath.mockResolvedValue({ kind: 'file', birthtimeMs: 500, mtimeMs: 500 });
  (globalThis as unknown as { window: Record<string, unknown> }).window.electronAPI = {
    fsBrowse: { statPath: mocks.statPath },
  };
});

afterEach(() => cleanup());

describe('GeneratedFilesCard', () => {
  it('keeps the plain file chips for a normal task', async () => {
    render(<GeneratedFilesCard files={FILES} turnStartMs={0} turnEndMs={1_000} />);
    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    expect(screen.queryAllByTestId('bot-artifact-card')).toHaveLength(0);
  });

  it('upgrades to deliverable cards inside a teammate conversation', async () => {
    render(
      <GeneratedFilesCard
        files={FILES}
        turnStartMs={0}
        turnEndMs={1_000}
        botSessionId="session-bot-1"
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-card')).toHaveLength(2));
    const categories = screen
      .getAllByTestId('bot-artifact-card')
      .map((card) => card.getAttribute('data-artifact-category'));
    expect(categories).toEqual(['doc', 'sheet']);
  });

  it('jumps to that teammate library from the card', async () => {
    render(
      <GeneratedFilesCard
        files={FILES}
        turnStartMs={0}
        turnEndMs={1_000}
        botSessionId="session-bot-1"
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('bot-artifact-card')).toHaveLength(2));
    fireEvent.click(screen.getAllByText('bots.artifacts.reveal')[0]!);
    expect(mocks.openBotArtifactsTab).toHaveBeenCalledWith('session-bot-1', {
      focusArtifactId: '/w/plan.md',
    });
  });

  it('still hides files that failed the existence gate', async () => {
    mocks.statPath.mockResolvedValue({ kind: 'missing' });
    const { container } = render(
      <GeneratedFilesCard
        files={FILES}
        turnStartMs={0}
        turnEndMs={1_000}
        botSessionId="session-bot-1"
      />,
    );
    await waitFor(() => expect(mocks.statPath).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
