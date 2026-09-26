// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '@/lib/ccAgent.types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { TaskMigrationDialog } from '../TaskMigrationDialog';
const state = vi.hoisted(() => ({
  request: vi.fn(),
  invoke: vi.fn(),
  openLink: vi.fn(),
  merge: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    captureSessionRead: () => Object.assign(() => true, { mergeActivity: (row: unknown) => row }),
    mergeDeviceSessions: state.merge,
  },
}));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    label: string;
    value: string;
    disabled: boolean;
    options: Array<{ value: string; label: string }>;
    onValueChange(value: string): void;
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onValueChange(e.target.value)}
    >
      <option value="" />
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const source = { id: 'task', title: 'Task', status: 'active', deviceLinkDeviceId: 'A' } as Session;
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'caps' ? { projects: ['B-project'] } : {}),
  }));
  state.openLink.mockResolvedValue(undefined);
  Object.assign(window, {
    electronAPI: {
      deviceLink: {
        taskMigration: state.request,
        invoke: state.invoke,
        openLink: state.openLink,
        listDevices: async () => ({
          devices: ['local', 'A', 'B', 'offline', 'phone'].map((deviceId) => ({
            deviceId,
            name: deviceId,
            online: deviceId !== 'offline',
            remoteControlEnabled: true,
            controlEnabled: true,
            platform: deviceId === 'phone' ? 'ios' : 'darwin',
          })),
        }),
      },
    },
  });
});
afterEach(cleanup);
const mount = () =>
  render(
    <MemoryRouter>
      <TaskMigrationDialog session={source} onDismiss={state.dismiss} />
    </MemoryRouter>,
  );
it('uses the source host for commands and the target host for destination projects, with no duplicate start', async () => {
  mount();
  await screen.findByRole('option', { name: 'B' });
  expect(screen.queryByRole('option', { name: 'A' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'offline' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'phone' })).toBeNull();
  expect(screen.getByRole('option', { name: 'local · settings.devices.thisDevice' })).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'taskMigration.device' }), {
    target: { value: 'B' },
  });
  await screen.findByRole('option', { name: 'B-project' });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => {
    if (command.action === 'start') return new Promise(() => {});
    return { supported: true, deviceId: device ?? 'local' };
  });
  const start = screen.getByRole('button', { name: 'taskMigration.start' });
  fireEvent.click(start);
  fireEvent.click(start);
  expect(state.request.mock.calls.filter(([, command]) => command.action === 'start')).toEqual([
    ['A', { action: 'start', sessionId: 'task', targetDeviceId: 'B', targetProject: null }],
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.close' }));
  expect(state.dismiss).toHaveBeenCalledOnce();
  expect(state.request.mock.calls.some(([, command]) => command.action === 'cancel')).toBe(false);
});
it('offers retry, without cancellation, when the source already retired but activation was interrupted', async () => {
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'status'
      ? {
          stage: 'moved',
          running: false,
          error: 'MIGRATION_FAILED',
          targetDeviceId: 'B',
          targetSessionId: 'migrated',
        }
      : {}),
  }));
  mount();
  const retry = await screen.findByRole('button', { name: 'taskMigration.retry' });
  expect(screen.queryByRole('button', { name: 'taskMigration.cancel' })).toBeNull();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith('A', { action: 'retry', sessionId: 'task' }),
  );
});
it('loads the completed task from the target computer before navigation and dismisses the dialog', async () => {
  state.request.mockImplementation(async (device: string | null, command: { action: string }) => ({
    supported: true,
    deviceId: device ?? 'local',
    ...(command.action === 'status'
      ? {
          stage: 'complete',
          running: false,
          targetDeviceId: 'B',
          targetSessionId: 'migrated',
        }
      : {}),
  }));
  state.invoke.mockResolvedValue({ id: 'migrated', status: 'active' });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'taskMigration.openTarget' }));
  await waitFor(() => expect(state.dismiss).toHaveBeenCalledOnce());
  expect(state.openLink).toHaveBeenCalledWith('B');
  expect(state.invoke).toHaveBeenCalledWith('B', 'local-db:sessions:get', ['migrated']);
  expect(state.merge).toHaveBeenCalledWith('B', 'B', [{ id: 'migrated', status: 'active' }]);
});

it('confirms the project selected in the menu without asking for a second selection', async () => {
  render(<MemoryRouter><TaskMigrationDialog session={source} onDismiss={state.dismiss}
    destination={{ deviceId: 'B', deviceName: 'Work Mac', project: 'B-project' }} /></MemoryRouter>);
  await waitFor(() => expect((screen.getByRole('button', { name: 'taskMigration.start' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByText(/Work Mac/)).toBeTruthy();
  expect(screen.getByText(/B-project/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'taskMigration.start' }));
  await waitFor(() => expect(state.request).toHaveBeenCalledWith('A', {
    action: 'start', sessionId: 'task', targetDeviceId: 'B', targetProject: 'B-project',
  }));
});
