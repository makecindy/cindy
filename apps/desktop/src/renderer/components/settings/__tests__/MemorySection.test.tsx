// @vitest-environment jsdom
/**
 * 记忆设置区 (docs/product-rules/cindy-memory.md §6): Cindy 记忆开着时它统一管理所有 harness 的
 * 记忆, Claude Code / Codex 的原生记忆两行不显示; 关掉 Cindy 记忆后两行才出现, 再打开又收起。
 * 新文件: MemorySection 此前没有测试。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => false }),
}));

import { setMakerMemoryEnabled } from '@/lib/memorySettingsStore';
import { MemorySection } from '../MemorySection';

const CLAUDE = 'settings.memory.agents.claude-code.label';
const CODEX = 'settings.memory.agents.codex.label';
const state = { isCustomized: false, customizedKeys: [], defaults: { maker: true, claudeCode: true, codex: true } };

describe('MemorySection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          memoryGet: vi.fn(async () => ({ enabled: true, source: 'host-runtime' })),
          memoryGetSettingsState: vi.fn(async () => ({ maker: true, claudeCode: true, codex: true, ...state })),
          makerMemorySetEnabled: vi.fn(async () => ({ effective: 'next-session', codexRestartDeferred: false, ...state })),
        },
      },
    });
  });

  it('shows the Claude Code and Codex rows only while Cindy memory is off', async () => {
    setMakerMemoryEnabled(true);
    render(<MemoryRouter><MemorySection /></MemoryRouter>);
    expect(screen.getByText('settings.memory.maker.label')).toBeTruthy();
    expect(screen.queryByText(CLAUDE)).toBeNull();
    expect(screen.queryByText(CODEX)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByLabelText('settings.memory.maker.toggleAria'));
    });
    await waitFor(() => expect(screen.getByText(CLAUDE)).toBeTruthy());
    expect(screen.getByText(CODEX)).toBeTruthy();
    expect(window.electronAPI.maker.makerMemorySetEnabled).toHaveBeenCalledWith(false);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('settings.memory.maker.toggleAria'));
    });
    await waitFor(() => expect(screen.queryByText(CLAUDE)).toBeNull());
    expect(screen.queryByText(CODEX)).toBeNull();
  });
});
