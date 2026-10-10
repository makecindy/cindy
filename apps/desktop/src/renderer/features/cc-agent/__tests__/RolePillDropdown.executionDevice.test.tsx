// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown } from '../RolePillDropdown';

const confirm = vi.hoisted(() =>
  vi.fn(async (_opts: { description: string }) => false),
);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'proxy-a',
    role: 'transcriber',
    agent: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    label: null,
    status: 'running',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

function openMenu(current: WorkerInfo) {
  render(
    <RolePillDropdown
      worker={current}
      workers={[current]}
      selectedWorkerId={current.workerId}
      activeWorkerCount={1}
      onSwitchFocus={vi.fn()}
      onArchiveWorker={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /transcriber/ }));
}

describe('RolePillDropdown worker on another computer', () => {
  afterEach(() => {
    cleanup();
  });

  it('names the execution device before the model', () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: 'Mac mini',
          reachable: true,
          workingDir: null,
        },
      }),
    );
    expect(screen.getAllByText('Mac mini').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
    expect(screen.queryByText('orca.rolePill.deviceUnreachable')).toBeNull();
  });

  it('shows that status is unavailable instead of the model while unreachable', () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: null,
          reachable: false,
          workingDir: null,
        },
      }),
    );
    expect(screen.getAllByText('orca.rolePill.unknownDevice').length).toBeGreaterThan(0);
    expect(screen.getAllByText('orca.rolePill.deviceUnreachable').length).toBeGreaterThan(0);
  });

  it('explains that archiving keeps the task on the execution device', async () => {
    openMenu(
      worker({
        executionDevice: {
          deviceId: 'mac-mini',
          remoteSessionId: 'remote-a',
          deviceName: 'Mac mini',
          reachable: true,
          workingDir: null,
        },
      }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'orca.rolePill.archiveWorkerAria' })[0]!);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls.at(-1)![0].description).toBe(
      'orca.rolePill.archiveRemoteWorkerConfirmDesc',
    );
  });

  it('leaves local workers unchanged', () => {
    openMenu(worker());
    expect(screen.queryByText('orca.rolePill.unknownDevice')).toBeNull();
    expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
  });
});
