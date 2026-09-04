// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import type { BotProfile } from '../botStore';
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
    channel: 'local',
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
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      localDb: {
        bots: {
          health: vi.fn(async () => null),
          lifecycleEvents: vi.fn(async () => []),
          searchHistory: vi.fn(async () => ({ sessions: [] })),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('BotLifecycleSettings v1 actions', () => {
  it('offers pause while deletion stays in the teammate list', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('active')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('bots.lifecycle.activeTitle')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'bots.lifecycle.pause' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });

  it('shows a legacy stopped Bot as read-only because deletion lives in the list', async () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={bot('archived')} onOpenSession={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('bots.lifecycle.stoppedTitle')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.lifecycle.restore' })).toBeNull();
  });
});
