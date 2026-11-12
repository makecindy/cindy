// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => ({ success: true })),
  openPath: vi.fn(async () => ({ success: true })),
  writeText: vi.fn(async () => undefined),
  sidebar: vi.fn(async () => undefined),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, opts?: { count?: number; role?: string }) =>
    opts?.count !== undefined ? `${key}:${opts.count}` : opts?.role ? `${key}:${opts.role}` : key }),
}));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({
  openUrlInSidebarBrowser: mocks.sidebar,
  pathToFileUrl: (path: string) => `file://${path}`,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../useForkAtMessage', () => ({
  useForkAtMessage: () => async () => {},
  textToTiptapDoc: () => null,
}));
vi.mock('../useDeleteMessage', () => ({ useDeleteMessage: () => async () => {} }));

import { MarkdownRenderer } from '../MarkdownRenderer';
import { UserMessageImageLink } from '../UserMessageImageLink';
import { UserMessage } from '../UserMessage';
import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { MemoryRouter } from 'react-router-dom';
import { toMessageAutomationOrigin } from '@/lib/messageAutomationOrigin';
import { _resetLinkOpenPreferenceForTests } from '@/hooks/useLinkOpenPreference';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  _resetLinkOpenPreferenceForTests();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal: mocks.openExternal, openPath: mocks.openPath },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});
afterEach(cleanup);

describe('message link entry points', () => {
  it('uses the same preference and Shift override for assistant Markdown URLs', async () => {
    render(
      <MarkdownRenderer
        content="[Preview](http://localhost:3000)"
        currentSessionId="task"
        workingDir="/workspace"
      />,
    );
    const link = screen.getByRole('link', { name: 'Preview' });
    fireEvent.click(link);
    await waitFor(() =>
      expect(mocks.sidebar).toHaveBeenCalledWith('task', 'http://localhost:3000'),
    );
    fireEvent.click(link, { shiftKey: true });
    await waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith('http://localhost:3000'));
    expect(mocks.sidebar).toHaveBeenCalledOnce();
  });

  // 回归：带首个 Worker 身份的合批必须显示数量并保留全部正文（unit）。
  it.each([undefined, 2])('renders Orca history for %s workers without a misleading source link', async count => {
    const body = 'Worker A (worker-1): done\nA full report\nWorker B (worker-2): error\nB full report';
    const automationOrigin = toMessageAutomationOrigin({ kind: 'orca', senderLabel: 'A', senderSessionId: 'worker-1',
      ...(count ? { autoBridge: true, autoBridgeBatchCount: count } : {}) });
    render(<MemoryRouter><UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} content={JSON.stringify({ orcaSource: 'worker', content: body })}
      workingDir="/workspace" automationOrigin={automationOrigin} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: count
      ? `chat.userMessage.orcaFromWorkerBatch:${count}` : 'chat.userMessage.orcaFromWorkerNamed:A' }));
    expect(await screen.findByText((_content, element) => element?.tagName === 'PRE' && element.textContent === body)).toBeTruthy();
    if (count) expect(screen.queryByRole('button', { name: 'chat.userMessage.sessionSent' })).toBeNull();
    else expect(screen.getByRole('button', { name: 'chat.userMessage.sessionSent' })).toBeTruthy();
  });

  it('copies assistant URLs from a keyboard menu even without a task context', async () => {
    render(<MarkdownRenderer content="[Website](https://example.com)" workingDir="/workspace" />);
    fireEvent.keyDown(screen.getByRole('link', { name: 'Website' }), {
      key: 'F10',
      shiftKey: true,
    });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyLink' }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('https://example.com'));
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('provides a copy menu for in-message heading anchors', async () => {
    render(<MarkdownRenderer content="[Details](#details)" workingDir="/workspace" />);
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Details' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyLink' }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('#details'));
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('gives bare user image paths preview, separate-open and path-copy actions', async () => {
    const preview = vi.fn();
    render(<UserMessageImageLink path="/images/example.png" onOpen={preview} />);
    const link = screen.getByRole('button', { name: '/images/example.png' });
    fireEvent.click(link);
    expect(preview).toHaveBeenCalledOnce();
    fireEvent.click(link, { shiftKey: true });
    await waitFor(() => expect(mocks.openPath).toHaveBeenCalledWith('/images/example.png'));
    fireEvent.keyDown(link, { key: 'ContextMenu' });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyFilePath' }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('/images/example.png'));
  });
});
