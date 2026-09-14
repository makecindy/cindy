// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { runBotLifecycleAction, type BotProfile } from '../botStore';
import { BotLifecycleSettings } from '../BotLifecycleSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('../botStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../botStore')>();
  return { ...original, runBotLifecycleAction: vi.fn() };
});

function bot(status: BotProfile['status']): BotProfile {
  return {
    id: 'bot-1',
    name: 'Helper',
    description: '',
    avatar: '🤖',
    avatarColor: 'violet',
    enabled: true,
    status,
    skills: [],
    capabilities: {
      model: 'test-model',
      effort: '',
      fastMode: false,
      harness: 'pi',
      modelChain: [
        { harness: 'pi', model: 'test-model', providerId: null, effort: '', fastMode: false },
      ],
      skillMode: 'inherit',
      skillsExcluded: [],
      toolsetMode: 'inherit',
      toolsets: [],
      mcpMode: 'inherit',
      mcpServers: [],
      memory: true,
      permissions: 'ask',
    },
    createdAt: 1,
    sessions: [],
  };
}

beforeEach(() => {
  vi.mocked(runBotLifecycleAction).mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: {
        bots: {
          health: vi.fn(async () => null),
          lifecycleEvents: vi.fn(async () => []),
          searchHistory: vi.fn(async () => ({ results: [] })),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('BotLifecycleSettings v1 actions', () => {
  it('restarts from settings with pending and success feedback and no confirmation', async () => {
    let finish!: () => void;
    vi.mocked(runBotLifecycleAction).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ botId: 'bot-1', action: 'restart', status: 'active',
        affected: { sessions: 1, routes: 0, automations: 0, delegations: 0, deliveries: 0, worktrees: 0 } });
    }));
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
    expect(runBotLifecycleAction).toHaveBeenCalledWith({ botId: 'bot-1', action: 'restart' });
    const pending = screen.getByRole('button', { name: 'bots.lifecycle.restarting' }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(runBotLifecycleAction).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('bots.lifecycle.restarted'));
  });

  it('keeps restart available after a failed attempt', async () => {
    vi.mocked(runBotLifecycleAction).mockRejectedValueOnce(new Error('unavailable'));
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'bots.lifecycle.restart' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders history search on its own settings page', async () => {
    render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} /></MemoryRouter>);
    const restart = screen.getByRole('button', { name: 'bots.lifecycle.restart' });
    expect(restart.closest('details')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'bots.historySearch.title' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'bots.historySearch.title' }), { target: { value: 'project' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.historySearch.search' }));
    await waitFor(() => expect(screen.getByText('bots.historySearch.empty')).toBeTruthy());
    expect(window.electronAPI.localDb.bots.searchHistory).toHaveBeenCalledWith({ botId: 'bot-1', query: 'project', limit: 20 });
  });

  it('offers deletion and restart without a pause action', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'bots.lifecycle.pause' })).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });

  it('allows deleting a legacy stopped teammate but does not offer restart', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('archived')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restart' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });
});

it('only deletes after confirmation and retains task history and independent worktrees', async () => {
  const deleted = vi.fn();
  render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} mode="actions" onDeleted={deleted} onOpenSession={vi.fn()} /></MemoryRouter>);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.deleteTitle' }));
  await screen.findByRole('dialog');
  expect(runBotLifecycleAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.delete' }));
  await waitFor(() => expect(deleted).toHaveBeenCalledWith('bot-1'));
  expect(runBotLifecycleAction).toHaveBeenCalledWith({ botId: 'bot-1', action: 'delete', confirmName: 'Helper', keepTaskHistory: true, worktreeDisposition: 'retain' });
});
it('does not restart when a pending settings save cannot finish', async () => {
  render(<MemoryRouter><BotLifecycleSettings bot={bot('active')} mode="actions" beforeAction={async () => false} onOpenSession={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'bots.lifecycle.restart' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'bots.lifecycle.restart' }) as HTMLButtonElement).disabled).toBe(false));
  expect(runBotLifecycleAction).not.toHaveBeenCalled();
});
