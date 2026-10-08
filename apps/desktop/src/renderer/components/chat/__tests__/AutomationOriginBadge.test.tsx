// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mocks.navigate };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  __resetStickySessionOriginForTest,
  getStickySessionDeviceId,
} from '@/features/device-link/stickySessionOrigin';
import type { Session } from '@/lib/ccAgent.types';

import { AutomationOriginBadge } from '../AutomationOriginBadge';

function remoteSession(id: string): Session {
  return {
    id,
    title: id,
    status: 'active',
    workingDir: '/repo',
    workspaceKind: 'project',
  } as Session;
}

afterEach(() => {
  remoteProjectsStore.clear();
  __resetStickySessionOriginForTest();
  mocks.navigate.mockReset();
});

describe('AutomationOriginBadge', () => {
  it('keeps a remote host task remote while the relay mirror is being rebuilt', () => {
    remoteProjectsStore.setDeviceSessions('dev-A', 'A', [remoteSession('host-task')]);
    // The session view has already resolved (and cached) this task as remote.
    expect(getStickySessionDeviceId('host-task')).toBe('dev-A');
    // Relay reconnect: the live registry is cleared before the snapshot returns.
    remoteProjectsStore.clear();
    const pin = vi.spyOn(remoteProjectsStore, 'pinSessionOrigin');

    render(
      <AutomationOriginBadge
        automationOrigin={{
          kind: 'session',
          senderSessionId: 'source-task',
          senderSessionTitle: 'Source',
        }}
        hostSessionId="host-task"
      />,
    );
    fireEvent.click(screen.getByRole('button'));

    expect(pin).toHaveBeenCalledWith('dev-A', 'source-task');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/source-task');
  });

  it('renders a redacted shared-task source as static text', () => {
    render(
      <AutomationOriginBadge automationOrigin={{ kind: 'session' }} hostSessionId="guest-task" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('chat.userMessage.sessionSent')).toBeTruthy();
  });

  it('lists the source session id under the existing tooltip line', () => {
    render(
      <AutomationOriginBadge
        automationOrigin={{ kind: 'session', senderSessionId: 'source-task', senderSessionTitle: 'Source' }}
      />,
    );
    expect(screen.getByRole('button').getAttribute('title')).toBe(
      'chat.userMessage.sessionViewSource\nchat.userMessage.sourceIds.session:source-task',
    );
  });

  it('lists the teammate id and the task id for a teammate sender', () => {
    render(
      <AutomationOriginBadge
        automationOrigin={{
          kind: 'session',
          senderSessionId: 'bot-task',
          senderBotId: 'bot-1',
          senderBotName: 'Cindy',
        }}
      />,
    );
    expect(screen.getByRole('button').getAttribute('title')).toBe(
      [
        'chat.userMessage.sessionViewSource',
        'chat.userMessage.sourceIds.teammate:bot-1',
        'chat.userMessage.sourceIds.session:bot-task',
      ].join('\n'),
    );
  });

  it('lists the automation id and opens the automation', () => {
    render(
      <AutomationOriginBadge
        automationOrigin={{ kind: 'scheduler', scheduleId: 'sched-1', scheduleName: 'Nightly' }}
      />,
    );
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('chat.userMessage.automationSentNamed:Nightly');
    expect(button.getAttribute('title')).toBe(
      'chat.userMessage.automationViewTask\nchat.userMessage.sourceIds.automation:sched-1',
    );
    fireEvent.click(button);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

  it('renders a redacted automation source (shared-task guest) as static text', () => {
    render(<AutomationOriginBadge automationOrigin={{ kind: 'scheduler' }} />);
    expect(screen.queryByRole('button')).toBeNull();
    const label = screen.getByText('chat.userMessage.automationSent');
    expect(label.closest('[title]')).toBeNull();
  });

  it('shows the IM channel for hook turns instead of an automation, without navigation', () => {
    render(
      <AutomationOriginBadge
        automationOrigin={{ kind: 'scheduler', scheduleId: 'hook:conn-1', scheduleName: 'Hook · Team Slack' }}
        hookIm="slack"
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/automationSent/)).toBeNull();
    expect(
      screen.getByText('chat.userMessage.hookChannelFrom:settings.tina.prefs.providerSlack'),
    ).toBeTruthy();
  });

  it('falls back to the hook connection name when the IM platform is unknown', () => {
    render(
      <AutomationOriginBadge
        automationOrigin={{ kind: 'scheduler', scheduleId: 'hook:conn-1', scheduleName: 'Hook · Team Slack' }}
      />,
    );
    expect(screen.getByText('chat.userMessage.hookChannelFrom:Team Slack')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for an Orca origin without a recorded sender session', () => {
    const { container } = render(
      <AutomationOriginBadge automationOrigin={{ kind: 'session', orca: true, orcaSenderLabel: '前端' }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
