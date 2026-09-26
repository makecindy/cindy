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
    t: (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key),
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
});
