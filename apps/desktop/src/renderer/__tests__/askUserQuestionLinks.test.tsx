// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: vi.fn(async () => undefined),
  pathToFileUrl: (path: string) => `file://${path}`,
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

const url = 'https://example.com/base?table=tbl123';
const openExternal = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  openExternal.mockClear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal },
  });
});

afterEach(() => {
  cleanup();
});

describe('AskUserQuestionPrompt question links', () => {
  it('opens an http URL from the question text', async () => {
    render(
      <AskUserQuestionPrompt
        pending={{
          requestId: 'req-link',
          questions: [
            {
              question: `请打开项目 Base (${url}), 进入“高级权限”。`,
              options: [{ label: '我现在检查' }],
            },
          ],
        }}
        onAnswer={vi.fn()}
        viewerState="expanded"
        onViewerStateChange={vi.fn()}
        draft={null}
        onDraftChange={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: url });
    expect(link.getAttribute('href')).toBe(url);

    fireEvent.click(link);

    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(url));
  });

  it('resets link-local menu state when the wizard advances to a different URL', async () => {
    const nextUrl = 'https://example.com/base?table=tbl456';
    render(
      <AskUserQuestionPrompt
        sessionId="session-a"
        pending={{
          requestId: 'req-link-steps',
          questions: [
            {
              question: url,
              options: [{ label: '继续' }],
            },
            {
              question: nextUrl,
              options: [{ label: '完成' }],
            },
          ],
        }}
        onAnswer={vi.fn()}
        viewerState="expanded"
        onViewerStateChange={vi.fn()}
        draft={null}
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('link', { name: url }));
    expect(screen.getByText('chat.markdownRenderer.copyLink')).toBeTruthy();

    fireEvent.click(screen.getByText('继续').closest('button')!);

    await waitFor(() => expect(screen.getByRole('link', { name: nextUrl })).toBeTruthy());
    expect(screen.queryByText('chat.markdownRenderer.copyLink')).toBeNull();
  });
});
