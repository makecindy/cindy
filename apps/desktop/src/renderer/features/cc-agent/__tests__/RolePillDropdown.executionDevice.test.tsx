// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';
import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown } from '../RolePillDropdown';

const confirm = vi.hoisted(() => vi.fn(async (_opts: { description: string }) => false));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
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

// Guard: actual remote session origin + execution-device projection must prevent local
// project reads/badges. Existing device-name tests did not install a projectLabel endpoint.
describe('Worker project badge device boundary', () => {
  afterEach(() => {
    cleanup();
    remoteProjectsStore.__resetPinnedOriginsForTest();
    __resetStickySessionOriginForTest();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });
  it.each(['controlled-lead', 'execution-device', 'local'])(
    'only queries and displays the local project for %s',
    async (location) => {
      const projectLabel = vi
        .fn()
        .mockResolvedValue({ name: 'other-project', path: '/other-project' });
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        localDb: { orcaWorkflows: { projectLabel } },
      };
      const current = worker(
        location === 'execution-device'
          ? {
              executionDevice: {
                deviceId: 'execution-pc',
                remoteSessionId: 'remote-worker',
                deviceName: 'Execution PC',
                reachable: true,
                workingDir: '/remote-project',
              },
            }
          : {},
      );
      if (location === 'controlled-lead') {
        remoteProjectsStore.pinSessionOrigin('controlled-pc', 'lead');
        remoteProjectsStore.pinSessionOrigin('controlled-pc', current.sessionId);
      }
      openMenu(current);
      await act(async () => {});
      if (location === 'local') {
        expect(projectLabel).toHaveBeenCalledWith(current.sessionId);
        expect(screen.getAllByText('other-project').length).toBeGreaterThan(0);
      } else {
        expect(projectLabel).not.toHaveBeenCalled();
        expect(screen.queryByText('other-project')).toBeNull();
        expect(screen.getAllByText('claude-opus-5-5').length).toBeGreaterThan(0);
      }
    },
  );
});
